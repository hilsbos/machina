# Deployment Tracker

## What It Does

After fritZ auto-merges a PR, the deployment tracker creates or updates a single GitHub issue per repo titled **"Deployment pending — \<repo\>"**. This issue serves as the authoritative list of what's in `main` but not yet deployed.

## Key Concepts

- **One open issue per repo** — subsequent merges append checklist entries, not create new issues
- **Close = deployed** — closing the issue is the only "deployed" signal; fritZ does **not** auto-close it
- **Best-effort** — tracker failures never block the merge flow
- **Label:** `deployment-pending` on all tracker issues
- **Assigned to:** `@your-org` (sole deployer)

## Pre-Deploy Checklist (fritZ repo only)

When the deployment issue is for the fritZ repo itself, the issue body includes:

1. **No active agents running** — verify with `fritz status` before deploying (daemon restart kills agents)
2. **Confirm rollback plan** — know how to revert the daemon if something goes wrong

## Hotfix & Rollback Detection

- **Hotfix PRs** (label `hotfix` or `priority:p0`): issue gets `priority:p0` label + urgent banner
- **Rollback PRs** (title starts with "Revert" or label `revert`): checklist entry prefixed with `⚠️ ROLLBACK:`

## Stale Deployment Reminder

If a deployment-pending issue remains open longer than `daemon.staleDeploymentReminderDays` (default: 3 days), fritZ sends a Telegram notification at critical level (bypasses quiet mode). Cooldown: at most one reminder per 24 hours per repo.

## Configuration

```yaml
# fritz.yaml

daemon:
  staleDeploymentReminderDays: 3  # Days before stale reminder fires (default: 3)

repos:
  your-org/some-repo:
    deployment-tracker: false     # Opt out of deployment tracking for this repo
```
