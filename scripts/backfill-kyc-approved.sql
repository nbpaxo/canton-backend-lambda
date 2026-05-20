-- Backfill missed inquiry.approved webhook for inq_AVAuPERe6o1K15thgUHi2qe96r1t5X.
-- Persona dashboard had the wrong webhook URL so the event never landed.
-- Mirrors the three writes in src/api/kyc.ts handleWebhook (users upsert,
-- kyc_inquiries upsert, audit_log) so /me will return kyc.decision='approved'.

\set party_id    '1f55c3abfe52a505fce051ad0557ff8a::122061b5340486fea0280e2fbf8722e8b2a3c924195448ea28e990dfd45cdfd31acd'
\set inquiry_id  'inq_AVAuPERe6o1K15thgUHi2qe96r1t5X'

BEGIN;

INSERT INTO users (party_id, is_external)
VALUES (:'party_id', true)
ON CONFLICT (party_id) DO NOTHING;

INSERT INTO kyc_inquiries
  (inquiry_id, user_party_id, reference_id, status, decision,
   completed_at, raw_last_event, updated_at)
VALUES
  (:'inquiry_id',
   :'party_id',
   :'party_id',
   'approved',
   'approved',
   '2026-05-13T09:50:19.000Z',
   $payload${"data":{"type":"event","id":"evt_AVAuPERLvttgYKNqY8gq89KBbkDLdW","attributes":{"name":"inquiry.approved","payload":{"data":{"type":"inquiry","id":"inq_AVAuPERe6o1K15thgUHi2qe96r1t5X","attributes":{"status":"approved","reference-id":"1f55c3abfe52a505fce051ad0557ff8a::122061b5340486fea0280e2fbf8722e8b2a3c924195448ea28e990dfd45cdfd31acd","note":null,"creator":"API","reviewer-comment":null,"updated-at":"2026-05-13T09:50:21.000Z","created-at":"2026-05-13T09:44:16.000Z","started-at":"2026-05-13T09:49:14.000Z","expires-at":null,"completed-at":"2026-05-13T09:50:19.000Z","failed-at":null,"marked-for-review-at":null,"decisioned-at":"2026-05-13T09:50:21.000Z","expired-at":null,"redacted-at":null,"previous-step-name":"selfie_d0e4d2_verification","next-step-name":"success_1819b7"}}},"created-at":"2026-05-13T09:50:21.739Z","context":{}}}}$payload$::jsonb,
   NOW())
ON CONFLICT (inquiry_id) DO UPDATE
  SET status         = EXCLUDED.status,
      decision       = COALESCE(EXCLUDED.decision, kyc_inquiries.decision),
      completed_at   = COALESCE(EXCLUDED.completed_at, kyc_inquiries.completed_at),
      raw_last_event = EXCLUDED.raw_last_event,
      updated_at     = NOW();

INSERT INTO audit_log (user_party_id, action, details)
VALUES
  (:'party_id',
   'kyc.event',
   '{"inquiryId":"inq_AVAuPERe6o1K15thgUHi2qe96r1t5X","eventName":"inquiry.approved","status":"approved","decision":"approved","backfilled":true,"reason":"persona-dashboard-url-was-wrong"}'::jsonb);

-- Sanity check before commit
SELECT inquiry_id, status, decision, completed_at, updated_at
FROM kyc_inquiries
WHERE inquiry_id = :'inquiry_id';

COMMIT;
