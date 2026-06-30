/**
 * Deployment Tracker
 *
 * After Fritz auto-merges a PR, creates or updates a per-repo GitHub issue
 * tracking all undeployed changes. Closing the issue = deployed.
 *
 * Config:
 *   fritz.yaml repos.<repo>.deployment-tracker: false   → opt-out
 *   fritz.yaml daemon.staleDeploymentReminderDays: N    → stale threshold (default: 3)
 *
 * @see Issue #636
 */

import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gh } from '../github/github.js';
import { config } from '../config.js';
import { getDaemonConfig, getRepoConfig, getAllRepoConfigs } from './fritz-config.js';
import * as lifecycle from '../core/lifecycle.js';

export interface DeploymentTrackerOptions {
  repo: string;         // Target repo (e.g., "your-org/fritZ")
  prNumber: number;     // PR that was just merged
  prTitle: string;      // PR title (for checklist entry)
  prLabels: string[];   // PR labels (hotfix detection, revert detection)
  mergedAt: string;     // ISO date string (YYYY-MM-DD)
}

interface ExistingIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
}

const SECTION_HEADER = '## PRs merged since last deploy';

function log(message: string): void {
  console.log(`[deployment-tracker] ${new Date().toISOString()} ${message}`);
}

/**
 * Creates or updates the deployment-pending issue for the given repo.
 * No-op if deployment-tracker is disabled for this repo.
 * Best-effort — never throws.
 */
export function createOrUpdateDeploymentIssue(opts: DeploymentTrackerOptions): void {
  try {
    // Check per-repo opt-out
    const repoConfig = getRepoConfig(opts.repo);
    if (repoConfig.deploymentTracker === false) {
      log(`Skipping ${opts.repo} — deployment-tracker disabled`);
      return;
    }

    const isRollback = opts.prTitle.startsWith('Revert') || opts.prLabels.includes('revert');
    const isHotfix = opts.prLabels.includes('hotfix') || opts.prLabels.includes('priority:p0');

    const prefix = isRollback ? '⚠️ ROLLBACK: ' : '';
    const entry = `- [ ] #${opts.prNumber} — ${prefix}${opts.prTitle} (merged ${opts.mergedAt})`;

    // Search for existing open deployment-pending issue
    const existing = findDeploymentIssue(opts.repo);

    if (existing) {
      appendToDeploymentIssue(existing, entry, isHotfix, opts.repo);
    } else {
      createDeploymentIssue(opts.repo, entry, isHotfix);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Failed to update deployment issue for ${opts.repo}: ${msg}`);
  }
}

function findDeploymentIssue(repo: string): ExistingIssue | null {
  try {
    const result = gh(
      `issue list --label "deployment-pending" --state open --json number,title,body,labels --repo ${repo}`
    );
    const issues: ExistingIssue[] = JSON.parse(result || '[]');
    return issues.length > 0 ? issues[0] : null;
  } catch {
    return null;
  }
}

function createDeploymentIssue(repo: string, entry: string, isHotfix: boolean): void {
  const isFritZ = repo === config.githubRepo;
  const body = buildIssueBody(repo, [entry], isHotfix, isFritZ);
  const labels = isHotfix ? 'deployment-pending,priority:p0' : 'deployment-pending';

  // Write body to temp file to avoid shell escaping issues
  const tmpFile = join(tmpdir(), `deployment-issue-${Date.now()}.md`);

  try {
    writeFileSync(tmpFile, body, 'utf-8');
    gh(
      `issue create --title "Deployment pending — ${repo}" --body-file "${tmpFile}" --label "${labels}" --assignee your-org --repo ${repo}`
    );
    log(`Created deployment issue for ${repo}`);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* best effort cleanup */ }
  }
}

function appendToDeploymentIssue(
  issue: ExistingIssue,
  entry: string,
  isHotfix: boolean,
  repo: string,
): void {
  let body = issue.body;

  // Find the section header and append after the last checklist item
  const sectionIdx = body.indexOf(SECTION_HEADER);
  if (sectionIdx !== -1) {
    // Find the end of the checklist: last "- [ ]" or "- [x]" line after the header
    const afterHeader = body.slice(sectionIdx + SECTION_HEADER.length);
    const lines = afterHeader.split('\n');
    let insertAfterLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('- [')) {
        insertAfterLine = i;
      }
    }
    // Insert the new entry after the last checklist item
    lines.splice(insertAfterLine + 1, 0, entry);
    body = body.slice(0, sectionIdx + SECTION_HEADER.length) + lines.join('\n');
  } else {
    // Section not found — append a new section
    body += `\n\n${SECTION_HEADER}\n\n${entry}`;
  }

  // If hotfix, prepend urgent banner
  if (isHotfix) {
    if (!body.includes('⚠️ URGENT — Hotfix pending deployment')) {
      const banner = `## ⚠️ URGENT — Hotfix pending deployment\n\nThis deployment includes a hotfix PR. Deploy as soon as possible.\n\n---\n\n`;
      body = banner + body;
    }
  }

  // Write body to temp file to avoid shell escaping issues
  const tmpFile = join(tmpdir(), `deployment-issue-${Date.now()}.md`);

  try {
    writeFileSync(tmpFile, body, 'utf-8');
    // Combine body update + label add into a single API call (≤2 calls total: search + edit)
    const hasP0 = issue.labels.some(l => l.name === 'priority:p0');
    const labelFlag = isHotfix && !hasP0 ? ' --add-label "priority:p0"' : '';
    gh(`issue edit ${issue.number} --body-file "${tmpFile}"${labelFlag} --repo ${repo}`);
    log(`Updated deployment issue #${issue.number} for ${repo}`);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* best effort cleanup */ }
  }
}

export function buildIssueBody(
  repo: string,
  entries: string[],
  isHotfix: boolean,
  isFritZ: boolean,
): string {
  const lines: string[] = [];

  if (isHotfix) {
    lines.push('## ⚠️ URGENT — Hotfix pending deployment');
    lines.push('');
    lines.push('This deployment includes a hotfix PR. Deploy as soon as possible.');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push(`## Deployment pending — ${repo}`);
  lines.push('');

  if (isFritZ) {
    lines.push('> ⚠️ **fritZ pre-deploy checklist** — check before deploying:');
    lines.push('> - [ ] No active agents running (`fritz status`)');
    lines.push('> - [ ] Confirm rollback plan for daemon restart');
    lines.push('');
  }

  lines.push('Only @your-org (owner) can trigger a deployment.');
  const deployWorkflow = getDaemonConfig().deployWorkflow;
  lines.push(`To deploy: \`gh workflow run "${deployWorkflow}" --repo ${repo}\``);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(SECTION_HEADER);
  lines.push('');
  lines.push(...entries);

  return lines.join('\n');
}

// ============================================================================
// Stale Deployment Check
// ============================================================================

// In-memory cooldown: repo → last reminder timestamp.
// Resets on daemon restart — a stale reminder may fire once on restart even if
// one was recently sent. This is acceptable for a best-effort notification.
const lastReminderSent = new Map<string, number>();
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Checks all repos with open deployment-pending issues.
 * Sends a Telegram critical reminder for any open > staleDeploymentReminderDays.
 * Cooldown: at most one reminder per 24 hours per repo.
 */
export async function checkStaleDeploymentIssues(): Promise<void> {
  const daemonConfig = getDaemonConfig();
  const thresholdDays = daemonConfig.staleDeploymentReminderDays;

  // Collect repos to check: config.githubRepo + any repos with deployment-tracker enabled
  const reposToCheck = new Set<string>();
  if (config.githubRepo) {
    const mainRepoConfig = getRepoConfig(config.githubRepo);
    if (mainRepoConfig.deploymentTracker !== false) {
      reposToCheck.add(config.githubRepo);
    }
  }

  for (const [repoName, repoConf] of Object.entries(getAllRepoConfigs())) {
    if (repoConf.deploymentTracker !== false) {
      reposToCheck.add(repoName);
    }
  }

  for (const repo of reposToCheck) {
    try {
      const result = gh(
        `issue list --label "deployment-pending" --state open --json number,createdAt,url --repo ${repo}`
      );
      const issues: Array<{ number: number; createdAt: string; url: string }> = JSON.parse(result || '[]');

      for (const issue of issues) {
        const createdAt = new Date(issue.createdAt);
        const ageDays = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

        if (ageDays >= thresholdDays) {
          // Check cooldown
          const lastSent = lastReminderSent.get(repo);
          if (lastSent && Date.now() - lastSent < REMINDER_COOLDOWN_MS) {
            continue;
          }

          try {
            await lifecycle.staleDeploymentReminder(repo, issue.url, ageDays);
            lastReminderSent.set(repo, Date.now());
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`Stale reminder failed for ${repo}: ${errMsg}`);
          }
        }
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`Stale check failed for ${repo}: ${msg}`);
    }
  }
}

// Re-export for testing
export { lastReminderSent as _lastReminderSent };
