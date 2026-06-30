/**
 * fritZ configuration loader (fritz.yaml)
 *
 * Loads operational configuration from config/fritz.yaml:
 *   - Agent defaults (TTL, model)
 *   - Per-role overrides
 *   - Orchestrator model
 *   - Daemon operational limits (parallelism, queues, timeouts, watchdog)
 *   - Claude Code behavior flags (skip permissions, print mode)
 *   - Telegram UX tuning (feedback, typing, edit-in-place)
 *   - Telegram topic thread IDs
 *
 * Config is loaded once at startup and cached.
 * Daemon fails to start if YAML is missing or invalid.
 *
 * See also: config.ts for environment-based configuration (.env)
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import type { AgentRole } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Agent configuration for a specific role
export interface AgentConfig {
  ttl: number;        // Time-to-live in seconds
  model: string;      // Claude model to use
}

// Orchestrator-specific configuration (no TTL — persistent process)
export interface OrchestratorConfig {
  model: string;
}

// Telegram topic thread IDs for role-based message routing
export interface TelegramTopics {
  define?: number;
  implement?: number;
  review?: number;
  validate?: number;
  questions?: number;
  retro?: number;
}

// Daemon-level operational limits (separate from per-agent defaults)
export interface DaemonConfig {
  maxParallelAgents: number;
  maxQueueSize: number;
  persistDebounceMs: number;
  agentMessageTimeoutMs: number;
  startupReadinessTimeoutMs: number;
  watchdogIntervalSec: number;
  workspaceMaxAgeHours: number;
  logArchiveMaxAgeDays: number;
  cleanupArtifactGlobs: string[];  // Build artifact directories to strip on agent exit (e.g. "target", "node_modules")
  deployWorkflow: string;
  staleDeploymentReminderDays: number;  // Days before stale deployment reminder fires (default: 3)
  writeQueueEnabled: boolean;           // Feature flag for GitHub write queue (default: true)
}

// Per-repo deployment tracker config
export interface RepoConfig {
  deploymentTracker?: boolean;  // default: true — set to false to opt-out
}

// Map of repo name → per-repo config
export interface ReposConfig {
  [repo: string]: RepoConfig;
}

// Notification mode controls Telegram notification verbosity
export type NotificationMode = 'quiet' | 'compact' | 'verbose' | 'essential';

// GitHub comment level controls GitHub issue comment verbosity
export type GitHubCommentLevel = 'essential' | 'quiet' | 'verbose';

// GitHub configuration (from fritz.yaml github section)
export interface GitHubConfig {
  commentLevel: GitHubCommentLevel;
}

// Telegram UX tuning (from fritz.yaml telegram section)
export interface TelegramConfig {
  chatFeedbackEnabled: boolean;
  typingIndicatorIntervalMs: number;
  progressUpdateIntervalMs: number;
  timeoutWarningThreshold: number;
  editInPlaceEnabled: boolean;
  editMinIntervalMs: number;
  notificationMode: NotificationMode;
}

// Claude Code behavior flags (from fritz.yaml claude section)
export interface ClaudeConfig {
  claudeSkipPermissions: boolean;
  claudePrintMode: boolean;
}

// Agent Teams configuration (from fritz.yaml teams section)
// All agents use persistent mode — enabled/roles gate removed (issue #329)
export interface TeamsConfig {
  ttlMultiplier: number;
}

// Dashboard configuration (from fritz.yaml dashboard section)
export interface DashboardConfig {
  enabled: boolean;
}

// Usage monitoring configuration (from fritz.yaml usage section)
export interface UsageConfig {
  enabled: boolean;
  pauseThreshold: number;       // Pause when any dimension >= this % (0-100)
  resumeThreshold: number;      // Resume when all dimensions < this %
  checkIntervalMinutes: number;  // How often to query the API
  allowP0: boolean;             // P0 issues bypass usage pause
}

// Schedule frequency types
export type ScheduleFrequency = 'hourly' | 'daily' | 'weekly';

// A configured scheduled job (from fritz.yaml)
export interface ScheduledJobConfig {
  id: string;                          // Unique identifier (e.g., "weekly-retro")
  role: string;                        // Agent role to invoke (e.g., "retro", "security-review")
  frequency: ScheduleFrequency;       // How often to run
  dayOfWeek?: number;                  // 0=Sunday..6=Saturday (required for weekly)
  hour: number;                        // Hour in UTC (0-23)
  minute?: number;                     // Minute (0-59, default 0)
  enabled: boolean;                    // Whether the job is active
  issueTitle: string;                  // Title template for created issues
  issueLabels?: string[];              // Additional labels (e.g., ["fritz.auto-pipeline"])
  issueBody?: string;                  // Optional body template for the issue
}

// Scheduler configuration (from fritz.yaml scheduler section)
export interface SchedulerConfig {
  enabled: boolean;                    // Master switch (default: false)
  checkIntervalSec: number;           // How often to check for due jobs (default: 60)
  jobs: ScheduledJobConfig[];          // Job definitions
}

// Autoloop configuration (from fritz.yaml autoloop section)
export interface AutoloopConfig {
  intervalSec: number;                 // Check for work every N seconds (default: 60)
  cleanupEveryNthCycle: number;        // Run fritz.depends-on cleanup every Nth cycle (default: 10)
}

// Default daemon config values (used when daemon section is absent or incomplete)
const DAEMON_DEFAULTS: DaemonConfig = {
  maxParallelAgents: 4,
  maxQueueSize: 10,
  persistDebounceMs: 1000,
  agentMessageTimeoutMs: 180_000,
  startupReadinessTimeoutMs: 30_000,
  watchdogIntervalSec: 60,
  workspaceMaxAgeHours: 24,
  logArchiveMaxAgeDays: 7,
  cleanupArtifactGlobs: ['target', 'node_modules', 'build', '.venv'],
  deployWorkflow: 'build-and-deploy-hetzner.yml',
  staleDeploymentReminderDays: 3,
  writeQueueEnabled: true,
};

// Valid notification modes
const VALID_NOTIFICATION_MODES: NotificationMode[] = ['quiet', 'compact', 'verbose', 'essential'];

// Valid GitHub comment levels
const VALID_COMMENT_LEVELS: GitHubCommentLevel[] = ['essential', 'quiet', 'verbose'];

// Default GitHub config values
const GITHUB_DEFAULTS: GitHubConfig = {
  commentLevel: 'essential',
};

// Default telegram config values
const TELEGRAM_DEFAULTS: TelegramConfig = {
  chatFeedbackEnabled: true,
  typingIndicatorIntervalMs: 4000,
  progressUpdateIntervalMs: 30000,
  timeoutWarningThreshold: 0.8,
  editInPlaceEnabled: true,
  editMinIntervalMs: 5000,
  notificationMode: 'essential',
};

// Default Claude Code behavior config values
const CLAUDE_DEFAULTS: ClaudeConfig = {
  claudeSkipPermissions: true,
  claudePrintMode: true,
};

// Default Agent Teams config values (fallback when teams: section is absent from fritz.yaml).
// Note: shipped fritz.yaml sets ttlMultiplier: 2.0 — this 1.0 default means "no multiplication"
// so removing the teams: section entirely disables TTL extension rather than applying 2x.
const TEAMS_DEFAULTS: TeamsConfig = {
  ttlMultiplier: 1.0,
};

const DASHBOARD_DEFAULTS: DashboardConfig = {
  enabled: true,
};

const USAGE_DEFAULTS: UsageConfig = {
  enabled: true,
  pauseThreshold: 80,
  resumeThreshold: 50,
  checkIntervalMinutes: 5,
  allowP0: true,
};

const SCHEDULER_DEFAULTS: SchedulerConfig = {
  enabled: false,
  checkIntervalSec: 60,
  jobs: [],
};

const AUTOLOOP_DEFAULTS: AutoloopConfig = {
  intervalSec: 60,
  cleanupEveryNthCycle: 10,
};

// Valid schedule frequencies
const VALID_FREQUENCIES: ScheduleFrequency[] = ['hourly', 'daily', 'weekly'];

// Valid roles for scheduler jobs (mirrors AgentRole from types.ts)
const VALID_SCHEDULER_ROLES: AgentRole[] = [
  'implement', 'review', 'validate', 'define', 'architect',
  'ux', 'budget', 'retro', 'security-review',
];

// Maximum number of scheduled jobs (bounded by GitHub rate limits)
const MAX_SCHEDULER_JOBS = 20;

// Valid job ID pattern
const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Default base TTL for chat-mode agents when defaults.chatTtl is not configured.
// Base value (effective TTL = base × teams.ttlMultiplier). 14400s = 4h base → 8h effective.
const DEFAULT_CHAT_TTL = 14400;

// Structure of fritz.yaml file
interface FritzConfigSchema {
  defaults: AgentConfig & { chatTtl: number };
  orchestrator?: OrchestratorConfig;
  claude: ClaudeConfig;
  daemon: DaemonConfig;
  telegramConfig: TelegramConfig;
  githubConfig: GitHubConfig;
  teams: TeamsConfig;
  dashboard: DashboardConfig;
  usage: UsageConfig;
  scheduler: SchedulerConfig;
  autoloop: AutoloopConfig;
  repos: ReposConfig;
  roles?: Record<string, Partial<AgentConfig>>;
  telegram?: {
    topics?: TelegramTopics;
  };
}

// Cached configuration (loaded once at startup)
let cachedConfig: FritzConfigSchema | null = null;

// Test override for config path
let testConfigPath: string | null = null;

/**
 * Get the path to fritz.yaml
 * In Docker: /app/config/fritz.yaml
 * In local dev: fritz-orchestrator/config/fritz.yaml (resolved relative to source)
 */
export function getConfigPath(): string {
  const isDocker = existsSync('/.dockerenv');
  const configDir = isDocker ? '/app/config' : resolve(__dirname, '../../../config');
  return resolve(configDir, 'fritz.yaml');
}

/**
 * Load fritz.yaml from hardcoded path.
 * Throws if file doesn't exist or is invalid - daemon cannot start without valid config.
 */
function loadFritzConfig(): FritzConfigSchema {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = testConfigPath ?? getConfigPath();

  if (!existsSync(configPath)) {
    throw new Error(`fritz.yaml not found at ${configPath}. Daemon cannot start without agent configuration.`);
  }

  let content: string;
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch (err: unknown) {
    throw new Error(`Failed to read fritz.yaml: ${err instanceof Error ? err.message : err}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err: unknown) {
    throw new Error(`Failed to parse fritz.yaml: ${err instanceof Error ? err.message : err}`);
  }

  // Validate structure
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('fritz.yaml must be a valid YAML object');
  }

  const config = parsed as Record<string, unknown>;

  if (!config.defaults || typeof config.defaults !== 'object') {
    throw new Error('fritz.yaml must have a "defaults" section');
  }

  const defaults = config.defaults as Record<string, unknown>;

  // Validate required default fields
  if (typeof defaults.ttl !== 'number') {
    throw new Error('fritz.yaml defaults.ttl must be a number');
  }
  if (typeof defaults.model !== 'string') {
    throw new Error('fritz.yaml defaults.model must be a string');
  }

  // Parse optional orchestrator section
  let orchestrator: OrchestratorConfig | undefined;
  if (config.orchestrator && typeof config.orchestrator === 'object') {
    const orch = config.orchestrator as Record<string, unknown>;
    if (typeof orch.model === 'string') {
      orchestrator = { model: orch.model };
    }
  }

  // Parse claude behavior section
  const claudeRaw = (config.claude && typeof config.claude === 'object')
    ? config.claude as Record<string, unknown>
    : {};
  const claude: ClaudeConfig = {
    claudeSkipPermissions: typeof claudeRaw.claudeSkipPermissions === 'boolean'
      ? claudeRaw.claudeSkipPermissions : CLAUDE_DEFAULTS.claudeSkipPermissions,
    claudePrintMode: typeof claudeRaw.claudePrintMode === 'boolean'
      ? claudeRaw.claudePrintMode : CLAUDE_DEFAULTS.claudePrintMode,
  };

  // Parse daemon section (operational limits, separate from per-agent defaults)
  const daemonRaw = (config.daemon && typeof config.daemon === 'object')
    ? config.daemon as Record<string, unknown>
    : {};
  const daemon: DaemonConfig = {
    maxParallelAgents: typeof daemonRaw.maxParallelAgents === 'number'
      ? daemonRaw.maxParallelAgents : DAEMON_DEFAULTS.maxParallelAgents,
    maxQueueSize: typeof daemonRaw.maxQueueSize === 'number'
      ? daemonRaw.maxQueueSize : DAEMON_DEFAULTS.maxQueueSize,
    persistDebounceMs: typeof daemonRaw.persistDebounceMs === 'number'
      ? daemonRaw.persistDebounceMs : DAEMON_DEFAULTS.persistDebounceMs,
    agentMessageTimeoutMs: typeof daemonRaw.agentMessageTimeoutMs === 'number'
      ? daemonRaw.agentMessageTimeoutMs : DAEMON_DEFAULTS.agentMessageTimeoutMs,
    startupReadinessTimeoutMs: typeof daemonRaw.startupReadinessTimeoutMs === 'number' && daemonRaw.startupReadinessTimeoutMs > 0
      ? daemonRaw.startupReadinessTimeoutMs : DAEMON_DEFAULTS.startupReadinessTimeoutMs,
    watchdogIntervalSec: typeof daemonRaw.watchdogIntervalSec === 'number'
      ? daemonRaw.watchdogIntervalSec : DAEMON_DEFAULTS.watchdogIntervalSec,
    workspaceMaxAgeHours: typeof daemonRaw.workspaceMaxAgeHours === 'number'
      ? daemonRaw.workspaceMaxAgeHours : DAEMON_DEFAULTS.workspaceMaxAgeHours,
    logArchiveMaxAgeDays: typeof daemonRaw.logArchiveMaxAgeDays === 'number'
      ? daemonRaw.logArchiveMaxAgeDays : DAEMON_DEFAULTS.logArchiveMaxAgeDays,
    cleanupArtifactGlobs: Array.isArray(daemonRaw.cleanupArtifactGlobs)
      ? daemonRaw.cleanupArtifactGlobs.filter((g: unknown) => typeof g === 'string') as string[]
      : DAEMON_DEFAULTS.cleanupArtifactGlobs,
    deployWorkflow: typeof daemonRaw.deployWorkflow === 'string' && daemonRaw.deployWorkflow.trim()
      ? daemonRaw.deployWorkflow.trim() : DAEMON_DEFAULTS.deployWorkflow,
    staleDeploymentReminderDays: typeof daemonRaw.staleDeploymentReminderDays === 'number'
      ? daemonRaw.staleDeploymentReminderDays : DAEMON_DEFAULTS.staleDeploymentReminderDays,
    writeQueueEnabled: typeof daemonRaw.writeQueue === 'object' && daemonRaw.writeQueue !== null
      && typeof (daemonRaw.writeQueue as Record<string, unknown>).enabled === 'boolean'
      ? (daemonRaw.writeQueue as Record<string, unknown>).enabled as boolean
      : DAEMON_DEFAULTS.writeQueueEnabled,
  };

  // Parse telegram UX tuning section
  const telegramRaw = (config.telegram && typeof config.telegram === 'object')
    ? config.telegram as Record<string, unknown>
    : {};
  // Parse and validate notificationMode
  const rawNotificationMode = typeof telegramRaw.notificationMode === 'string'
    ? telegramRaw.notificationMode as string
    : TELEGRAM_DEFAULTS.notificationMode;
  const notificationMode: NotificationMode = VALID_NOTIFICATION_MODES.includes(rawNotificationMode as NotificationMode)
    ? rawNotificationMode as NotificationMode
    : TELEGRAM_DEFAULTS.notificationMode;
  if (typeof telegramRaw.notificationMode === 'string' && !VALID_NOTIFICATION_MODES.includes(telegramRaw.notificationMode as NotificationMode)) {
    console.warn(`[fritz-config] Warning: telegram.notificationMode "${telegramRaw.notificationMode}" is invalid. Using default "${TELEGRAM_DEFAULTS.notificationMode}".`);
  }

  const telegramConfig: TelegramConfig = {
    chatFeedbackEnabled: typeof telegramRaw.chatFeedbackEnabled === 'boolean'
      ? telegramRaw.chatFeedbackEnabled : TELEGRAM_DEFAULTS.chatFeedbackEnabled,
    typingIndicatorIntervalMs: typeof telegramRaw.typingIndicatorIntervalMs === 'number'
      ? telegramRaw.typingIndicatorIntervalMs : TELEGRAM_DEFAULTS.typingIndicatorIntervalMs,
    progressUpdateIntervalMs: typeof telegramRaw.progressUpdateIntervalMs === 'number'
      ? telegramRaw.progressUpdateIntervalMs : TELEGRAM_DEFAULTS.progressUpdateIntervalMs,
    timeoutWarningThreshold: typeof telegramRaw.timeoutWarningThreshold === 'number'
      ? telegramRaw.timeoutWarningThreshold : TELEGRAM_DEFAULTS.timeoutWarningThreshold,
    editInPlaceEnabled: typeof telegramRaw.editInPlaceEnabled === 'boolean'
      ? telegramRaw.editInPlaceEnabled : TELEGRAM_DEFAULTS.editInPlaceEnabled,
    editMinIntervalMs: typeof telegramRaw.editMinIntervalMs === 'number'
      ? telegramRaw.editMinIntervalMs : TELEGRAM_DEFAULTS.editMinIntervalMs,
    notificationMode,
  };

  // Parse github section (comment level filtering)
  const githubRaw = (config.github && typeof config.github === 'object')
    ? config.github as Record<string, unknown>
    : {};
  const rawCommentLevel = typeof githubRaw.commentLevel === 'string'
    ? githubRaw.commentLevel as string
    : GITHUB_DEFAULTS.commentLevel;
  const commentLevel: GitHubCommentLevel = VALID_COMMENT_LEVELS.includes(rawCommentLevel as GitHubCommentLevel)
    ? rawCommentLevel as GitHubCommentLevel
    : GITHUB_DEFAULTS.commentLevel;
  if (typeof githubRaw.commentLevel === 'string' && !VALID_COMMENT_LEVELS.includes(githubRaw.commentLevel as GitHubCommentLevel)) {
    console.warn(`[fritz-config] Warning: github.commentLevel "${githubRaw.commentLevel}" is invalid. Using default "${GITHUB_DEFAULTS.commentLevel}".`);
  }
  const githubConfig: GitHubConfig = {
    commentLevel,
  };

  // Parse teams section (enabled/roles removed in #329 — silently ignored for backwards compat)
  const teamsRaw = (config.teams && typeof config.teams === 'object')
    ? config.teams as Record<string, unknown>
    : {};
  const teams: TeamsConfig = {
    ttlMultiplier: typeof teamsRaw.ttlMultiplier === 'number'
      ? teamsRaw.ttlMultiplier : TEAMS_DEFAULTS.ttlMultiplier,
  };

  // Parse dashboard section
  const dashboardRaw = (config.dashboard && typeof config.dashboard === 'object')
    ? config.dashboard as Record<string, unknown>
    : {};
  const dashboard: DashboardConfig = {
    enabled: typeof dashboardRaw.enabled === 'boolean'
      ? dashboardRaw.enabled : DASHBOARD_DEFAULTS.enabled,
  };

  // Parse usage monitoring section
  const usageRaw = (config.usage && typeof config.usage === 'object')
    ? config.usage as Record<string, unknown>
    : {};
  const usageParsed: UsageConfig = {
    enabled: typeof usageRaw.enabled === 'boolean'
      ? usageRaw.enabled : USAGE_DEFAULTS.enabled,
    pauseThreshold: typeof usageRaw.pauseThreshold === 'number'
      ? usageRaw.pauseThreshold : USAGE_DEFAULTS.pauseThreshold,
    resumeThreshold: typeof usageRaw.resumeThreshold === 'number'
      ? usageRaw.resumeThreshold : USAGE_DEFAULTS.resumeThreshold,
    checkIntervalMinutes: typeof usageRaw.checkIntervalMinutes === 'number'
      ? usageRaw.checkIntervalMinutes : USAGE_DEFAULTS.checkIntervalMinutes,
    allowP0: typeof usageRaw.allowP0 === 'boolean'
      ? usageRaw.allowP0 : USAGE_DEFAULTS.allowP0,
  };

  // Validate usage thresholds
  if (usageParsed.pauseThreshold <= usageParsed.resumeThreshold) {
    console.warn(`[fritz-config] Warning: usage.pauseThreshold (${usageParsed.pauseThreshold}) must be greater than resumeThreshold (${usageParsed.resumeThreshold}). Using defaults.`);
    usageParsed.pauseThreshold = USAGE_DEFAULTS.pauseThreshold;
    usageParsed.resumeThreshold = USAGE_DEFAULTS.resumeThreshold;
  }

  // Validate check interval
  if (usageParsed.checkIntervalMinutes <= 0) {
    console.warn(`[fritz-config] Warning: usage.checkIntervalMinutes must be > 0. Using default (${USAGE_DEFAULTS.checkIntervalMinutes}).`);
    usageParsed.checkIntervalMinutes = USAGE_DEFAULTS.checkIntervalMinutes;
  }

  // Parse scheduler section
  const schedulerRaw = (config.scheduler && typeof config.scheduler === 'object')
    ? config.scheduler as Record<string, unknown>
    : {};
  const schedulerParsed: SchedulerConfig = {
    enabled: typeof schedulerRaw.enabled === 'boolean'
      ? schedulerRaw.enabled : SCHEDULER_DEFAULTS.enabled,
    checkIntervalSec: typeof schedulerRaw.checkIntervalSec === 'number'
      ? schedulerRaw.checkIntervalSec : SCHEDULER_DEFAULTS.checkIntervalSec,
    jobs: Array.isArray(schedulerRaw.jobs) ? parseSchedulerJobs(schedulerRaw.jobs) : [],
  };

  // Validate scheduler check interval
  if (schedulerParsed.checkIntervalSec <= 0) {
    console.warn(`[fritz-config] Warning: scheduler.checkIntervalSec must be > 0. Using default (${SCHEDULER_DEFAULTS.checkIntervalSec}).`);
    schedulerParsed.checkIntervalSec = SCHEDULER_DEFAULTS.checkIntervalSec;
  }

  // Parse autoloop section
  const autoloopRaw = (config.autoloop && typeof config.autoloop === 'object')
    ? config.autoloop as Record<string, unknown>
    : {};
  const autoloopParsed: AutoloopConfig = {
    intervalSec: typeof autoloopRaw.intervalSec === 'number'
      ? autoloopRaw.intervalSec : AUTOLOOP_DEFAULTS.intervalSec,
    cleanupEveryNthCycle: typeof autoloopRaw.cleanupEveryNthCycle === 'number'
      ? autoloopRaw.cleanupEveryNthCycle : AUTOLOOP_DEFAULTS.cleanupEveryNthCycle,
  };

  // Validate autoloop interval
  if (autoloopParsed.intervalSec <= 0) {
    console.warn(`[fritz-config] Warning: autoloop.intervalSec must be > 0. Using default (${AUTOLOOP_DEFAULTS.intervalSec}).`);
    autoloopParsed.intervalSec = AUTOLOOP_DEFAULTS.intervalSec;
  }

  // Validate cleanup cycle count
  if (autoloopParsed.cleanupEveryNthCycle <= 0) {
    console.warn(`[fritz-config] Warning: autoloop.cleanupEveryNthCycle must be > 0. Using default (${AUTOLOOP_DEFAULTS.cleanupEveryNthCycle}).`);
    autoloopParsed.cleanupEveryNthCycle = AUTOLOOP_DEFAULTS.cleanupEveryNthCycle;
  }

  // Parse repos section (per-repo deployment tracker config)
  const reposRaw = (config.repos && typeof config.repos === 'object')
    ? config.repos as Record<string, unknown>
    : {};
  const reposParsed: ReposConfig = {};
  for (const [repoName, repoConf] of Object.entries(reposRaw)) {
    if (repoConf && typeof repoConf === 'object') {
      const rc = repoConf as Record<string, unknown>;
      reposParsed[repoName] = {
        deploymentTracker: typeof rc['deployment-tracker'] === 'boolean'
          ? rc['deployment-tracker'] : undefined,
      };
    }
  }

  // Parse optional telegram topics section
  let telegram: { topics?: TelegramTopics } | undefined;
  if (config.telegram && typeof config.telegram === 'object') {
    const tg = config.telegram as Record<string, unknown>;
    if (tg.topics && typeof tg.topics === 'object') {
      const raw = tg.topics as Record<string, unknown>;
      telegram = {
        topics: {
          define: typeof raw.define === 'number' ? raw.define : undefined,
          implement: typeof raw.implement === 'number' ? raw.implement : undefined,
          review: typeof raw.review === 'number' ? raw.review : undefined,
          validate: typeof raw.validate === 'number' ? raw.validate : undefined,
          questions: typeof raw.questions === 'number' ? raw.questions : undefined,
          retro: typeof raw.retro === 'number' ? raw.retro : undefined,
        },
      };
    }
  }

  cachedConfig = {
    defaults: {
      ttl: defaults.ttl,
      model: defaults.model,
      chatTtl: typeof defaults.chatTtl === 'number' ? defaults.chatTtl : DEFAULT_CHAT_TTL,
    },
    orchestrator,
    claude,
    daemon,
    telegramConfig,
    githubConfig,
    teams,
    dashboard,
    usage: usageParsed,
    scheduler: schedulerParsed,
    autoloop: autoloopParsed,
    repos: reposParsed,
    roles: config.roles as Record<string, Partial<AgentConfig>> | undefined,
    telegram,
  };

  console.log(`[fritz-config] Loaded configuration from ${configPath}`);

  return cachedConfig;
}

/**
 * Parse and validate scheduler job definitions from fritz.yaml.
 * Invalid jobs are logged and skipped.
 */
function parseSchedulerJobs(rawJobs: unknown[]): ScheduledJobConfig[] {
  const jobs: ScheduledJobConfig[] = [];
  const seenIds = new Set<string>();

  for (const raw of rawJobs) {
    if (!raw || typeof raw !== 'object') {
      console.warn('[fritz-config] Warning: scheduler job entry is not an object, skipping');
      continue;
    }

    const job = raw as Record<string, unknown>;

    // Validate id
    if (typeof job.id !== 'string' || !JOB_ID_PATTERN.test(job.id)) {
      console.warn(`[fritz-config] Warning: scheduler job has invalid id "${job.id}", skipping`);
      continue;
    }

    // Check for duplicate id
    if (seenIds.has(job.id)) {
      console.warn(`[fritz-config] Warning: duplicate scheduler job id "${job.id}", skipping`);
      continue;
    }

    // Validate role against known agent roles
    if (typeof job.role !== 'string' || !VALID_SCHEDULER_ROLES.includes(job.role as AgentRole)) {
      console.warn(`[fritz-config] Warning: scheduler job "${job.id}" has invalid role "${job.role}" (valid: ${VALID_SCHEDULER_ROLES.join(', ')}), skipping`);
      continue;
    }

    // Validate frequency
    if (typeof job.frequency !== 'string' || !VALID_FREQUENCIES.includes(job.frequency as ScheduleFrequency)) {
      console.warn(`[fritz-config] Warning: scheduler job "${job.id}" has invalid frequency "${job.frequency}", skipping`);
      continue;
    }

    const frequency = job.frequency as ScheduleFrequency;

    // Validate dayOfWeek for weekly
    if (frequency === 'weekly') {
      if (typeof job.dayOfWeek !== 'number' || job.dayOfWeek < 0 || job.dayOfWeek > 6) {
        console.warn(`[fritz-config] Warning: scheduler job "${job.id}" (weekly) has invalid dayOfWeek "${job.dayOfWeek}", skipping`);
        continue;
      }
    }

    // Validate hour (required for daily/weekly, ignored for hourly)
    if (frequency === 'hourly') {
      if (typeof job.hour === 'number') {
        console.warn(`[fritz-config] Warning: scheduler job "${job.id}" has hour=${job.hour} but frequency is "hourly" — hour is ignored for hourly jobs`);
      }
    } else {
      if (typeof job.hour !== 'number' || job.hour < 0 || job.hour > 23) {
        console.warn(`[fritz-config] Warning: scheduler job "${job.id}" has invalid hour "${job.hour}", skipping`);
        continue;
      }
    }

    // Validate minute
    const minute = typeof job.minute === 'number' ? job.minute : 0;
    if (minute < 0 || minute > 59) {
      console.warn(`[fritz-config] Warning: scheduler job "${job.id}" has invalid minute "${job.minute}", skipping`);
      continue;
    }

    // Validate issueTitle
    if (typeof job.issueTitle !== 'string' || job.issueTitle.length === 0) {
      console.warn(`[fritz-config] Warning: scheduler job "${job.id}" has missing issueTitle, skipping`);
      continue;
    }

    // Parse labels
    const issueLabels = Array.isArray(job.issueLabels)
      ? job.issueLabels.filter((l: unknown) => typeof l === 'string') as string[]
      : undefined;

    seenIds.add(job.id);
    jobs.push({
      id: job.id,
      role: job.role,
      frequency,
      dayOfWeek: frequency === 'weekly' ? (job.dayOfWeek as number) : undefined,
      hour: typeof job.hour === 'number' ? job.hour : 0,
      minute,
      enabled: typeof job.enabled === 'boolean' ? job.enabled : true,
      issueTitle: job.issueTitle,
      issueLabels,
      issueBody: typeof job.issueBody === 'string' ? job.issueBody : undefined,
    });

    // Enforce max jobs limit
    if (jobs.length >= MAX_SCHEDULER_JOBS) {
      console.warn(`[fritz-config] Warning: scheduler job limit (${MAX_SCHEDULER_JOBS}) reached, ignoring remaining jobs`);
      break;
    }
  }

  return jobs;
}

/**
 * Get resolved configuration for a specific agent role.
 * Resolution order: role-specific YAML > YAML defaults
 */
export function getAgentConfig(role: AgentRole): AgentConfig {
  const config = loadFritzConfig();
  const roleConfig = config.roles?.[role] || {};

  return {
    ttl: roleConfig.ttl ?? config.defaults.ttl,
    model: roleConfig.model ?? config.defaults.model,
  };
}

/**
 * Get TTL for a role.
 */
export function getRoleTtl(role: AgentRole): number {
  return getAgentConfig(role).ttl;
}

/**
 * Get model for a role.
 */
export function getRoleModel(role: AgentRole): string {
  return getAgentConfig(role).model;
}

/**
 * Get the default model (from defaults section).
 */
export function getDefaultModel(): string {
  return loadFritzConfig().defaults.model;
}

/**
 * Get the base TTL for chat-mode agents (defaults.chatTtl).
 * Used by bootAgent when mode === 'chat' and no explicit ttl was passed.
 * Effective TTL = this value × teams.ttlMultiplier.
 */
export function getDefaultChatTtl(): number {
  return loadFritzConfig().defaults.chatTtl;
}

/**
 * Get the orchestrator model.
 * Falls back to defaults.model if orchestrator section is not configured.
 */
export function getOrchestratorModel(): string {
  const config = loadFritzConfig();
  return config.orchestrator?.model ?? config.defaults.model;
}

/**
 * Get the maximum number of parallel agent containers.
 * Runtime override (set via dashboard) takes precedence over fritz.yaml.
 * Configured in fritz.yaml under daemon.maxParallelAgents (default: 4).
 */
export function getMaxParallelAgents(): number {
  return runtimeMaxParallelAgents ?? loadFritzConfig().daemon.maxParallelAgents;
}

/**
 * Set a runtime max parallel agents override.
 * Pass null to clear the override and use the fritz.yaml value.
 * Value is clamped to 1–20.
 */
export function setMaxParallelAgents(count: number | null): void {
  if (count === null) {
    runtimeMaxParallelAgents = null;
    return;
  }
  // Clamp 1–20: defense-in-depth for internal callers. The dashboard endpoint
  // also validates strictly (rejects out-of-range), and the UI disables buttons
  // at boundaries — three layers ensure no invalid value reaches the runtime.
  runtimeMaxParallelAgents = Math.max(1, Math.min(20, Math.round(count)));
}

/**
 * Persist the current maxParallelAgents value to fritz.yaml using targeted regex replacement.
 * Preserves comments and formatting. Creates a .bak backup before writing.
 * Assumes count is already validated as integer 1–20 by the caller (endpoint validates,
 * setMaxParallelAgents clamps as defense-in-depth).
 * Returns true on success, false on failure.
 */
export function persistMaxParallelAgents(count: number): boolean {
  try {
    const configPath = testConfigPath ?? getConfigPath();
    const content = readFileSync(configPath, 'utf-8');
    const pattern = /^(\s*maxParallelAgents:\s*)\d+/m;
    if (!pattern.test(content)) {
      console.warn('[fritz-config] Cannot persist maxParallelAgents: key not found in fritz.yaml');
      return false;
    }
    const updated = content.replace(pattern, `$1${count}`);
    copyFileSync(configPath, configPath + '.bak');
    writeFileSync(configPath, updated, 'utf-8');
    return true;
  } catch (err) {
    console.error(`[fritz-config] Failed to persist maxParallelAgents: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Get the daemon-level operational limits.
 * Configured in fritz.yaml under the daemon section.
 */
export function getDaemonConfig(): DaemonConfig {
  return loadFritzConfig().daemon;
}

/**
 * Get the log archive max age in days.
 * Configured in fritz.yaml under daemon.logArchiveMaxAgeDays (default: 7).
 */
export function getLogArchiveMaxAgeDays(): number {
  return loadFritzConfig().daemon.logArchiveMaxAgeDays;
}

/**
 * Get Telegram topic configuration.
 * Returns undefined if no telegram.topics section is configured.
 */
export function getTelegramTopics(): TelegramTopics | undefined {
  return loadFritzConfig().telegram?.topics;
}

/**
 * Get Telegram UX tuning configuration.
 * Configured in fritz.yaml under the telegram section.
 */
export function getTelegramConfig(): TelegramConfig {
  return loadFritzConfig().telegramConfig;
}

/**
 * Get Claude Code behavior configuration.
 * Configured in fritz.yaml under the claude section.
 */
export function getClaudeConfig(): ClaudeConfig {
  return loadFritzConfig().claude;
}

/**
 * Get Agent Teams configuration.
 * Configured in fritz.yaml under the teams section.
 * All agents use persistent mode — ttlMultiplier applies to all agents.
 *
 * @see ADR-009 in DECISIONS.md — enabled/roles gate removed, persistent mode is universal.
 */
export function getTeamsConfig(): TeamsConfig {
  return loadFritzConfig().teams;
}

/**
 * Get dashboard configuration.
 * Configured in fritz.yaml under the dashboard section.
 */
export function getDashboardConfig(): DashboardConfig {
  return loadFritzConfig().dashboard;
}

/**
 * Get usage monitoring configuration.
 * Configured in fritz.yaml under the usage section.
 */
export function getUsageConfig(): UsageConfig {
  return loadFritzConfig().usage;
}

/**
 * Get scheduler configuration.
 * Configured in fritz.yaml under the scheduler section.
 * Disabled by default — operator must explicitly enable.
 */
export function getSchedulerConfig(): SchedulerConfig {
  return loadFritzConfig().scheduler;
}

/**
 * Get autoloop configuration.
 * Configured in fritz.yaml under the autoloop section.
 */
export function getAutoloopConfig(): AutoloopConfig {
  return loadFritzConfig().autoloop;
}

/**
 * Get per-repo config for a specific repo.
 * Returns an empty object (all defaults) if the repo has no overrides.
 */
export function getRepoConfig(repo: string): RepoConfig {
  return loadFritzConfig().repos[repo] ?? {};
}

/**
 * Get all per-repo configs.
 * Returns the full repos map from fritz.yaml.
 */
export function getAllRepoConfigs(): ReposConfig {
  return loadFritzConfig().repos;
}

// Runtime override for max parallel agents (set via dashboard stepper).
// null means "use fritz.yaml value" (no runtime override).
let runtimeMaxParallelAgents: number | null = null;

// Runtime override for notification mode (set via "fritz mode" Telegram command).
// null means "use fritz.yaml value" (no runtime override).
let runtimeNotificationMode: NotificationMode | null = null;

/**
 * Get the active notification mode.
 * Runtime override (set via "fritz mode" command) takes precedence over fritz.yaml.
 */
export function getNotificationMode(): NotificationMode {
  return runtimeNotificationMode ?? loadFritzConfig().telegramConfig.notificationMode;
}

/**
 * Set a runtime notification mode override.
 * Pass null to clear the override and use the fritz.yaml value.
 */
export function setNotificationMode(mode: NotificationMode | null): void {
  runtimeNotificationMode = mode;
}

/**
 * Check if a given string is a valid notification mode.
 */
export function isValidNotificationMode(mode: string): mode is NotificationMode {
  return VALID_NOTIFICATION_MODES.includes(mode as NotificationMode);
}

// Runtime override for GitHub comment level (set via "fritz github mode" command).
// null means "use fritz.yaml value" (no runtime override).
let runtimeCommentLevel: GitHubCommentLevel | null = null;

/**
 * Get the active GitHub comment level.
 * Runtime override takes precedence over fritz.yaml.
 */
export function getCommentLevel(): GitHubCommentLevel {
  return runtimeCommentLevel ?? loadFritzConfig().githubConfig.commentLevel;
}

/**
 * Set a runtime GitHub comment level override.
 * Pass null to clear the override and use the fritz.yaml value.
 */
export function setCommentLevel(level: GitHubCommentLevel | null): void {
  runtimeCommentLevel = level;
}

/**
 * Check if a given string is a valid GitHub comment level.
 */
export function isValidCommentLevel(mode: string): mode is GitHubCommentLevel {
  return VALID_COMMENT_LEVELS.includes(mode as GitHubCommentLevel);
}

/**
 * Get GitHub configuration.
 * Configured in fritz.yaml under the github section.
 */
export function getGitHubConfig(): GitHubConfig {
  return loadFritzConfig().githubConfig;
}

/**
 * Reset cached config (useful for testing)
 */
export function resetConfigCache(): void {
  cachedConfig = null;
  runtimeNotificationMode = null;
  runtimeCommentLevel = null;
  runtimeMaxParallelAgents = null;
}

/**
 * Set a test override for the config path (for testing only).
 * Pass null to clear the override.
 */
export function setTestConfigPath(path: string | null): void {
  testConfigPath = path;
  cachedConfig = null; // Reset cache when path changes
}
