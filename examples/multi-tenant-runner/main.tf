# Multi-Tenant GitHub Actions Runner Example
#
# This example demonstrates a SaaS deployment pattern where:
# - A single GitHub App serves multiple customer organizations (tenants)
# - Tenants are auto-provisioned when they install the GitHub App
# - Fixed runner tiers (small/medium/large) with per-tenant limits
# - JIT tokens ensure runners can only access their installation
# - Ephemeral runners for security isolation

locals {
  environment = var.environment != null ? var.environment : "multi-tenant"
  aws_region  = var.aws_region
}

resource "random_id" "random" {
  byte_length = 20
}

module "base" {
  source = "../base"

  prefix     = local.environment
  aws_region = local.aws_region
}

module "runners" {
  source = "../../modules/multi-tenant-runner"

  prefix     = local.environment
  aws_region = local.aws_region

  github_app = {
    key_base64     = var.github_app.key_base64
    id             = var.github_app.id
    webhook_secret = random_id.random.hex
  }

  # Fixed runner tiers - tenants choose from these via workflow labels
  runner_tiers = {
    small = {
      runner_os           = "linux"
      runner_architecture = "x64"
      instance_types      = ["t3.medium"]
      max_runners         = 2
      labels              = ["self-hosted", "linux", "x64", "small"]
    }
    medium = {
      runner_os           = "linux"
      runner_architecture = "x64"
      instance_types      = ["t3.large", "m5.large"]
      max_runners         = 5
      labels              = ["self-hosted", "linux", "x64", "medium"]
    }
    large = {
      runner_os           = "linux"
      runner_architecture = "x64"
      instance_types      = ["t3.xlarge", "m5.xlarge"]
      max_runners         = 10
      labels              = ["self-hosted", "linux", "x64", "large"]
    }
  }

  # EventBridge for event routing
  eventbridge = {
    enable        = true
    accept_events = ["workflow_job", "installation"]
  }

  tags = {
    Project     = "multi-tenant-runners"
    Environment = local.environment
  }
}

# Output the webhook endpoint for GitHub App configuration
output "webhook_endpoint" {
  value = module.runners.webhook.endpoint
}

output "tenant_table" {
  value = module.runners.tenant_table
}

output "runner_tiers" {
  value = module.runners.runner_tiers
}

output "queues" {
  value = module.runners.queues
}
