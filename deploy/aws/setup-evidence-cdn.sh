#!/usr/bin/env bash
#
# Provision the PUBLIC, SCREENSHOT-ONLY CloudFront CDN in front of the DealRoute
# evidence bucket, and print the `S3_CDN_BASE_URL` value to set as a Fly secret.
#
# This is the deployment half of the trust gate documented in ARCHITECTURE.md
# ("Public read surface") and the KNOWN_ISSUES "Public CDN must expose ONLY
# screenshot.png" finding. An evidence bundle stores screenshot.png + page.html +
# terms.txt + evidence.json under ONE `<id>/` prefix; only the screenshot may be
# public. This script builds:
#
#   1. a CloudFront Function (viewer-request) from cloudfront-screenshot-only.js that
#      403s any path NOT ending in /screenshot.png — the load-bearing lock;
#   2. an Origin Access Control (OAC) so ONLY CloudFront can read the bucket (the
#      bucket itself stays fully public-access-blocked — set by setup-evidence-s3.sh);
#   3. a CloudFront distribution: S3 origin + OAC + the function on viewer-request;
#   4. a bucket policy (deploy/aws/evidence-cdn-bucket-policy.json) granting read to
#      exactly this distribution's OAC and nothing else.
#
# The bucket is NEVER unblocked — CloudFront is the single public door, the function
# is the lock, and the OAC + scoped bucket policy keep S3 reachable ONLY through it.
#
# SAFE-BY-DEFAULT: until you run this AND set S3_CDN_BASE_URL on the app, the public
# feed exposes NO evidence URL (evidence_screenshot_url: null); the admin panel reads
# evidence via the authenticated path regardless. Leaving S3_CDN_BASE_URL unset is a
# fully-supported production posture.
#
# Idempotent: re-running detects + reuses an existing function / OAC / distribution
# (matched by name/comment) and re-applies the bucket policy. It does NOT delete or
# unblock anything.
#
# Prereqs:
#   - awscli v2 + jq, configured with an ADMIN/bootstrap profile (CloudFront +
#     S3 PutBucketPolicy permissions). NOT the least-privilege app IAM user.
#   - The evidence bucket must already exist and be public-access-blocked
#     (run deploy/aws/setup-evidence-s3.sh first).
#
# Usage:
#   deploy/aws/setup-evidence-cdn.sh
#   BUCKET=dealroute-evidence-prod REGION=eu-central-1 deploy/aws/setup-evidence-cdn.sh
#
# After it prints the CloudFront domain, set the Fly secret it shows, then run the
# acceptance test in deploy/fly/README.md §2.4 (curl the CDN: screenshot.png → 200,
# terms.txt / page.html → 403) BEFORE relying on public screenshots.
set -euo pipefail

BUCKET="${BUCKET:-dealroute-evidence-prod}"
REGION="${REGION:-eu-central-1}"
FUNCTION_NAME="${FUNCTION_NAME:-dealroute-evidence-screenshot-only}"
OAC_NAME="${OAC_NAME:-dealroute-evidence-oac}"
# The distribution is matched/created by this Comment (CloudFront has no name field).
DIST_COMMENT="${DIST_COMMENT:-dealroute-evidence-cdn (screenshot-only public read)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNCTION_FILE="$SCRIPT_DIR/cloudfront-screenshot-only.js"
POLICY_TEMPLATE="$SCRIPT_DIR/evidence-cdn-bucket-policy.json"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    %s\033[0m\n' "$1"; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

# ── 0. Tooling + input files ──────────────────────────────────────────────────
command -v aws >/dev/null 2>&1 || die "awscli v2 not found."
command -v jq  >/dev/null 2>&1 || die "jq not found (brew install jq) — required for CloudFront JSON."
[ -f "$FUNCTION_FILE" ]   || die "missing $FUNCTION_FILE (the screenshot-only edge function)."
[ -f "$POLICY_TEMPLATE" ] || die "missing $POLICY_TEMPLATE (the OAC bucket-policy template)."

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
say "AWS account: $ACCOUNT_ID  |  bucket: $BUCKET ($REGION)  |  function: $FUNCTION_NAME"

# ── 1. Precondition: the bucket exists AND is fully public-access-blocked ──────
# CloudFront+OAC is the ONLY thing that should read this bucket. If the bucket were
# public, the screenshot-only gate would be bypassable by hitting S3 directly — so we
# refuse to wire a CDN onto a bucket that isn't locked down. setup-evidence-s3.sh sets
# this; we re-assert it here so this script is safe to run standalone.
say "Precondition: bucket public-access fully blocked"
aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null \
  || die "bucket '$BUCKET' not found — run deploy/aws/setup-evidence-s3.sh first."
PAB="$(aws s3api get-public-access-block --bucket "$BUCKET" \
  --query 'PublicAccessBlockConfiguration' --output json 2>/dev/null || echo '{}')"
ALL_BLOCKED="$(printf '%s' "$PAB" | jq -r '
  (.BlockPublicAcls and .IgnorePublicAcls and .BlockPublicPolicy and .RestrictPublicBuckets) // false')"
if [ "$ALL_BLOCKED" != "true" ]; then
  die "bucket '$BUCKET' is NOT fully public-access-blocked. Refusing to front a public bucket with a CDN.
       Run: aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration \\
            BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
       (or re-run deploy/aws/setup-evidence-s3.sh), then re-run this script."
fi
echo "  blocked — good. CloudFront/OAC will be the only reader."

# ── 2. CloudFront Function (the screenshot-only gate), published to LIVE ───────
say "CloudFront Function: $FUNCTION_NAME"
FUNCTION_ARN=""
if aws cloudfront describe-function --name "$FUNCTION_NAME" >/dev/null 2>&1; then
  echo "  exists — updating code to match $FUNCTION_FILE."
  ETAG="$(aws cloudfront describe-function --name "$FUNCTION_NAME" --query 'ETag' --output text)"
  aws cloudfront update-function --name "$FUNCTION_NAME" \
    --if-match "$ETAG" \
    --function-config Comment="DealRoute evidence screenshot-only gate",Runtime="cloudfront-js-2.0" \
    --function-code "fileb://$FUNCTION_FILE" >/dev/null
else
  echo "  creating."
  aws cloudfront create-function --name "$FUNCTION_NAME" \
    --function-config Comment="DealRoute evidence screenshot-only gate",Runtime="cloudfront-js-2.0" \
    --function-code "fileb://$FUNCTION_FILE" >/dev/null
fi
# Publish the DEVELOPMENT version to LIVE so the distribution can associate it.
PUB_ETAG="$(aws cloudfront describe-function --name "$FUNCTION_NAME" --query 'ETag' --output text)"
aws cloudfront publish-function --name "$FUNCTION_NAME" --if-match "$PUB_ETAG" >/dev/null
FUNCTION_ARN="$(aws cloudfront describe-function --name "$FUNCTION_NAME" \
  --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)"
echo "  published LIVE: $FUNCTION_ARN"

# ── 3. Origin Access Control (so only CloudFront can read the bucket) ──────────
say "Origin Access Control: $OAC_NAME"
OAC_ID="$(aws cloudfront list-origin-access-controls \
  --query "OriginAccessControlList.Items[?Name=='$OAC_NAME'].Id | [0]" --output text 2>/dev/null || echo 'None')"
if [ "$OAC_ID" = "None" ] || [ -z "$OAC_ID" ]; then
  OAC_ID="$(aws cloudfront create-origin-access-control \
    --origin-access-control-config \
      Name="$OAC_NAME",SigningProtocol="sigv4",SigningBehavior="always",OriginAccessControlOriginType="s3",Description="DealRoute evidence OAC" \
    --query 'OriginAccessControl.Id' --output text)"
  echo "  created: $OAC_ID"
else
  echo "  exists — reusing: $OAC_ID"
fi

# ── 4. CloudFront distribution (S3 origin + OAC + the function) ────────────────
# The S3 REST origin domain (not the website endpoint) — required for OAC.
ORIGIN_DOMAIN="${BUCKET}.s3.${REGION}.amazonaws.com"
ORIGIN_ID="s3-evidence"
say "CloudFront distribution (origin $ORIGIN_DOMAIN)"

DIST_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='$DIST_COMMENT'].Id | [0]" --output text 2>/dev/null || echo 'None')"

if [ "$DIST_ID" != "None" ] && [ -n "$DIST_ID" ]; then
  echo "  exists — reusing: $DIST_ID (config left as-is; delete it to recreate)."
else
  echo "  creating (this can take a few minutes to deploy globally)."
  # CachingOptimized is an AWS-managed cache policy with a stable, well-known id.
  CACHE_POLICY_ID="658327ea-f89d-4fab-a63d-7e88639e58f6"
  DIST_CONFIG="$(jq -n \
    --arg comment "$DIST_COMMENT" \
    --arg originDomain "$ORIGIN_DOMAIN" \
    --arg originId "$ORIGIN_ID" \
    --arg oacId "$OAC_ID" \
    --arg fnArn "$FUNCTION_ARN" \
    --arg cachePolicyId "$CACHE_POLICY_ID" \
    '{
      CallerReference: ("dealroute-evidence-cdn-" + $originDomain),
      Comment: $comment,
      Enabled: true,
      DefaultRootObject: "",
      Origins: {
        Quantity: 1,
        Items: [{
          Id: $originId,
          DomainName: $originDomain,
          OriginAccessControlId: $oacId,
          S3OriginConfig: { OriginAccessIdentity: "" },
          OriginShield: { Enabled: false },
          CustomHeaders: { Quantity: 0 },
          ConnectionAttempts: 3,
          ConnectionTimeout: 10
        }]
      },
      DefaultCacheBehavior: {
        TargetOriginId: $originId,
        ViewerProtocolPolicy: "redirect-to-https",
        Compress: true,
        CachePolicyId: $cachePolicyId,
        AllowedMethods: {
          Quantity: 2,
          Items: ["GET", "HEAD"],
          CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] }
        },
        FunctionAssociations: {
          Quantity: 1,
          Items: [{ EventType: "viewer-request", FunctionARN: $fnArn }]
        },
        LambdaFunctionAssociations: { Quantity: 0 },
        FieldLevelEncryptionId: ""
      },
      PriceClass: "PriceClass_100",
      HttpVersion: "http2and3",
      IsIPV6Enabled: true,
      Restrictions: { GeoRestriction: { RestrictionType: "none", Quantity: 0 } },
      ViewerCertificate: { CloudFrontDefaultCertificate: true }
    }')"
  DIST_ID="$(aws cloudfront create-distribution \
    --distribution-config "$DIST_CONFIG" \
    --query 'Distribution.Id' --output text)"
  echo "  created: $DIST_ID"
fi

DIST_DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" \
  --query 'Distribution.DomainName' --output text)"
echo "  domain: $DIST_DOMAIN"

# ── 5. Bucket policy: grant read ONLY to this distribution's OAC ──────────────
say "Bucket policy (OAC read for distribution $DIST_ID only)"
POLICY_JSON="$(jq \
  --arg bucket "$BUCKET" \
  --arg account "$ACCOUNT_ID" \
  --arg dist "$DIST_ID" \
  'del(.__comment)
   | .Statement[0].Resource = ("arn:aws:s3:::" + $bucket + "/*")
   | .Statement[0].Condition."StringEquals"."AWS:SourceArn"
       = ("arn:aws:cloudfront::" + $account + ":distribution/" + $dist)' \
  "$POLICY_TEMPLATE")"
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$POLICY_JSON"
echo "  applied — only CloudFront distribution $DIST_ID can read the bucket."

# ── 6. Output: the Fly secret + the acceptance test ───────────────────────────
say "Done — set the CDN base URL as a Fly secret"
echo "  CloudFront domain: https://$DIST_DOMAIN"
echo ""
echo "  Copy/paste:"
echo "    fly secrets set -a dealroute-api S3_CDN_BASE_URL=https://$DIST_DOMAIN"
echo ""
warn "Distribution status may be 'InProgress' for a few minutes before the domain serves."
warn "BEFORE relying on it, run the SCOPING acceptance test (a real bundle id is needed):"
echo "    curl -sI https://$DIST_DOMAIN/<id>/screenshot.png   # MUST be 200"
echo "    curl -sI https://$DIST_DOMAIN/<id>/terms.txt        # MUST be 403"
echo "    curl -sI https://$DIST_DOMAIN/<id>/page.html        # MUST be 403"
echo "  If terms.txt is reachable, UNSET S3_CDN_BASE_URL and stop — see deploy/fly/README.md §2.4."
