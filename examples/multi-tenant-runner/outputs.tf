output "webhook_endpoint" {
  description = "Webhook URL for GitHub App configuration"
  value       = module.runners.webhook.endpoint
}

output "webhook_secret" {
  description = "Webhook secret for GitHub App configuration"
  value       = module.runners.webhook.secret
  sensitive   = true
}

output "tenant_table" {
  description = "DynamoDB table details for tenant registry"
  value       = module.runners.tenant_table
}

output "runner_tiers" {
  description = "Configured runner tiers"
  value       = module.runners.runner_tiers
}

output "queues" {
  description = "SQS queues for each tier"
  value       = module.runners.queues
}

output "runners" {
  description = "Runner infrastructure for each tier"
  value       = module.runners.runners
}

output "runner_binaries" {
  description = "S3 buckets for runner binaries"
  value       = module.runners.runner_binaries
}
