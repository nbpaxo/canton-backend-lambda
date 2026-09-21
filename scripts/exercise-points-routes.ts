/**
 * DEV ONLY — exercise the /points routes end-to-end through Express against the
 * local Postgres. There is no real Keycloak/Loop credential locally, so the
 * routers are loaded with `../auth.js` redirected (via a Node loader hook, see
 * scripts/dev-auth-hook.mjs) to a stub that injects a chosen party. Router,
 * SQL and JSON shapes are the real code.
 *
 *   TEST_PARTY=<party> TEST_OTHER=<party> \
 *   npx tsx --import ./scripts/dev-auth-hook.mjs scripts/exercise-points-routes.ts
 */
import express from 'express';
import { setDevParty } from './dev-auth-stub.js';

const PARTY = process.env.TEST_PARTY!;
const OTHER = process.env.TEST_OTHER!;

const { default: pointsRoutes } = await import('../src/api/points.js');
const { default: referralRoutes } = await import('../src/api/referral.js');

const app = express();
app.use(express.json());
app.use('/', pointsRoutes);
app.use('/', referralRoutes);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;

async function get(path: string, party = PARTY) {
  setDevParty(party);
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, body: await r.json() };
}
const show = (label: string, x: unknown) => console.log(`\n=== ${label} ===\n${JSON.stringify(x, null, 2)}`);

show('GET /points/me (top party)', await get('/points/me'));
show('GET /points/me/daily (top party)', await get('/points/me/daily'));
show('GET /points/leaderboard?limit=5 (top party)', await get('/points/leaderboard?limit=5'));
show('GET /points/leaderboard?limit=3 (low party: own rank in `me` even outside top N)', await get('/points/leaderboard?limit=3', OTHER));
show('GET /points/me/referrals (top party)', await get('/points/me/referrals'));
show('GET /referral/me → summary now populated', (await get('/referral/me')).body.summary);
show('GET /points/me (unknown party → zeros)', await get('/points/me', 'nobody::1220ffff'));

server.close();
process.exit(0);
