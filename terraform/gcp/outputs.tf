output "firebase_app_id" {
  description = "Firebase web app ID"
  value       = google_firebase_web_app.tradequt.app_id
}

output "firebase_api_key" {
  description = "Firebase web API key"
  value       = data.google_firebase_web_app_config.tradequt.api_key
}

output "firebase_project_id" {
  description = "Firebase / GCP project ID"
  value       = var.gcp_project_id
}
