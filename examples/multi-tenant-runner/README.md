# Multi-Tenant Runner Example

This example demonstrates how to deploy a multi-tenant GitHub Actions runner infrastructure suitable for SaaS deployments. Multiple customer organizations can share a single GitHub App while maintaining strict isolation.

## Features

- **Self-Service Onboarding**: Customers install the GitHub App and are automatically provisioned
- **Fixed Runner Tiers**: Small, Medium, and Large tiers with different resource allocations
- **Per-Tenant Limits**: Each tenant has a maximum number of concurrent runners
- **JIT Tokens**: Secure, single-use tokens for runner registration
- **Ephemeral Runners**: Runners terminate after each job for isolation
- **Cost Allocation**: All resources tagged for per-tenant billing

## Prerequisites

1. **AWS Account** with appropriate permissions
2. **GitHub App** created with the following configuration:
   - **Permissions**:
     - Repository: `Actions: Read`, `Metadata: Read`
     - Organization: `Self-hosted runners: Read & Write`
   - **Events**:
     - `Workflow job`
     - `Installation` (for auto-provisioning)
3. **Terraform** >= 1.3.0
4. **Node.js** 20.x and Yarn (for building lambdas)

## Quick Start

### Step 1: Build the Lambda Functions

```bash
cd ../../lambdas
yarn install
yarn build
cd ../examples/multi-tenant-runner
```

Alternatively, download pre-built lambdas:

```bash
cd ../lambdas-download
terraform init
terraform apply -var=module_version=<VERSION>
cd ../multi-tenant-runner
```

### Step 2: Configure Variables

Create a `terraform.tfvars` file:

```hcl
github_app = {
  id         = "123456"                    # Your GitHub App ID
  key_base64 = "LS0tLS1CRUdJTi..."        # Base64-encoded private key
}

aws_region  = "us-east-1"
environment = "my-saas"
```

To get the base64-encoded key:

```bash
cat your-app-private-key.pem | base64 -w 0
```

### Step 3: Deploy

```bash
terraform init
terraform apply
```

### Step 4: Configure GitHub App Webhook

After deployment, get the webhook URL:

```bash
terraform output webhook_endpoint
```

Configure your GitHub App:
1. Go to your GitHub App settings
2. Set the **Webhook URL** to the output value
3. Set the **Webhook secret** (get from `terraform output -raw webhook_secret`)
4. Ensure these events are enabled:
   - `Workflow job`
   - `Installation`

### Step 5: Install the App

Install the GitHub App on a test organization. The tenant will be automatically provisioned in DynamoDB.

### Step 6: Test with a Workflow

Create a workflow file in a repository within the installed org:

```yaml
# .github/workflows/test-runner.yml
name: Test Self-Hosted Runner

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  test:
    runs-on: [self-hosted, linux, x64, small]  # Use small tier
    steps:
      - uses: actions/checkout@v4
      - name: Hello
        run: echo "Hello from self-hosted runner!"
```

Push the workflow or trigger it manually to test.

## Runner Tiers

Tenants select runner tiers via workflow labels:

| Tier | Labels | Instance Types | Max Runners |
|------|--------|---------------|-------------|
| Small | `self-hosted, linux, x64, small` | t3.medium | 2 |
| Medium | `self-hosted, linux, x64, medium` | t3.large, m5.large | 5 |
| Large | `self-hosted, linux, x64, large` | t3.xlarge, m5.xlarge | 10 |

Example workflow for medium tier:

```yaml
jobs:
  build:
    runs-on: [self-hosted, linux, x64, medium]
    steps:
      # ...
```

## Monitoring Tenants

### List Active Tenants

```bash
aws dynamodb scan \
  --table-name my-saas-tenants \
  --filter-expression "#s = :active" \
  --expression-attribute-names '{"#s": "status"}' \
  --expression-attribute-values '{":active": {"S": "active"}}'
```

### Check Tenant Details

```bash
aws dynamodb get-item \
  --table-name my-saas-tenants \
  --key '{"installation_id": {"N": "12345678"}}'
```

### Upgrade Tenant Tier

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

### View Running Runners by Tenant

```bash
aws ec2 describe-instances \
  --filters "Name=tag:ghr:tenant_id,Values=12345678" \
            "Name=instance-state-name,Values=running,pending" \
  --query 'Reservations[].Instances[].{ID:InstanceId,State:State.Name,LaunchTime:LaunchTime}'
```

## Cost Allocation

All resources are tagged with:

- `ghr:tenant_id` - Installation ID (for per-tenant billing)
- `ghr:tenant_tier` - Tier name (for tier-based analysis)
- `ghr:environment` - Deployment prefix

To enable cost allocation:

1. Go to AWS Billing → Cost Allocation Tags
2. Activate the tags: `ghr:tenant_id`, `ghr:tenant_tier`
3. Wait 24 hours for tags to appear in Cost Explorer

## Customization

### Custom Tiers

Modify the `runner_tiers` variable in `main.tf`:

```hcl
runner_tiers = {
  starter = {
    runner_os           = "linux"
    runner_architecture = "x64"
    instance_types      = ["t3.small"]
    max_runners         = 1
    labels              = ["self-hosted", "linux", "x64", "starter"]
  }
  pro = {
    runner_os           = "linux"
    runner_architecture = "x64"
    instance_types      = ["m5.xlarge", "c5.xlarge"]
    max_runners         = 20
    labels              = ["self-hosted", "linux", "x64", "pro"]
  }
  enterprise = {
    runner_os           = "linux"
    runner_architecture = "x64"
    instance_types      = ["m5.2xlarge", "c5.2xlarge"]
    max_runners         = 50
    labels              = ["self-hosted", "linux", "x64", "enterprise"]
  }
}
```

### ARM64 Runners

Add ARM64 tiers:

```hcl
runner_tiers = {
  # ... existing tiers ...

  "arm64-medium" = {
    runner_os           = "linux"
    runner_architecture = "arm64"
    instance_types      = ["t4g.large", "m6g.large"]
    max_runners         = 5
    labels              = ["self-hosted", "linux", "arm64", "medium"]
  }
}
```

## Troubleshooting

### Tenant Not Provisioning

Check the Tenant Manager Lambda logs:

```bash
aws logs tail /aws/lambda/my-saas-tenant-manager --follow
```

### Jobs Not Starting

1. Check webhook Lambda logs:
   ```bash
   aws logs tail /aws/lambda/my-saas-webhook --follow
   ```

2. Verify tenant is active:
   ```bash
   aws dynamodb get-item \
     --table-name my-saas-tenants \
     --key '{"installation_id": {"N": "YOUR_INSTALLATION_ID"}}'
   ```

3. Check SQS queue for messages:
   ```bash
   aws sqs get-queue-attributes \
     --queue-url https://sqs.us-east-1.amazonaws.com/123456789/my-saas-small-builds \
     --attribute-names ApproximateNumberOfMessages
   ```

### Tenant At Runner Limit

Check current runners:

```bash
aws ec2 describe-instances \
  --filters "Name=tag:ghr:tenant_id,Values=YOUR_INSTALLATION_ID" \
            "Name=instance-state-name,Values=running,pending" \
  --query 'length(Reservations[].Instances[])'
```

Upgrade the tenant tier or wait for runners to complete.

## Clean Up

To destroy all resources:

```bash
terraform destroy
```

Note: This will terminate all running runners and delete the tenant registry.

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
| random | >= 3.0 |

## Modules

| Name | Source | Version |
|------|--------|---------|
| base | ../base | n/a |
| runners | ../../modules/multi-tenant-runner | n/a |

## Resources

| Name | Type |
|------|------|
| random_id.random | resource |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| github_app | GitHub App configuration | `object({ id = string, key_base64 = string })` | n/a | yes |
| environment | Environment name | `string` | `null` | no |
| aws_region | AWS region | `string` | `"us-east-1"` | no |

## Outputs

| Name | Description |
|------|-------------|
| webhook_endpoint | Webhook URL for GitHub App configuration |
| tenant_table | DynamoDB table details for tenant registry |
| runner_tiers | Configured runner tiers |
| queues | SQS queues for each tier |
<!-- END_TF_DOCS -->
