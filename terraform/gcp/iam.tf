resource "google_project_iam_member" "vertex_ai_user" {
  project = var.gcp_project_id
  role    = "roles/aiplatform.user"
  member  = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.cognito.name}/*"
}
