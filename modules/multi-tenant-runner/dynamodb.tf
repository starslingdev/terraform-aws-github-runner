resource "aws_dynamodb_table" "tenants" {
  name         = "${var.prefix}-tenants"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "installation_id"

  attribute {
    name = "installation_id"
    type = "N"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "org_name"
    type = "S"
  }

  global_secondary_index {
    name            = "status-index"
    hash_key        = "status"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "org-name-index"
    hash_key        = "org_name"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = var.enable_point_in_time_recovery
  }

  tags = merge(var.tags, {
    "ghr:environment" = var.prefix
    "ghr:component"   = "tenant-registry"
  })
}
