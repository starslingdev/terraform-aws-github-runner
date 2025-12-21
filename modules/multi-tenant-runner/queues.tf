# SQS queues for each runner tier
resource "aws_sqs_queue" "tier_builds" {
  for_each = var.runner_tiers

  name                       = "${var.prefix}-${each.key}-builds"
  delay_seconds              = 30
  visibility_timeout_seconds = var.lambda_timeout + 10
  message_retention_seconds  = 86400 # 1 day

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
