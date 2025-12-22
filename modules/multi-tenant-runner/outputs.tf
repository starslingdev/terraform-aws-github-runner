output "tenant_table" {
  description = "DynamoDB table for tenant registry"
  value = {
    name = aws_dynamodb_table.tenants.name
    arn  = aws_dynamodb_table.tenants.arn
  }
}

output "webhook" {
  description = "Webhook endpoint configuration"
  value = {
    gateway          = module.webhook.gateway
    endpoint         = "${module.webhook.gateway.api_endpoint}/${module.webhook.endpoint_relative_path}"
    lambda           = module.webhook.lambda
    lambda_log_group = module.webhook.lambda_log_group
    eventbridge      = module.webhook.eventbridge
  }
}

output "runner_tiers" {
  description = "Configured runner tiers"
  value       = var.runner_tiers
}

output "queues" {
  description = "SQS queues for runner tiers"
  value = {
    for tier, queue in aws_sqs_queue.tier_builds : tier => {
      id  = queue.id
      arn = queue.arn
      url = queue.url
    }
  }
}

output "runners" {
  description = "Runner infrastructure for each tier"
  value = {
    for tier, runner in module.runners : tier => {
      launch_template   = runner.launch_template
      lambda_scale_up   = runner.lambda_scale_up
      lambda_scale_down = runner.lambda_scale_down
      role_runner       = runner.role_runner
      role_scale_up     = runner.role_scale_up
      role_scale_down   = runner.role_scale_down
    }
  }
}

output "runner_binaries" {
  description = "S3 buckets for runner binaries by OS/architecture"
  value = {
    for key, syncer in module.runner_binaries : key => {
      bucket_id  = syncer.bucket.id
      bucket_arn = syncer.bucket.arn
    }
  }
}
