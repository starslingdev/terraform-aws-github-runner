# Tenant Manager Lambda - handles GitHub App installation events

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
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances",
          "ec2:TerminateInstances"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:ResourceTag/ghr:environment" = var.prefix
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = "ec2:DescribeInstances"
        Resource = "*"
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
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_lambda_function" "tenant_manager" {
  function_name = "${var.prefix}-tenant-manager"
  role          = aws_iam_role.tenant_manager.arn
  handler       = "index.lambdaHandler"
  runtime       = "nodejs20.x"
  timeout       = var.lambda_timeout
  memory_size   = 256
  architectures = ["arm64"]

  filename         = var.tenant_manager_lambda_zip
  source_code_hash = filebase64sha256(var.tenant_manager_lambda_zip)

  environment {
    variables = {
      TENANT_TABLE_NAME       = aws_dynamodb_table.tenants.name
      LOG_LEVEL               = var.log_level
      AWS_REGION              = var.aws_region
      POWERTOOLS_SERVICE_NAME = "tenant-manager"
    }
  }

  tags = local.tags
}

# EventBridge rule for installation events
resource "aws_cloudwatch_event_rule" "installation" {
  name           = "${var.prefix}-installation"
  description    = "GitHub App installation events"
  event_bus_name = module.webhook.eventbridge.event_bus_name

  event_pattern = jsonencode({
    "detail-type" = ["installation"]
  })

  tags = local.tags
}

resource "aws_cloudwatch_event_target" "tenant_manager" {
  rule           = aws_cloudwatch_event_rule.installation.name
  event_bus_name = module.webhook.eventbridge.event_bus_name
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
