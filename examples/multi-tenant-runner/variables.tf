variable "github_app" {
  description = "GitHub App configuration"
  type = object({
    key_base64 = string
    id         = string
  })
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = null
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}
