/**
 * Vitest unit tests for scheduler:
 * - calculateNextRun logic for hourly, daily, weekly
 * - Job state management (enable/disable, lastRun tracking)
 * - Integration with fritz-config parsing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

vi.mock('../config.js', () => ({
  config: {
    githubRepo: 'owner/repo',
    githubToken: 'gh-token',
    telegramBotToken: 'test-token',
    telegramChatId: '-123',
    workspacesDir: '/tmp/test-workspaces',
    fritzRoot: '/fritz-root',
  },
}));

import { calculateNextRun, getJobs, resetState, enableJob, disableJob } from './scheduler.js';
import type { ScheduledJobConfig } from '../agents/fritz-config.js';
import {
  getSchedulerConfig,
  resetConfigCache,
  setTestConfigPath,
} from '../agents/fritz-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Fixtures ────────────────────────────────────────────────────────────

const TEST_DIR = resolve(__dirname, '../../.test-fixtures');
const TEST_CONFIG_PATH = resolve(TEST_DIR, 'config/fritz.yaml');

function writeTestConfig(content: string): void {
  writeFileSync(TEST_CONFIG_PATH, content);
  setTestConfigPath(TEST_CONFIG_PATH);
}

function makeJob(overrides: Partial<ScheduledJobConfig> = {}): ScheduledJobConfig {
  return {
    id: 'test-job',
    role: 'retro',
    frequency: 'daily',
    hour: 9,
    minute: 0,
    enabled: true,
    issueTitle: 'Test Job',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('scheduler', () => {
  // ── calculateNextRun ─────────────────────────────────────────────────

  describe('calculateNextRun', () => {
    it('daily, before target time — same day', () => {
      const job = makeJob({ frequency: 'daily', hour: 14, minute: 30 });
      const after = new Date('2025-06-15T10:00:00Z');
      const next = calculateNextRun(job, after);

      expect(next.getUTCHours()).toBe(14);
      expect(next.getUTCMinutes()).toBe(30);
      expect(next.getUTCDate()).toBe(15);
    });

    it('daily, after target time — rolls to next day', () => {
      const job = makeJob({ frequency: 'daily', hour: 9, minute: 0 });
      const after = new Date('2025-06-15T15:00:00Z');
      const next = calculateNextRun(job, after);

      expect(next.getUTCHours()).toBe(9);
      expect(next.getUTCMinutes()).toBe(0);
      expect(next.getUTCDate()).toBe(16);
    });

    it('hourly, before target minute — same hour', () => {
      const job = makeJob({ frequency: 'hourly', minute: 30 });
      const after = new Date('2025-06-15T10:15:00Z');
      const next = calculateNextRun(job, after);

      expect(next.getUTCMinutes()).toBe(30);
      expect(next.getUTCHours()).toBe(10);
    });

    it('hourly, after target minute — rolls to next hour', () => {
      const job = makeJob({ frequency: 'hourly', minute: 15 });
      const after = new Date('2025-06-15T10:30:00Z');
      const next = calculateNextRun(job, after);

      expect(next.getUTCMinutes()).toBe(15);
      expect(next.getUTCHours()).toBe(11);
    });

    it('weekly, target day is ahead', () => {
      // 2025-06-15 is a Sunday (day 0), target is Friday (day 5)
      const job = makeJob({ frequency: 'weekly', dayOfWeek: 5, hour: 9, minute: 0 });
      const after = new Date('2025-06-15T10:00:00Z');
      const next = calculateNextRun(job, after);

      expect(next.getUTCDay()).toBe(5);
      expect(next.getUTCDate()).toBe(20);
      expect(next.getUTCHours()).toBe(9);
    });

    it('weekly, same day past time — rolls to next week', () => {
      // 2025-06-20 is a Friday (day 5), target is Friday at 09:00, but after 15:00
      const job = makeJob({ frequency: 'weekly', dayOfWeek: 5, hour: 9, minute: 0 });
      const after = new Date('2025-06-20T15:00:00Z');
      const next = calculateNextRun(job, after);

      expect(next.getUTCDay()).toBe(5);
      expect(next.getUTCDate()).toBe(27);
    });

    it('weekly, same day before time — same day', () => {
      // 2025-06-20 is a Friday (day 5), target is Friday at 14:00, currently 09:00
      const job = makeJob({ frequency: 'weekly', dayOfWeek: 5, hour: 14, minute: 0 });
      const after = new Date('2025-06-20T09:00:00Z');
      const next = calculateNextRun(job, after);

      expect(next.getUTCDay()).toBe(5);
      expect(next.getUTCDate()).toBe(20);
      expect(next.getUTCHours()).toBe(14);
    });

    it('default minute is 0', () => {
      const job = makeJob({ frequency: 'daily', hour: 12 });
      const after = new Date('2025-06-15T00:00:00Z');
      const next = calculateNextRun(job, after);

      expect(next.getUTCMinutes()).toBe(0);
      expect(next.getUTCHours()).toBe(12);
    });

    it('hourly job wraps at midnight', () => {
      const job = makeJob({ frequency: 'hourly', minute: 45 });
      const after = new Date('2025-06-15T23:50:00Z');
      const next = calculateNextRun(job, after);

      expect(next.getUTCMinutes()).toBe(45);
      expect(next.getUTCDate()).toBe(16);
      expect(next.getUTCHours()).toBe(0);
    });

    it('daily job wraps at month boundary', () => {
      const job = makeJob({ frequency: 'daily', hour: 8, minute: 0 });
      const after = new Date('2025-06-30T12:00:00Z');
      const next = calculateNextRun(job, after);

      expect(next.getUTCMonth()).toBe(6);
      expect(next.getUTCDate()).toBe(1);
      expect(next.getUTCHours()).toBe(8);
    });

    it('from epoch (first run ever)', () => {
      const job = makeJob({ frequency: 'daily', hour: 9, minute: 0 });
      const after = new Date(0);
      const next = calculateNextRun(job, after);

      expect(next.getUTCHours()).toBe(9);
      expect(next.getUTCMinutes()).toBe(0);
      expect(next > after).toBe(true);
    });
  });

  // ── Job state management ─────────────────────────────────────────────

  describe('job state management', () => {
    beforeEach(() => {
      resetConfigCache();
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true });
      }
      mkdirSync(resolve(TEST_DIR, 'config'), { recursive: true });
    });

    afterEach(() => {
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true });
      }
      setTestConfigPath(null);
      resetState();
    });

    it('enableJob returns false for unknown job ID', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: real-job
      role: retro
      frequency: daily
      hour: 9
      issueTitle: Real Job
`);

      resetConfigCache();
      const result = enableJob('nonexistent-job');
      expect(result).toBe(false);
    });

    it('disableJob returns false for unknown job ID', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: real-job
      role: retro
      frequency: daily
      hour: 9
      issueTitle: Real Job
`);

      resetConfigCache();
      const result = disableJob('nonexistent-job');
      expect(result).toBe(false);
    });

    it('enableJob returns true for valid job ID', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: real-job
      role: retro
      frequency: daily
      hour: 9
      issueTitle: Real Job
`);

      resetConfigCache();
      const result = enableJob('real-job');
      expect(result).toBe(true);
    });

    it('disableJob returns true and disables the job', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: real-job
      role: retro
      frequency: daily
      hour: 9
      issueTitle: Real Job
`);

      resetConfigCache();
      const result = disableJob('real-job');
      expect(result).toBe(true);

      // Verify the job is now disabled in getJobs()
      const jobs = getJobs();
      expect(jobs[0].enabled).toBe(false);
    });
  });

  // ── Config integration ───────────────────────────────────────────────

  describe('config integration', () => {
    beforeEach(() => {
      resetConfigCache();
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true });
      }
      mkdirSync(resolve(TEST_DIR, 'config'), { recursive: true });
    });

    afterEach(() => {
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true });
      }
      setTestConfigPath(null);
      resetState();
    });

    it('parses scheduler section correctly', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  checkIntervalSec: 120
  jobs:
    - id: weekly-retro
      role: retro
      frequency: weekly
      dayOfWeek: 5
      hour: 9
      minute: 0
      enabled: true
      issueTitle: Weekly Retrospective
      issueLabels:
        - fritz.auto-pipeline
      issueBody: Run the weekly retro.
    - id: nightly-security
      role: security-review
      frequency: daily
      hour: 2
      enabled: true
      issueTitle: Nightly Security Scan
`);

      const cfg = getSchedulerConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.checkIntervalSec).toBe(120);
      expect(cfg.jobs.length).toBe(2);

      const retro = cfg.jobs[0];
      expect(retro.id).toBe('weekly-retro');
      expect(retro.role).toBe('retro');
      expect(retro.frequency).toBe('weekly');
      expect(retro.dayOfWeek).toBe(5);
      expect(retro.hour).toBe(9);
      expect(retro.minute).toBe(0);
      expect(retro.issueTitle).toBe('Weekly Retrospective');
      expect(retro.issueLabels).toEqual(['fritz.auto-pipeline']);
      expect(retro.issueBody).toBe('Run the weekly retro.');

      const security = cfg.jobs[1];
      expect(security.id).toBe('nightly-security');
      expect(security.role).toBe('security-review');
      expect(security.frequency).toBe('daily');
      expect(security.hour).toBe(2);
    });

    it('defaults when scheduler section is missing', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6
`);

      const cfg = getSchedulerConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.checkIntervalSec).toBe(60);
      expect(cfg.jobs.length).toBe(0);
    });

    it('skips invalid jobs (bad id)', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: "INVALID ID!"
      role: retro
      frequency: daily
      hour: 9
      issueTitle: Bad Job
    - id: valid-job
      role: retro
      frequency: daily
      hour: 9
      issueTitle: Good Job
`);

      const cfg = getSchedulerConfig();
      expect(cfg.jobs.length).toBe(1);
      expect(cfg.jobs[0].id).toBe('valid-job');
    });

    it('skips jobs with invalid frequency', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: bad-freq
      role: retro
      frequency: monthly
      hour: 9
      issueTitle: Bad Freq
`);

      const cfg = getSchedulerConfig();
      expect(cfg.jobs.length).toBe(0);
    });

    it('skips weekly job without dayOfWeek', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: no-day
      role: retro
      frequency: weekly
      hour: 9
      issueTitle: Missing Day
`);

      const cfg = getSchedulerConfig();
      expect(cfg.jobs.length).toBe(0);
    });

    it('skips jobs with missing issueTitle', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: no-title
      role: retro
      frequency: daily
      hour: 9
`);

      const cfg = getSchedulerConfig();
      expect(cfg.jobs.length).toBe(0);
    });

    it('skips duplicate job ids', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: dupe
      role: retro
      frequency: daily
      hour: 9
      issueTitle: First
    - id: dupe
      role: retro
      frequency: daily
      hour: 10
      issueTitle: Second
`);

      const cfg = getSchedulerConfig();
      expect(cfg.jobs.length).toBe(1);
      expect(cfg.jobs[0].issueTitle).toBe('First');
    });

    it('validates invalid checkIntervalSec', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  checkIntervalSec: -1
`);

      const cfg = getSchedulerConfig();
      expect(cfg.checkIntervalSec).toBe(60);
    });

    it('job enabled defaults to true when not specified', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: no-enabled
      role: retro
      frequency: daily
      hour: 9
      issueTitle: Test
`);

      const cfg = getSchedulerConfig();
      expect(cfg.jobs[0].enabled).toBe(true);
    });

    it('rejects invalid role', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: bad-role
      role: nonexistent-role
      frequency: daily
      hour: 9
      issueTitle: Bad Role Job
`);

      const cfg = getSchedulerConfig();
      expect(cfg.jobs.length).toBe(0);
    });

    it('accepts valid roles', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: retro-job
      role: retro
      frequency: daily
      hour: 9
      issueTitle: Retro
    - id: security-job
      role: security-review
      frequency: daily
      hour: 2
      issueTitle: Security
    - id: implement-job
      role: implement
      frequency: weekly
      dayOfWeek: 1
      hour: 10
      issueTitle: Implement
`);

      const cfg = getSchedulerConfig();
      expect(cfg.jobs.length).toBe(3);
      expect(cfg.jobs[0].role).toBe('retro');
      expect(cfg.jobs[1].role).toBe('security-review');
      expect(cfg.jobs[2].role).toBe('implement');
    });

    it('enforces max 20 jobs limit', () => {
      // Generate 25 jobs
      const jobEntries = Array.from({ length: 25 }, (_, i) => `
    - id: job-${i}
      role: retro
      frequency: daily
      hour: ${i % 24}
      issueTitle: Job ${i}`).join('');

      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:${jobEntries}
`);

      const cfg = getSchedulerConfig();
      expect(cfg.jobs.length).toBe(20);
    });

    it('hourly job without hour field is accepted', () => {
      writeTestConfig(`
defaults:
  ttl: 3600
  model: claude-opus-4-6

scheduler:
  enabled: true
  jobs:
    - id: hourly-no-hour
      role: retro
      frequency: hourly
      minute: 30
      issueTitle: Hourly Check
`);

      const cfg = getSchedulerConfig();
      expect(cfg.jobs.length).toBe(1);
      expect(cfg.jobs[0].frequency).toBe('hourly');
    });
  });
});
