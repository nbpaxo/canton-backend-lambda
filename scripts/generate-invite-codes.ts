/**
 * Generate 50 single-use invite codes and store them in DynamoDB.
 *
 * Usage:
 *   npx tsx scripts/generate-invite-codes.ts
 *   npx tsx scripts/generate-invite-codes.ts 100    # custom count
 */

import crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION || 'ap-southeast-5';
const TABLE = process.env.INVITE_TABLE || 'canton-invite-codes';
const COUNT = parseInt(process.argv[2] || '50', 10);

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

/**
 * Generate a readable invite code: MPERP-XXXXX-XXXXX
 */
function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  const part = () =>
    Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `MPERP-${part()}-${part()}`;
}

async function main() {
  console.log(`Generating ${COUNT} invite codes in ${TABLE} (${REGION})...\n`);

  const codes: string[] = [];

  for (let i = 0; i < COUNT; i++) {
    const code = generateCode();
    try {
      await docClient.send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            code,
            redeemed: false,
            createdAt: new Date().toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(code)', // no duplicates
        }),
      );
      codes.push(code);
      process.stdout.write(`  ${i + 1}. ${code}\n`);
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') {
        // Extremely unlikely collision — retry
        i--;
        continue;
      }
      throw err;
    }
  }

  console.log(`\nDone. ${codes.length} invite codes created.\n`);

  // Print as CSV for easy copy
  console.log('--- CSV ---');
  console.log('code');
  codes.forEach((c) => console.log(c));
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
