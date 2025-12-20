# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Terraform module for self-hosted, auto-scaling GitHub Actions runners on AWS. Runners are created on-demand using AWS spot instances, scale to zero when idle, and are ephemeral (terminated after each job). Supports Linux (x64/arm64) and Windows, GitHub.com and GitHub Enterprise Server.

## Common Commands

### Terraform
```bash
terraform init                    # Initialize modules (required before linting)
terraform fmt -recursive          # Format all .tf files
terraform validate                # Validate configuration
```

### Lambda Development (run from `lambdas/` directory)
```bash
yarn install                      # Install dependencies
yarn build                        # Build all functions and libs
yarn test                         # Run all tests
yarn lint                         # Lint all code
yarn format                       # Format all TypeScript files
yarn format-check                 # Check formatting

# Nx commands for targeted builds
yarn nx run <project>:test        # Run tests for specific project
yarn nx run <project>:build       # Build specific project
yarn affected:test                # Test only affected packages
yarn affected:build               # Build only affected packages
```

### Pre-commit Hooks
```bash
pre-commit install                # Install hooks
pre-commit run --all-files        # Run all hooks manually
```

## Architecture

### Terraform Modules (`modules/`)
- **webhook** - API Gateway + Lambda receiving GitHub webhook events, dispatches to SQS
- **runners** - Scale-up/down Lambda functions, EC2 launch templates, manages runner lifecycle
- **runner-binaries-syncer** - Syncs GitHub Actions runner binaries to S3
- **ssm** - SSM Parameter Store for GitHub App credentials
- **ami-housekeeper** - Cleans up old AMIs
- **termination-watcher** - Handles EC2 spot termination notices
- **multi-runner** - Orchestrates multiple runner configurations
- **download-lambda** - Downloads pre-built Lambda artifacts

### Lambda Functions (`lambdas/functions/`)
- **webhook** - Receives GitHub workflow_job events, validates signatures, queues jobs
- **control-plane** - Scale-up (creates EC2 instances) and scale-down (terminates idle runners)
- **gh-agent-syncer** - Downloads and syncs GitHub runner binaries
- **ami-housekeeper** - Cleans up old AMIs based on configuration
- **termination-watcher** - Monitors and handles spot instance terminations

### Lambda Libraries (`lambdas/libs/`)
- **aws-powertools-util** - Shared AWS Lambda Powertools configuration
- **aws-ssm-util** - SSM parameter fetching utilities

### Event Flow
1. GitHub sends `workflow_job` webhook → API Gateway → webhook Lambda
2. Webhook validates signature, matches runner labels, puts message on SQS
3. SQS triggers scale-up Lambda → creates EC2 runner via Fleet API
4. Runner registers with GitHub, executes job, self-terminates (ephemeral)
5. Scale-down Lambda runs on schedule, terminates idle non-ephemeral runners

## Development Requirements

- Terraform >= 1.3.0
- Node.js with Yarn 4.x (see `packageManager` in `lambdas/package.json`)
- Pre-commit hooks: tflint, terraform_fmt
- AWS provider >= 6.21

## Key Configuration Patterns

- GitHub App credentials stored in SSM Parameter Store
- Lambdas use arm64 architecture by default for cost optimization
- Lambda runtime: nodejs24.x
- Runners use spot instances by default (configurable to on-demand)
- EventBridge enabled by default for event routing
