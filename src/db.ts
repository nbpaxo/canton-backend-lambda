/**
 * DynamoDB client for invite codes.
 *
 * Table: canton-invite-codes
 * PK: code (String)
 *
 * Schema:
 *   code: string          — the invite code
 *   redeemed: boolean     — whether it's been used
 *   redeemedAt?: string   — ISO timestamp
 *   redeemedBy?: object   — { username, fullName, email, phone, countryCode, partyId }
 *   createdAt: string     — ISO timestamp
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { AWS_REGION, INVITE_TABLE } from './config.js';

const ddbClient = new DynamoDBClient({ region: AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

export interface RedeemedByInfo {
  username: string;
}

export interface InviteCode {
  code: string;
  redeemed: boolean;
  redeemedAt?: string;
  redeemedBy?: RedeemedByInfo;
  createdAt: string;
}

/**
 * Get an invite code record.
 */
export async function getInviteCode(code: string): Promise<InviteCode | null> {
  const result = await docClient.send(new GetCommand({
    TableName: INVITE_TABLE,
    Key: { code },
  }));
  return (result.Item as InviteCode) ?? null;
}

/**
 * Create a new invite code (unused).
 */
export async function createInviteCode(code: string): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: INVITE_TABLE,
    Item: {
      code,
      redeemed: false,
      createdAt: new Date().toISOString(),
    },
    ConditionExpression: 'attribute_not_exists(code)',
  }));
}

/**
 * Redeem an invite code. Fails if already redeemed or doesn't exist.
 * Uses a conditional update for atomicity.
 */
export async function redeemInviteCode(
  code: string,
  userInfo: RedeemedByInfo,
): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: INVITE_TABLE,
    Key: { code },
    UpdateExpression: 'SET redeemed = :t, redeemedAt = :now, redeemedBy = :info',
    ConditionExpression: 'attribute_exists(code) AND redeemed = :f',
    ExpressionAttributeValues: {
      ':t': true,
      ':f': false,
      ':now': new Date().toISOString(),
      ':info': userInfo,
    },
  }));
}

/**
 * List all invite codes (admin).
 */
export async function listInviteCodes(): Promise<InviteCode[]> {
  const result = await docClient.send(new ScanCommand({
    TableName: INVITE_TABLE,
  }));
  return (result.Items as InviteCode[]) ?? [];
}
