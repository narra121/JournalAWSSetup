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
