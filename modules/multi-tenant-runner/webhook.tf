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

  # Pass tenant table name as environment variable for tenant validation
  lambda_environment_variables = {
    TENANT_TABLE_NAME = aws_dynamodb_table.tenants.name
  }
}
