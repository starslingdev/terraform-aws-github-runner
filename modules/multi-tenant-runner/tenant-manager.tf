# Tenant Manager Lambda - handles GitHub App installation events

data "aws_caller_identity" "current" {}

locals {
  tenant_manager_lambda_zip = var.tenant_manager_lambda_zip == null ? "${path.module}/../../lambdas/functions/tenant-manager/tenant-manager.zip" : var.tenant_manager_lambda_zip
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "tenant_manager" {
  name               = "${var.prefix}-tenant-manager"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "tenant_manager_dynamodb" {
  name = "dynamodb"
  role = aws_iam_role.tenant_manager.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
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

resource "aws_iam_role_policy" "tenant_manager_ec2" {
  name = "ec2"
  role = aws_iam_role.tenant_manager.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ec2:DescribeInstances"
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = "ec2:TerminateInstances"
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:ResourceTag/ghr:environment" = var.prefix
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "tenant_manager_ssm" {
  name = "ssm"
  role = aws_iam_role.tenant_manager.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]
        Resource = [
          "arn:${var.aws_partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_root_path}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "tenant_manager_logs" {
  role       = aws_iam_role.tenant_manager.name
  policy_arn = "arn:${var.aws_partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "tenant_manager" {
  name              = "/aws/lambda/${aws_lambda_function.tenant_manager.function_name}"
  retention_in_days = var.logging_retention_in_days
  kms_key_id        = var.logging_kms_key_id
  tags              = local.tags
}

resource "aws_lambda_function" "tenant_manager" {
  function_name = "${var.prefix}-tenant-manager"
  role          = aws_iam_role.tenant_manager.arn
  handler       = "index.lambdaHandler"
  runtime       = "nodejs24.x"
  timeout       = var.lambda_timeout
  memory_size   = 256
  architectures = ["arm64"]

  filename         = local.tenant_manager_lambda_zip
  source_code_hash = filebase64sha256(local.tenant_manager_lambda_zip)

  environment {
    variables = {
      TENANT_TABLE_NAME           = aws_dynamodb_table.tenants.name
      LOG_LEVEL                   = var.log_level
      POWERTOOLS_SERVICE_NAME     = "tenant-manager"
      POWERTOOLS_LOGGER_LOG_EVENT = var.log_level == "debug" ? "true" : "false"
      DEFAULT_TENANT_TIER         = var.default_tenant_tier
    }
  }

  tags = local.tags
}

# EventBridge rule for installation events
resource "aws_cloudwatch_event_rule" "installation" {
  name           = "${var.prefix}-installation"
  description    = "GitHub App installation events"
  event_bus_name = module.webhook.eventbridge.event_bus.name

  event_pattern = jsonencode({
    "detail-type" = ["installation"]
  })

  tags = local.tags
}

resource "aws_cloudwatch_event_target" "tenant_manager" {
  rule           = aws_cloudwatch_event_rule.installation.name
  event_bus_name = module.webhook.eventbridge.event_bus.name
  target_id      = "tenant-manager"
  arn            = aws_lambda_function.tenant_manager.arn
}

resource "aws_lambda_permission" "eventbridge_tenant_manager" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tenant_manager.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.installation.arn
}
