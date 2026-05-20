/**
 * Replay a Persona webhook payload against /kyc/webhook with a correctly-
 * computed HMAC signature. Use this when an event didn't reach the server
 * (e.g. wrong webhook URL configured in the Persona dashboard) and you want
 * to exercise the real handler path instead of writing to the DB directly.
 *
 * The "invalid signature" gotcha: Persona signs the EXACT bytes of the
 * request body. If you pretty-print or re-serialize the JSON between
 * computing the signature and POSTing, the hash won't match. This script
 * holds one canonical `rawBody` string and uses the same bytes for both.
 *
 * Signature scheme (see verifyWebhookSignature):
 *   header: Persona-Signature: t=<unix>,v1=<hex>
 *   v1 = HMAC-SHA256(PERSONA_WEBHOOK_SECRET, `${t}.${rawBody}`)
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/replay-kyc-webhook.ts
 *   WEBHOOK_URL=http://127.0.0.1:3003/kyc/webhook \
 *     npx tsx --env-file=.env scripts/replay-kyc-webhook.ts
 */

import { createHmac } from 'node:crypto';

const WEBHOOK_URL =
  process.env.WEBHOOK_URL ?? 'http://127.0.0.1:3003/kyc/webhook';
const SECRET = process.env.PERSONA_WEBHOOK_SECRET;

if (!SECRET) {
  console.error('PERSONA_WEBHOOK_SECRET not set (load .env via --env-file=.env)');
  process.exit(1);
}

// The payload as Persona delivered it. Keep this as a literal object — we
// JSON.stringify ONCE and use those bytes for both signing and POSTing.
const payload = {
  data: {
    type: 'event',
    id: 'evt_AVAuPERLvttgYKNqY8gq89KBbkDLdW',
    attributes: {
      name: 'inquiry.approved',
      payload: {
        data: {
          type: 'inquiry',
          id: 'inq_AVAuPERe6o1K15thgUHi2qe96r1t5X',
          attributes: {
            status: 'approved',
            'reference-id':
              '1f55c3abfe52a505fce051ad0557ff8a::122061b5340486fea0280e2fbf8722e8b2a3c924195448ea28e990dfd45cdfd31acd',
            note: null,
            creator: 'API',
            'reviewer-comment': null,
            'updated-at': '2026-05-13T09:50:21.000Z',
            'created-at': '2026-05-13T09:44:16.000Z',
            'started-at': '2026-05-13T09:49:14.000Z',
            'expires-at': null,
            'completed-at': '2026-05-13T09:50:19.000Z',
            'failed-at': null,
            'marked-for-review-at': null,
            'decisioned-at': '2026-05-13T09:50:21.000Z',
            'expired-at': null,
            'redacted-at': null,
            'previous-step-name': 'selfie_d0e4d2_verification',
            'next-step-name': 'success_1819b7',
          },
        },
      },
      'created-at': '2026-05-13T09:50:21.739Z',
      context: {},
    },
  },
};

// Single canonical serialization — these bytes get hashed AND posted.
const rawBody = JSON.stringify(payload);

const t = Math.floor(Date.now() / 1000).toString();
const v1 = createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex');
const sigHeader = `t=${t},v1=${v1}`;

console.log(`POST ${WEBHOOK_URL}`);
console.log(`  Persona-Signature: ${sigHeader}`);
console.log(`  Body bytes: ${Buffer.byteLength(rawBody, 'utf8')}`);

const res = await fetch(WEBHOOK_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Persona-Signature': sigHeader,
  },
  body: rawBody,
});

const text = await res.text();
console.log(`\n← ${res.status} ${res.statusText}`);
console.log(text);
process.exit(res.ok ? 0 : 2);
