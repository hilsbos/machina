/**
 * Auto-orchestration loop - watches GitHub and spawns agents automatically
 *
 * Monitors issues in actionable states and triggers the appropriate agents:
 * - for-define → define agent
 * - for-implement → implement agent
 * - for-architect → architect agent
 * - for-ux → ux agent
 * - for-budget → budget agent
 * - for-review → review agent
 * - for-validate → validate agent
 * - for-security-review → security-review agent
 * - for-pentest → pentest agent
 * - for-rework → implement agent (for fixes)
 * - for-merge → CI check + merge PR (no agent spawned)
 * - discussion → next agent in turn
 */

import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import * as github from '../github/github.js';
import * as agents from './agents.js';
import * as registry from '../core/registry.js';
import * as lifecycle from '../core/lifecycle.js';
import { escapeMd } from '../telegram/telegram-helpers.js';
import { logEvent } from '../core/event-log.js';
import type { AgentRole } from '../types.js';
import {
  sortByPriority,
} from './priority-utils.js';
import * as usageMonitor from './usage-monitor.js';
import { getUsageConfig, getAutoloopConfig } from './fritz-config.js';
import { getTargetRepo as getTargetRepoFromLabels } from './repo-gate.js';
import * as graphql from '../github/github-graphql.js';
import type { CachedIssue } from '../github/github-graphql.js';
import { isRateLimited } from '../github/github-cache.js';
import * as deploymentTracker from './deployment-tracker.js';
import * as deferralTracker from './deferral-tracker.js';

// Re-export deferral state as ReadonlyMap for dashboard/debugging visibility
export const getDeferralState: () => ReadonlyMap<number, string> = deferralTracker.getDeferralState;

let loopInterval: NodeJS.Timeout | null = null;
let isProcessing = false;
let cycleCount = 0;

// Track issues whose PR mergeable status was UNKNOWN, to allow a single retry next cycle.
// Key: issue number, Value: cycle in which UNKNOWN was first seen.
const mergeableRetries = new Map<number, number>();

// Track reported cycles to avoid duplicate GitHub comments.
// Key: sorted cycle string (e.g. "610,612,614,615,622"), Value: timestamp.
// Note: stale entries (for broken cycles) are never pruned. This is intentional —
// the map stays small (few unique cycles) and the daemon restarts periodically.
export const reportedCycles = new Map<string, number>();
export const CYCLE_REPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// Cache of issues found in the last check cycle (exported for dashboard)
let lastKnownQueue: Array<{ number: number; labels: string[]; title?: string }> = [];

// Queue change listeners (used by dashboard SSE)
type QueueChangeCallback = () => void;
const queueListeners = new Set<QueueChangeCallback>();

/** Subscribe to queue cache updates. Returns an unsubscribe function. */
export function onQueueChange(callback: QueueChangeCallback): () => void {
  queueListeners.add(callback);
  return () => { queueListeners.delete(callback); };
}

// File-based pause flag — persistent across daemon restarts.
// Resolved at call time (not module scope) so tests can override config.workspacesDir.
function getPauseFile(): string {
  return join(config.workspacesDir, 'autoloop.paused');
}

/** Loop interval in seconds — configured in fritz.yaml autoloop.intervalSec */
export function getLoopInterval(): number {
  return getAutoloopConfig().intervalSec;
}

function log(message: string): void {
  console.log(`[autoloop] ${new Date().toISOString()} ${message}`);
}

// Check if an agent is already working on this issue
function hasActiveAgent(issue: number): boolean {
  const localAgents = registry.listAgents();
  return localAgents.some(a => a.issue === issue);
}

/** Resolves the target repo for an issue from its labels (delegates to repo-gate.ts). */
function getTargetRepo(labels: string[]): string {
  return getTargetRepoFromLabels(labels, config.githubRepo ?? 'default');
}

// Check if an issue's dependencies are all resolved.
// Accepts optional pre-fetched labels to avoid redundant API calls.
function areDependenciesMet(issue: number, labels?: string[]): boolean {
  const deps = labels
    ? github.parseDependenciesFromLabels(labels)
    : github.getDependencies(issue);
  if (deps.length === 0) return true;

  for (const dep of deps) {
    if (!github.isDependencyClosed(dep)) {
      const reason = `fritz.depends-on:#${dep} not closed`;
      if (deferralTracker.trackDeferral(issue, reason)) {
        log(`AGENT-DEFERRED issue #${issue} — ${reason}`);
      }
      return false;
    }
  }
  return true;
}

// Process a single issue based on its status.
// For 'defined' and 'validated' statuses, pre-fetches labels once and passes
// them to both dependency and auto-pipeline checks to avoid redundant API calls.
// When usagePausedP0Only is true, only P0 issues are processed.
async function processIssue(issue: number, status: string, labels: string[] = []): Promise<void> {
  // Skip if already has an active agent
  if (hasActiveAgent(issue)) {
    log(`#${issue}: Skipped (agent already active)`);
    return;
  }

  // For auto-pipeline statuses, pre-fetch labels to avoid double API calls
  if (status === 'defined' || status === 'validated') {
    const freshLabels = github.getIssueLabels(issue);

    // Check dependencies using pre-fetched labels
    if (!areDependenciesMet(issue, freshLabels)) return;

    // Check auto-pipeline using pre-fetched labels
    if (status === 'defined') {
      await handleAutoPipelineDefined(issue, freshLabels);
    } else {
      await handleAutoPipelineValidated(issue, freshLabels);
    }
    return;
  }

  // Check fritz.depends-on labels before spawning any agent
  if (!areDependenciesMet(issue, labels)) {
    return;
  }

  log(`Processing #${issue} (status: ${status})`);

  // Direct status → agent mapping using for-{role} pattern
  switch (status) {
    case 'for-define':
      await spawnIfNoAgent(issue, 'define');
      break;

    case 'for-implement':
      await spawnIfNoAgent(issue, 'implement');
      break;

    case 'for-architect':
      await spawnIfNoAgent(issue, 'architect');
      break;

    case 'for-ux':
      await spawnIfNoAgent(issue, 'ux');
      break;

    case 'for-budget':
      await spawnIfNoAgent(issue, 'budget');
      break;

    case 'for-review':
      await handleForReview(issue, labels);
      break;

    case 'for-validate':
      await spawnIfNoAgent(issue, 'validate');
      break;

    case 'for-rework':
      // Rework always goes back to implement - agent reads PR/issue comments to understand what needs fixing
      await spawnIfNoAgent(issue, 'implement');
      break;

    case 'for-security-review':
      await spawnIfNoAgent(issue, 'security-review');
      break;

    case 'for-pentest':
      await spawnIfNoAgent(issue, 'pentest');
      break;

    case 'for-merge':
      await handleForMerge(issue, labels);
      break;

    case 'discussion':
      await handleDiscussion(issue);
      break;
  }
}

// Handle 'for-review' status: check PR merge conflicts before spawning review agent.
// If PR is CONFLICTING → transition to for-rework with conflict details.
// If UNKNOWN → retry once next cycle. If MERGEABLE or no PR → proceed as normal.
async function handleForReview(issue: number, labels: string[]): Promise<void> {
  const targetRepo = getTargetRepo(labels);
  let pr: ReturnType<typeof github.findIssuePR>;
  try {
    pr = github.findIssuePR(issue, targetRepo);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`#${issue}: Failed to look up PR: ${msg} — will retry next cycle`);
    return; // Treat as transient, retry next cycle
  }

  if (!pr) {
    // No PR yet — proceed as normal (agent may still be pushing)
    await spawnIfNoAgent(issue, 'review');
    return;
  }

  let mergeableStatus: string;
  try {
    mergeableStatus = github.getPRMergeableStatus(pr.number, targetRepo);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`#${issue}: Failed to check mergeable status for PR #${pr.number}: ${msg} — proceeding with review`);
    await spawnIfNoAgent(issue, 'review');
    return;
  }

  switch (mergeableStatus) {
    case 'MERGEABLE':
      mergeableRetries.delete(issue);
      await spawnIfNoAgent(issue, 'review');
      return;

    case 'UNKNOWN': {
      // GitHub is still computing — allow one retry next cycle
      const firstSeen = mergeableRetries.get(issue);
      if (firstSeen === undefined) {
        mergeableRetries.set(issue, cycleCount);
        log(`#${issue}: PR #${pr.number} mergeable status UNKNOWN — will retry next cycle`);
        return;
      }
      // Already retried once — treat as MERGEABLE and proceed (don't block indefinitely)
      log(`#${issue}: PR #${pr.number} mergeable status still UNKNOWN after retry — proceeding with review`);
      mergeableRetries.delete(issue);
      await spawnIfNoAgent(issue, 'review');
      return;
    }

    case 'CONFLICTING': {
      mergeableRetries.delete(issue);
      log(`#${issue}: PR #${pr.number} has merge conflicts — sending to rework agent for rebase`);

      // Gather conflict context for the rework agent
      const prFiles = github.getPRFiles(pr.number, targetRepo);
      const otherPRs = github.listOpenPRsWithFiles(targetRepo)
        .filter(p => p.number !== pr.number);

      // Find which other PRs touch the same files
      const conflictingPRs: Array<{ number: number; sharedFiles: string[] }> = [];
      for (const other of otherPRs) {
        const sharedFiles = prFiles.filter(f => other.files.includes(f));
        if (sharedFiles.length > 0) {
          conflictingPRs.push({ number: other.number, sharedFiles });
        }
      }

      let comment = `⚠️ **Merge Conflict — Rebase Required**\n\n`;
      comment += `PR #${pr.number} has merge conflicts and needs rebasing onto \`${pr.baseRefName}\`.\n\n`;

      if (prFiles.length > 0) {
        comment += `**Files in this PR:**\n`;
        for (const f of prFiles) {
          comment += `- \`${f}\`\n`;
        }
        comment += `\n`;
      }

      if (conflictingPRs.length > 0) {
        comment += `**Other open PRs touching the same files:**\n`;
        for (const cp of conflictingPRs) {
          comment += `- PR #${cp.number}: ${cp.sharedFiles.map(f => `\`${f}\``).join(', ')}\n`;
        }
        comment += `\n`;
      }

      comment += `**Action:** Rebase onto \`${pr.baseRefName}\`, resolve conflicts`;
      if (conflictingPRs.length > 0) {
        comment += ` (check PRs ${conflictingPRs.map(p => `#${p.number}`).join(', ')} for context)`;
      }
      comment += `, then push.\n\n`;
      comment += `---\n🤖 Detected by fritZ autoloop merge conflict check`;

      // Post comment and transition (gated by comment level — conflicts always post)
      if (github.shouldPostComment('conflict')) {
        try {
          await github.postComment(issue, comment);
        } catch (err: unknown) {
          log(`#${issue}: Failed to post conflict comment: ${err instanceof Error ? err.message : err}`);
        }
      }

      await github.transitionStatus(issue, 'for-review', 'for-rework');
      logEvent('autoloop.conflict', `#${issue} PR #${pr.number} merge conflicts — sent to rework for rebase`, { issue, pr: pr.number });
      lifecycle.system(`⚠️ *#${issue}* PR #${pr.number} has merge conflicts — sent to rework agent for rebase.`);
      return;
    }

    default:
      // Unexpected status — proceed with review to avoid blocking
      log(`#${issue}: PR #${pr.number} unexpected mergeable status "${mergeableStatus}" — proceeding with review`);
      await spawnIfNoAgent(issue, 'review');
      return;
  }
}

// Handle 'for-merge' status: CI check → mergeability check → merge PR → close issue.
// Triggered by dashboard approval (non-auto-pipeline) or auto-pipeline transition from validated.
// CI pending → retry next cycle (silent). CI failed / conflicts → escalate to for-human.
// Uses fritz.repo: label to find PRs on the correct repo (cross-repo support).
async function handleForMerge(issue: number, labels: string[] = []): Promise<void> {
  // Resolve target repo from fritz.repo: label (cross-repo issues have PRs on a different repo)
  const targetRepo = getTargetRepo(labels);

  // Step 1: Find the PR
  let pr: ReturnType<typeof github.findIssuePR>;
  try {
    pr = github.findIssuePR(issue, targetRepo);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`#${issue}: Failed to look up PR: ${msg} — will retry next cycle`);
    return; // Treat as transient, retry next cycle
  }
  if (!pr) {
    log(`#${issue}: No open PR found for merge — escalating to for-human`);
    logEvent('autoloop.escalated', `#${issue} merge failed: no open PR found`, { issue, reason: 'no-pr' });
    lifecycle.system(`⚠️ *#${issue}* merge failed: no open PR found. Escalating to human.`);
    await github.transitionStatus(issue, 'for-merge', 'for-human');
    return;
  }

  // Step 2: Check CI status
  let ciStatus: 'success' | 'failure' | 'pending';
  try {
    ciStatus = github.getPRCheckStatus(pr.number, targetRepo);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`#${issue}: Failed to check CI status for PR #${pr.number}: ${msg} — will retry next cycle`);
    return; // Treat as transient, retry next cycle
  }

  switch (ciStatus) {
    case 'pending':
      // Leave as for-merge — autoloop will retry next cycle (silent, no Telegram spam)
      log(`#${issue}: PR #${pr.number} checks still pending — will retry`);
      return;

    case 'failure':
      log(`#${issue}: PR #${pr.number} CI checks failed — escalating to for-human`);
      logEvent('autoloop.escalated', `#${issue} merge blocked: CI failed on PR #${pr.number}`, { issue, pr: pr.number, reason: 'ci-failed' });
      lifecycle.system(`⚠️ *#${issue}* merge blocked: CI checks failed on PR #${pr.number}. Escalating to human.`);
      await github.transitionStatus(issue, 'for-merge', 'for-human');
      return;

    case 'success':
      break; // Continue to mergeability check
  }

  // Step 3: Check mergeability (conflicts)
  let mergeable: boolean;
  try {
    mergeable = github.isPRMergeable(pr.number, targetRepo);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`#${issue}: Failed to check mergeability for PR #${pr.number}: ${msg} — will retry next cycle`);
    return; // Treat as transient, retry next cycle
  }

  if (!mergeable) {
    // Conflicts detected pre-merge: send to rework agent for rebase/resolve.
    // Matches the branch-behind path below and the CONFLICTING path in
    // handleForReview — agents have git identity configured and can resolve
    // conflicts the daemon cannot. Part of Issue #792's auto-rebase intent.
    log(`#${issue}: PR #${pr.number} has merge conflicts — sending to rework agent for rebase`);

    try {
      github.postComment(issue,
        `🔄 **fritZ · Rebase Required**\n\n` +
        `Merge blocked: PR #${pr.number} has conflicts with \`${pr.baseRefName}\`.\n\n` +
        `**Action:** Rebase onto \`${pr.baseRefName}\` and resolve conflicts.\n\n` +
        `---\n🤖 Sending to rework agent for rebase`
      );
    } catch { /* best effort */ }

    await github.transitionStatus(issue, 'for-merge', 'for-rework');
    logEvent('autoloop.rebase-needed', `#${issue} PR #${pr.number} has conflicts — sent to rework for rebase`, { issue, pr: pr.number, reason: 'conflicts' });
    lifecycle.system(`🔄 *#${issue}* PR #${pr.number} has merge conflicts — sent to rework agent for rebase.`);
    return;
  }

  // Step 4: Merge (with auto-rebase on "branch behind" failure)
  try {
    await github.mergePR(pr.number, targetRepo);
  } catch (error: unknown) {
    // Race condition mitigation: check if PR was already merged between our check and merge call
    const prState = github.getPRState(pr.number, targetRepo);
    if (prState === 'MERGED') {
      log(`#${issue}: PR #${pr.number} was already merged (race condition) — treating as success`);
      // Fall through to close + comment below
    } else {
      const msg = error instanceof Error ? error.message : String(error);

      // Branch behind base: send to rework agent for rebase (agents have git identity configured)
      if (github.isBranchBehindError(msg)) {
        log(`#${issue}: PR #${pr.number} branch is behind base — sending to rework agent for rebase`);

        try {
          github.postComment(issue,
            `🔄 **fritZ · Rebase Required**\n\n` +
            `Merge failed: branch \`${pr.headRefName}\` is behind \`${pr.baseRefName}\`.\n\n` +
            `**Action:** Rebase onto \`${pr.baseRefName}\` and push.\n\n` +
            `---\n🤖 Sending to rework agent for rebase`
          );
        } catch { /* best effort */ }

        await github.transitionStatus(issue, 'for-merge', 'for-rework');
        logEvent('autoloop.rebase-needed', `#${issue} PR #${pr.number} branch behind — sent to rework for rebase`, { issue, pr: pr.number });
        lifecycle.system(`🔄 *#${issue}* PR #${pr.number} branch is behind base — sent to rework agent for rebase.`);
        return;
      } else {
        // Not a "branch behind" error — escalate directly
        log(`#${issue}: Failed to merge PR #${pr.number}: ${msg} — escalating to for-human`);
        logEvent('autoloop.escalated', `#${issue} merge failed: PR #${pr.number} — ${msg}`, { issue, pr: pr.number, reason: 'merge-error' });
        lifecycle.system(`⚠️ *#${issue}* merge failed: could not merge PR #${pr.number}. ${msg}. Escalating to human.`);
        await github.transitionStatus(issue, 'for-merge', 'for-human');
        return;
      }
    }
  }

  logEvent('pr.merged', `PR #${pr.number} merged via dashboard for issue #${issue}`, {
    pr: pr.number,
    issue,
    trigger: 'dashboard',
  });

  // Step 4b: Create/update deployment tracking issue (best-effort)
  try {
    const prInfo = github.getPRInfo(pr.number, targetRepo);
    deploymentTracker.createOrUpdateDeploymentIssue({
      repo: targetRepo,
      prNumber: pr.number,
      prTitle: prInfo.title,
      prLabels: prInfo.labels,
      mergedAt: new Date().toISOString().slice(0, 10),
    });
  } catch (error: unknown) {
    log(`#${issue}: Deployment tracker failed: ${error instanceof Error ? error.message : error}`);
  }

  // Step 5: Close issue and post comment (best-effort)
  // Issue lives on the main repo (your-org/fritZ), not the PR repo
  await github.closeIssue(issue);
  try { await github.postMergeComment(issue, pr.number, 'dashboard'); } catch { /* best effort */ }

  logEvent('issue.done', `Issue #${issue} completed`, {
    issue,
    pr: pr.number,
    trigger: 'dashboard',
  });

  // Step 6: Remove for-merge label (issue is now closed)
  try {
    await github.removeStatusLabel(issue, 'for-merge');
  } catch { /* best effort — issue is closed anyway */ }

  log(`#${issue}: Merged PR #${pr.number} via dashboard approve`);
  lifecycle.system(`✅ *#${issue}* merged PR #${pr.number} via Dashboard approve.`);
}

// Handle discussion - spawn next agent in turn
async function handleDiscussion(issue: number): Promise<void> {
  const state = await github.getDiscussionState(issue);

  if (!state.currentTurn) {
    // Max rounds reached or no more turns
    log(`#${issue}: Discussion ended (max rounds or complete)`);
    await github.endDiscussion(issue, 'max-rounds');
    return;
  }

  log(`#${issue}: Discussion turn for ${state.currentTurn} (round ${state.rounds + 1}/${state.maxRounds})`);
  await spawnAgent(issue, state.currentTurn);
}

// Handle 'defined' status with auto-pipeline: transition to for-implement.
// Accepts pre-fetched labels to avoid redundant API calls.
async function handleAutoPipelineDefined(issue: number, labels: string[]): Promise<void> {
  if (!github.hasAutoPipeline(issue, labels)) {
    return; // No auto-pipeline — human gate applies
  }

  log(`#${issue}: Auto-pipeline enabled, transitioning defined → for-implement`);
  try {
    await github.transitionToForImplement(issue);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`#${issue}: Failed to auto-transition defined → for-implement: ${msg}`);
    logEvent('autoloop.escalated', `#${issue} auto-pipeline failed: defined → for-implement`, { issue, reason: 'transition-failed' });
    lifecycle.system(`⚠️ *#${issue}* auto-pipeline failed: could not transition defined → for-implement. ${msg}`);
  }
}

// Handle 'validated' status with auto-pipeline: skip human gate, advance to for-merge.
// The for-merge handler then performs CI checks before merging (no direct merge here).
// Accepts pre-fetched labels to avoid redundant API calls.
async function handleAutoPipelineValidated(issue: number, labels: string[]): Promise<void> {
  if (!github.hasAutoPipeline(issue, labels)) {
    return; // No auto-pipeline — human merge gate applies
  }

  log(`#${issue}: Auto-pipeline enabled, transitioning validated → for-merge`);
  try {
    await github.transitionStatus(issue, 'validated', 'for-merge');
    logEvent('autoloop.transition', `#${issue} auto-pipeline: validated → for-merge`, { issue, from: 'validated', to: 'for-merge' });
    lifecycle.system(`🔄 *#${issue}* auto-pipeline: skipped human gate, advanced to for-merge.`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`#${issue}: Failed to auto-transition validated → for-merge: ${msg} — escalating to for-human`);
    logEvent('autoloop.escalated', `#${issue} auto-pipeline failed: validated → for-merge`, { issue, reason: 'transition-failed' });
    lifecycle.system(`⚠️ *#${issue}* auto-pipeline failed: could not transition validated → for-merge. ${escapeMd(msg)}. Escalating to human.`);
    await github.transitionStatus(issue, 'validated', 'for-human');
  }
}

// Spawn agent if none already working on this issue
async function spawnIfNoAgent(issue: number, role: AgentRole): Promise<void> {
  if (!hasActiveAgent(issue)) {
    await spawnAgent(issue, role);
  }
}

// Spawn an agent for an issue
async function spawnAgent(issue: number, role: AgentRole): Promise<void> {
  try {
    // bootAgent() handles fritz.repo: label lookup internally and logs the resolved target
    log(`Spawning ${role} agent for #${issue}...`);
    const _agentName = await agents.startAgent({
      role,
      issue,
    });

    // Activity tracked via agent's issue comment (posted by assignAgent) and local event log.
    // logActivity() was removed in #685 Phase 1 to eliminate redundant issue body edits.
  } catch (error: unknown) {
    log(`Failed to spawn ${role} for #${issue}: ${error instanceof Error ? error.message : error}`);
  }
}

// Single check cycle
async function check(): Promise<void> {
  if (isProcessing) {
    return; // Skip if previous cycle still running
  }

  if (isManuallyPaused()) {
    log('Autoloop paused (manual) — skipping cycle');
    return;
  }

  // Usage-paused: skip cycle unless P0 bypass is enabled
  const usagePaused = usageMonitor.isUsagePaused() && !usageMonitor.hasOverride();
  if (usagePaused) {
    const usageConfig = getUsageConfig();
    if (!usageConfig.allowP0) {
      log('Autoloop paused (usage, P0 bypass disabled) — skipping cycle');
      return;
    }
    // P0 bypass enabled — continue but only process P0 issues
    log('Autoloop paused (usage) — processing P0 issues only');
  }

  if (isRateLimited()) {
    log('Autoloop paused (GitHub rate limit) — skipping cycle');
    return;
  }

  if (!config.githubRepo) {
    return; // No repo configured
  }

  isProcessing = true;

  // Reset current-cycle deferral tracking BEFORE the try block so stale
  // entries from a partial/errored previous cycle don't leak forward.
  deferralTracker.resetCurrentCycle();

  try {
    // Check each actionable status using for-{role} pattern.
    // 'defined' and 'validated' are filtered by fritz.auto-pipeline to avoid
    // fetching issues that don't need auto-transitions (O(1) vs O(N)).
    const statuses = [
      'for-define',
      'for-implement',
      'for-architect',
      'for-ux',
      'for-budget',
      'for-review',
      'for-validate',
      'for-security-review',
      'for-pentest',
      'for-rework',
      'for-merge',
      'discussion',
      'defined',
      'validated',
    ];
    const AUTO_PIPELINE_STATUSES = new Set(['defined', 'validated']);

    // Single GraphQL query replaces 14 separate gh issue list calls
    const repo = config.githubRepo!;
    const [owner, name] = repo.split('/');
    const allIssues = await graphql.fetchAllOpenIssues(owner, name);

    // Client-side filtering (same result, 1 API call instead of 14)
    const statusResults = statuses.map(status => ({
      status,
      issues: graphql.filterByStatus(
        allIssues,
        status,
        AUTO_PIPELINE_STATUSES.has(status) ? ['fritz.auto-pipeline'] : undefined
      ),
    }));

    const results: Record<string, number> = {};

    // Update queue cache for dashboard (all actionable issues across all statuses)
    const queueEntries: typeof lastKnownQueue = [];
    for (const { issues } of statusResults) {
      for (const issue of issues) {
        queueEntries.push({
          number: issue.number,
          labels: issue.labels,
          title: issue.title,
        });
      }
    }
    lastKnownQueue = queueEntries;

    // Notify dashboard listeners of queue change
    for (const cb of queueListeners) {
      try { cb(); } catch (e) { log(`Queue listener error: ${e}`); }
    }

    // Process results sequentially (spawning respects maxParallelAgents)
    for (const { status, issues } of statusResults) {
      results[status] = issues.length;

      if (issues.length > 0) {
        // Sort by priority: p0 first, then p1, p2, p3, unprioritized last
        const sorted = sortByPriority(issues);
        const issueList = sorted.map(i => `#${i.number}${i.priority ? ` (${i.priority})` : ''}`).join(', ');
        log(`Found ${sorted.length} issue(s) with status ${status}: ${issueList}`);

        for (const issue of sorted) {
          // When usage-paused with P0 bypass: only process P0 issues
          if (usagePaused && issue.priority !== 'p0') {
            log(`#${issue.number}: Skipped (usage-paused, not P0)`);
            continue;
          }
          // Skip individually paused issues
          if (issue.labels.includes('fritz.paused')) {
            if (deferralTracker.trackDeferral(issue.number, 'fritz.paused label')) {
              log(`#${issue.number}: Skipped (fritz.paused)`);
            }
            continue;
          }
          try {
            await processIssue(issue.number, status, issue.labels);
          } catch (error: unknown) {
            // Error boundary: log and skip this issue so the autoloop continues
            log(`#${issue.number}: processIssue failed — skipping: ${error instanceof Error ? error.message : error}`);
          }
        }
      }
    }

    // Reconcile deferrals: log AGENT-UNDEFERRED for issues that left the deferred state
    const undeferred = deferralTracker.reconcileDeferrals();
    for (const { issueNumber, previousReason } of undeferred) {
      log(`AGENT-UNDEFERRED issue #${issueNumber} — was: ${previousReason}`);
    }

    // Log cycle summary
    const total = Object.values(results).reduce((sum, count) => sum + count, 0);
    if (total === 0) {
      log('Check cycle complete - no actionable issues found');
    } else {
      const summary = statuses.map(s => `${s}: ${results[s] || 0}`).join(', ');
      log(`Check cycle complete - processed ${total} issue(s) (${summary})`);
    }

    // Cleanup stale fritz.depends-on labels and detect cycles (throttled to every Nth cycle)
    cycleCount++;
    const cleanupInterval = getAutoloopConfig().cleanupEveryNthCycle;
    if (cycleCount % cleanupInterval === 0) {
      await cleanupStaleDependsOnLabels();
      await detectAndReportCycles(allIssues);
      // Check stale deployment issues (best-effort)
      try {
        await deploymentTracker.checkStaleDeploymentIssues();
      } catch (error: unknown) {
        log(`Stale deployment check failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error: unknown) {
    log(`Error in check cycle: ${error instanceof Error ? error.message : error}`);
  } finally {
    isProcessing = false;
  }
}

// ============================================================================
// Dependency Cycle Detection
// ============================================================================

/**
 * Build a dependency graph from open issues and detect cycles using DFS.
 * Returns an array of cycles found, each cycle is an array of issue numbers.
 *
 * Only considers dependencies between open issues (closed issues can't form
 * actionable cycles since they're already resolved).
 */
export function findDependencyCycles(
  issues: CachedIssue[]
): number[][] {
  // Build adjacency list: issue -> issues it depends on (only open ones)
  const openIssueNumbers = new Set(issues.map(i => i.number));
  const graph = new Map<number, number[]>();

  for (const issue of issues) {
    const deps = github.parseDependenciesFromLabels(issue.labels)
      .filter(dep => openIssueNumbers.has(dep));
    if (deps.length > 0) {
      graph.set(issue.number, deps);
    }
  }

  // DFS cycle detection
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<number, number>();
  const parent = new Map<number, number>();
  const cycles: number[][] = [];
  const seenCycleSigs = new Set<string>();

  for (const node of openIssueNumbers) {
    color.set(node, WHITE);
  }

  function dfs(u: number): void {
    color.set(u, GRAY);
    const neighbors = graph.get(u) ?? [];
    for (const v of neighbors) {
      if (color.get(v) === GRAY) {
        // Back edge found — extract cycle
        const cycle: number[] = [v];
        let cur = u;
        while (cur !== v) {
          cycle.push(cur);
          cur = parent.get(cur)!;
        }
        cycle.reverse();

        // Normalize: start from the smallest number to deduplicate
        const minIdx = cycle.indexOf(Math.min(...cycle));
        const normalized = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
        const sig = normalized.join(',');
        if (!seenCycleSigs.has(sig)) {
          seenCycleSigs.add(sig);
          cycles.push(normalized);
        }
      } else if (color.get(v) === WHITE) {
        parent.set(v, u);
        dfs(v);
      }
    }
    color.set(u, BLACK);
  }

  for (const node of openIssueNumbers) {
    if (color.get(node) === WHITE) {
      dfs(node);
    }
  }

  return cycles;
}

/**
 * Detect dependency cycles among open issues and log warnings.
 * Posts a GitHub comment on the first issue in each new cycle detected.
 * Uses a cooldown to avoid spamming the same cycle repeatedly.
 */
export async function detectAndReportCycles(allIssues: CachedIssue[]): Promise<void> {
  try {
    const cycles = findDependencyCycles(allIssues);
    if (cycles.length === 0) return;

    for (const cycle of cycles) {
      const sig = [...cycle].sort((a, b) => a - b).join(',');
      const chainStr = cycle.map(n => `#${n}`).join(' → ') + ` → #${cycle[0]}`;

      // Always log
      log(`⚠️ Dependency cycle detected: ${chainStr}`);

      // Check cooldown before posting to GitHub
      const lastReported = reportedCycles.get(sig);
      if (lastReported && Date.now() - lastReported < CYCLE_REPORT_COOLDOWN_MS) {
        continue;
      }

      // Track cooldown regardless of whether we post (prevents re-triggering if comment level changes)
      reportedCycles.set(sig, Date.now());

      // Post comment on the first issue in the cycle (gated — dependency cycles always post)
      const targetIssue = cycle[0];
      if (github.shouldPostComment('dependency-cycle')) {
        try {
          await github.postComment(targetIssue,
            `⚠️ **Dependency Cycle Detected**\n\n` +
            `The following issues form a circular dependency chain:\n\n` +
            `\`\`\`\n${chainStr}\n\`\`\`\n\n` +
            `None of these issues can progress until the cycle is broken. ` +
            `Remove at least one \`fritz.depends-on:\` label to unblock them.\n\n` +
            `---\n🤖 Detected by fritZ autoloop cycle detection`
          );
        } catch (err: unknown) {
          log(`Failed to post cycle warning on #${targetIssue}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  } catch (error: unknown) {
    log(`Cycle detection failed: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Remove fritz.depends-on:NNN labels whose referenced issue has been closed.
 * Runs once per autoloop cycle, after processing all issues.
 *
 * For each fritz.depends-on:NNN label in the repo:
 * 1. Parse the issue number from the label name
 * 2. Check if that issue is closed
 * 3. If closed, remove the label from all open issues and delete the label
 */
async function cleanupStaleDependsOnLabels(): Promise<void> {
  try {
    const labels = await github.listDependsOnLabels();
    if (labels.length === 0) return;

    for (const label of labels) {
      const deps = github.parseDependenciesFromLabels([label]);
      if (deps.length === 0) continue;
      const issueNum = deps[0];

      if (github.isDependencyClosed(issueNum)) {
        log(`Cleaning up stale label "${label}" — dependency #${issueNum} is closed`);
        await github.removeLabelAndDelete(label);
      }
    }
  } catch (error: unknown) {
    log(`fritz.depends-on cleanup failed: ${error instanceof Error ? error.message : error}`);
  }
}

// Start the auto-orchestration loop
export function start(options?: { quiet?: boolean }): void {
  if (loopInterval) {
    if (!options?.quiet) log('Auto-loop already running');
    return;
  }

  if (!config.githubRepo) {
    log('Auto-loop disabled (no GITHUB_REPO configured)');
    return;
  }

  const intervalSec = getLoopInterval();
  if (!options?.quiet) {
    log(`Starting auto-orchestration loop (interval: ${intervalSec}s)`);
  }

  // Run first check after a short delay
  setTimeout(() => check(), 5000);

  // Then run on interval
  loopInterval = setInterval(check, intervalSec * 1000);
}

// Stop the auto-orchestration loop
export function stop(): void {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
    log('Auto-loop stopped');
  }
}

// Get status (used by dashboard)
export function isRunning(): boolean {
  return loopInterval !== null;
}

/** Check if manually paused (file-based, via fritz pause/resume). */
export function isManuallyPaused(): boolean {
  return existsSync(getPauseFile());
}

/** Check if paused for any reason (manual OR usage). Both must be clear to spawn. */
export function isPaused(): boolean {
  return isManuallyPaused() || usageMonitor.isUsagePaused();
}

export function pause(): void {
  if (!isManuallyPaused()) {
    writeFileSync(getPauseFile(), new Date().toISOString(), 'utf-8');
    log('Autoloop paused (manual)');
  }
}

export function resume(): void {
  if (isManuallyPaused()) {
    try {
      unlinkSync(getPauseFile());
    } catch {
      // File already removed — no-op
    }
    log('Autoloop resumed (manual)');
  }
}

/** Get cached queue data from last autoloop check cycle (used by dashboard). */
export function getLastKnownQueue(): Array<{ number: number; labels: string[]; title?: string }> {
  return lastKnownQueue;
}

/** @internal Test-only: run one check cycle (used to verify error boundary behavior). */
export const _check = check;
