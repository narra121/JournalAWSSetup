resource "google_firebase_project" "default" {
  provider = google-beta
  project  = var.gcp_project_id
}

resource "google_firebase_web_app" "tradequt" {
  provider     = google-beta
  project      = var.gcp_project_id
  display_name = "TradeQut ${var.environment}"
  depends_on   = [google_firebase_project.default]
}

data "google_firebase_web_app_config" "tradequt" {
  provider   = google-beta
  project    = var.gcp_project_id
  web_app_id = google_firebase_web_app.tradequt.app_id
}

resource "google_project_service" "firebase" {
  project = var.gcp_project_id
  service = "firebase.googleapis.com"
}

resource "google_project_service" "generativelanguage" {
  project = var.gcp_project_id
  service = "generativelanguage.googleapis.com"
}

resource "google_project_service" "recaptcha_enterprise" {
  project = var.gcp_project_id
  service = "recaptchaenterprise.googleapis.com"
}

resource "google_recaptcha_enterprise_key" "app_check" {
  display_name = "TradeQut ${var.environment}"
  project      = var.gcp_project_id

  web_settings {
    integration_type  = "SCORE"
    allowed_domains   = var.allowed_domains
  }

  depends_on = [google_project_service.recaptcha_enterprise]
}

resource "google_firebase_app_check_recaptcha_enterprise_config" "default" {
  provider  = google-beta
  project   = var.gcp_project_id
  app_id    = google_firebase_web_app.tradequt.app_id
  site_key  = google_recaptcha_enterprise_key.app_check.key_id
  token_ttl = "3600s"

  depends_on = [google_firebase_project.default]
}

module "ai_logic" {
  source     = "GoogleCloudPlatform/firebase/google//modules/firebase_ai_logic_core"
  version    = "~> 0.1"
  project_id = var.gcp_project_id

  api_config = {
    gemini_developer = true
    vertex_ai        = false
  }

  depends_on = [google_firebase_project.default]
}

resource "google_service_usage_consumer_quota_override" "ai_logic_rpm_per_user" {
  provider       = google-beta
  project        = var.gcp_project_id
  service        = "firebasevertexai.googleapis.com"
  metric         = "firebasevertexai.googleapis.com%2Fgenerate_content_requests_per_minute_per_project_per_user"
  limit          = "%2Fmin%2Fproject%2Fregion%2Fuser"
  override_value = var.ai_rpm_per_user
  force          = true
}
