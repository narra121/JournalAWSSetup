#!/usr/bin/env bash
#
# GCP Bootstrap Script for TradeQut
#
# One-time setup per GCP project. Creates the resources that enable
# GitHub Actions CI/CD to manage GCP infrastructure via Terraform.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - gh CLI installed and authenticated (gh auth login)
#   - Active GCP project with billing enabled
#
# Usage:
#   ./scripts/gcp-bootstrap.sh <GCP_PROJECT_ID> <GITHUB_ORG/BACKEND_REPO> <GITHUB_ORG/FRONTEND_REPO>
#
# Example:
#   ./scripts/gcp-bootstrap.sh gen-lang-client-0672520490 narra121/JournalAWSSetup narra121/TradeFlow
#
# What this script creates:
#   1. Enables GCP APIs (Vertex AI, IAM, STS, Resource Manager)
#   2. Creates GCS bucket for Terraform state
#   3. Creates CI/CD service account
#   4. Grants IAM roles to the service account
#   5. Creates GitHub Actions WIF pool + OIDC provider
#   6. Binds service account to GitHub WIF provider
#   7. Sets GitHub Secrets in both repos
#
# After running this script:
#   - Push to main on JournalAWSSetup → SAM deploy + Terraform apply (creates Cognito WIF)
#   - Push to main on TradeFlow → Frontend build with GCP env vars
#   - Manually add Google OAuth redirect URIs in GCP Console (one-time)
#

set -euo pipefail

# ── Argument validation ──────────────────────────────────────────────

if [ $# -lt 3 ]; then
  echo "Usage: $0 <GCP_PROJECT_ID> <GITHUB_ORG/BACKEND_REPO> <GITHUB_ORG/FRONTEND_REPO>"
  echo ""
  echo "Example:"
  echo "  $0 gen-lang-client-0672520490 narra121/JournalAWSSetup narra121/TradeFlow"
  exit 1
fi

GCP_PROJECT_ID="$1"
BACKEND_REPO="$2"
FRONTEND_REPO="$3"
GITHUB_ORG="${BACKEND_REPO%%/*}"

# ── Configuration ────────────────────────────────────────────────────

REGION="us-central1"
STATE_BUCKET="tradequt-terraform-state"
SA_NAME="tradequt-cicd"
SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
WIF_POOL_ID="github-actions-pool"
WIF_PROVIDER_ID="github-provider"

# ── Detect gcloud path (Linux/Mac vs Windows) ───────────────────────

if command -v gcloud &>/dev/null; then
  GCLOUD="gcloud"
  GSUTIL="gsutil"
elif [ -f "/c/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd" ]; then
  # Windows with Git Bash — gcloud.cmd needs PowerShell wrapper
  gcloud_win() {
    powershell.exe -Command "& 'C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd' $*"
  }
  gsutil_win() {
    powershell.exe -Command "& 'C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gsutil.cmd' $*"
  }
  GCLOUD="gcloud_win"
  GSUTIL="gsutil_win"
else
  echo "ERROR: gcloud CLI not found. Install from https://cloud.google.com/sdk/docs/install"
  exit 1
fi

echo ""
echo "============================================="
echo "  GCP Bootstrap for TradeQut"
echo "============================================="
echo ""
echo "  Project:        ${GCP_PROJECT_ID}"
echo "  Backend Repo:   ${BACKEND_REPO}"
echo "  Frontend Repo:  ${FRONTEND_REPO}"
echo "  GitHub Org:     ${GITHUB_ORG}"
echo "  Region:         ${REGION}"
echo ""

# ── Step 1: Set active project ───────────────────────────────────────

echo "[1/8] Setting active GCP project..."
$GCLOUD config set project "${GCP_PROJECT_ID}" 2>&1 | grep -v "^WARNING" || true
echo "  ✓ Project set to ${GCP_PROJECT_ID}"

# ── Step 2: Enable required APIs ─────────────────────────────────────

echo ""
echo "[2/8] Enabling required APIs..."
$GCLOUD services enable \
  aiplatform.googleapis.com \
  iam.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  iamcredentials.googleapis.com 2>&1
echo "  ✓ APIs enabled (Vertex AI, IAM, STS, Resource Manager, IAM Credentials)"

# ── Step 3: Create GCS bucket for Terraform state ────────────────────

echo ""
echo "[3/8] Creating GCS bucket for Terraform state..."
if $GSUTIL ls -b "gs://${STATE_BUCKET}" &>/dev/null; then
  echo "  ✓ Bucket gs://${STATE_BUCKET} already exists, skipping."
else
  $GSUTIL mb -p "${GCP_PROJECT_ID}" -l "${REGION}" "gs://${STATE_BUCKET}" 2>&1
  $GSUTIL versioning set on "gs://${STATE_BUCKET}" 2>&1
  echo "  ✓ Bucket gs://${STATE_BUCKET} created with versioning."
fi

# ── Step 4: Create service account ───────────────────────────────────

echo ""
echo "[4/8] Creating CI/CD service account..."
if $GCLOUD iam service-accounts describe "${SA_EMAIL}" &>/dev/null 2>&1; then
  echo "  ✓ Service account ${SA_NAME} already exists, skipping."
else
  $GCLOUD iam service-accounts create "${SA_NAME}" \
    --display-name="TradeQut CI/CD Service Account" \
    --description="Used by GitHub Actions to manage GCP infrastructure via Terraform" 2>&1
  echo "  ✓ Service account ${SA_EMAIL} created."
fi

# ── Step 5: Grant IAM roles to service account ───────────────────────

echo ""
echo "[5/8] Granting IAM roles to service account..."

ROLES=(
  "roles/iam.workloadIdentityPoolAdmin"
  "roles/iam.serviceAccountAdmin"
  "roles/aiplatform.admin"
  "roles/storage.objectAdmin"
)

for ROLE in "${ROLES[@]}"; do
  $GCLOUD projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet 2>&1 | tail -1
  echo "  ✓ Granted ${ROLE}"
done

# ── Step 6: Create GitHub OIDC WIF pool + provider ──────────────────

echo ""
echo "[6/8] Creating Workload Identity Federation pool + OIDC provider..."

GCP_PROJECT_NUMBER=$($GCLOUD projects describe "${GCP_PROJECT_ID}" --format="value(projectNumber)" 2>&1)
echo "  Project number: ${GCP_PROJECT_NUMBER}"

# Create pool
if $GCLOUD iam workload-identity-pools describe "${WIF_POOL_ID}" \
  --location="global" &>/dev/null 2>&1; then
  echo "  ✓ WIF pool '${WIF_POOL_ID}' already exists, skipping."
else
  $GCLOUD iam workload-identity-pools create "${WIF_POOL_ID}" \
    --location="global" \
    --display-name="GitHub Actions Pool" \
    --description="WIF pool for GitHub Actions OIDC authentication" 2>&1
  echo "  ✓ WIF pool '${WIF_POOL_ID}' created."
fi

# Create OIDC provider
if $GCLOUD iam workload-identity-pools providers describe "${WIF_PROVIDER_ID}" \
  --location="global" \
  --workload-identity-pool="${WIF_POOL_ID}" &>/dev/null 2>&1; then
  echo "  ✓ WIF provider '${WIF_PROVIDER_ID}' already exists, skipping."
else
  $GCLOUD iam workload-identity-pools providers create-oidc "${WIF_PROVIDER_ID}" \
    --location="global" \
    --workload-identity-pool="${WIF_POOL_ID}" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository_owner == '${GITHUB_ORG}'" 2>&1
  echo "  ✓ WIF provider '${WIF_PROVIDER_ID}' created."
fi

# ── Step 7: Bind service account to GitHub WIF ──────────────────────

echo ""
echo "[7/8] Binding service account to GitHub WIF provider..."

WIF_PROVIDER_FULL="projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/providers/${WIF_PROVIDER_ID}"

# Bind for backend repo
$GCLOUD iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.repository/${BACKEND_REPO}" \
  --quiet 2>&1 | tail -1
echo "  ✓ Bound to ${BACKEND_REPO}"

# Bind for frontend repo (if different)
if [ "${BACKEND_REPO}" != "${FRONTEND_REPO}" ]; then
  $GCLOUD iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.repository/${FRONTEND_REPO}" \
    --quiet 2>&1 | tail -1
  echo "  ✓ Bound to ${FRONTEND_REPO}"
fi

# ── Step 8: Set GitHub Secrets ───────────────────────────────────────

echo ""
echo "[8/8] Setting GitHub Secrets..."

if ! command -v gh &>/dev/null; then
  echo "  ⚠ gh CLI not found. Set secrets manually (printed below)."
else
  # Backend repo secrets
  gh secret set GCP_PROJECT_ID      -b "${GCP_PROJECT_ID}"      -R "${BACKEND_REPO}" 2>&1
  gh secret set GCP_PROJECT_NUMBER  -b "${GCP_PROJECT_NUMBER}"  -R "${BACKEND_REPO}" 2>&1
  gh secret set GCP_SERVICE_ACCOUNT -b "${SA_EMAIL}"            -R "${BACKEND_REPO}" 2>&1
  gh secret set GCP_WIF_PROVIDER    -b "${WIF_PROVIDER_FULL}"   -R "${BACKEND_REPO}" 2>&1
  echo "  ✓ Backend secrets set (${BACKEND_REPO})"

  # Frontend repo secrets
  gh secret set VITE_GCP_PROJECT_ID_DEV      -b "${GCP_PROJECT_ID}"      -R "${FRONTEND_REPO}" 2>&1
  gh secret set VITE_GCP_PROJECT_NUMBER_DEV  -b "${GCP_PROJECT_NUMBER}"  -R "${FRONTEND_REPO}" 2>&1
  gh secret set VITE_GCP_WIF_POOL_ID_DEV     -b "tradequt-wif-dev"      -R "${FRONTEND_REPO}" 2>&1
  gh secret set VITE_GCP_WIF_PROVIDER_ID_DEV -b "cognito-dev"           -R "${FRONTEND_REPO}" 2>&1
  gh secret set VITE_GCP_REGION              -b "${REGION}"             -R "${FRONTEND_REPO}" 2>&1
  echo "  ✓ Frontend dev secrets set (${FRONTEND_REPO})"
fi

# ── Summary ──────────────────────────────────────────────────────────

echo ""
echo "============================================="
echo "  GCP Bootstrap Complete!"
echo "============================================="
echo ""
echo "Resources created:"
echo "  • GCS bucket:        gs://${STATE_BUCKET}"
echo "  • Service account:   ${SA_EMAIL}"
echo "  • WIF pool:          ${WIF_POOL_ID}"
echo "  • OIDC provider:     ${WIF_PROVIDER_ID}"
echo ""
echo "GitHub Secrets (backend - ${BACKEND_REPO}):"
echo "  GCP_PROJECT_ID       = ${GCP_PROJECT_ID}"
echo "  GCP_PROJECT_NUMBER   = ${GCP_PROJECT_NUMBER}"
echo "  GCP_SERVICE_ACCOUNT  = ${SA_EMAIL}"
echo "  GCP_WIF_PROVIDER     = ${WIF_PROVIDER_FULL}"
echo ""
echo "GitHub Secrets (frontend - ${FRONTEND_REPO}):"
echo "  VITE_GCP_PROJECT_ID_DEV       = ${GCP_PROJECT_ID}"
echo "  VITE_GCP_PROJECT_NUMBER_DEV   = ${GCP_PROJECT_NUMBER}"
echo "  VITE_GCP_WIF_POOL_ID_DEV      = tradequt-wif-dev"
echo "  VITE_GCP_WIF_PROVIDER_ID_DEV  = cognito-dev"
echo "  VITE_GCP_REGION               = ${REGION}"
echo ""
echo "Production secrets (set manually when ready):"
echo "  VITE_GCP_PROJECT_ID_PROD       = ${GCP_PROJECT_ID}"
echo "  VITE_GCP_PROJECT_NUMBER_PROD   = ${GCP_PROJECT_NUMBER}"
echo "  VITE_GCP_WIF_POOL_ID_PROD      = tradequt-wif-prod"
echo "  VITE_GCP_WIF_PROVIDER_ID_PROD  = cognito-prod"
echo ""
echo "Manual step (Google API limitation):"
echo "  Add these redirect URIs to your Google OAuth Client in GCP Console:"
echo "    https://auth-tradequt-dev.tradequt.com/oauth2/idpresponse"
echo "    https://auth-tradequt-prod.tradequt.com/oauth2/idpresponse"
echo ""
echo "Next steps:"
echo "  1. Push JournalAWSSetup to main → SAM deploy + Terraform apply"
echo "  2. Push TradeFlow to main → Frontend deploy with GCP env vars"
echo "  3. Test: login → AI Insights → generate report → verify streaming"
echo ""
