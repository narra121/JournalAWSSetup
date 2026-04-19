terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }

  backend "gcs" {
    bucket = "tradequt-terraform-state"
    prefix = "gcp-wif"
  }
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}
