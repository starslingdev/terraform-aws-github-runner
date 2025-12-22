# Module - Multi-Tenant Runner

This module creates a multi-tenant GitHub Actions runner infrastructure designed for SaaS deployments. It allows multiple customer organizations (tenants) to share a single GitHub App while maintaining strict isolation between tenants.

## Overview

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              GitHub                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                       │
│  │   Tenant A   │  │   Tenant B   │  │   Tenant C   │                       │
│  │   (Org A)    │  │   (Org B)    │  │   (Org C)    │                       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                       │
│         │                 │                 │                                │
│         └────────────┬────┴────────────────┬┘                               │
│                      │ installation_id      │                                │
│                      ▼                      │                                │
│              ┌───────────────┐             │                                │
│              │  GitHub App   │◄────────────┘                                │
│              └───────┬───────┘                                              │
└──────────────────────┼──────────────────────────────────────────────────────┘
                       │ webhook
                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              AWS                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │                         API Gateway                                    │   │
│  └───────────────────────────────┬───────────────────────────────────────┘   │
│                                  │                                            │
│  ┌───────────────────────────────▼───────────────────────────────────────┐   │
│  │                    Webhook Lambda                                      │   │
│  │  • Validates signature                                                 │   │
│  │  • Looks up tenant in DynamoDB                                        │   │
│  │  • Routes to tier-specific SQS queue                                  │   │
│  └───────────────────────────────┬───────────────────────────────────────┘   │
│                                  │                                            │
│           ┌──────────────────────┼──────────────────────┐                    │
│           ▼                      ▼                      ▼                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │  Small Queue    │  │  Medium Queue   │  │  Large Queue    │              │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘              │
│           │                    │                    │                        │
│           └──────────────┬─────┴────────────────────┘                        │
│                          ▼                                                   │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │                    Scale-Up Lambda                                     │   │
│  │  • Checks tenant runner limits                                        │   │
│  │  • Creates EC2 with tenant tags                                       │   │
│  │  • Generates JIT config                                               │   │
│  └───────────────────────────────┬───────────────────────────────────────┘   │
│                                  │                                            │
│  ┌───────────────────────────────▼───────────────────────────────────────┐   │
│  │                    EC2 Runners                                         │   │
│  │  • Tagged with ghr:tenant_id                                          │   │
│  │  • Ephemeral (terminate after job)                                    │   │
│  │  • JIT token scoped to installation                                   │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │                    DynamoDB (Tenant Registry)                          │   │
│  │  • installation_id (PK)                                               │   │
│  │  • org_name, status, tier, max_runners                                │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Key Features

- **Multi-Tenant Isolation**: Each tenant is identified by their GitHub App `installation_id`
- **Self-Service Onboarding**: Tenants are auto-provisioned when they install the GitHub App
- **Fixed Runner Tiers**: Pre-defined tiers (small/medium/large) with different instance types and limits
- **Per-Tenant Limits**: Each tenant has a maximum number of concurrent runners based on their tier
- **JIT Tokens**: Just-in-time runner tokens ensure runners can only access their specific installation
- **Ephemeral Runners**: Runners terminate after each job for security isolation
- **Cost Allocation**: All resources tagged with `tenant_id` for billing/chargeback

### Tenant Lifecycle

1. **Onboarding**: Customer installs the GitHub App to their org
   - `installation.created` webhook triggers Tenant Manager Lambda
   - Tenant record created in DynamoDB with default "small" tier
   - Tenant can immediately start using runners

2. **Running Jobs**: Customer pushes code triggering a workflow
   - Webhook validates tenant exists and is active
   - Job routed to appropriate tier queue based on labels
   - Scale-up Lambda checks tenant limits before creating runner
   - Runner created with tenant tags, executes job, terminates

3. **Offboarding**: Customer uninstalls the GitHub App
   - `installation.deleted` webhook triggers cleanup
   - Any running runners for tenant are terminated
   - Tenant marked as "deleted" in DynamoDB

### Security Model

| Security Control | Implementation |
|-----------------|----------------|
| Tenant Authentication | `installation_id` from GitHub-signed webhook payload |
| Token Scoping | JIT tokens generated per-installation via GitHub API |
| Runner Isolation | Ephemeral EC2 instances with tenant tags |
| SSM Path Isolation | Tokens stored in tenant-scoped paths |
| Network Isolation | Shared VPC with per-tenant security groups |
| Limit Enforcement | Per-tenant max runners checked before scale-up |

## Components

### Tenant Registry (DynamoDB)

The tenant registry stores configuration for each tenant:

```
Table: {prefix}-tenants
Partition Key: installation_id (Number)

Schema:
{
  installation_id: number,      // GitHub App installation ID
  org_name: string,             // GitHub org/user name
  org_type: "Organization" | "User",
  status: "active" | "suspended" | "deleted",
  tier: "small" | "medium" | "large",
  max_runners: number,          // Based on tier
  created_at: string,           // ISO timestamp
  updated_at: string
}

Global Secondary Indexes:
- status-index: For listing active/suspended tenants
- org-name-index: For lookup by org name
```

### Tenant Manager Lambda

Handles GitHub App installation lifecycle events:

- `installation.created` - Creates tenant in DynamoDB
- `installation.deleted` - Marks tenant as deleted, terminates runners
- `installation.suspend` - Suspends tenant
- `installation.unsuspend` - Reactivates tenant

### Runner Tiers

Default tier configuration:

| Tier | Instance Types | Max Runners | Labels |
|------|---------------|-------------|--------|
| small | t3.medium | 2 | `self-hosted, linux, x64, small` |
| medium | t3.large, m5.large | 5 | `self-hosted, linux, x64, medium` |
| large | t3.xlarge, m5.xlarge | 10 | `self-hosted, linux, x64, large` |

Tenants select tiers via workflow labels:

```yaml
jobs:
  build:
    runs-on: [self-hosted, linux, x64, medium]
    steps:
      - uses: actions/checkout@v4
      # ...
```

## Lambda Functions

The Lambda functions are written in [TypeScript](https://www.typescriptlang.org/) and require Node 20.x and yarn. Sources are located in `lambdas/`.

### Install

```bash
cd lambdas
yarn install
```

### Test

```bash
yarn test
```

### Build

```bash
yarn build
```

### Package

```bash
yarn dist
```

## Usage

```hcl
module "multi_tenant_runners" {
  source = "../../modules/multi-tenant-runner"

  prefix     = "my-saas"
  aws_region = "us-east-1"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  github_app = {
    id             = var.github_app_id
    key_base64     = var.github_app_key_base64
    webhook_secret = var.github_app_webhook_secret
  }

  # Customize runner tiers
  runner_tiers = {
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

  eventbridge = {
    enable        = true
    accept_events = ["workflow_job", "installation"]
  }

  tags = {
    Project = "my-saas-runners"
  }
}
```

## Upgrading Tenant Tiers

To upgrade a tenant's tier, update the DynamoDB record:

```bash
aws dynamodb update-item \
  --table-name my-saas-tenants \
  --key '{"installation_id": {"N": "12345678"}}' \
  --update-expression "SET tier = :tier, max_runners = :max, updated_at = :now" \
  --expression-attribute-values '{
    ":tier": {"S": "medium"},
    ":max": {"N": "5"},
    ":now": {"S": "2024-01-15T12:00:00Z"}
  }'
```

## Monitoring

### CloudWatch Metrics

The module emits custom CloudWatch metrics:

- `TenantOnboarded` - New tenant installations
- `TenantUninstalled` - Tenant uninstallations
- `TenantLimitReached` - When a tenant hits their runner limit

### Cost Allocation

All resources are tagged with:

- `ghr:tenant_id` - The installation ID
- `ghr:tenant_tier` - The tier (small/medium/large)
- `ghr:environment` - The deployment prefix

Enable these as cost allocation tags in AWS Cost Explorer for per-tenant billing.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.3.0 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | >= 6.21 |
| <a name="requirement_random"></a> [random](#requirement\_random) | >= 3.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_aws"></a> [aws](#provider\_aws) | >= 6.21 |
| <a name="provider_random"></a> [random](#provider\_random) | >= 3.0 |

## Modules

| Name | Source | Version |
|------|--------|---------|
| <a name="module_runner_binaries"></a> [runner\_binaries](#module\_runner\_binaries) | ../runner-binaries-syncer | n/a |
| <a name="module_runners"></a> [runners](#module\_runners) | ../runners | n/a |
| <a name="module_ssm"></a> [ssm](#module\_ssm) | ../ssm | n/a |
| <a name="module_webhook"></a> [webhook](#module\_webhook) | ../webhook | n/a |

## Resources

| Name | Type |
|------|------|
| [aws_cloudwatch_event_rule.installation](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_event_rule) | resource |
| [aws_cloudwatch_event_target.tenant_manager](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_event_target) | resource |
| [aws_cloudwatch_log_group.tenant_manager](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_group) | resource |
| [aws_dynamodb_table.tenants](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/dynamodb_table) | resource |
| [aws_iam_role.tenant_manager](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role) | resource |
| [aws_iam_role_policy.scale_up_tenant_dynamodb](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) | resource |
| [aws_iam_role_policy.tenant_manager_dynamodb](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) | resource |
| [aws_iam_role_policy.tenant_manager_ec2](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) | resource |
| [aws_iam_role_policy.tenant_manager_ssm](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) | resource |
| [aws_iam_role_policy_attachment.tenant_manager_logs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy_attachment) | resource |
| [aws_iam_service_linked_role.spot](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_service_linked_role) | resource |
| [aws_lambda_function.tenant_manager](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function) | resource |
| [aws_lambda_permission.eventbridge_tenant_manager](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_permission) | resource |
| [aws_sqs_queue.tier_builds](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue) | resource |
| [aws_sqs_queue.tier_builds_dlq](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue) | resource |
| [aws_sqs_queue_policy.build_queue_dlq_policy](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue_policy) | resource |
| [aws_sqs_queue_policy.build_queue_policy](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue_policy) | resource |
| [aws_sqs_queue_redrive_allow_policy.tier_builds_dlq](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue_redrive_allow_policy) | resource |
| [random_string.random](https://registry.terraform.io/providers/hashicorp/random/latest/docs/resources/string) | resource |
| [aws_caller_identity.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/caller_identity) | data source |
| [aws_iam_policy_document.deny_insecure_transport](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |
| [aws_iam_policy_document.lambda_assume_role](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_aws_partition"></a> [aws\_partition](#input\_aws\_partition) | AWS partition (aws, aws-cn, aws-us-gov) | `string` | `"aws"` | no |
| <a name="input_aws_region"></a> [aws\_region](#input\_aws\_region) | AWS region | `string` | n/a | yes |
| <a name="input_create_service_linked_role_spot"></a> [create\_service\_linked\_role\_spot](#input\_create\_service\_linked\_role\_spot) | Create the service-linked role for EC2 Spot. Required for first deployment in an account. | `bool` | `false` | no |
| <a name="input_default_tenant_tier"></a> [default\_tenant\_tier](#input\_default\_tenant\_tier) | Default tier for new tenants when they install the GitHub App | `string` | `"small"` | no |
| <a name="input_enable_ephemeral_runners"></a> [enable\_ephemeral\_runners](#input\_enable\_ephemeral\_runners) | Enable ephemeral runners. Runners will be terminated after each job. | `bool` | `true` | no |
| <a name="input_enable_point_in_time_recovery"></a> [enable\_point\_in\_time\_recovery](#input\_enable\_point\_in\_time\_recovery) | Enable point-in-time recovery for DynamoDB table | `bool` | `true` | no |
| <a name="input_enable_ssm_on_runners"></a> [enable\_ssm\_on\_runners](#input\_enable\_ssm\_on\_runners) | Enable SSM access on runner instances for debugging | `bool` | `false` | no |
| <a name="input_eventbridge"></a> [eventbridge](#input\_eventbridge) | EventBridge configuration | <pre>object({<br/>    enable        = bool<br/>    accept_events = list(string)<br/>  })</pre> | <pre>{<br/>  "accept_events": [<br/>    "workflow_job",<br/>    "installation"<br/>  ],<br/>  "enable": true<br/>}</pre> | no |
| <a name="input_github_app"></a> [github\_app](#input\_github\_app) | GitHub App configuration | <pre>object({<br/>    id                 = optional(string)<br/>    key_base64         = optional(string)<br/>    webhook_secret     = optional(string)<br/>    id_ssm             = optional(object({ arn = string, name = string }))<br/>    key_base64_ssm     = optional(object({ arn = string, name = string }))<br/>    webhook_secret_ssm = optional(object({ arn = string, name = string }))<br/>  })</pre> | n/a | yes |
| <a name="input_instance_target_capacity_type"></a> [instance\_target\_capacity\_type](#input\_instance\_target\_capacity\_type) | Default lifecycle for runner instances: 'spot' or 'on-demand' | `string` | `"spot"` | no |
| <a name="input_kms_key_arn"></a> [kms\_key\_arn](#input\_kms\_key\_arn) | KMS key ARN for encrypting SSM parameters. If null, AWS managed key is used. | `string` | `null` | no |
| <a name="input_lambda_timeout"></a> [lambda\_timeout](#input\_lambda\_timeout) | Lambda timeout in seconds | `number` | `60` | no |
| <a name="input_log_level"></a> [log\_level](#input\_log\_level) | Lambda log level | `string` | `"info"` | no |
| <a name="input_logging_kms_key_id"></a> [logging\_kms\_key\_id](#input\_logging\_kms\_key\_id) | Specifies the KMS key ID to encrypt the logs with. | `string` | `null` | no |
| <a name="input_logging_retention_in_days"></a> [logging\_retention\_in\_days](#input\_logging\_retention\_in\_days) | Specifies the number of days you want to retain log events for the Lambda log group. | `number` | `180` | no |
| <a name="input_prefix"></a> [prefix](#input\_prefix) | Prefix for all resources | `string` | n/a | yes |
| <a name="input_runner_binaries_syncer_lambda_zip"></a> [runner\_binaries\_syncer\_lambda\_zip](#input\_runner\_binaries\_syncer\_lambda\_zip) | Path to the runner-binaries-syncer Lambda zip file | `string` | `null` | no |
| <a name="input_runner_tiers"></a> [runner\_tiers](#input\_runner\_tiers) | Fixed runner tier definitions | <pre>map(object({<br/>    runner_os           = string<br/>    runner_architecture = string<br/>    instance_types      = list(string)<br/>    max_runners         = number<br/>    labels              = list(string)<br/>  }))</pre> | <pre>{<br/>  "large": {<br/>    "instance_types": [<br/>      "t3.xlarge",<br/>      "m5.xlarge"<br/>    ],<br/>    "labels": [<br/>      "self-hosted",<br/>      "linux",<br/>      "x64",<br/>      "large"<br/>    ],<br/>    "max_runners": 10,<br/>    "runner_architecture": "x64",<br/>    "runner_os": "linux"<br/>  },<br/>  "medium": {<br/>    "instance_types": [<br/>      "t3.large",<br/>      "m5.large"<br/>    ],<br/>    "labels": [<br/>      "self-hosted",<br/>      "linux",<br/>      "x64",<br/>      "medium"<br/>    ],<br/>    "max_runners": 5,<br/>    "runner_architecture": "x64",<br/>    "runner_os": "linux"<br/>  },<br/>  "small": {<br/>    "instance_types": [<br/>      "t3.medium"<br/>    ],<br/>    "labels": [<br/>      "self-hosted",<br/>      "linux",<br/>      "x64",<br/>      "small"<br/>    ],<br/>    "max_runners": 2,<br/>    "runner_architecture": "x64",<br/>    "runner_os": "linux"<br/>  }<br/>}</pre> | no |
| <a name="input_runners_lambda_zip"></a> [runners\_lambda\_zip](#input\_runners\_lambda\_zip) | Path to the runners Lambda zip file (control-plane) | `string` | `null` | no |
| <a name="input_scale_down_schedule_expression"></a> [scale\_down\_schedule\_expression](#input\_scale\_down\_schedule\_expression) | Cron expression for scale-down schedule | `string` | `"cron(*/5 * * * ? *)"` | no |
| <a name="input_ssm_paths"></a> [ssm\_paths](#input\_ssm\_paths) | SSM parameter paths | <pre>object({<br/>    root = string<br/>  })</pre> | <pre>{<br/>  "root": "github-action-runners"<br/>}</pre> | no |
| <a name="input_subnet_ids"></a> [subnet\_ids](#input\_subnet\_ids) | List of subnet IDs where runner instances will be launched | `list(string)` | n/a | yes |
| <a name="input_tags"></a> [tags](#input\_tags) | Tags to apply to all resources | `map(string)` | `{}` | no |
| <a name="input_tenant_manager_lambda_zip"></a> [tenant\_manager\_lambda\_zip](#input\_tenant\_manager\_lambda\_zip) | Path to tenant-manager Lambda zip file | `string` | `null` | no |
| <a name="input_vpc_id"></a> [vpc\_id](#input\_vpc\_id) | The VPC ID for runner instances and security groups | `string` | n/a | yes |
| <a name="input_webhook_lambda_zip"></a> [webhook\_lambda\_zip](#input\_webhook\_lambda\_zip) | Path to webhook Lambda zip file | `string` | `null` | no |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_queues"></a> [queues](#output\_queues) | SQS queues for runner tiers |
| <a name="output_runner_binaries"></a> [runner\_binaries](#output\_runner\_binaries) | S3 buckets for runner binaries by OS/architecture |
| <a name="output_runner_tiers"></a> [runner\_tiers](#output\_runner\_tiers) | Configured runner tiers |
| <a name="output_runners"></a> [runners](#output\_runners) | Runner infrastructure for each tier |
| <a name="output_tenant_table"></a> [tenant\_table](#output\_tenant\_table) | DynamoDB table for tenant registry |
| <a name="output_webhook"></a> [webhook](#output\_webhook) | Webhook endpoint configuration |
<!-- END_TF_DOCS -->
