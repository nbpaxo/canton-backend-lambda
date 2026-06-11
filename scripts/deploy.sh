#!/usr/bin/env bash
#
# Deploy canton-backend-lambda to AWS Lambda.
#
# Usage:
#   ./scripts/deploy.sh                  # deploy CODE ONLY — env vars left untouched
#   ./scripts/deploy.sh --update-env     # also overwrite Lambda env from .env.lambda/.env
#
# By default the deployed function's Environment.Variables are LEFT AS-IS;
# only the code is updated. Pass --update-env (or -e) to push env vars from
# .env.lambda (preferred) or .env. This prevents an accidental deploy from
# clobbering env values set in the console.
#
# Prerequisites:
#   - AWS CLI configured (aws configure)
#   - Lambda function already created in AWS console
#
set -euo pipefail

FUNCTION_NAME="mainnet-canton-backend-lambda"
REGION="${AWS_REGION:-ap-southeast-5}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.lambda-build"
ZIP_FILE="$ROOT_DIR/lambda.zip"

# Env-var push is OFF by default; enable explicitly with --update-env / -e.
UPDATE_ENV=false
for arg in "$@"; do
  case "$arg" in
    --update-env|--env|-e) UPDATE_ENV=true ;;
  esac
done

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

if [ "$UPDATE_ENV" = true ]; then
echo "==> Updating environment variables..."
# Source-of-truth for the env vars pushed to Lambda:
#   1. If `.env.lambda` exists in the repo root, use it (overrides `.env`).
#   2. Otherwise fall back to plain `.env`.
#
# Read line-by-line; comments / blanks / AWS-reserved keys are skipped.
# DATABASE_URL is NEVER taken from a file — `.env` holds the local/tunnel URL,
# which would break the in-VPC function. Instead we read the function's CURRENT
# DATABASE_URL and re-inject it, so the atomic swap (--cli-input-json replaces
# the WHOLE Environment.Variables map) never changes or drops it.
if [ -f "$ROOT_DIR/.env.lambda" ]; then
  ENV_FILE="$ROOT_DIR/.env.lambda"
  echo "    using .env.lambda (overrides .env for the deployed function)"
else
  ENV_FILE="$ROOT_DIR/.env"
  echo "    using .env (no .env.lambda found)"
fi

# Read the function's existing DATABASE_URL so we can preserve it (never set
# it from a file). Empty if the function has none yet.
EXISTING_DB_URL="$(aws lambda get-function-configuration --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --query 'Environment.Variables.DATABASE_URL' --output text 2>/dev/null || true)"
[ "$EXISTING_DB_URL" = "None" ] && EXISTING_DB_URL=""

ENV_JSON="$ROOT_DIR/.lambda-env.json"
echo -n '{"FunctionName":"'"$FUNCTION_NAME"'","Environment":{"Variables":{' > "$ENV_JSON"
# Reserved AWS Lambda env vars — cannot be set
RESERVED="AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_LAMBDA_FUNCTION_NAME AWS_LAMBDA_FUNCTION_VERSION AWS_LAMBDA_LOG_GROUP_NAME AWS_LAMBDA_LOG_STREAM_NAME AWS_EXECUTION_ENV"

FIRST=true
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  # Skip AWS reserved keys
  echo "$RESERVED" | grep -qw "$key" && continue
  # NEVER push DATABASE_URL from a file — preserved from the function below.
  [ "$key" = "DATABASE_URL" ] && continue
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
# Re-inject the function's existing DATABASE_URL (the atomic swap would
# otherwise drop it, since it's not in the file map).
if [ -n "$EXISTING_DB_URL" ]; then
  esc_db="${EXISTING_DB_URL//\\/\\\\}"
  esc_db="${esc_db//\"/\\\"}"
  if [ "$FIRST" = true ]; then FIRST=false; else echo -n ',' >> "$ENV_JSON"; fi
  echo -n "\"DATABASE_URL\":\"$esc_db\"" >> "$ENV_JSON"
  echo "    preserved the function's existing DATABASE_URL (not from .env)"
else
  echo "    WARNING: function has no DATABASE_URL set — set it once in the console."
fi
echo -n '}},"Handler":"index.handler","Runtime":"nodejs20.x","Timeout":30,"MemorySize":256}' >> "$ENV_JSON"

aws lambda update-function-configuration \
  --region "$REGION" \
  --cli-input-json "file://$ENV_JSON" \
  --no-cli-pager > /dev/null

rm -f "$ENV_JSON"
else
  echo "==> Skipping environment variables (code-only deploy)."
  echo "    Pass --update-env to push .env.lambda/.env to the function."
fi

echo "==> Cleanup..."
rm -rf "$BUILD_DIR" "$ZIP_FILE"

echo ""
echo "Deployed $FUNCTION_NAME successfully."
echo ""
echo "API Gateway setup (if not done):"
echo "  1. Create HTTP API in API Gateway"
echo "  2. Add route: ANY /{proxy+} → $FUNCTION_NAME"
echo "  3. Deploy to a stage"
