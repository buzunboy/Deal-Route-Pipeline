#!/usr/bin/env bash
#
# Provision the DealRoute evidence S3 bucket + a least-privilege IAM user, and print
# the S3_* values to set as Fly secrets. Idempotent: safe to re-run (existing bucket /
# policy / user are detected and reused; a new access key is created only when asked).
#
# Prereqs: awscli v2, configured with credentials that can create S3 buckets + IAM
# users/policies (an admin/bootstrap principal — NOT the app user this creates).
#
# Usage:
#   deploy/aws/setup-evidence-s3.sh                 # create everything, no new key
#   CREATE_ACCESS_KEY=1 deploy/aws/setup-evidence-s3.sh   # also mint an access key (prints the secret ONCE)
#
# Override defaults via env:
#   BUCKET=dealroute-evidence-prod  REGION=eu-central-1  USER_NAME=dealroute-pipeline
#   POLICY_NAME=dealroute-evidence-rw
#
# The bucket-access POLICY DOCUMENT lives in deploy/aws/evidence-bucket-policy.json —
# if you change BUCKET, update the Resource ARN there too (this script reads it as-is).
set -euo pipefail

BUCKET="${BUCKET:-dealroute-evidence-prod}"
REGION="${REGION:-eu-central-1}"
USER_NAME="${USER_NAME:-dealroute-pipeline}"
POLICY_NAME="${POLICY_NAME:-dealroute-evidence-rw}"
CREATE_ACCESS_KEY="${CREATE_ACCESS_KEY:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_FILE="$SCRIPT_DIR/evidence-bucket-policy.json"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# Guard: the policy file's Resource ARN must match $BUCKET, or the user would be scoped
# to the wrong bucket. Fail loudly rather than provisioning a mismatched grant.
if ! grep -q "arn:aws:s3:::$BUCKET/\*" "$POLICY_FILE"; then
  echo "ERROR: $POLICY_FILE does not reference bucket '$BUCKET'." >&2
  echo "       Update its Resource ARN to arn:aws:s3:::$BUCKET/* (or set BUCKET to match)." >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
say "AWS account: $ACCOUNT_ID  |  bucket: $BUCKET ($REGION)  |  user: $USER_NAME"

# ── 1. Bucket ────────────────────────────────────────────────────────────────
say "Bucket"
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "  exists — reusing."
else
  # us-east-1 must NOT pass a LocationConstraint; every other region must.
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION"
  fi
  echo "  created."
fi

# ── 2. Block ALL public access (trust invariant: html/terms must never be public) ──
say "Block public access (all four flags ON)"
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
echo "  enforced."

# ── 3. IAM policy (least privilege: Put/Get/HeadObject on this bucket only) ─────
say "IAM policy: $POLICY_NAME"
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"
if aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  echo "  exists — reusing ($POLICY_ARN)."
else
  aws iam create-policy --policy-name "$POLICY_NAME" \
    --policy-document "file://$POLICY_FILE" \
    --description "DealRoute evidence bucket object read/write (Put/Get/HeadObject)" >/dev/null
  echo "  created ($POLICY_ARN)."
fi

# ── 4. IAM user + attach the policy ───────────────────────────────────────────
say "IAM user: $USER_NAME"
if aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  echo "  exists — reusing."
else
  aws iam create-user --user-name "$USER_NAME" \
    --tags Key=app,Value=dealroute Key=purpose,Value=evidence-store >/dev/null
  echo "  created."
fi
aws iam attach-user-policy --user-name "$USER_NAME" --policy-arn "$POLICY_ARN"
echo "  policy attached."

# ── 5. Access key (only when explicitly requested — the secret prints ONCE) ─────
if [ "$CREATE_ACCESS_KEY" = "1" ]; then
  say "Access key (the secret is shown ONCE — copy it now)"
  EXISTING="$(aws iam list-access-keys --user-name "$USER_NAME" \
    --query 'AccessKeyMetadata[].AccessKeyId' --output text)"
  if [ -n "$EXISTING" ]; then
    echo "  WARNING: this user already has access key(s): $EXISTING"
    echo "  AWS allows max 2 per user. Delete an old one first if needed:"
    echo "    aws iam delete-access-key --user-name $USER_NAME --access-key-id <id>"
  fi
  KEY_JSON="$(aws iam create-access-key --user-name "$USER_NAME" --output json)"
  AK="$(printf '%s' "$KEY_JSON" | grep -o '"AccessKeyId": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')"
  SK="$(printf '%s' "$KEY_JSON" | grep -o '"SecretAccessKey": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')"
  echo ""
  echo "  Set these as Fly secrets (or your secret manager):"
  echo "    S3_BUCKET=$BUCKET"
  echo "    S3_REGION=$REGION"
  echo "    S3_ACCESS_KEY_ID=$AK"
  echo "    S3_SECRET_ACCESS_KEY=$SK"
  echo ""
  echo "  Copy/paste:"
  echo "    fly secrets set -a dealroute-api \\"
  echo "      S3_BUCKET=$BUCKET S3_REGION=$REGION \\"
  echo "      S3_ACCESS_KEY_ID=$AK S3_SECRET_ACCESS_KEY=$SK"
else
  say "Done (no access key created)"
  echo "  Re-run with CREATE_ACCESS_KEY=1 to mint one:"
  echo "    CREATE_ACCESS_KEY=1 $0"
  echo "  S3_BUCKET=$BUCKET  S3_REGION=$REGION  (keys come from the access-key step)"
fi
