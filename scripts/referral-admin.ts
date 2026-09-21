/**
 * Referral admin — attach, detach, or inspect a user's referrer.
 *
 * The self-service paths are deliberately narrow: mperps users bind on the
 * signup form, and Loop users only inside their post-connect window. This
 * script is the operator escape hatch for everything else — a user who missed
 * the window, a support case, or a fraudulent attribution that has to go.
 *
 * Usage (add --dry-run to any command to see the outcome without writing):
 *
 *   # who referred this user, and who have they referred?
 *   npx tsx --env-file=.env scripts/referral-admin.ts show <partyId>
 *
 *   # attach a referrer (bypasses the window; every other rule still applies)
 *   npx tsx --env-file=.env scripts/referral-admin.ts bind <partyId> <code>
 *
 *   # detach — marks the edge revoked, keeping it for audit
 *   npx tsx --env-file=.env scripts/referral-admin.ts unbind <partyId> "reason"
 *
 *   # move a user to a different referrer (revoke + re-bind, one transaction)
 *   npx tsx --env-file=.env scripts/referral-admin.ts reassign <partyId> <code> "reason"
 *
 * Run against prod through the SSM tunnel (DATABASE_URL → localhost:15432)
 * or on the EC2 box directly.
 *
 * Safety: `bind` cannot create a duplicate — `referrals.referee_party_id` is
 * the primary key, so a user who already has a referrer is rejected rather
 * than silently overwritten. Use `reassign` when replacement is the intent.
 */
import { getPool, closePool } from '../src/db/pool.js';
import { bindReferral, getInviter, getSummary } from '../src/referral/service.js';
import { lookupActiveCode } from '../src/referral/service.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter((a) => a !== '--dry-run');
const [command, partyId, ...rest] = positional;

function usage(): never {
  console.error(
    'Usage:\n'
    + '  referral-admin.ts show     <partyId>\n'
    + '  referral-admin.ts bind     <partyId> <code>\n'
    + '  referral-admin.ts unbind   <partyId> "<reason>"\n'
    + '  referral-admin.ts reassign <partyId> <code> "<reason>"\n'
    + '  (append --dry-run to any of the above)',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  if (!command || !partyId) usage();
  const pool = getPool();

  const userRes = await pool.query<{ is_external: boolean; created_at: Date }>(
    'SELECT is_external, created_at FROM users WHERE party_id = $1',
    [partyId],
  );
  if (!userRes.rows[0]) {
    console.error(`No such user: ${partyId}`);
    process.exit(1);
  }

  switch (command) {
    case 'show': {
      const [inviter, summary] = await Promise.all([
        getInviter(pool, partyId),
        getSummary(pool, partyId),
      ]);
      console.log(`party:       ${partyId}`);
      console.log(`type:        ${userRes.rows[0].is_external ? 'loop' : 'mperps'}`);
      console.log(`created_at:  ${userRes.rows[0].created_at.toISOString()}`);
      console.log(
        inviter
          ? `referred by: ${inviter.partyId} (code ${inviter.code}, ${inviter.boundAt})`
          : 'referred by: — (no referrer attached)',
      );
      console.log(`has referred: ${summary.referredFriends} user(s)`);
      break;
    }

    case 'bind': {
      const [code] = rest;
      if (!code) usage();

      // Resolve first so a dry run reports the same verdict a real run would.
      const target = await lookupActiveCode(pool, code);
      if (!target) {
        console.error(`Invalid or disabled referral code: ${code}`);
        process.exit(1);
      }
      if (dryRun) {
        console.log(`[dry-run] would bind ${partyId} → ${target.ownerPartyId} (${target.code})`);
        break;
      }

      const result = await bindReferral(pool, {
        refereePartyId: partyId,
        rawCode: code,
        source: 'admin',
      });
      if (!result.ok) {
        console.error(`Bind refused: ${result.reason}`);
        process.exit(1);
      }
      console.log(`Bound ${partyId} → ${result.referrerPartyId} (code ${result.code})`);
      break;
    }

    case 'unbind': {
      const reason = rest.join(' ').trim();
      if (!reason) {
        console.error('A reason is required so the audit trail explains itself.');
        process.exit(1);
      }
      if (dryRun) {
        const inviter = await getInviter(pool, partyId);
        console.log(
          inviter
            ? `[dry-run] would revoke ${partyId} → ${inviter.partyId} (${inviter.code})`
            : `[dry-run] nothing to revoke for ${partyId}`,
        );
        break;
      }
      const res = await pool.query(
        `UPDATE referrals
            SET status = 'revoked', revoked_at = NOW(), revoked_reason = $2
          WHERE referee_party_id = $1 AND status = 'active'`,
        [partyId, reason],
      );
      console.log(
        res.rowCount
          ? `Revoked the referrer for ${partyId}.`
          : `No active referral to revoke for ${partyId}.`,
      );
      break;
    }

    case 'reassign': {
      const [code, ...reasonParts] = rest;
      const reason = reasonParts.join(' ').trim();
      if (!code || !reason) usage();

      const target = await lookupActiveCode(pool, code);
      if (!target) {
        console.error(`Invalid or disabled referral code: ${code}`);
        process.exit(1);
      }
      if (target.ownerPartyId === partyId) {
        console.error('Refusing to make a user their own referrer.');
        process.exit(1);
      }
      if (dryRun) {
        console.log(`[dry-run] would reassign ${partyId} → ${target.ownerPartyId} (${target.code})`);
        break;
      }

      // One transaction: the old edge must never be revoked without the new
      // one landing, or the user silently ends up with no referrer at all.
      // bindReferral overwrites a revoked row, so revoke-then-bind is enough —
      // and audit_log keeps the record of who they were moved away from.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const previous = await getInviter(client, partyId);
        await client.query(
          `INSERT INTO audit_log (user_party_id, action, details)
                VALUES ($1, 'referral_reassign', $2)`,
          [partyId, JSON.stringify({
            fromPartyId: previous?.partyId ?? null,
            fromCode: previous?.code ?? null,
            toCode: target.code,
            reason,
          })],
        );
        await client.query(
          `UPDATE referrals
              SET status = 'revoked', revoked_at = NOW(), revoked_reason = $2
            WHERE referee_party_id = $1 AND status = 'active'`,
          [partyId, reason],
        );
        const bound = await bindReferral(client, {
          refereePartyId: partyId,
          rawCode: code,
          source: 'admin',
        });
        if (!bound.ok) throw new Error(`re-bind failed: ${bound.reason}`);
        await client.query('COMMIT');
        console.log(`Reassigned ${partyId} → ${bound.referrerPartyId} (code ${bound.code})`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      break;
    }

    default:
      usage();
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
