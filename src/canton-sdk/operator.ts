/**
 * Operator Identity Resolution
 *
 * Resolves the operator's Canton user ID using the admin token.
 * The admin token (client_credentials grant) has permission to list users.
 * The operator token (password grant) does NOT — it can only act as operator,
 * not query user management APIs.
 */

import type { CantonSdkConfig } from './config.js';
import { getAdminToken } from './tokens.js';

let cachedOperatorCantonId: string | null = null;
let cachedCircleCantonId: string | null = null;

/**
 * Resolve the operator's Canton user ID by looking up users with the admin token.
 * Result is cached — only one API call per process lifetime.
 */
export async function resolveOperatorCantonId(config: CantonSdkConfig): Promise<string> {
  if (cachedOperatorCantonId) return cachedOperatorCantonId;

  // Use admin token (client_credentials) — has permission to list users
  const adminToken = await getAdminToken(config);

  const allUsers: Array<{ id: string; primaryParty: string }> = [];
  let pageToken: string | undefined;

  while (true) {
    const params = new URLSearchParams({ pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${config.cantonLedgerApi}/v2/users?${params}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    if (!res.ok) throw new Error(`List users failed (${res.status}): ${await res.text()}`);

    const data = await res.json() as {
      users: Array<{ id: string; primaryParty: string }>;
      nextPageToken?: string;
    };

    allUsers.push(...data.users);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  const opUser = allUsers.find((u) => u.primaryParty === config.parties.operator);
  if (!opUser) {
    throw new Error(`Operator Canton user not found. No user with primaryParty=${config.parties.operator}`);
  }

  cachedOperatorCantonId = opUser.id;
  console.log(`Resolved operator Canton user ID: ${cachedOperatorCantonId}`);
  return cachedOperatorCantonId;
}

/**
 * Resolve the circle (token issuer) Canton user ID.
 * Result is cached — only one API call per process lifetime.
 */
export async function resolveCircleCantonId(config: CantonSdkConfig): Promise<string> {
  if (cachedCircleCantonId) return cachedCircleCantonId;

  const adminToken = await getAdminToken(config);

  const allUsers: Array<{ id: string; primaryParty: string }> = [];
  let pageToken: string | undefined;

  while (true) {
    const params = new URLSearchParams({ pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${config.cantonLedgerApi}/v2/users?${params}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    if (!res.ok) throw new Error(`List users failed (${res.status}): ${await res.text()}`);

    const data = await res.json() as {
      users: Array<{ id: string; primaryParty: string }>;
      nextPageToken?: string;
    };

    allUsers.push(...data.users);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  const circleUser = allUsers.find((u) => u.primaryParty === config.parties.tokenIssuer);
  if (!circleUser) {
    throw new Error(`Circle Canton user not found. No user with primaryParty=${config.parties.tokenIssuer}`);
  }

  cachedCircleCantonId = circleUser.id;
  console.log(`Resolved circle Canton user ID: ${cachedCircleCantonId}`);
  return cachedCircleCantonId;
}
