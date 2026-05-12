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

echo "==> Updating environment variables from .env..."
# Build JSON file for --cli-input-json
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
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    echo -n ',' >> "$ENV_JSON"
  fi
  echo -n "\"$key\":\"$value\"" >> "$ENV_JSON"
done < "$ROOT_DIR/.env"
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
