/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Vitest unit tests for the fritz-config module.
 *
 * Verifies configuration loading from fritz.yaml including validation,
 * error handling, defaults, role overrides, and resolution order.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  getAgentConfig,
  getRoleTtl,
  getRoleModel,
  getDefaultModel,
  getDefaultChatTtl,
  getOrchestratorModel,
  getMaxParallelAgents,
  setMaxParallelAgents,
  persistMaxParallelAgents,
  getDaemonConfig,
  getTelegramTopics,
  getTelegramConfig,
  getClaudeConfig,
  getTeamsConfig,
  getDashboardConfig,
  getUsageConfig,
  getNotificationMode,
  setNotificationMode,
  isValidNotificationMode,
  getCommentLevel,
  setCommentLevel,
  isValidCommentLevel,
  getGitHubConfig,
  resetConfigCache,
  setTestConfigPath,
  getRepoConfig,
  getAllRepoConfigs,
} from './fritz-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Test fixtures directory
const TEST_DIR = resolve(__dirname, '../../.test-fixtures-vitest');
const TEST_CONFIG_PATH = resolve(TEST_DIR, 'config/fritz.yaml');

function writeTestConfig(content: string): void {
  writeFileSync(TEST_CONFIG_PATH, content);
  setTestConfigPath(TEST_CONFIG_PATH);
}

beforeEach(() => {
  resetConfigCache();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(resolve(TEST_DIR, 'config'), { recursive: true });
});

afterEach(() => {
  setTestConfigPath(null);
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

// ============================================================================
// Valid minimal config (defaults only)
// ============================================================================

describe('fritz-config', () => {
  describe('valid minimal config (defaults only)', () => {
    it('loads defaults correctly', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-5
`);
      const config = getAgentConfig('implement');
      expect(config.ttl).toBe(3600);
      expect(config.model).toBe('claude-opus-4-5');
    });
  });

  // ==========================================================================
  // Config with role overrides
  // ==========================================================================

  describe('config with role overrides', () => {
    it('applies role-specific TTL override', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-5

roles:
  implement:
    ttl: 14400
  review:
    ttl: 7200
`);
      const implConfig = getAgentConfig('implement');
      expect(implConfig.ttl).toBe(14400);

      resetConfigCache();
      const reviewConfig = getAgentConfig('review');
      expect(reviewConfig.ttl).toBe(7200);
    });

    it('applies role-specific model override', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-5

roles:
  implement:
    ttl: 14400
    model: claude-sonnet-4
`);
      const implConfig = getAgentConfig('implement');
      expect(implConfig.ttl).toBe(14400);
      expect(implConfig.model).toBe('claude-sonnet-4');
    });

    it('falls back to defaults for unspecified role fields', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-5

roles:
  implement:
    ttl: 14400
`);
      const implConfig = getAgentConfig('implement');
      expect(implConfig.ttl).toBe(14400);
      expect(implConfig.model).toBe('claude-opus-4-5');
    });

    it('falls back to defaults for unknown roles', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-5

roles:
  implement:
    ttl: 14400
`);
      const reviewConfig = getAgentConfig('review');
      expect(reviewConfig.ttl).toBe(3600);
      expect(reviewConfig.model).toBe('claude-opus-4-5');
    });

    it('all agent roles get correct config', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-5

roles:
  implement:
    ttl: 14400
  review:
    ttl: 7200
  validate:
    ttl: 7200
  architect:
    ttl: 10800
  define:
    ttl: 3600
  ux:
    ttl: 7200
  budget:
    ttl: 3600
  retro:
    ttl: 3600
  security-review:
    ttl: 7200
`);
      type AgentRole = 'implement' | 'review' | 'validate' | 'define' | 'architect' | 'ux' | 'budget' | 'retro' | 'security-review';
      const roles: AgentRole[] = ['implement', 'review', 'validate', 'architect', 'define', 'ux', 'budget', 'retro', 'security-review'];
      for (const role of roles) {
        resetConfigCache();
        const roleConfig = getAgentConfig(role);
        expect(typeof roleConfig.ttl).toBe('number');
        expect(typeof roleConfig.model).toBe('string');
      }
    });
  });

  // ==========================================================================
  // Config with orchestrator model
  // ==========================================================================

  describe('config with orchestrator model', () => {
    it('reads orchestrator model from dedicated section', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

orchestrator:
  model: claude-opus-4-5-20250514
`);
      expect(getOrchestratorModel()).toBe('claude-opus-4-5-20250514');
      resetConfigCache();
      expect(getDefaultModel()).toBe('claude-opus-4-6');
    });

    it('falls back to default when orchestrator section is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      expect(getOrchestratorModel()).toBe('claude-opus-4-6');
    });

    it('falls back when orchestrator section has no model field', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

orchestrator:
  foo: bar
`);
      expect(getOrchestratorModel()).toBe('claude-opus-4-6');
    });
  });

  // ==========================================================================
  // Config with daemon limits
  // ==========================================================================

  describe('config with daemon settings', () => {
    it('reads daemon config from dedicated section', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  maxParallelAgents: 8
  maxQueueSize: 20
  persistDebounceMs: 2000
  agentMessageTimeoutMs: 300000
  startupReadinessTimeoutMs: 15000
`);
      const daemon = getDaemonConfig();
      expect(daemon.maxParallelAgents).toBe(8);
      expect(daemon.maxQueueSize).toBe(20);
      expect(daemon.persistDebounceMs).toBe(2000);
      expect(daemon.agentMessageTimeoutMs).toBe(300000);
      expect(daemon.startupReadinessTimeoutMs).toBe(15000);

      resetConfigCache();
      expect(getMaxParallelAgents()).toBe(8);
    });

    it('uses defaults when daemon section is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      const daemon = getDaemonConfig();
      expect(daemon.maxParallelAgents).toBe(4);
      expect(daemon.maxQueueSize).toBe(10);
      expect(daemon.persistDebounceMs).toBe(1000);
      expect(daemon.agentMessageTimeoutMs).toBe(180000);
      expect(daemon.startupReadinessTimeoutMs).toBe(30000);
    });

    it('supports partial override (missing fields use defaults)', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  maxParallelAgents: 6
`);
      const daemon = getDaemonConfig();
      expect(daemon.maxParallelAgents).toBe(6);
      expect(daemon.maxQueueSize).toBe(10);
      expect(daemon.persistDebounceMs).toBe(1000);
      expect(daemon.agentMessageTimeoutMs).toBe(180000);
      expect(daemon.startupReadinessTimeoutMs).toBe(30000);
    });

    it('rejects zero or negative startupReadinessTimeoutMs (falls back to default)', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  startupReadinessTimeoutMs: 0
`);
      expect(getDaemonConfig().startupReadinessTimeoutMs).toBe(30000);

      resetConfigCache();
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  startupReadinessTimeoutMs: -5000
`);
      expect(getDaemonConfig().startupReadinessTimeoutMs).toBe(30000);
    });

    it('reads watchdog and workspace age fields', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  maxParallelAgents: 4
  watchdogIntervalSec: 120
  workspaceMaxAgeHours: 48
`);
      const daemon = getDaemonConfig();
      expect(daemon.watchdogIntervalSec).toBe(120);
      expect(daemon.workspaceMaxAgeHours).toBe(48);
    });

    it('uses defaults for new daemon fields when missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  maxParallelAgents: 6
`);
      const daemon = getDaemonConfig();
      expect(daemon.watchdogIntervalSec).toBe(60);
      expect(daemon.workspaceMaxAgeHours).toBe(24);
    });
  });

  // ==========================================================================
  // Config with telegram settings
  // ==========================================================================

  describe('config with telegram settings', () => {
    it('reads telegram config from YAML', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

telegram:
  chatFeedbackEnabled: false
  typingIndicatorIntervalMs: 3000
  progressUpdateIntervalMs: 60000
  timeoutWarningThreshold: 0.9
  editInPlaceEnabled: false
  editMinIntervalMs: 10000
`);
      const tg = getTelegramConfig();
      expect(tg.chatFeedbackEnabled).toBe(false);
      expect(tg.typingIndicatorIntervalMs).toBe(3000);
      expect(tg.progressUpdateIntervalMs).toBe(60000);
      expect(tg.timeoutWarningThreshold).toBe(0.9);
      expect(tg.editInPlaceEnabled).toBe(false);
      expect(tg.editMinIntervalMs).toBe(10000);
    });

    it('uses defaults when telegram section is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      const tg = getTelegramConfig();
      expect(tg.chatFeedbackEnabled).toBe(true);
      expect(tg.typingIndicatorIntervalMs).toBe(4000);
      expect(tg.progressUpdateIntervalMs).toBe(30000);
      expect(tg.timeoutWarningThreshold).toBe(0.8);
      expect(tg.editInPlaceEnabled).toBe(true);
      expect(tg.editMinIntervalMs).toBe(5000);
    });

    it('supports partial override', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

telegram:
  chatFeedbackEnabled: false
  editMinIntervalMs: 8000
`);
      const tg = getTelegramConfig();
      expect(tg.chatFeedbackEnabled).toBe(false);
      expect(tg.typingIndicatorIntervalMs).toBe(4000);
      expect(tg.progressUpdateIntervalMs).toBe(30000);
      expect(tg.timeoutWarningThreshold).toBe(0.8);
      expect(tg.editInPlaceEnabled).toBe(true);
      expect(tg.editMinIntervalMs).toBe(8000);
    });
  });

  // ==========================================================================
  // Telegram topics
  // ==========================================================================

  describe('telegram topics', () => {
    it('returns topics from telegram section', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

telegram:
  topics:
    define: 100
    implement: 200
    review: 300
    validate: 400
    questions: 500
    retro: 600
`);
      const topics = getTelegramTopics();
      expect(topics).toBeDefined();
      expect(topics?.define).toBe(100);
      expect(topics?.implement).toBe(200);
      expect(topics?.review).toBe(300);
      expect(topics?.validate).toBe(400);
      expect(topics?.questions).toBe(500);
      expect(topics?.retro).toBe(600);
    });

    it('returns undefined when telegram section is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      const topics = getTelegramTopics();
      expect(topics).toBeUndefined();
    });

    it('handles partial topics (some fields missing)', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

telegram:
  topics:
    implement: 200
    questions: 500
`);
      const topics = getTelegramTopics();
      expect(topics).toBeDefined();
      expect(topics?.define).toBeUndefined();
      expect(topics?.implement).toBe(200);
      expect(topics?.review).toBeUndefined();
      expect(topics?.questions).toBe(500);
    });

    it('treats non-numeric values as undefined', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

telegram:
  topics:
    define: "not-a-number"
    implement: 200
    review: true
`);
      const topics = getTelegramTopics();
      expect(topics).toBeDefined();
      expect(topics?.define).toBeUndefined();
      expect(topics?.implement).toBe(200);
      expect(topics?.review).toBeUndefined();
    });

    it('returns undefined when telegram section exists but no topics key', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

telegram:
  other: value
`);
      const topics = getTelegramTopics();
      expect(topics).toBeUndefined();
    });
  });

  // ==========================================================================
  // Config with all sections
  // ==========================================================================

  describe('config with all sections', () => {
    it('loads claude config from YAML', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

claude:
  claudeSkipPermissions: false
  claudePrintMode: false
`);
      const claude = getClaudeConfig();
      expect(claude.claudeSkipPermissions).toBe(false);
      expect(claude.claudePrintMode).toBe(false);
    });

    it('uses claude config defaults when section is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      const claude = getClaudeConfig();
      expect(claude.claudeSkipPermissions).toBe(true);
      expect(claude.claudePrintMode).toBe(true);
    });

    it('loads teams config from YAML', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

teams:
  ttlMultiplier: 2.5
`);
      const teams = getTeamsConfig();
      expect(teams.ttlMultiplier).toBe(2.5);
    });

    it('uses teams config defaults when section is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      const teams = getTeamsConfig();
      expect(teams.ttlMultiplier).toBe(1.0);
    });

    it('supports teams config partial override', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

teams:
  ttlMultiplier: 3.0
`);
      const teams = getTeamsConfig();
      expect(teams.ttlMultiplier).toBe(3.0);
    });

    it('silently ignores legacy teams fields (enabled, roles, teammateModel)', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

teams:
  enabled: true
  roles:
    - implement
    - review
  ttlMultiplier: 1.5
  teammateModel: claude-sonnet-4-6
`);
      const teams = getTeamsConfig();
      expect((teams as unknown as Record<string, unknown>).enabled).toBeUndefined();
      expect((teams as unknown as Record<string, unknown>).roles).toBeUndefined();
      expect((teams as unknown as Record<string, unknown>).teammateModel).toBeUndefined();
      expect(teams.ttlMultiplier).toBe(1.5);
    });

    it('loads dashboard config', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

dashboard:
  enabled: false
`);
      const dashboard = getDashboardConfig();
      expect(dashboard.enabled).toBe(false);
    });

    it('uses dashboard defaults when section is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      const dashboard = getDashboardConfig();
      expect(dashboard.enabled).toBe(true);
    });

    it('loads usage config', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

usage:
  enabled: true
  pauseThreshold: 90
  resumeThreshold: 60
  checkIntervalMinutes: 10
  allowP0: false
`);
      const usage = getUsageConfig();
      expect(usage.enabled).toBe(true);
      expect(usage.pauseThreshold).toBe(90);
      expect(usage.resumeThreshold).toBe(60);
      expect(usage.checkIntervalMinutes).toBe(10);
      expect(usage.allowP0).toBe(false);
    });

    it('uses usage defaults when section is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      const usage = getUsageConfig();
      expect(usage.enabled).toBe(true);
      expect(usage.pauseThreshold).toBe(80);
      expect(usage.resumeThreshold).toBe(50);
      expect(usage.checkIntervalMinutes).toBe(5);
      expect(usage.allowP0).toBe(true);
    });
  });

  // ==========================================================================
  // Missing file throws
  // ==========================================================================

  describe('missing file throws', () => {
    it('throws error on missing config file', () => {
      // Point to non-existent file (don't write config)
      setTestConfigPath(TEST_CONFIG_PATH + '-nonexistent');
      expect(() => getAgentConfig('implement')).toThrow('not found');
    });
  });

  // ==========================================================================
  // Invalid YAML throws
  // ==========================================================================

  describe('invalid YAML throws', () => {
    it('throws error on invalid YAML', () => {
      writeTestConfig('{ invalid yaml {{{}');
      expect(() => getAgentConfig('implement')).toThrow();
    });
  });

  // ==========================================================================
  // Missing defaults section throws
  // ==========================================================================

  describe('missing defaults section throws', () => {
    it('throws when defaults section is missing', () => {
      writeTestConfig(`
roles:
  implement:
    ttl: 14400
`);
      expect(() => getAgentConfig('implement')).toThrow('defaults');
    });
  });

  // ==========================================================================
  // Missing required fields throw
  // ==========================================================================

  describe('missing required fields throw', () => {
    it('throws when defaults.ttl is missing', () => {
      writeTestConfig(`
defaults:
  model: claude-opus-4-5
`);
      expect(() => getAgentConfig('implement')).toThrow('ttl');
    });

    it('throws when defaults.model is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
`);
      expect(() => getAgentConfig('implement')).toThrow('model');
    });

    it('throws when ttl is a string instead of number', () => {
      writeTestConfig(`
defaults:
  ttl: "3600"
  model: claude-opus-4-5
`);
      expect(() => getAgentConfig('implement')).toThrow('number');
    });
  });

  // ==========================================================================
  // Notification mode validation
  // ==========================================================================

  describe('notification mode validation', () => {
    it('reads notification mode from YAML', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

telegram:
  notificationMode: compact
`);
      const tg = getTelegramConfig();
      expect(tg.notificationMode).toBe('compact');
      expect(getNotificationMode()).toBe('compact');
    });

    it('defaults to essential when not specified', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      const tg = getTelegramConfig();
      expect(tg.notificationMode).toBe('essential');
    });

    it('falls back to essential for invalid mode', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

telegram:
  notificationMode: invalid_mode
`);
      const tg = getTelegramConfig();
      expect(tg.notificationMode).toBe('essential');
    });

    it('reads quiet mode from YAML', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

telegram:
  notificationMode: quiet
`);
      const tg = getTelegramConfig();
      expect(tg.notificationMode).toBe('quiet');
    });

    it('reads essential mode from YAML', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

telegram:
  notificationMode: essential
`);
      const tg = getTelegramConfig();
      expect(tg.notificationMode).toBe('essential');
      expect(getNotificationMode()).toBe('essential');
    });

    it('supports runtime notification mode override', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

telegram:
  notificationMode: verbose
`);
      // Initial value from config
      expect(getNotificationMode()).toBe('verbose');

      // Runtime override
      setNotificationMode('quiet');
      expect(getNotificationMode()).toBe('quiet');

      // Another override
      setNotificationMode('compact');
      expect(getNotificationMode()).toBe('compact');

      // Essential override
      setNotificationMode('essential');
      expect(getNotificationMode()).toBe('essential');

      // Clear override
      setNotificationMode(null);
      expect(getNotificationMode()).toBe('verbose');
    });

    it('isValidNotificationMode validates correctly', () => {
      expect(isValidNotificationMode('essential')).toBe(true);
      expect(isValidNotificationMode('quiet')).toBe(true);
      expect(isValidNotificationMode('compact')).toBe(true);
      expect(isValidNotificationMode('verbose')).toBe(true);
      expect(isValidNotificationMode('invalid')).toBe(false);
      expect(isValidNotificationMode('')).toBe(false);
      expect(isValidNotificationMode('QUIET')).toBe(false);
    });
  });

  // ==========================================================================
  // Usage threshold validation
  // ==========================================================================

  describe('usage threshold validation', () => {
    it('resets to defaults when pauseThreshold <= resumeThreshold', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

usage:
  enabled: true
  pauseThreshold: 50
  resumeThreshold: 50
  checkIntervalMinutes: 5
`);
      const usage = getUsageConfig();
      // Should be reset to defaults because pauseThreshold <= resumeThreshold
      expect(usage.pauseThreshold).toBe(80);
      expect(usage.resumeThreshold).toBe(50);
    });

    it('resets to defaults when pauseThreshold < resumeThreshold', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

usage:
  enabled: true
  pauseThreshold: 30
  resumeThreshold: 60
  checkIntervalMinutes: 5
`);
      const usage = getUsageConfig();
      expect(usage.pauseThreshold).toBe(80);
      expect(usage.resumeThreshold).toBe(50);
    });
  });

  // ==========================================================================
  // setTestConfigPath changes config path
  // ==========================================================================

  describe('setTestConfigPath changes config path', () => {
    it('allows switching config path', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-5
`);
      const config1 = getAgentConfig('implement');
      expect(config1.ttl).toBe(3600);

      // Write a different config to a second path
      const secondPath = resolve(TEST_DIR, 'config/fritz2.yaml');
      writeFileSync(secondPath, `
defaults:
  ttl: 9999
  model: claude-sonnet-4
`);
      setTestConfigPath(secondPath);
      const config2 = getAgentConfig('implement');
      expect(config2.ttl).toBe(9999);
      expect(config2.model).toBe('claude-sonnet-4');
    });
  });

  // ==========================================================================
  // resetConfigCache clears cache
  // ==========================================================================

  describe('resetConfigCache clears cache', () => {
    it('re-reads config after cache reset', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-5
`);
      const config1 = getAgentConfig('implement');
      expect(config1.ttl).toBe(3600);

      // Modify the file (without resetting cache)
      writeFileSync(TEST_CONFIG_PATH, `
defaults:
  ttl: 9999
  model: claude-opus-4-5
`);

      // Should return cached value
      const config2 = getAgentConfig('implement');
      expect(config2.ttl).toBe(3600);

      // Reset cache and call again
      resetConfigCache();
      const config3 = getAgentConfig('implement');
      expect(config3.ttl).toBe(9999);
    });

    it('also clears runtime notification mode override', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

telegram:
  notificationMode: verbose
`);
      setNotificationMode('quiet');
      expect(getNotificationMode()).toBe('quiet');

      resetConfigCache();
      expect(getNotificationMode()).toBe('verbose');
    });
  });

  // ==========================================================================
  // GitHub comment level validation
  // ==========================================================================

  describe('github comment level', () => {
    it('reads comment level from YAML', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

github:
  commentLevel: verbose
`);
      const gh = getGitHubConfig();
      expect(gh.commentLevel).toBe('verbose');
      expect(getCommentLevel()).toBe('verbose');
    });

    it('defaults to essential when github section is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      expect(getCommentLevel()).toBe('essential');
    });

    it('defaults to essential when commentLevel is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

github:
  other: value
`);
      expect(getCommentLevel()).toBe('essential');
    });

    it('falls back to essential for invalid comment level', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

github:
  commentLevel: invalid_mode
`);
      expect(getCommentLevel()).toBe('essential');
    });

    it('reads quiet mode from YAML', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

github:
  commentLevel: quiet
`);
      expect(getCommentLevel()).toBe('quiet');
    });

    it('supports runtime comment level override', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

github:
  commentLevel: verbose
`);
      expect(getCommentLevel()).toBe('verbose');

      setCommentLevel('quiet');
      expect(getCommentLevel()).toBe('quiet');

      setCommentLevel('essential');
      expect(getCommentLevel()).toBe('essential');

      setCommentLevel(null);
      expect(getCommentLevel()).toBe('verbose');
    });

    it('isValidCommentLevel validates correctly', () => {
      expect(isValidCommentLevel('essential')).toBe(true);
      expect(isValidCommentLevel('quiet')).toBe(true);
      expect(isValidCommentLevel('verbose')).toBe(true);
      expect(isValidCommentLevel('compact')).toBe(false);
      expect(isValidCommentLevel('invalid')).toBe(false);
      expect(isValidCommentLevel('')).toBe(false);
      expect(isValidCommentLevel('QUIET')).toBe(false);
    });

    it('resetConfigCache clears runtime comment level override', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

github:
  commentLevel: verbose
`);
      setCommentLevel('quiet');
      expect(getCommentLevel()).toBe('quiet');

      resetConfigCache();
      expect(getCommentLevel()).toBe('verbose');
    });
  });

  // ==========================================================================
  // Helper functions
  // ==========================================================================

  describe('helper functions', () => {
    it('getRoleTtl returns correct value', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-5

roles:
  implement:
    ttl: 14400
    model: claude-sonnet-4
`);
      expect(getRoleTtl('implement')).toBe(14400);
    });

    it('getRoleModel returns correct value', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-5

roles:
  implement:
    ttl: 14400
    model: claude-sonnet-4
`);
      expect(getRoleModel('implement')).toBe('claude-sonnet-4');
    });

    it('getDefaultModel returns defaults.model', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-5

roles:
  implement:
    model: claude-sonnet-4
`);
      expect(getDefaultModel()).toBe('claude-opus-4-5');
    });

    it('getDefaultChatTtl reads defaults.chatTtl when set', () => {
      writeTestConfig(`
defaults:
  ttl: 1800
  chatTtl: 21600
  model: claude-opus-4-6
`);
      expect(getDefaultChatTtl()).toBe(21600);
    });

    it('getDefaultChatTtl falls back to 14400 when defaults.chatTtl is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 1800
  model: claude-opus-4-6
`);
      expect(getDefaultChatTtl()).toBe(14400);
    });
  });

  // ==========================================================================
  // Per-repo config and deployment tracker settings (W5)
  // ==========================================================================

  describe('per-repo config (getRepoConfig, getAllRepoConfigs)', () => {
    it('returns empty object for unknown repos', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      const config = getRepoConfig('your-org/unknown');
      expect(config).toEqual({});
    });

    it('returns correct per-repo config', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

repos:
  your-org/fritZ:
    deployment-tracker: true
  your-org/other:
    deployment-tracker: false
`);
      const fritzConfig = getRepoConfig('your-org/fritZ');
      expect(fritzConfig.deploymentTracker).toBe(true);

      resetConfigCache();
      const otherConfig = getRepoConfig('your-org/other');
      expect(otherConfig.deploymentTracker).toBe(false);
    });

    it('maps YAML kebab-case deployment-tracker to camelCase deploymentTracker', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

repos:
  your-org/fritZ:
    deployment-tracker: false
`);
      const config = getRepoConfig('your-org/fritZ');
      // Key should be camelCase in TypeScript
      expect(config.deploymentTracker).toBe(false);
      // Kebab-case key should NOT exist on the object
      expect((config as any)['deployment-tracker']).toBeUndefined();
    });

    it('getAllRepoConfigs returns the full repos map', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

repos:
  your-org/fritZ:
    deployment-tracker: true
  your-org/monitor:
    deployment-tracker: false
`);
      const allRepos = getAllRepoConfigs();
      expect(Object.keys(allRepos)).toEqual(['your-org/fritZ', 'your-org/monitor']);
      expect(allRepos['your-org/fritZ'].deploymentTracker).toBe(true);
      expect(allRepos['your-org/monitor'].deploymentTracker).toBe(false);
    });

    it('getAllRepoConfigs returns empty object when repos section is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      const allRepos = getAllRepoConfigs();
      expect(allRepos).toEqual({});
    });
  });

  describe('staleDeploymentReminderDays config', () => {
    it('reads staleDeploymentReminderDays from daemon section', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  staleDeploymentReminderDays: 7
`);
      expect(getDaemonConfig().staleDeploymentReminderDays).toBe(7);
    });

    it('defaults staleDeploymentReminderDays to 3 when not specified', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      expect(getDaemonConfig().staleDeploymentReminderDays).toBe(3);
    });

    it('defaults staleDeploymentReminderDays to 3 when daemon section exists but field is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  maxParallelAgents: 4
`);
      expect(getDaemonConfig().staleDeploymentReminderDays).toBe(3);
    });
  });

  // ==========================================================================
  // Runtime max parallel agents override
  // ==========================================================================

  describe('runtime max parallel agents override', () => {
    it('returns config value when no runtime override set', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  maxParallelAgents: 8
`);
      expect(getMaxParallelAgents()).toBe(8);
    });

    it('runtime override takes precedence over config', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  maxParallelAgents: 8
`);
      expect(getMaxParallelAgents()).toBe(8);

      setMaxParallelAgents(12);
      expect(getMaxParallelAgents()).toBe(12);

      setMaxParallelAgents(3);
      expect(getMaxParallelAgents()).toBe(3);
    });

    it('clearing override reverts to config value', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  maxParallelAgents: 6
`);
      setMaxParallelAgents(10);
      expect(getMaxParallelAgents()).toBe(10);

      setMaxParallelAgents(null);
      expect(getMaxParallelAgents()).toBe(6);
    });

    it('clamps value to 1–20 range', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      setMaxParallelAgents(0);
      expect(getMaxParallelAgents()).toBe(1);

      setMaxParallelAgents(-5);
      expect(getMaxParallelAgents()).toBe(1);

      setMaxParallelAgents(25);
      expect(getMaxParallelAgents()).toBe(20);

      setMaxParallelAgents(100);
      expect(getMaxParallelAgents()).toBe(20);
    });

    it('rounds non-integer values', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      setMaxParallelAgents(5.7);
      expect(getMaxParallelAgents()).toBe(6);

      setMaxParallelAgents(3.2);
      expect(getMaxParallelAgents()).toBe(3);
    });

    it('resetConfigCache clears runtime override', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  maxParallelAgents: 4
`);
      setMaxParallelAgents(15);
      expect(getMaxParallelAgents()).toBe(15);

      resetConfigCache();
      // After reset, need to re-set config path since resetConfigCache clears it
      setTestConfigPath(TEST_CONFIG_PATH);
      expect(getMaxParallelAgents()).toBe(4);
    });
  });

  // ==========================================================================
  // Persist max parallel agents to fritz.yaml
  // ==========================================================================

  describe('persistMaxParallelAgents', () => {
    it('writes new value to fritz.yaml preserving comments', () => {
      const yaml = `# Config
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  maxParallelAgents: 6               # Max concurrent agent containers
  maxQueueSize: 10
`;
      writeTestConfig(yaml);

      const result = persistMaxParallelAgents(10);
      expect(result).toBe(true);

      const updated = readFileSync(TEST_CONFIG_PATH, 'utf-8');
      expect(updated).toContain('maxParallelAgents: 10');
      expect(updated).toContain('# Max concurrent agent containers');
      expect(updated).toContain('maxQueueSize: 10');
    });

    it('returns false when key not found in yaml', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);
      const result = persistMaxParallelAgents(10);
      expect(result).toBe(false);
    });

    it('returns false when config file does not exist', () => {
      // Point to a path that doesn't exist
      const badPath = resolve(TEST_DIR, 'config/nonexistent.yaml');
      setTestConfigPath(badPath);
      const result = persistMaxParallelAgents(5);
      expect(result).toBe(false);
    });

    it('creates a .bak backup before writing', () => {
      const yaml = `daemon:
  maxParallelAgents: 4
`;
      writeTestConfig(yaml);

      persistMaxParallelAgents(8);
      expect(existsSync(TEST_CONFIG_PATH + '.bak')).toBe(true);
      const backup = readFileSync(TEST_CONFIG_PATH + '.bak', 'utf-8');
      expect(backup).toContain('maxParallelAgents: 4');
    });

    it('handles yaml with tabs and extra whitespace around key', () => {
      const yaml = `daemon:
    maxParallelAgents:   7
`;
      writeTestConfig(yaml);

      const result = persistMaxParallelAgents(12);
      expect(result).toBe(true);

      const updated = readFileSync(TEST_CONFIG_PATH, 'utf-8');
      expect(updated).toContain('maxParallelAgents:   12');
    });
  });
});
