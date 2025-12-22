module "webhook" {
  source = "../webhook"
  prefix = var.prefix
  tags   = local.tags

  eventbridge = var.eventbridge

  # Build matcher config for all tiers
  runner_matcher_config = local.matcher_config

  ssm_paths = {
    root    = local.ssm_root_path
    webhook = "webhook"
  }

  github_app_parameters = {
    webhook_secret = local.github_app_parameters.webhook_secret
  }

  lambda_zip     = var.webhook_lambda_zip
  lambda_timeout = var.lambda_timeout

  aws_partition = var.aws_partition
  log_level     = var.log_level

  # Pass tenant table for tenant validation
  tenant_table_name   = aws_dynamodb_table.tenants.name
  tenant_table_arn    = aws_dynamodb_table.tenants.arn
  enable_tenant_table = true
}
