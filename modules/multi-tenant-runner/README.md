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
| terraform | >= 1.3.0 |
| aws | >= 5.0 |
| random | >= 3.0 |

## Providers

| Name | Version |
|------|---------|
| aws | >= 5.0 |
| random | >= 3.0 |

## Modules

| Name | Source | Version |
|------|--------|---------|
| ssm | ../ssm | n/a |
| webhook | ../webhook | n/a |

## Resources

| Name | Type |
|------|------|
| aws_dynamodb_table.tenants | resource |
| aws_sqs_queue.tier_builds | resource |
| aws_sqs_queue.tier_builds_dlq | resource |
| aws_lambda_function.tenant_manager | resource |
| aws_cloudwatch_event_rule.installation | resource |
| aws_cloudwatch_event_target.tenant_manager | resource |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| prefix | Prefix for all resources | `string` | n/a | yes |
| aws_region | AWS region | `string` | n/a | yes |
| vpc_id | VPC ID for runners | `string` | n/a | yes |
| subnet_ids | Subnet IDs for runners | `list(string)` | n/a | yes |
| github_app | GitHub App configuration | `object` | n/a | yes |
| runner_tiers | Fixed runner tier definitions | `map(object)` | See defaults | no |
| eventbridge | EventBridge configuration | `object` | `{ enable = true, accept_events = ["workflow_job", "installation"] }` | no |
| tags | Tags to apply to all resources | `map(string)` | `{}` | no |

## Outputs

| Name | Description |
|------|-------------|
| tenant_table | DynamoDB table for tenant registry |
| webhook | Webhook endpoint configuration |
| runner_tiers | Configured runner tiers |
| queues | SQS queues for runner tiers |
<!-- END_TF_DOCS -->
