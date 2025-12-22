locals {
  tags = merge(var.tags, {
    "ghr:environment" = var.prefix
  })

  github_app_parameters = {
    id             = coalesce(var.github_app.id_ssm, module.ssm.parameters.github_app_id)
    key_base64     = coalesce(var.github_app.key_base64_ssm, module.ssm.parameters.github_app_key_base64)
    webhook_secret = coalesce(var.github_app.webhook_secret_ssm, module.ssm.parameters.github_app_webhook_secret)
  }

  ssm_root_path = "/${var.ssm_paths.root}/${var.prefix}"

  # Build matcher config for each tier
  matcher_config = {
    for tier, config in var.runner_tiers : tier => {
      id  = aws_sqs_queue.tier_builds[tier].id
      arn = aws_sqs_queue.tier_builds[tier].arn
      matcherConfig = {
        labelMatchers = [config.labels]
        exactMatch    = true
        priority      = 100
      }
    }
  }
}

resource "random_string" "random" {
  length  = 24
  special = false
  upper   = false
}

module "ssm" {
  source = "../ssm"

  github_app  = var.github_app
  kms_key_arn = var.kms_key_arn
  tags        = local.tags
  path_prefix = "${local.ssm_root_path}/app"
}
