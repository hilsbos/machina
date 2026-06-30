/**
 * Usage Monitor — Auto-pause autoloop when Claude subscription usage exceeds threshold.
 *
 * Periodically queries the Anthropic OAuth usage API to get real subscription
 * utilization percentages for:
 *   - 5-hour rolling window
 *   - 7-day weekly quota
 *   - 7-day Opus-specific quota (if available)
 *
 * When ANY dimension exceeds the configurable threshold, the autoloop is paused.
 * Resumes only when ALL dimensions drop below the resume threshold (hysteresis).
 *
 * Separate from manual `fritz pause/resume` — both must be clear for agents to spawn.
 * P0 issues can bypass usage-pause (but not manual pause).
 *
 * @see TECH_SPEC at fritz/specs/354-usage-auto-pause/TECH_SPEC.md
 */

import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { getUsageConfig } from './fritz-config.js';
import * as lifecycle from '../core/lifecycle.js';
import { logEvent } from '../core/event-log.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Single utilization dimension from the API. */
interface UsageDimension {
  utilization: number;      // 0-100
  resetsAt: string | null;  // ISO timestamp
}

/** Cached usage data from the last API call. */
export interface CachedUsageData {
  fiveHour: UsageDimension;
  sevenDay: UsageDimension;
  sevenDayOpus: UsageDimension | null;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let checkInterval: NodeJS.Timeout | null = null;
let initialTimeout: NodeJS.Timeout | null = null;
let cachedUsage: CachedUsageData | null = null;
let lastCheckTime: string | null = null;
let authMode: 'oauth_token' | 'credentials_file' | 'none' = 'none';
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5; // Disable after this many failures
let previousMaxUtil: number | null = null; // Track previous max for delta-based notifications
let envTokenForbidden = false; // Track if env var token got 403 (avoid retrying every cycle)
let stopReason: string | null = null; // Why the monitor stopped (null = running or never started)

// Usage velocity snapshots — ring buffer for computing burn rate
export interface UsageSnapshot {
  timestamp: string;       // ISO
  fiveHourPct: number;     // 0-100
  sevenDayPct: number;     // 0-100
  sevenDayOpusPct: number | null;
  agentCount: number;      // active agents at snapshot time
}
const SNAPSHOT_BUFFER_SIZE = 120; // ~2 hours at 1/min
const usageSnapshots: UsageSnapshot[] = [];
let agentCountFn: (() => number) | null = null;

/** Register a callback that returns current active agent count. */
export function setAgentCountProvider(fn: () => number): void {
  agentCountFn = fn;
}

/** Get all usage snapshots for velocity computation. */
export function getUsageSnapshots(): UsageSnapshot[] {
  return usageSnapshots;
}

function recordSnapshot(usage: CachedUsageData): void {
  const snap: UsageSnapshot = {
    timestamp: new Date().toISOString(),
    fiveHourPct: usage.fiveHour.utilization,
    sevenDayPct: usage.sevenDay.utilization,
    sevenDayOpusPct: usage.sevenDayOpus?.utilization ?? null,
    agentCount: agentCountFn ? agentCountFn() : 0,
  };
  usageSnapshots.push(snap);
  if (usageSnapshots.length > SNAPSHOT_BUFFER_SIZE) {
    usageSnapshots.shift();
  }
}

// Change listeners (for dashboard SSE)
type UsageChangeCallback = () => void;
const changeListeners = new Set<UsageChangeCallback>();

function log(message: string): void {
  console.log(`[usage-monitor] ${new Date().toISOString()} ${message}`);
}

// ---------------------------------------------------------------------------
// File-based state (persistent across daemon restarts)
// ---------------------------------------------------------------------------

function getUsagePauseFile(): string {
  return join(config.workspacesDir, 'usage-paused');
}

function getOverrideFile(): string {
  return join(config.workspacesDir, 'usage-override');
}

/** Check if autoloop is currently paused due to usage. */
export function isUsagePaused(): boolean {
  return existsSync(getUsagePauseFile());
}

/** Check if override is active (ignoring usage limits). */
export function hasOverride(): boolean {
  return existsSync(getOverrideFile());
}

/**
 * Toggle override state.
 * When enabled: clears usage-pause, ignores threshold.
 * When disabled: re-engages usage checking; triggers an immediate check.
 */
export function setOverride(enabled: boolean): void {
  if (enabled) {
    writeFileSync(getOverrideFile(), new Date().toISOString(), 'utf-8');
    // Clear usage-pause when override is enabled
    if (isUsagePaused()) {
      try { unlinkSync(getUsagePauseFile()); } catch { /* ignore */ }
    }
    log('Override enabled — usage limits ignored');
  } else {
    try { unlinkSync(getOverrideFile()); } catch { /* ignore */ }
    log('Override disabled — usage limits re-engaged');
    // Trigger immediate check so pause re-engages if above threshold
    check();
  }
  notifyListeners();
}

function setPaused(paused: boolean): void {
  const wasPaused = isUsagePaused();
  if (paused && !wasPaused) {
    writeFileSync(getUsagePauseFile(), new Date().toISOString(), 'utf-8');
  } else if (!paused && wasPaused) {
    try { unlinkSync(getUsagePauseFile()); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// OAuth token resolution & refresh
// ---------------------------------------------------------------------------

/** Claude Code's OAuth client ID (used for token refresh). */
const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Refresh when token expires within this many ms (10 minutes). */
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

/** Token refresh endpoint. */
const TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';

/** Get OAuth token from CLAUDE_CODE_OAUTH_TOKEN env var. */
function getEnvToken(): string | null {
  return config.claudeOauthToken ?? null;
}

/** Read the full credentials object from ~/.claude/.credentials.json. */
function readCredentialsFile(): Record<string, unknown> | null {
  const credFile = join(config.claudeHome, '.credentials.json');
  if (existsSync(credFile)) {
    try {
      return JSON.parse(readFileSync(credFile, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

/** Get OAuth token from ~/.claude/.credentials.json file. */
function getCredentialsFileToken(): string | null {
  const creds = readCredentialsFile();
  return (creds?.claudeAiOauth as Record<string, unknown>)?.accessToken as string ?? null;
}

/**
 * Refresh the OAuth access token using the refresh token from .credentials.json.
 *
 * Claude Code stores OAuth credentials including a refresh token, but has a
 * known bug where it doesn't use the refresh token automatically (see
 * https://github.com/anthropics/claude-code/issues/21765). The daemon
 * implements refresh to keep the usage monitor running without manual
 * re-authentication.
 *
 * Refresh tokens are single-use — the response includes a new refresh token
 * that must be persisted. Since Claude Code doesn't refresh on its own, there
 * is no race condition.
 *
 * @param force - Skip the expiry check and refresh unconditionally. Use after
 *   a 401 response, where the API has confirmed the token is invalid regardless
 *   of what expiresAt says (e.g., revoked token, clock skew).
 * @returns The new access token, or null if refresh failed or wasn't needed.
 */
export async function refreshTokenIfNeeded(options?: { force?: boolean }): Promise<string | null> {
  const creds = readCredentialsFile();
  const oauth = creds?.claudeAiOauth as Record<string, unknown> | undefined;
  if (!oauth) return null;

  const expiresAt = oauth.expiresAt as number | undefined;
  const refreshToken = oauth.refreshToken as string | undefined;

  if (!refreshToken) {
    return null; // No refresh token available
  }

  if (options?.force) {
    log('Forced refresh (e.g., after 401 from API)');
  } else if (!expiresAt) {
    // No expiresAt field — try refreshing anyway (token might already be expired)
    log('No expiresAt in credentials — attempting refresh');
  } else {
    const msUntilExpiry = expiresAt - Date.now();
    if (msUntilExpiry > REFRESH_BUFFER_MS) {
      return null; // Token is still fresh, no refresh needed
    }
    log(`Token expires in ${Math.round(msUntilExpiry / 1000)}s — refreshing`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
    });

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      log(`Token refresh failed: ${response.status} ${response.statusText} ${text}`);
      return null;
    }

    const data = await response.json() as Record<string, unknown>;
    const newAccessToken = data.access_token as string | undefined;
    const newRefreshToken = data.refresh_token as string | undefined;
    const expiresIn = data.expires_in as number | undefined; // seconds

    if (!newAccessToken) {
      log('Token refresh response missing access_token');
      return null;
    }

    // Update the credentials file with new tokens
    const updatedOauth: Record<string, unknown> = { ...oauth, accessToken: newAccessToken };
    if (newRefreshToken) {
      updatedOauth.refreshToken = newRefreshToken;
    }
    if (expiresIn) {
      updatedOauth.expiresAt = Date.now() + expiresIn * 1000;
    }

    const updatedCreds = { ...creds, claudeAiOauth: updatedOauth };
    const credFile = join(config.claudeHome, '.credentials.json');
    try {
      writeFileSync(credFile, JSON.stringify(updatedCreds, null, 2), 'utf-8');
    } catch (writeErr: unknown) {
      // Write may fail if credentials file is on a bind mount with
      // restrictive permissions. The refreshed token still works for the
      // current session — it just won't survive a daemon restart.
      const wmsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      log(`Warning: could not persist refreshed token: ${wmsg}`);
    }

    log(`Token refreshed successfully (expires in ${expiresIn ?? '?'}s)`);
    return newAccessToken;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Token refresh error: ${msg}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get the best available OAuth token for the usage API.
 * Skips the env var token if it previously received a 403 (Forbidden),
 * falling back to the credentials file token instead.
 */
function getOAuthToken(): string | null {
  // Priority 1: env var (unless it previously got 403)
  if (!envTokenForbidden) {
    const envToken = getEnvToken();
    if (envToken) return envToken;
  }

  // Priority 2 (or primary if env token forbidden): credentials file
  return getCredentialsFileToken();
}


// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

/** Fetch usage data from the Anthropic OAuth API. */
async function fetchUsage(token: string): Promise<CachedUsageData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000); // 15s timeout

  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    throw new AuthError('OAuth token expired or invalid (401)');
  }

  if (response.status === 403) {
    throw new ForbiddenError('OAuth token lacks permission to access usage API (403)');
  }

  if (response.status === 429) {
    throw new RateLimitError('Rate limited by Anthropic API (429)');
  }

  if (!response.ok) {
    throw new Error(`Anthropic usage API returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json() as Record<string, unknown>;

  // Parse response with fallbacks for unexpected shapes
  const fiveHour = parseDimension(data.five_hour);
  const sevenDay = parseDimension(data.seven_day);
  const sevenDayOpus = data.seven_day_opus
    ? parseDimension(data.seven_day_opus)
    : null;

  return { fiveHour, sevenDay, sevenDayOpus };
}

function parseDimension(raw: unknown): UsageDimension {
  if (!raw || typeof raw !== 'object') {
    return { utilization: 0, resetsAt: null };
  }
  const obj = raw as Record<string, unknown>;
  return {
    utilization: typeof obj.utilization === 'number' ? obj.utilization : 0,
    resetsAt: typeof obj.resets_at === 'string' ? obj.resets_at : null,
  };
}

class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// ---------------------------------------------------------------------------
// Check logic
// ---------------------------------------------------------------------------

/**
 * Apply fetched usage data to module state: update cache, handle pause/resume,
 * notify listeners. Extracted to avoid duplicating this logic between the
 * normal check path and the 401-retry path.
 *
 * @param logSuffix - Optional suffix appended to the "Check complete" log line
 *   (e.g., " (after refresh)") to distinguish retry completions in logs.
 */
function applyUsageData(
  usage: CachedUsageData,
  usageConfig: ReturnType<typeof getUsageConfig>,
  logSuffix = '',
): void {
  cachedUsage = usage;
  lastCheckTime = new Date().toISOString();
  consecutiveErrors = 0;
  recordSnapshot(usage);

  const maxUtil = getMaxUtilization(usage);

  // Override active — skip pause/resume logic but keep fetching data for display
  if (hasOverride()) {
    if (previousMaxUtil === null || Math.abs(maxUtil - previousMaxUtil) >= 5) {
      notifyListeners();
    }
    previousMaxUtil = maxUtil;
    log(`Check complete${logSuffix} (override active): 5h=${usage.fiveHour.utilization.toFixed(1)}%, 7d=${usage.sevenDay.utilization.toFixed(1)}%`);
    return;
  }

  const wasPaused = isUsagePaused();

  if (!wasPaused && maxUtil >= usageConfig.pauseThreshold) {
    // PAUSE — usage exceeded threshold
    setPaused(true);
    const dimLabel = getHighestDimensionLabel(usage);
    log(`Usage PAUSED: ${dimLabel} at ${maxUtil.toFixed(1)}% (threshold: ${usageConfig.pauseThreshold}%)`);
    lifecycle.system(
      `⚠️ *Autoloop paused* — Claude usage at *${maxUtil.toFixed(1)}%* (${dimLabel})\n` +
      `Threshold: ${usageConfig.pauseThreshold}% | Resume below: ${usageConfig.resumeThreshold}%\n` +
      `Override: \`fritz override\``
    );
    notifyListeners();
  } else if (wasPaused && maxUtil < usageConfig.resumeThreshold) {
    // RESUME — all dimensions below resume threshold
    setPaused(false);
    log(`Usage RESUMED: max utilization ${maxUtil.toFixed(1)}% (threshold: ${usageConfig.resumeThreshold}%)`);
    lifecycle.system(
      `▶️ *Autoloop resumed* — Claude usage at *${maxUtil.toFixed(1)}%*\n` +
      `Below resume threshold (${usageConfig.resumeThreshold}%)`
    );
    notifyListeners();
  } else {
    // Notify listeners only on significant utilization changes (>= 5% delta)
    if (previousMaxUtil === null || Math.abs(maxUtil - previousMaxUtil) >= 5) {
      notifyListeners();
    }
  }
  previousMaxUtil = maxUtil;

  log(`Check complete${logSuffix}: 5h=${usage.fiveHour.utilization.toFixed(1)}%, ` +
      `7d=${usage.sevenDay.utilization.toFixed(1)}%` +
      (usage.sevenDayOpus ? `, 7d-opus=${usage.sevenDayOpus.utilization.toFixed(1)}%` : '') +
      ` | paused=${isUsagePaused()}`);
}

/**
 * Run a single usage check cycle.
 * @internal Exported for testing only.
 */
export async function check(): Promise<void> {
  const usageConfig = getUsageConfig();
  if (!usageConfig.enabled) return;

  // Proactively refresh the credentials file token if it's near expiry, so
  // the token we read below is always fresh. Only applies to the credentials
  // file token — env var tokens (CLAUDE_CODE_OAUTH_TOKEN) have no refresh token.
  const usingCredentialsFile = authMode === 'credentials_file' || (!envTokenForbidden && !getEnvToken());
  if (usingCredentialsFile) {
    await refreshTokenIfNeeded();
  }

  const token = getOAuthToken();
  if (!token) return; // No token — monitoring disabled at startup

  try {
    const usage = await fetchUsageWithFallback(token);
    applyUsageData(usage, usageConfig);
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      // Token rejected by API — force-refresh regardless of expiresAt, since
      // the API has confirmed the token is invalid (revoked, clock skew, etc.).
      const newToken = await refreshTokenIfNeeded({ force: true });
      if (newToken) {
        log('Token refreshed after 401 — retrying check');
        try {
          const retryUsage = await fetchUsageWithFallback(newToken);
          authMode = 'credentials_file';
          applyUsageData(retryUsage, usageConfig, ' (after refresh)');
          return;
        } catch (retryError: unknown) {
          log(`Retry after refresh also failed: ${retryError instanceof Error ? retryError.message : retryError}`);
          // Fall through to disable monitoring
        }
      }

      log(`ERROR: ${error.message} — disabling usage monitoring`);
      logEvent('usage.disabled', 'Usage monitor disabled — OAuth token expired (401)', { reason: 'auth-expired' });
      lifecycle.system(
        `⚠️ *Usage monitor disabled* — OAuth token expired or invalid.\n` +
        `Run \`claude login\` on the host to refresh.`
      );
      stopReason = 'OAuth token expired and refresh failed (401). Run claude login to re-authenticate.';
      stop();
      return;
    }

    if (error instanceof ForbiddenError) {
      log(`ERROR: ${error.message} — disabling usage monitoring`);
      logEvent('usage.disabled', 'Usage monitor disabled — token forbidden (403)', { reason: 'forbidden' });
      lifecycle.system(
        `⚠️ *Usage monitor disabled* — token lacks permission to access usage API (403 Forbidden).\n` +
        `Long-lived OAuth tokens may not have usage API access.\n` +
        `Fix: run \`claude login\` on the host to create a credentials file with a proper OAuth token.`
      );
      stopReason = 'Token lacks permission to access usage API (403).';
      stop();
      return;
    }

    if (error instanceof RateLimitError) {
      log(`WARNING: ${error.message} — will retry next cycle`);
      return;
    }

    consecutiveErrors++;
    const msg = error instanceof Error ? error.message : String(error);
    log(`ERROR (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${msg}`);

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      log(`Too many consecutive errors — disabling usage monitoring`);
      logEvent('usage.disabled', `Usage monitor disabled — ${MAX_CONSECUTIVE_ERRORS} consecutive errors`, { reason: 'errors', lastError: msg });
      lifecycle.system(
        `⚠️ *Usage monitor disabled* — ${MAX_CONSECUTIVE_ERRORS} consecutive API errors.\n` +
        `Last error: ${msg}`
      );
      stopReason = `${MAX_CONSECUTIVE_ERRORS} consecutive API errors. Last: ${msg}`;
      stop();
    }
    // Fail-open: don't change pause state on errors
  }
}

/**
 * Attempt to fetch usage data, falling back to credentials file token on 403/429.
 *
 * Long-lived OAuth tokens (CLAUDE_CODE_OAUTH_TOKEN) may lack permission to
 * access the usage API (403) or may be stale and rate-limited (429). When
 * either is encountered, this function tries the credentials file token
 * (~/.claude/.credentials.json) as a fallback.
 * If the fallback succeeds, the env token is marked as forbidden so future
 * checks skip directly to the credentials file.
 */
async function fetchUsageWithFallback(primaryToken: string): Promise<CachedUsageData> {
  try {
    return await fetchUsage(primaryToken);
  } catch (error: unknown) {
    if (!(error instanceof ForbiddenError) && !(error instanceof RateLimitError)) {
      throw error; // Not a 403/429 — propagate as-is
    }

    // 403/429 with the primary token — try credentials file fallback
    // (Only useful when primary was the env var token)
    const errorType = error instanceof ForbiddenError ? '403' : '429';
    const hasEnvToken = !envTokenForbidden && getEnvToken();
    const credToken = hasEnvToken ? getCredentialsFileToken() : null;
    log(`Fallback check (${errorType}): hasEnvToken=${!!hasEnvToken}, credToken=${!!credToken}, differs=${credToken !== primaryToken}`);

    if (hasEnvToken && credToken && credToken !== primaryToken) {
        log(`Env var token got ${errorType} — trying credentials file token as fallback`);
        try {
          const usage = await fetchUsage(credToken);
          // Fallback succeeded — remember to skip env token in future
          envTokenForbidden = true;
          authMode = 'credentials_file';
          log(`Credentials file token works — switching to credentials_file auth mode`);
          return usage;
        } catch (fallbackError: unknown) {
          // Fallback also failed — mark env token as forbidden.
          envTokenForbidden = true;
          log(`Credentials file token also failed: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`);
          // If fallback failed with 401, surface that AuthError so check() can
          // attempt a token refresh. Masking it with the original 403 would
          // bypass the refresh logic and immediately disable the monitor.
          if (fallbackError instanceof AuthError) {
            throw fallbackError;
          }
          throw error; // Throw the original error (403 or 429)
        }
    }

    // No fallback available — propagate the original error
    log(`No fallback available — propagating ${errorType}`);
    throw error;
  }
}

/** Get the maximum utilization across all dimensions. */
function getMaxUtilization(usage: CachedUsageData): number {
  let max = Math.max(usage.fiveHour.utilization, usage.sevenDay.utilization);
  if (usage.sevenDayOpus) {
    max = Math.max(max, usage.sevenDayOpus.utilization);
  }
  return max;
}

/** Get a human-readable label for the highest utilization dimension. */
function getHighestDimensionLabel(usage: CachedUsageData): string {
  let max = usage.fiveHour.utilization;
  let label = '5-hour window';

  if (usage.sevenDay.utilization > max) {
    max = usage.sevenDay.utilization;
    label = '7-day quota';
  }
  if (usage.sevenDayOpus && usage.sevenDayOpus.utilization > max) {
    label = '7-day Opus quota';
  }
  return label;
}

// ---------------------------------------------------------------------------
// Change listeners (for dashboard SSE)
// ---------------------------------------------------------------------------

/** Subscribe to usage state changes. Returns an unsubscribe function. */
export function onUsageChange(callback: UsageChangeCallback): () => void {
  changeListeners.add(callback);
  return () => { changeListeners.delete(callback); };
}

function notifyListeners(): void {
  for (const cb of changeListeners) {
    try { cb(); } catch (err) {
      log(`Listener error: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/** Get cached usage data (from last API call). */
export function getUsageData(): CachedUsageData | null {
  return cachedUsage;
}

/** Get ISO timestamp of the last successful API check. */
export function getLastCheckTime(): string | null {
  return lastCheckTime;
}

/** Get the authentication mode being used. */
export function getAuthMode(): 'oauth_token' | 'credentials_file' | 'none' {
  return authMode;
}

/** Get the configured account name (if set). */
export function getAccountName(): string | undefined {
  return config.claudeAccountName;
}

/** Check if the usage monitor is actively running. */
export function isRunning(): boolean {
  return initialTimeout !== null || checkInterval !== null;
}

/** Get the reason the monitor stopped (null if running or never started). */
export function getStopReason(): string | null {
  return stopReason;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Start the usage monitor. */
export function start(): void {
  const usageConfig = getUsageConfig();

  if (!usageConfig.enabled) {
    log('Usage monitoring disabled (usage.enabled: false)');
    return;
  }

  // Already running — idempotent
  if (isRunning()) return;

  // Resolve auth mode
  const token = getOAuthToken();
  if (!token) {
    log('Usage monitoring disabled — no OAuth token available');
    log('Set CLAUDE_CODE_OAUTH_TOKEN or ensure ~/.claude/.credentials.json contains an OAuth token');
    return;
  }

  authMode = (!envTokenForbidden && getEnvToken()) ? 'oauth_token' : 'credentials_file';
  stopReason = null; // Clear any previous stop reason
  log(`Started (auth: ${authMode}, interval: ${usageConfig.checkIntervalMinutes}min, ` +
      `pause: ${usageConfig.pauseThreshold}%, resume: ${usageConfig.resumeThreshold}%, ` +
      `allowP0: ${usageConfig.allowP0})`);

  // First check after a short delay (let other systems initialize)
  initialTimeout = setTimeout(() => {
    initialTimeout = null;
    check();

    // Then check on interval
    checkInterval = setInterval(check, usageConfig.checkIntervalMinutes * 60 * 1000);
  }, 5000);
}

/** Stop the usage monitor. Does NOT reset authMode — it stays as last-known source. */
export function stop(): void {
  stopInner();
  notifyListeners();
}

/** Internal stop — clears timers and cached data but does NOT notify listeners. */
function stopInner(): void {
  if (initialTimeout) {
    clearTimeout(initialTimeout);
    initialTimeout = null;
  }
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  cachedUsage = null;
  lastCheckTime = null;
  previousMaxUtil = null;
}

/**
 * Reload the usage monitor — reset ephemeral error state and restart.
 *
 * Use this when a token has been refreshed (new CLAUDE_CODE_OAUTH_TOKEN or
 * updated credentials file) and monitoring was previously stopped/disabled.
 * Also clears the envTokenForbidden flag so the env var token is retried.
 */
export function reload(): void {
  stopInner(); // no intermediate notification
  envTokenForbidden = false;
  consecutiveErrors = 0;
  stopReason = null;
  start();
  notifyListeners();
}

/**
 * Reset internal state (for testing only).
 * @internal
 */
export function _resetForTesting(): void {
  stopInner();
  authMode = 'none';
  consecutiveErrors = 0;
  envTokenForbidden = false;
  stopReason = null;
  changeListeners.clear();
}
