# Policy to deny insecure transport (require TLS)
data "aws_iam_policy_document" "deny_insecure_transport" {
  statement {
    sid = "DenyInsecureTransport"

    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = [
      "sqs:*"
    ]

    resources = [
      "*"
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

# SQS queues for each runner tier
resource "aws_sqs_queue" "tier_builds" {
  for_each = var.runner_tiers

  name                       = "${var.prefix}-${each.key}-builds"
  delay_seconds              = var.delay_webhook_event
  visibility_timeout_seconds = var.lambda_timeout + 10
  message_retention_seconds  = 86400 # 1 day
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.tier_builds_dlq[each.key].arn
    maxReceiveCount     = 3
  })

  tags = merge(local.tags, {
    "ghr:tier" = each.key
  })
}

resource "aws_sqs_queue" "tier_builds_dlq" {
  for_each = var.runner_tiers

  name                      = "${var.prefix}-${each.key}-builds-dlq"
  message_retention_seconds = 604800 # 7 days
  sqs_managed_sse_enabled   = true

  tags = merge(local.tags, {
    "ghr:tier" = each.key
    "ghr:type" = "dlq"
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "tier_builds_dlq" {
  for_each = var.runner_tiers

  queue_url = aws_sqs_queue.tier_builds_dlq[each.key].url

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.tier_builds[each.key].arn]
  })
}

# Enforce TLS for main queues
resource "aws_sqs_queue_policy" "build_queue_policy" {
  for_each  = var.runner_tiers
  queue_url = aws_sqs_queue.tier_builds[each.key].id
  policy    = data.aws_iam_policy_document.deny_insecure_transport.json
}

# Enforce TLS for DLQs
resource "aws_sqs_queue_policy" "build_queue_dlq_policy" {
  for_each  = var.runner_tiers
  queue_url = aws_sqs_queue.tier_builds_dlq[each.key].id
  policy    = data.aws_iam_policy_document.deny_insecure_transport.json
}
