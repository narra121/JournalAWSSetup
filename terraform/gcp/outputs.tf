output "wif_pool_id" {
  description = "Workload Identity Federation pool ID"
  value       = google_iam_workload_identity_pool.cognito.workload_identity_pool_id
}

output "wif_provider_id" {
  description = "Workload Identity Federation provider ID"
  value       = google_iam_workload_identity_pool_provider.cognito.workload_identity_pool_provider_id
}

output "wif_pool_name" {
  description = "Full resource name of the WIF pool"
  value       = google_iam_workload_identity_pool.cognito.name
}
