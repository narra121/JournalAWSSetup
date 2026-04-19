variable "environment" {
  description = "Deployment environment (dev or prod)"
  type        = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "Environment must be 'dev' or 'prod'."
  }
}

variable "gcp_project_id" {
  description = "GCP project ID"
  type        = string
}

variable "gcp_project_number" {
  description = "GCP project number"
  type        = string
}

variable "gcp_region" {
  description = "GCP region for resources"
  type        = string
  default     = "us-central1"
}

variable "cognito_user_pool_id" {
  description = "AWS Cognito User Pool ID (e.g. us-east-1_XXXXXXXXX)"
  type        = string
}

variable "cognito_client_id" {
  description = "AWS Cognito App Client ID"
  type        = string
}
