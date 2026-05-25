#!/usr/bin/env bash
#
# Deploy canton-backend-lambda to AWS Lambda.
#
# Usage:
#   ./scripts/deploy.sh                  # deploy to default function
#   ./scripts/deploy.sh my-function      # deploy to a specific function name
#
# Prerequisites:
#   - AWS CLI configured (aws configure)
#   - Lambda function already created in AWS console
#
set -euo pipefail

FUNCTION_NAME="${1:-canton-backend-lambda}"
REGION="${AWS_REGION:-ap-southeast-5}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.lambda-build"
ZIP_FILE="$ROOT_DIR/lambda.zip"

echo "==> Building TypeScript..."
cd "$ROOT_DIR"
npx tsc

echo "==> Preparing Lambda package..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Copy compiled JS + source maps
cp -r dist/* "$BUILD_DIR/"

# Copy package files and install production deps (no .env — pushed as Lambda env vars)
cp package.json package-lock.json "$BUILD_DIR/"
cd "$BUILD_DIR"
npm ci --omit=dev --quiet

echo "==> Creating zip..."
cd "$BUILD_DIR"
rm -f "$ZIP_FILE"
zip -r -q "$ZIP_FILE" .

ZIP_SIZE=$(du -h "$ZIP_FILE" | cut -f1)
echo "    Package size: $ZIP_SIZE"

echo "==> Deploying to Lambda: $FUNCTION_NAME ($REGION)..."
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$ZIP_FILE" \
  --region "$REGION" \
  --no-cli-pager

echo "==> Waiting for update to complete..."
aws lambda wait function-updated \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION"

echo "==> Updating environment variables..."
# Source-of-truth for the env vars pushed to Lambda:
#   1. If `.env.lambda` exists in the repo root, use it. This is the
#      escape hatch for values that differ between local dev and the
#      deployed function (most commonly DATABASE_URL — `.env` points at
#      a local postgres, `.env.lambda` at RDS).
#   2. Otherwise fall back to plain `.env`.
#
# Either file is read line-by-line; `# comments` and blank lines are
# skipped and AWS reserved keys are excluded. The Lambda configuration
# is updated via --cli-input-json so we get a clean atomic swap of the
# Environment.Variables map.
if [ -f "$ROOT_DIR/.env.lambda" ]; then
  ENV_FILE="$ROOT_DIR/.env.lambda"
  echo "    using .env.lambda (overrides .env for the deployed function)"
else
  ENV_FILE="$ROOT_DIR/.env"
  echo "    using .env (no .env.lambda found)"
fi

ENV_JSON="$ROOT_DIR/.lambda-env.json"
echo -n '{"FunctionName":"'"$FUNCTION_NAME"'","Environment":{"Variables":{' > "$ENV_JSON"
# Reserved AWS Lambda env vars — cannot be set
RESERVED="AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_LAMBDA_FUNCTION_NAME AWS_LAMBDA_FUNCTION_VERSION AWS_LAMBDA_LOG_GROUP_NAME AWS_LAMBDA_LOG_STREAM_NAME AWS_EXECUTION_ENV"

FIRST=true
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  # Skip AWS reserved keys
  echo "$RESERVED" | grep -qw "$key" && continue
  value="${value%\"}"
  value="${value#\"}"
  # Escape backslashes + double-quotes so we emit valid JSON
  esc_value="${value//\\/\\\\}"
  esc_value="${esc_value//\"/\\\"}"
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    echo -n ',' >> "$ENV_JSON"
  fi
  echo -n "\"$key\":\"$esc_value\"" >> "$ENV_JSON"
done < "$ENV_FILE"
echo -n '}},"Handler":"index.handler","Runtime":"nodejs20.x","Timeout":30,"MemorySize":256}' >> "$ENV_JSON"

aws lambda update-function-configuration \
  --region "$REGION" \
  --cli-input-json "file://$ENV_JSON" \
  --no-cli-pager > /dev/null

rm -f "$ENV_JSON"

echo "==> Cleanup..."
rm -rf "$BUILD_DIR" "$ZIP_FILE"

echo ""
echo "Deployed $FUNCTION_NAME successfully."
echo ""
echo "API Gateway setup (if not done):"
echo "  1. Create HTTP API in API Gateway"
echo "  2. Add route: ANY /{proxy+} → $FUNCTION_NAME"
echo "  3. Deploy to a stage"
