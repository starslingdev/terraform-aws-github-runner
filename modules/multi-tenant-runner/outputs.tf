output "tenant_table" {
  description = "DynamoDB table for tenant registry"
  value = {
    name = aws_dynamodb_table.tenants.name
    arn  = aws_dynamodb_table.tenants.arn
  }
}

output "webhook" {
  description = "Webhook endpoint configuration"
  value       = module.webhook.webhook
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
