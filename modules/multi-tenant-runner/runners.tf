# Runner infrastructure for multi-tenant deployment
#
# This file creates:
# - Runner binaries syncer (S3 bucket + Lambda to sync GitHub runner binaries)
# - Runners module for each tier (scale-up Lambda, scale-down Lambda, launch template)
# - IAM policy for scale-up Lambda to access tenant DynamoDB table

locals {
  # Get unique OS/architecture combinations from runner tiers
  unique_os_arch = distinct([
    for tier, config in var.runner_tiers : {
      os   = config.runner_os
      arch = config.runner_architecture
      key  = "${config.runner_os}-${config.runner_architecture}"
    }
  ])

  unique_os_arch_map = {
    for item in local.unique_os_arch : item.key => item
  }

  # Lambda zip paths
  runners_lambda_zip                = var.runners_lambda_zip == null ? "${path.module}/../../lambdas/functions/control-plane/runners.zip" : var.runners_lambda_zip
  runner_binaries_syncer_lambda_zip = var.runner_binaries_syncer_lambda_zip == null ? "${path.module}/../../lambdas/functions/gh-agent-syncer/runner-binaries-syncer.zip" : var.runner_binaries_syncer_lambda_zip

  # Map runner binaries by OS and architecture
  runner_binaries_by_os_arch = {
    for k, v in module.runner_binaries : k => {
      arn = v.bucket.arn
      id  = v.bucket.id
      key = v.runner_distribution_object_key
    }
  }
}

# Runner binaries syncer - downloads GitHub runner binaries to S3
module "runner_binaries" {
  source   = "../runner-binaries-syncer"
  for_each = local.unique_os_arch_map

  prefix = "${var.prefix}-${each.key}"
  tags   = local.tags

  distribution_bucket_name = lower("${var.prefix}-${each.key}-dist-${random_string.random.result}")

  runner_os           = each.value.os
  runner_architecture = each.value.arch

  lambda_zip                = local.runner_binaries_syncer_lambda_zip
  lambda_timeout            = var.lambda_timeout
  logging_retention_in_days = var.logging_retention_in_days
  logging_kms_key_id        = var.logging_kms_key_id

  log_level     = var.log_level
  aws_partition = var.aws_partition
}

# Runners module for each tier
module "runners" {
  source   = "../runners"
  for_each = var.runner_tiers

  prefix     = "${var.prefix}-${each.key}"
  aws_region = var.aws_region
  vpc_id     = var.vpc_id
  subnet_ids = var.subnet_ids

  tags = merge(local.tags, {
    "ghr:tier" = each.key
  })

  # SQS queue for this tier
  sqs_build_queue = {
    arn = aws_sqs_queue.tier_builds[each.key].arn
    url = aws_sqs_queue.tier_builds[each.key].url
  }

  # Runner binaries from syncer
  s3_runner_binaries = local.runner_binaries_by_os_arch["${each.value.runner_os}-${each.value.runner_architecture}"]

  # SSM paths for this tier
  ssm_paths = {
    root   = "${local.ssm_root_path}/${each.key}"
    tokens = "tokens"
    config = "config"
  }

  # GitHub App parameters
  github_app_parameters = {
    key_base64 = {
      name = local.github_app_parameters.key_base64.name
      arn  = local.github_app_parameters.key_base64.arn
    }
    id = {
      name = local.github_app_parameters.id.name
      arn  = local.github_app_parameters.id.arn
    }
  }

  # Runner configuration from tier definition
  runner_os             = each.value.runner_os
  runner_architecture   = each.value.runner_architecture
  instance_types        = each.value.instance_types
  runner_labels         = each.value.labels
  runners_maximum_count = each.value.max_runners

  # Common runner settings
  enable_organization_runners     = true # Multi-tenant always uses org-level runners
  enable_ephemeral_runners        = var.enable_ephemeral_runners
  enable_ssm_on_runners           = var.enable_ssm_on_runners
  instance_target_capacity_type   = var.instance_target_capacity_type
  create_service_linked_role_spot = var.create_service_linked_role_spot && each.key == keys(var.runner_tiers)[0] # Only create once
  scale_down_schedule_expression  = var.scale_down_schedule_expression

  # Lambda configuration
  lambda_zip                = local.runners_lambda_zip
  lambda_timeout_scale_up   = var.lambda_timeout
  lambda_timeout_scale_down = var.lambda_timeout
  logging_retention_in_days = var.logging_retention_in_days
  logging_kms_key_id        = var.logging_kms_key_id
  log_level                 = var.log_level
  kms_key_arn               = var.kms_key_arn
  aws_partition             = var.aws_partition

  # Pass tenant table name to scale-up Lambda for multi-tenant limit enforcement
  tenant_table_name = aws_dynamodb_table.tenants.name
}

# IAM policy for scale-up Lambda to read tenant configuration from DynamoDB
resource "aws_iam_role_policy" "scale_up_tenant_dynamodb" {
  for_each = var.runner_tiers

  name = "tenant-dynamodb"
  role = module.runners[each.key].role_scale_up.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query"
        ]
        Resource = [
          aws_dynamodb_table.tenants.arn,
          "${aws_dynamodb_table.tenants.arn}/index/*"
        ]
      }
    ]
  })
}
