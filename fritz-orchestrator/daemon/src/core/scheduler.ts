/**
 * Scheduler - periodic task execution engine
 *
 * Creates GitHub issues on configurable schedules to trigger agent tasks.
 * Follows the same interval-based pattern as autoloop and watchdog.
 * GitHub issues are used as the execution mechanism for full traceability.
 *
 * Disabled by default (scheduler.enabled: false in fritz.yaml).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { config } from '../config.js';
import { getSchedulerConfig, type ScheduledJobConfig } from '../agents/fritz-config.js';
import { gh } from '../github/github.js';
import { isValidRole } from '../agents/boot.js';
import * as registry from './registry.js';
import * as lifecycle from './lifecycle.js';
import { logEvent } from './event-log.js';

// Persistent state file path
const STATE_FILE = () => `${config.workspacesDir}/scheduler-state.json`;

// Persistent state (saved to disk)
interface SchedulerState {
  jobs: Record<string, {
    lastRun: string | null;
    lastIssue: number | null;
    enabled: boolean;
  }>;
}

// Runtime state of a scheduled job
export interface ScheduledJob extends ScheduledJobConfig {
  lastRun: string | null;
  nextRun: string;
  lastIssue: number | null;
}

// Status returned for a specific job
export interface JobStatus {
  job: ScheduledJob;
  isOverdue: boolean;
  activeAgent: boolean;
}

// Result of a trigger attempt
export interface TriggerResult {
  success: boolean;
  issueNumber?: number;
  reason?: string;
}

let schedulerInterval: NodeJS.Timeout | null = null;
let isProcessing = false;
let state: SchedulerState = { jobs: {} };
let stateLoaded = false;

function log(message: string): void {
  console.log(`[scheduler] ${new Date().toISOString()} ${message}`);
}

// ---- State Persistence ----

function loadState(): void {
  const stateFile = STATE_FILE();
  if (!existsSync(stateFile)) {
    state = { jobs: {} };
    stateLoaded = true;
    return;
  }

  try {
    const data = readFileSync(stateFile, 'utf-8');
    state = JSON.parse(data);
    if (!state.jobs || typeof state.jobs !== 'object') {
      state = { jobs: {} };
    }
  } catch {
    log('State file corrupted — starting fresh');
    state = { jobs: {} };
  }
  stateLoaded = true;
}

function ensureStateLoaded(): void {
  if (!stateLoaded) {
    loadState();
  }
}

function saveState(): void {
  const stateFile = STATE_FILE();
  try {
    const dir = dirname(stateFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`Failed to save state: ${err instanceof Error ? err.message : err}`);
  }
}

function getJobState(jobId: string): { lastRun: string | null; lastIssue: number | null; enabled: boolean } | undefined {
  return state.jobs[jobId];
}

function updateJobState(jobId: string, lastRun: string, lastIssue: number): void {
  if (!state.jobs[jobId]) {
    state.jobs[jobId] = { lastRun: null, lastIssue: null, enabled: true };
  }
  state.jobs[jobId].lastRun = lastRun;
  state.jobs[jobId].lastIssue = lastIssue;
  saveState();
}

// ---- Next Run Calculation ----

/**
 * Calculate the next run time for a job after a given point in time.
 */
export function calculateNextRun(job: ScheduledJobConfig, after: Date = new Date()): Date {
  const next = new Date(after);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(job.minute ?? 0);

  switch (job.frequency) {
    case 'hourly':
      // Next occurrence of :MM after 'after'
      next.setUTCHours(after.getUTCHours());
      if (next <= after) next.setUTCHours(next.getUTCHours() + 1);
      break;

    case 'daily':
      // Next occurrence of HH:MM UTC after 'after'
      next.setUTCHours(job.hour);
      if (next <= after) next.setUTCDate(next.getUTCDate() + 1);
      break;

    case 'weekly': {
      // Next occurrence of dayOfWeek at HH:MM UTC after 'after'
      next.setUTCHours(job.hour);
      const targetDay = job.dayOfWeek ?? 1;
      const currentDay = next.getUTCDay();
      let daysUntil = (targetDay - currentDay + 7) % 7;
      if (daysUntil === 0 && next <= after) daysUntil = 7;
      next.setUTCDate(next.getUTCDate() + daysUntil);
      break;
    }
  }

  return next;
}

// ---- Shell Escaping ----

/**
 * Escape a string for safe use in double-quoted shell arguments.
 * Matches the established pattern in github.ts.
 */
function shellEscape(value: string): string {
  return value.replace(/"/g, '\\"').replace(/`/g, '\\`');
}

// ---- Trigger Logic ----

/**
 * Check if a previous issue from this job still has an active agent.
 */
function isLastIssueStillActive(lastIssue: number | null): boolean {
  if (!lastIssue) return false;
  const agents = registry.listAgents();
  return agents.some(a => a.issue === lastIssue);
}

/**
 * Create a GitHub issue to trigger a scheduled job.
 */
function createIssue(jobConfig: ScheduledJobConfig): number | null {
  const repo = config.githubRepo;
  if (!repo) {
    log('Cannot create issue — GITHUB_REPO not configured');
    return null;
  }

  // Validate role against known roles before constructing shell commands
  if (!isValidRole(jobConfig.role)) {
    log(`Cannot create issue — invalid role "${jobConfig.role}" for job "${jobConfig.id}"`);
    return null;
  }

  // Build title with date for uniqueness
  const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const title = `[Scheduled] ${jobConfig.issueTitle} (${dateStr})`;

  // Build labels — escape each value to prevent shell injection
  const labels = [`fritz.status:for-${jobConfig.role}`];
  if (jobConfig.issueLabels) {
    labels.push(...jobConfig.issueLabels);
  }
  const labelArgs = labels.map(l => `--label "${shellEscape(l)}"`).join(' ');

  // Build body
  const body = jobConfig.issueBody
    ? `${jobConfig.issueBody}\n\n---\n_Automated scheduled run by fritZ scheduler._\n_Job: ${jobConfig.id} | Frequency: ${jobConfig.frequency}_`
    : `Automated scheduled run by fritZ scheduler.\n\nJob: ${jobConfig.id}\nFrequency: ${jobConfig.frequency}\n\nSee scheduler config in fritz.yaml for details.`;

  // Use a temp file for body to avoid shell escaping issues (using os.tmpdir() for portability)
  const tmpFile = join(tmpdir(), `scheduler-issue-${jobConfig.id}-${Date.now()}.md`);
  try {
    writeFileSync(tmpFile, body);

    const result = gh(
      `issue create --title "${shellEscape(title)}" ${labelArgs} --body-file "${tmpFile}" --repo ${repo}`
    );

    // Parse issue number from output (e.g., "https://github.com/owner/repo/issues/123")
    const match = result.match(/\/issues\/(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }

    log(`Created issue but couldn't parse number from: ${result}`);
    return null;
  } catch (err) {
    log(`Failed to create issue for job "${jobConfig.id}": ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    // Clean up temp file (best-effort, always runs)
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/**
 * Trigger a specific job — create GitHub issue and update state.
 * Manual triggers (via Telegram) work on disabled jobs with a warning.
 */
export async function triggerJob(jobId: string): Promise<TriggerResult> {
  // Ensure state is loaded (handles manual triggers when scheduler is not started)
  ensureStateLoaded();

  const schedulerConfig = getSchedulerConfig();
  const jobConfig = schedulerConfig.jobs.find(j => j.id === jobId);

  if (!jobConfig) {
    return { success: false, reason: `Job "${jobId}" not found` };
  }

  // Check if previous issue still has an active agent
  const jobState = getJobState(jobId);
  if (isLastIssueStillActive(jobState?.lastIssue ?? null)) {
    log(`Skipping job "${jobId}" — previous run (issue #${jobState?.lastIssue}) still active`);
    return { success: false, reason: `Previous run still active (issue #${jobState?.lastIssue})` };
  }

  // Warn if job is disabled but being triggered manually
  const isDisabled = jobState?.enabled === false || !jobConfig.enabled;
  if (isDisabled) {
    log(`Job "${jobId}" is disabled but triggered manually`);
  }

  // Create the issue
  const issueNumber = createIssue(jobConfig);
  if (!issueNumber) {
    return { success: false, reason: 'Failed to create GitHub issue' };
  }

  // Update state
  const now = new Date().toISOString();
  updateJobState(jobId, now, issueNumber);

  // Notify via Telegram
  const disabledNote = isDisabled ? ' (job is disabled, triggered manually)' : '';
  logEvent('scheduler.triggered', `Job "${jobId}" triggered — created issue #${issueNumber}${disabledNote}`, { jobId, issue: issueNumber });
  lifecycle.system(`📅 Scheduled job \`${jobId}\` triggered — created issue #${issueNumber}${disabledNote}`);

  log(`Triggered job "${jobId}" — created issue #${issueNumber}${disabledNote}`);
  return { success: true, issueNumber };
}

// ---- Check Cycle ----

/**
 * Single check cycle — evaluate all jobs and trigger those that are due.
 */
async function check(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const schedulerConfig = getSchedulerConfig();
    if (!schedulerConfig.enabled) return;

    const now = new Date();

    for (const jobConfig of schedulerConfig.jobs) {
      const jobState = getJobState(jobConfig.id);

      // Skip disabled jobs (runtime override takes precedence over config)
      if (jobState?.enabled === false || !jobConfig.enabled) continue;

      // Calculate next run from last run (or from epoch if never run)
      const lastRun = jobState?.lastRun ? new Date(jobState.lastRun) : new Date(0);
      const nextRun = calculateNextRun(jobConfig, lastRun);

      if (now >= nextRun) {
        await triggerJob(jobConfig.id);
      }
    }
  } catch (error) {
    log(`Error in scheduler check: ${error instanceof Error ? error.message : error}`);
  } finally {
    isProcessing = false;
  }
}

// ---- Public API ----

/**
 * Start the scheduler interval.
 */
export function start(options?: { quiet?: boolean }): void {
  if (schedulerInterval) {
    if (!options?.quiet) log('Scheduler already running');
    return;
  }

  const schedulerConfig = getSchedulerConfig();

  if (!schedulerConfig.enabled) {
    log('Scheduler: disabled (set scheduler.enabled: true in fritz.yaml)');
    return;
  }

  if (!config.githubRepo) {
    log('Scheduler: disabled (no GITHUB_REPO configured)');
    return;
  }

  // Load persisted state
  loadState();

  const jobCount = schedulerConfig.jobs.filter(j => j.enabled).length;
  if (!options?.quiet) {
    log(`📅 Scheduler starting (${jobCount} job(s), check every ${schedulerConfig.checkIntervalSec}s)`);
  }

  // Run first check after a short delay
  setTimeout(() => check(), 3000);

  // Then run on interval
  schedulerInterval = setInterval(check, schedulerConfig.checkIntervalSec * 1000);
}

/**
 * Stop the scheduler interval.
 */
export function stop(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    log('📅 Scheduler stopped');
  }
}

/**
 * Check if the scheduler is running.
 */
export function isRunning(): boolean {
  return schedulerInterval !== null;
}

/**
 * Get all configured jobs with runtime state.
 */
export function getJobs(): ScheduledJob[] {
  const schedulerConfig = getSchedulerConfig();

  return schedulerConfig.jobs.map(jobConfig => {
    const jobState = getJobState(jobConfig.id);
    const lastRun = jobState?.lastRun ? new Date(jobState.lastRun) : new Date(0);
    const nextRun = calculateNextRun(jobConfig, lastRun);

    return {
      ...jobConfig,
      // Runtime override for enabled (state takes precedence if explicitly false)
      enabled: jobState?.enabled === false ? false : jobConfig.enabled,
      lastRun: jobState?.lastRun ?? null,
      nextRun: nextRun.toISOString(),
      lastIssue: jobState?.lastIssue ?? null,
    };
  });
}

/**
 * Get status of a specific job.
 */
export function getJobStatus(jobId: string): JobStatus | undefined {
  const jobs = getJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) return undefined;

  const now = new Date();
  return {
    job,
    isOverdue: now >= new Date(job.nextRun),
    activeAgent: isLastIssueStillActive(job.lastIssue),
  };
}

/**
 * Enable a disabled job at runtime.
 * Returns false if the job ID is not in the config.
 */
export function enableJob(jobId: string): boolean {
  const schedulerConfig = getSchedulerConfig();
  if (!schedulerConfig.jobs.some(j => j.id === jobId)) {
    log(`Cannot enable unknown job "${jobId}"`);
    return false;
  }

  if (!state.jobs[jobId]) {
    state.jobs[jobId] = { lastRun: null, lastIssue: null, enabled: true };
  }
  state.jobs[jobId].enabled = true;
  saveState();
  log(`Job "${jobId}" enabled`);
  return true;
}

/**
 * Disable a job at runtime.
 * Returns false if the job ID is not in the config.
 */
export function disableJob(jobId: string): boolean {
  const schedulerConfig = getSchedulerConfig();
  if (!schedulerConfig.jobs.some(j => j.id === jobId)) {
    log(`Cannot disable unknown job "${jobId}"`);
    return false;
  }

  if (!state.jobs[jobId]) {
    state.jobs[jobId] = { lastRun: null, lastIssue: null, enabled: true };
  }
  state.jobs[jobId].enabled = false;
  saveState();
  log(`Job "${jobId}" disabled`);
  return true;
}

// ---- Test Helpers ----

/**
 * Reset scheduler state (for testing only).
 */
export function resetState(): void {
  state = { jobs: {} };
  isProcessing = false;
  stateLoaded = false;
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

/**
 * Expose check for testing.
 */
export { check };
