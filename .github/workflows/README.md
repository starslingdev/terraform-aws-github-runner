# GitHub Workflows

This document describes the GitHub Actions workflows in this repository, including what configuration is required to enable them in a fork.

## Quick Reference

| Workflow | Trigger | Safe to Enable | Action Required |
|----------|---------|----------------|-----------------|
| codeql.yml | push/PR, schedule | Yes | Requires GHAS for private repos |
| dependency-review.yml | PR | Yes | None |
| lambda.yml | PR (lambdas paths) | Yes | None |
| ossf-scorecard.yml | push (main), schedule | Yes | May be unnecessary for private forks |
| ovs.yml | PR, merge_group | Yes | None |
| packer-build.yml | push/PR (image paths) | Yes | None |
| release.yml | push (main/v1), dispatch | **No** | Requires GitHub App credentials |
| semantic-check.yml | pull_request_target | Yes | None |
| stale.yml | schedule, dispatch | Yes* | Consider disabling initially |
| terraform.yml | push/PR (tf paths) | Yes | None |
| update-docs.yml | push (tf/md paths) | Yes* | Has known bug; gracefully degrades in forks |
| zizmor.yml | push/PR (workflow paths) | Yes | Requires code scanning features |

## Required Secrets and Variables

### Custom Configuration Required

These credentials are only needed if you want to use the automated release workflow:

| Name | Type | Workflow | Line | Purpose |
|------|------|----------|------|---------|
| `RELEASER_APP_ID` | Variable | release.yml | 45 | GitHub App ID for automated releases |
| `RELEASER_APP_PRIVATE_KEY` | Secret | release.yml | 46 | GitHub App private key for releases |

**To configure:** Go to Repository Settings > Secrets and variables > Actions

#### Releaser App vs Runner App

The Releaser App is **separate** from the GitHub App used by the runner infrastructure:

| App | Purpose | Where Configured | Required Permissions |
|-----|---------|------------------|---------------------|
| **Runner App** | Authenticates self-hosted runners, receives webhooks, registers/deregisters runners | SSM Parameter Store (Terraform module) | `administration:write`, `checks:read`, `actions:read` |
| **Releaser App** | Automates creating releases and PRs for this repository | Repository secrets/variables | `contents:write`, `pull-requests:write`, `actions:write` |

**Why separate apps?**
- Different permissions for different purposes (principle of least privilege)
- The Runner App is used by EC2 instances (broader attack surface)
- Separate apps allow independent credential rotation
- If you don't need automated releases, you can skip the Releaser App entirely

### Auto-Provided (No Configuration Needed)

| Name | Used By |
|------|---------|
| `GITHUB_TOKEN` | packer-build.yml, release.yml, update-docs.yml, semantic-check.yml, terraform.yml |

The `GITHUB_TOKEN` is automatically provided by GitHub Actions and requires no setup.

## Workflow Details

### codeql.yml
- **Purpose:** CodeQL security scanning for JavaScript/TypeScript and Actions
- **Triggers:** Push/PR to main, develop, v1; weekly schedule
- **Requirements:** GitHub Advanced Security (GHAS) for private repositories
- **Permissions:** `contents: read`, `security-events: write`

### dependency-review.yml
- **Purpose:** Scans PR dependencies for vulnerabilities
- **Triggers:** Pull requests only
- **Requirements:** None
- **Permissions:** `contents: read`, `pull-requests: write`

### lambda.yml
- **Purpose:** Runs tests and builds for Lambda functions
- **Triggers:** PRs to main when `lambdas/**` files change
- **Requirements:** None (runs in container)
- **Permissions:** `contents: read`

### ossf-scorecard.yml
- **Purpose:** OSSF Scorecard security assessment
- **Triggers:** Push to main, weekly schedule, branch protection changes
- **Requirements:** OIDC token for publishing results
- **Permissions:** `contents: read`, `security-events: write`, `id-token: write`

### ovs.yml
- **Purpose:** OSV vulnerability scanning
- **Triggers:** PRs and merge_group to main
- **Requirements:** None (uses external reusable workflow)
- **Permissions:** `actions: read`, `security-events: write`, `contents: read`

### packer-build.yml
- **Purpose:** Validates Packer configurations (init/fmt/validate only)
- **Triggers:** Push to main, PRs when image files change
- **Requirements:** None (no AWS credentials needed for validation)
- **Permissions:** `contents: read`

### release.yml
- **Purpose:** Automated releases with attestations
- **Triggers:** Push to main/v1, workflow_dispatch
- **Requirements:**
  - `vars.RELEASER_APP_ID` - GitHub App ID
  - `secrets.RELEASER_APP_PRIVATE_KEY` - GitHub App private key
- **Permissions:** `contents: write`, `actions: write`, `id-token: write`, `attestations: write`
- **Note:** This workflow will fail without the GitHub App credentials configured

### semantic-check.yml
- **Purpose:** Validates PR titles follow conventional commit format
- **Triggers:** pull_request_target (opened, edited, synchronize)
- **Requirements:** None
- **Permissions:** `contents: read`, `pull-requests: read`

### stale.yml
- **Purpose:** Auto-labels and closes stale issues/PRs
- **Triggers:** Daily schedule (01:30 UTC), workflow_dispatch
- **Configuration:** 90 days until stale, 14 days until close
- **Requirements:** None
- **Permissions:** `issues: write`, `pull-requests: write`

### terraform.yml
- **Purpose:** Terraform linting and validation
- **Triggers:** Push to main, PRs when .tf/.hcl files change
- **Requirements:** None (uses TFLint)
- **Permissions:** `contents: read`

### update-docs.yml
- **Purpose:** Auto-generates Terraform documentation and deploys to GitHub Pages
- **Triggers:** Push when .tf/.md files change
- **Requirements:** None for forks (org check skips PR creation)
- **Permissions:** `contents: write`, `pull-requests: write`

### zizmor.yml
- **Purpose:** Security scanning for GitHub Actions workflows
- **Triggers:** Push/PR when workflow files change
- **Requirements:** Code scanning features
- **Permissions:** `contents: read`, `actions: read`, `security-events: write`

## Known Issues

### update-docs.yml - PR Base Reference Bug (Line 64)

```yaml
base: ${{ github.event.pull_request.base.ref }}
```

This line references `github.event.pull_request.base.ref` but the workflow triggers on `push` events, where this value is undefined. The PR creation step only runs for the upstream org (`github-aws-runners`), so forks are unaffected.

### semantic-check.yml - pull_request_target Usage

Uses `pull_request_target` instead of `pull_request`. This trigger runs with repository write permissions. Currently safe because:
- Only reads PR metadata (title, labels)
- Does not execute code from the PR
- Minimal permissions: `contents: read`, `pull-requests: read`

**Warning:** If this workflow is modified to checkout or execute PR code, it becomes a security risk.

## Recommended Actions for Forks

### Must Disable (Requires Configuration)

1. **release.yml** - Requires GitHub App credentials. Either:
   - Disable the workflow, OR
   - Create your own GitHub App and configure the secrets/variables

### Consider Disabling Initially

2. **stale.yml** - Will auto-close issues and PRs after inactivity. You may want to disable this until your fork is actively maintained.

### Enable If GHAS Available

3. **codeql.yml**, **ossf-scorecard.yml**, **zizmor.yml** - These security scanning workflows require GitHub Advanced Security features for private repositories. They will work automatically for public repos.

### Works Without Changes

All other workflows will function correctly in a fork without any configuration changes.

## Security Notes

- All actions are pinned to specific commit SHAs (good security practice)
- `step-security/harden-runner` is used consistently across workflows
- MkDocs requirements use hash verification (update-docs.yml)
