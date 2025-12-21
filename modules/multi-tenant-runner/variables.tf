variable "prefix" {
  description = "Prefix for all resources"
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "aws_partition" {
  description = "AWS partition (aws, aws-cn, aws-us-gov)"
  type        = string
  default     = "aws"
}

variable "enable_point_in_time_recovery" {
  description = "Enable point-in-time recovery for DynamoDB table"
  type        = bool
  default     = true
}

variable "github_app" {
  description = "GitHub App configuration"
  type = object({
    id                 = optional(string)
    key_base64         = optional(string)
    webhook_secret     = optional(string)
    id_ssm             = optional(object({ arn = string, name = string }))
    key_base64_ssm     = optional(object({ arn = string, name = string }))
    webhook_secret_ssm = optional(object({ arn = string, name = string }))
  })
}

variable "runner_tiers" {
  description = "Fixed runner tier definitions"
  type = map(object({
    runner_os           = string
    runner_architecture = string
    instance_types      = list(string)
    max_runners         = number
    labels              = list(string)
  }))
  default = {
    small = {
      runner_os           = "linux"
      runner_architecture = "x64"
      instance_types      = ["t3.medium"]
      max_runners         = 2
      labels              = ["self-hosted", "linux", "x64", "small"]
    }
    medium = {
      runner_os           = "linux"
      runner_architecture = "x64"
      instance_types      = ["t3.large", "m5.large"]
      max_runners         = 5
      labels              = ["self-hosted", "linux", "x64", "medium"]
    }
    large = {
      runner_os           = "linux"
      runner_architecture = "x64"
      instance_types      = ["t3.xlarge", "m5.xlarge"]
      max_runners         = 10
      labels              = ["self-hosted", "linux", "x64", "large"]
    }
  }
  validation {
    condition     = alltrue([for tier in values(var.runner_tiers) : length(tier.labels) > 0])
    error_message = "Each runner tier must have at least one label."
  }
  validation {
    condition     = alltrue([for tier in values(var.runner_tiers) : tier.max_runners > 0])
    error_message = "Each runner tier must have max_runners > 0."
  }
  validation {
    condition     = alltrue([for tier in values(var.runner_tiers) : length(tier.instance_types) > 0])
    error_message = "Each runner tier must have at least one instance type."
  }
}

variable "ssm_paths" {
  description = "SSM parameter paths"
  type = object({
    root = string
  })
  default = {
    root = "github-action-runners"
  }
}

variable "eventbridge" {
  description = "EventBridge configuration"
  type = object({
    enable        = bool
    accept_events = list(string)
  })
  default = {
    enable        = true
    accept_events = ["workflow_job", "installation"]
  }
  validation {
    condition     = var.eventbridge.enable == true
    error_message = "EventBridge must be enabled for the multi-tenant runner module. The tenant-manager relies on EventBridge for installation event routing."
  }
}

variable "lambda_timeout" {
  description = "Lambda timeout in seconds"
  type        = number
  default     = 60
}

variable "log_level" {
  description = "Lambda log level"
  type        = string
  default     = "info"
  validation {
    condition = anytrue([
      var.log_level == "debug",
      var.log_level == "info",
      var.log_level == "warn",
      var.log_level == "error",
    ])
    error_message = "`log_level` value not valid. Valid values are 'debug', 'info', 'warn', 'error'."
  }
}

variable "kms_key_arn" {
  description = "KMS key ARN for encrypting SSM parameters. If null, AWS managed key is used."
  type        = string
  default     = null
}

variable "tenant_manager_lambda_zip" {
  description = "Path to tenant-manager Lambda zip file"
  type        = string
  default     = null
}

variable "webhook_lambda_zip" {
  description = "Path to webhook Lambda zip file"
  type        = string
  default     = null
}

variable "logging_retention_in_days" {
  description = "Specifies the number of days you want to retain log events for the Lambda log group."
  type        = number
  default     = 180
}

variable "logging_kms_key_id" {
  description = "Specifies the KMS key ID to encrypt the logs with."
  type        = string
  default     = null
}

# Runner infrastructure variables
variable "vpc_id" {
  description = "The VPC ID for runner instances and security groups"
  type        = string
}

variable "subnet_ids" {
  description = "List of subnet IDs where runner instances will be launched"
  type        = list(string)
}

variable "runners_lambda_zip" {
  description = "Path to the runners Lambda zip file (control-plane)"
  type        = string
  default     = null
}

variable "runner_binaries_syncer_lambda_zip" {
  description = "Path to the runner-binaries-syncer Lambda zip file"
  type        = string
  default     = null
}

variable "enable_ephemeral_runners" {
  description = "Enable ephemeral runners. Runners will be terminated after each job."
  type        = bool
  default     = true
}

variable "enable_ssm_on_runners" {
  description = "Enable SSM access on runner instances for debugging"
  type        = bool
  default     = false
}

variable "instance_target_capacity_type" {
  description = "Default lifecycle for runner instances: 'spot' or 'on-demand'"
  type        = string
  default     = "spot"
  validation {
    condition     = contains(["spot", "on-demand"], var.instance_target_capacity_type)
    error_message = "Valid values are 'spot' or 'on-demand'."
  }
}

variable "create_service_linked_role_spot" {
  description = "Create the service-linked role for EC2 Spot. Required for first deployment in an account."
  type        = bool
  default     = false
}

variable "scale_down_schedule_expression" {
  description = "Cron expression for scale-down schedule"
  type        = string
  default     = "cron(*/5 * * * ? *)"
}
