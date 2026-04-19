#!/usr/bin/env bash
#
# GCP Bootstrap Script for TradeQut
#
# One-time setup: enables APIs, creates service account, GitHub OIDC WIF,
# and GCS state bucket. Run once per GCP project before first Terraform apply.
#
# Usage: ./scripts/gcp-bootstrap.sh <GCP_PROJECT_ID> <GITHUB_ORG/REPO>
#
# Example: ./scripts/gcp-bootstrap.sh tradequt-prod my-org/JournalAWSSetup
#

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <GCP_PROJECT_ID> <GITHUB_ORG/REPO>"
  echo "Example: $0 tradequt-prod my-org/JournalAWSSetup"
  exit 1
fi

GCP_PROJECT_ID="$1"
GITHUB_REPO="$2"
GITHUB_ORG="${GITHUB_REPO%%/*}"

REGION="us-central1"
STATE_BUCKET="tradequt-terraform-state"
SA_NAME="tradequt-cicd"
SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
WIF_POOL_ID="github-actions-pool"
WIF_PROVIDER_ID="github-provider"

echo "=== GCP Bootstrap for TradeQut ==="
echo "Project:     ${GCP_PROJECT_ID}"
echo "GitHub Repo: ${GITHUB_REPO}"
echo "Region:      ${REGION}"
echo ""

# -----------------------------------------------
# Step 1: Set active project
# -----------------------------------------------
echo "[1/7] Setting active GCP project..."
gcloud config set project "${GCP_PROJECT_ID}"

# -----------------------------------------------
# Step 2: Enable required APIs
# -----------------------------------------------
echo "[2/7] Enabling required APIs..."
gcloud services enable \
  aiplatform.googleapis.com \
  iam.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com

echo "  APIs enabled."

# -----------------------------------------------
# Step 3: Create GCS bucket for Terraform state
# -----------------------------------------------
echo "[3/7] Creating GCS bucket for Terraform state..."
if gsutil ls -b "gs://${STATE_BUCKET}" &>/dev/null; then
  echo "  Bucket gs://${STATE_BUCKET} already exists, skipping."
else
  gsutil mb -p "${GCP_PROJECT_ID}" -l "${REGION}" "gs://${STATE_BUCKET}"
  gsutil versioning set on "gs://${STATE_BUCKET}"
  echo "  Bucket gs://${STATE_BUCKET} created with versioning enabled."
fi

# -----------------------------------------------
# Step 4: Create service account for CI/CD
# -----------------------------------------------
echo "[4/7] Creating service account..."
if gcloud iam service-accounts describe "${SA_EMAIL}" &>/dev/null; then
  echo "  Service account ${SA_EMAIL} already exists, skipping."
else
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="TradeQut CI/CD Service Account" \
    --description="Used by GitHub Actions to manage GCP infrastructure via Terraform"
  echo "  Service account ${SA_EMAIL} created."
fi

# -----------------------------------------------
# Step 5: Grant roles to the service account
# -----------------------------------------------
echo "[5/7] Granting IAM roles to service account..."

ROLES=(
  "roles/iam.workloadIdentityPoolAdmin"
  "roles/iam.serviceAccountAdmin"
  "roles/aiplatform.admin"
)

for ROLE in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet
  echo "  Granted ${ROLE}"
done

# -----------------------------------------------
# Step 6: Create GitHub OIDC WIF pool and provider
# -----------------------------------------------
echo "[6/7] Creating Workload Identity Federation pool and provider..."

GCP_PROJECT_NUMBER=$(gcloud projects describe "${GCP_PROJECT_ID}" --format="value(projectNumber)")

# Create pool
if gcloud iam workload-identity-pools describe "${WIF_POOL_ID}" \
  --location="global" &>/dev/null; then
  echo "  WIF pool '${WIF_POOL_ID}' already exists, skipping."
else
  gcloud iam workload-identity-pools create "${WIF_POOL_ID}" \
    --location="global" \
    --display-name="GitHub Actions Pool" \
    --description="WIF pool for GitHub Actions OIDC"
  echo "  WIF pool '${WIF_POOL_ID}' created."
fi

# Create OIDC provider
if gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER_ID}" \
  --location="global" \
  --workload-identity-pool="${WIF_POOL_ID}" &>/dev/null; then
  echo "  WIF provider '${WIF_PROVIDER_ID}' already exists, skipping."
else
  gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER_ID}" \
    --location="global" \
    --workload-identity-pool="${WIF_POOL_ID}" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository_owner == '${GITHUB_ORG}'"
  echo "  WIF provider '${WIF_PROVIDER_ID}' created."
fi

# -----------------------------------------------
# Step 7: Bind service account to GitHub WIF provider
# -----------------------------------------------
echo "[7/7] Binding service account to GitHub WIF provider..."

WIF_PROVIDER_FULL="projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/providers/${WIF_PROVIDER_ID}"

gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.repository/${GITHUB_REPO}" \
  --quiet

echo "  Service account bound to GitHub WIF provider."

# -----------------------------------------------
# Print summary and required GitHub Secrets
# -----------------------------------------------
echo ""
echo "============================================="
echo "  GCP Bootstrap Complete!"
echo "============================================="
echo ""
echo "Set the following GitHub Secrets in your repository:"
echo ""
echo "  GCP_PROJECT_ID          = ${GCP_PROJECT_ID}"
echo "  GCP_PROJECT_NUMBER      = ${GCP_PROJECT_NUMBER}"
echo "  GCP_SERVICE_ACCOUNT     = ${SA_EMAIL}"
echo "  GCP_WIF_PROVIDER        = projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/providers/${WIF_PROVIDER_ID}"
echo ""
echo "For the TradeFlow (frontend) repository, also set:"
echo ""
echo "  VITE_GCP_PROJECT_ID_DEV         = ${GCP_PROJECT_ID}"
echo "  VITE_GCP_PROJECT_NUMBER_DEV     = ${GCP_PROJECT_NUMBER}"
echo "  VITE_GCP_WIF_POOL_ID_DEV        = tradequt-wif-dev"
echo "  VITE_GCP_WIF_PROVIDER_ID_DEV    = cognito-dev"
echo "  VITE_GCP_REGION_DEV             = ${REGION}"
echo ""
echo "  (Use _PROD suffix for production environment)"
echo ""
echo "Terraform state bucket: gs://${STATE_BUCKET}"
echo ""
