resource "google_iam_workload_identity_pool" "cognito" {
  workload_identity_pool_id = "tradequt-wif-${var.environment}"
  display_name              = "TradeQut WIF Pool (${var.environment})"
  description               = "Workload Identity Federation pool for Cognito JWT exchange"
}

resource "google_iam_workload_identity_pool_provider" "cognito" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.cognito.workload_identity_pool_id
  workload_identity_pool_provider_id = "cognito-${var.environment}"
  display_name                       = "Cognito OIDC Provider (${var.environment})"

  oidc {
    issuer_uri        = "https://cognito-idp.us-east-1.amazonaws.com/${var.cognito_user_pool_id}"
    allowed_audiences = [var.cognito_client_id]
  }

  attribute_mapping = {
    "google.subject" = "assertion.sub"
  }
}
