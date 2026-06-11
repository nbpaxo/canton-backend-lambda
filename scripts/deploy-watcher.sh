#!/usr/bin/env bash
#
# Deploy the deposit watcher to the mainnet validator EC2 — CODE ONLY.
#
# Transport is AWS Session Manager (SSM Run Command) + an S3 presigned URL;
# no SSH and no public IP needed. The box's .env is NEVER shipped or touched,
# so any env values set directly on the box are preserved across deploys.
#
# Flow:
#   build (tsc) -> tar dist + package files (NO .env) -> S3 presigned URL ->
#   SSM on the box:  pm2 stop  ->  swap code  ->  npm ci  ->  pm2 (re)start
#                    ->  pm2 save  ->  tail logs
#
# Usage:
#   ./scripts/deploy-watcher.sh
#
# Overridable via env:
#   AWS_REGION           (default ap-southeast-5)
#   WATCHER_INSTANCE_ID  (default i-000a05bae176ec6cb)  — the validator EC2
#   DEPLOY_BUCKET        (default mperps-deploy-698174268763)
#
set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-5}"
INSTANCE_ID="${WATCHER_INSTANCE_ID:-i-000a05bae176ec6cb}"
BUCKET="${DEPLOY_BUCKET:-mperps-deploy-698174268763}"
APP_DIR="/opt/canton-backend-lambda"
PM2_NAME="canton-watcher"
S3_KEY="canton-backend-lambda/watcher-$(date +%s).tgz"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Building (tsc)..."
npx tsc

echo "==> Packaging dist + package files (NO .env)..."
STAGE="$(mktemp -d)"
cp -r dist "$STAGE/"
cp package.json package-lock.json "$STAGE/"
TARBALL="$ROOT_DIR/.watcher-deploy.tgz"
# COPYFILE_DISABLE avoids macOS ._ AppleDouble files in the archive.
COPYFILE_DISABLE=1 tar -czf "$TARBALL" -C "$STAGE" .
rm -rf "$STAGE"

echo "==> Uploading to s3://$BUCKET/$S3_KEY ..."
aws s3 cp "$TARBALL" "s3://$BUCKET/$S3_KEY" --region "$REGION" >/dev/null
rm -f "$TARBALL"
URL="$(aws s3 presign "s3://$BUCKET/$S3_KEY" --region "$REGION" --expires-in 1800)"

echo "==> Building SSM command (pm2 stop -> swap code -> npm ci -> pm2 start)..."
PARAMS="$(mktemp)"
python3 - "$URL" "$APP_DIR" "$PM2_NAME" > "$PARAMS" <<'PY'
import json, sys
url, app_dir, pm2 = sys.argv[1], sys.argv[2], sys.argv[3]
cmds = [
  "set -e",
  f"mkdir -p {app_dir}",
  f'curl -fsSL "{url}" -o /tmp/watcher.tgz',
  "echo '==> pm2 stop (before code swap)'",
  f"pm2 stop {pm2} 2>/dev/null || true",
  "echo '==> replacing code (dist) — .env left untouched'",
  f"rm -rf {app_dir}/dist",
  f"tar -xzf /tmp/watcher.tgz -C {app_dir}",
  f"cd {app_dir} && npm ci --omit=dev > /tmp/npmci.log 2>&1 || {{ echo NPM_CI_FAILED; tail -30 /tmp/npmci.log; exit 1; }}",
  "echo '==> starting watcher'",
  f"cd {app_dir} && (pm2 restart {pm2} --update-env 2>/dev/null || pm2 start dist/workers/depositWatcher.js --name {pm2} --cwd {app_dir} --time --max-memory-restart 400M)",
  "pm2 save >/dev/null 2>&1 || true",
  "rm -f /tmp/watcher.tgz",
  "sleep 6",
  "echo '===== PM2 ====='",
  "pm2 ls",
  "echo '===== LOGS ====='",
  f"pm2 logs {pm2} --lines 40 --nostream 2>&1 | tail -45",
]
json.dump({"commands": cmds}, sys.stdout)
PY

CMD="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --timeout-seconds 600 \
  --parameters "file://$PARAMS" --query 'Command.CommandId' --output text)"
rm -f "$PARAMS"
echo "    CommandId: $CMD"

echo "==> Waiting for deploy to finish..."
for _ in $(seq 1 40); do
  ST="$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" \
        --instance-id "$INSTANCE_ID" --query 'Status' --output text 2>/dev/null || echo Pending)"
  case "$ST" in
    Success) break ;;
    Failed|Cancelled|TimedOut) echo "    deploy status: $ST"; break ;;
  esac
  sleep 6
done

echo ""
echo "================ REMOTE OUTPUT ================"
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" \
  --instance-id "$INSTANCE_ID" --query 'StandardOutputContent' --output text
ERR="$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" \
  --instance-id "$INSTANCE_ID" --query 'StandardErrorContent' --output text 2>/dev/null || true)"
# Drop the harmless macOS-xattr tar warnings from the displayed stderr.
ERR_FILTERED="$(printf '%s\n' "$ERR" | grep -v 'com.apple.provenance' || true)"
[ -n "${ERR_FILTERED//[$' \t\n']/}" ] && { echo "---------------- STDERR ----------------"; printf '%s\n' "$ERR_FILTERED"; }

echo "==> Cleaning up S3 artifact..."
aws s3 rm "s3://$BUCKET/$S3_KEY" --region "$REGION" >/dev/null 2>&1 || true

FINAL="$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" \
  --instance-id "$INSTANCE_ID" --query 'Status' --output text 2>/dev/null || echo Unknown)"
echo ""
echo "==> Watcher deploy: $FINAL"
[ "$FINAL" = "Success" ] || exit 1
