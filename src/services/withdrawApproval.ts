/**
 * Approval-lookup against exchange-backend.
 *
 * The contract — to be implemented by the exchange-backend team:
 *
 *   GET  be/internal/withdraw/approvals/:approvalId
 *   Auth: X-Internal-Key: <shared secret>
 *
 *   Response (200):
 *     { partyId, amount, nonce, expiry, status: 'approved' }
 *   Response (404 / 410):
 *     { status: 'not_found' | 'expired' | 'already_finalized' }
 *
 * Once that endpoint ships, replace the body of `lookupWithdrawApproval`
 * with the real fetch. Until then, we trust the client-supplied hint and
 * just shape it into the canonical response — the per-user-type auth at
 * /cb/withdraw (Loop signature OR Keycloak JWT) is what stops a malicious
 * caller from claiming someone else's approval.
 */

export interface WithdrawApproval {
  partyId: string;        // canonical Canton party id (hint::fingerprint)
  amount: string;         // decimal string
  nonce: string;
  expiry: number;         // unix ms
  status: 'approved' | 'expired' | 'finalized' | 'not_found';
}

export interface WithdrawApprovalHint {
  partyId: string;
  amount: string;
  nonce: string;
  expiry: number;
}

/**
 * Look up an approval by id.
 *
 * STUB: returns the caller-supplied hint verbatim. Replace with the real
 * server-to-server call when exchange-backend exposes the endpoint.
 */
export async function lookupWithdrawApproval(
  _approvalId: string,
  hint: WithdrawApprovalHint,
): Promise<WithdrawApproval> {
  // TODO(exchange-dev): replace with:
  //   const res = await fetch(`${BE}/internal/withdraw/approvals/${approvalId}`, {
  //     headers: { 'X-Internal-Key': process.env.EXCHANGE_INTERNAL_API_KEY ?? '' },
  //   });
  //   if (res.status === 404) return { ...hint, status: 'not_found' };
  //   if (res.status === 410) return { ...hint, status: 'expired' };
  //   if (!res.ok)            throw new Error(`approval lookup failed: ${res.status}`);
  //   return (await res.json()) as WithdrawApproval;
  return { ...hint, status: 'approved' };
}
