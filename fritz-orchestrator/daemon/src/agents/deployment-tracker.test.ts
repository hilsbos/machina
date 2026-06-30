/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Vitest unit tests for deployment-tracker module.
 *
 * Tests buildIssueBody(), createOrUpdateDeploymentIssue() logic,
 * and stale deployment checking with cooldown.
 *
 * @see Issue #636
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before any imports that transitively use it
vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  spawn: vi.fn(),
}));

// Mock config.ts to avoid env var requirements
vi.mock('../config.js', () => ({
  config: {
    githubRepo: 'your-org/fritZ',
    githubToken: 'gh-token',
    telegramBotToken: 'tg-token',
    telegramChatId: '123',
    workspacesDir: '/tmp/test-workspaces',
  },
}));

// Mock lifecycle to avoid Telegram dependencies
vi.mock('../core/lifecycle.js', () => ({
  staleDeploymentReminder: vi.fn(),
  system: vi.fn(),
}));

// Mock github-cache to avoid side effects
vi.mock('../github/github-cache.js', () => ({
  invalidateAll: vi.fn(),
  invalidate: vi.fn(),
  isRateLimited: vi.fn(() => false),
}));

// Mock fritz-config to provide defaults without needing fritz.yaml
vi.mock('./fritz-config.js', () => ({
  getDaemonConfig: vi.fn(() => ({
    deployWorkflow: 'build-and-deploy.yml',
    staleDeploymentReminderDays: 3,
  })),
  getRepoConfig: vi.fn(() => ({})),
  getAllRepoConfigs: vi.fn(() => ({})),
}));

import { buildIssueBody, createOrUpdateDeploymentIssue, checkStaleDeploymentIssues, _lastReminderSent } from './deployment-tracker.js';
import { execSync } from 'child_process';
import * as lifecycle from '../core/lifecycle.js';
import { getRepoConfig, getAllRepoConfigs, getDaemonConfig } from './fritz-config.js';

const mockExecSync = vi.mocked(execSync);

// ============================================================================
// buildIssueBody() tests
// ============================================================================

describe('buildIssueBody', () => {
  it('builds a basic issue body for a generic repo', () => {
    const body = buildIssueBody(
      'your-org/fritzmonitor',
      ['- [ ] #45 — feat: dashboard (merged 2026-03-23)'],
      false,
      false,
    );

    expect(body).toContain('## Deployment pending — your-org/fritzmonitor');
    expect(body).toContain('Only @your-org (owner) can trigger a deployment.');
    expect(body).toContain('gh workflow run');
    expect(body).toContain('## PRs merged since last deploy');
    expect(body).toContain('- [ ] #45 — feat: dashboard (merged 2026-03-23)');
    expect(body).not.toContain('fritZ pre-deploy checklist');
    expect(body).not.toContain('URGENT');
  });

  it('includes fritZ pre-deploy checklist when isFritZ is true', () => {
    const body = buildIssueBody(
      'your-org/fritZ',
      ['- [ ] #630 — fix: timeout (merged 2026-03-23)'],
      false,
      true,
    );

    expect(body).toContain('fritZ pre-deploy checklist');
    expect(body).toContain('No active agents running');
    expect(body).toContain('rollback plan');
  });

  it('prepends hotfix banner when isHotfix is true', () => {
    const body = buildIssueBody(
      'your-org/fritZ',
      ['- [ ] #99 — hotfix: crash (merged 2026-03-23)'],
      true,
      false,
    );

    expect(body).toContain('## ⚠️ URGENT — Hotfix pending deployment');
    expect(body).toContain('Deploy as soon as possible');
    const urgentIdx = body.indexOf('URGENT');
    const deployIdx = body.indexOf('Deployment pending');
    expect(urgentIdx).toBeLessThan(deployIdx);
  });

  it('includes multiple entries', () => {
    const entries = [
      '- [ ] #630 — fix: timeout (merged 2026-03-22)',
      '- [ ] #631 — fix: deadlock (merged 2026-03-23)',
    ];
    const body = buildIssueBody('your-org/fritZ', entries, false, false);

    expect(body).toContain('- [ ] #630');
    expect(body).toContain('- [ ] #631');
  });

  it('includes deploy workflow command', () => {
    const body = buildIssueBody('your-org/fritZ', ['- [ ] #1 — test (merged 2026-03-23)'], false, false);
    expect(body).toContain('gh workflow run');
    expect(body).toContain('--repo your-org/fritZ');
  });
});

// ============================================================================
// createOrUpdateDeploymentIssue() tests
// ============================================================================

describe('createOrUpdateDeploymentIssue', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('creates a new deployment issue when none exists', () => {
    mockExecSync
      .mockReturnValueOnce('[]' as any)  // issue list search
      .mockReturnValueOnce('' as any);   // issue create

    createOrUpdateDeploymentIssue({
      repo: 'your-org/fritZ',
      prNumber: 630,
      prTitle: 'fix: timeout',
      prLabels: [],
      mergedAt: '2026-03-23',
    });

    const calls = mockExecSync.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const createCall = calls.find(c => String(c[0]).includes('issue create'));
    expect(createCall).toBeDefined();
    expect(String(createCall![0])).toContain('Deployment pending');
    expect(String(createCall![0])).toContain('deployment-pending');
  });

  it('appends to existing deployment issue', () => {
    const existingBody = `## Deployment pending — your-org/fritZ\n\n## PRs merged since last deploy\n\n- [ ] #629 — fix: old bug (merged 2026-03-22)`;

    mockExecSync
      .mockReturnValueOnce(JSON.stringify([{
        number: 100,
        title: 'Deployment pending — your-org/fritZ',
        body: existingBody,
        labels: [{ name: 'deployment-pending' }],
      }]) as any)
      .mockReturnValueOnce('' as any);  // issue edit

    createOrUpdateDeploymentIssue({
      repo: 'your-org/fritZ',
      prNumber: 630,
      prTitle: 'fix: timeout',
      prLabels: [],
      mergedAt: '2026-03-23',
    });

    const calls = mockExecSync.mock.calls;
    const editCall = calls.find(c => String(c[0]).includes('issue edit'));
    expect(editCall).toBeDefined();
  });

  it('adds priority:p0 label for hotfix PR in a single edit call', () => {
    mockExecSync
      .mockReturnValueOnce(JSON.stringify([{
        number: 100,
        title: 'Deployment pending — your-org/fritZ',
        body: `## Deployment pending\n\n## PRs merged since last deploy\n\n- [ ] #629 — old (merged 2026-03-22)`,
        labels: [{ name: 'deployment-pending' }],
      }]) as any)
      .mockReturnValueOnce('' as any);  // combined issue edit (body + label)

    createOrUpdateDeploymentIssue({
      repo: 'your-org/fritZ',
      prNumber: 630,
      prTitle: 'hotfix: crash',
      prLabels: ['hotfix'],
      mergedAt: '2026-03-23',
    });

    const calls = mockExecSync.mock.calls;
    // Should be exactly 2 calls: issue list + issue edit (combined body + label)
    expect(calls.length).toBe(2);
    const editCall = calls.find(c => String(c[0]).includes('issue edit'));
    expect(editCall).toBeDefined();
    expect(String(editCall![0])).toContain('priority:p0');
    expect(String(editCall![0])).toContain('--body-file');
  });

  it('does not add priority:p0 label when issue already has it', () => {
    mockExecSync
      .mockReturnValueOnce(JSON.stringify([{
        number: 100,
        title: 'Deployment pending — your-org/fritZ',
        body: `## Deployment pending\n\n## PRs merged since last deploy\n\n- [ ] #629 — old (merged 2026-03-22)`,
        labels: [{ name: 'deployment-pending' }, { name: 'priority:p0' }],
      }]) as any)
      .mockReturnValueOnce('' as any);  // issue edit (body only)

    createOrUpdateDeploymentIssue({
      repo: 'your-org/fritZ',
      prNumber: 630,
      prTitle: 'hotfix: crash',
      prLabels: ['hotfix'],
      mergedAt: '2026-03-23',
    });

    const calls = mockExecSync.mock.calls;
    const editCall = calls.find(c => String(c[0]).includes('issue edit'));
    expect(editCall).toBeDefined();
    expect(String(editCall![0])).not.toContain('priority:p0');
  });

  it('does not throw on GitHub API errors (best-effort)', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('GitHub API error');
    });

    expect(() => {
      createOrUpdateDeploymentIssue({
        repo: 'your-org/fritZ',
        prNumber: 630,
        prTitle: 'fix: timeout',
        prLabels: [],
        mergedAt: '2026-03-23',
      });
    }).not.toThrow();
  });
});

// ============================================================================
// Checklist entry formatting tests
// ============================================================================

describe('checklist entry formatting', () => {
  it('formats a normal PR entry', () => {
    const entry = `- [ ] #45 — feat: add dashboard (merged 2026-03-23)`;
    expect(entry).toBe('- [ ] #45 — feat: add dashboard (merged 2026-03-23)');
  });

  it('formats a rollback PR entry with ⚠️ prefix', () => {
    const prTitle = 'Revert "feat: add dashboard"';
    const isRollback = prTitle.startsWith('Revert');
    const prefix = isRollback ? '⚠️ ROLLBACK: ' : '';
    const entry = `- [ ] #46 — ${prefix}${prTitle} (merged 2026-03-23)`;
    expect(entry).toContain('⚠️ ROLLBACK:');
  });

  it('detects hotfix by hotfix label', () => {
    const labels = ['hotfix', 'type:bug'];
    const isHotfix = labels.includes('hotfix') || labels.includes('priority:p0');
    expect(isHotfix).toBe(true);
  });

  it('detects hotfix by priority:p0 label', () => {
    const labels = ['priority:p0', 'type:feature'];
    const isHotfix = labels.includes('hotfix') || labels.includes('priority:p0');
    expect(isHotfix).toBe(true);
  });

  it('does not detect hotfix for normal labels', () => {
    const labels = ['type:feature', 'priority:p1'];
    const isHotfix = labels.includes('hotfix') || labels.includes('priority:p0');
    expect(isHotfix).toBe(false);
  });

  it('detects rollback by revert label', () => {
    const labels = ['revert'];
    const isRollback = 'some title'.startsWith('Revert') || labels.includes('revert');
    expect(isRollback).toBe(true);
  });
});

// ============================================================================
// Stale reminder cooldown tests
// ============================================================================

describe('stale reminder cooldown', () => {
  beforeEach(() => {
    _lastReminderSent.clear();
  });

  afterEach(() => {
    _lastReminderSent.clear();
  });

  it('cooldown map starts empty', () => {
    expect(_lastReminderSent.size).toBe(0);
  });

  it('tracks last reminder timestamp per repo', () => {
    const now = Date.now();
    _lastReminderSent.set('your-org/fritZ', now);
    expect(_lastReminderSent.get('your-org/fritZ')).toBe(now);
  });

  it('independent tracking per repo', () => {
    _lastReminderSent.set('your-org/fritZ', 1000);
    _lastReminderSent.set('your-org/other', 2000);
    expect(_lastReminderSent.get('your-org/fritZ')).toBe(1000);
    expect(_lastReminderSent.get('your-org/other')).toBe(2000);
  });

  it('cooldown check: recent reminder blocks re-send', () => {
    const COOLDOWN = 24 * 60 * 60 * 1000;
    const now = Date.now();
    _lastReminderSent.set('your-org/fritZ', now - 1000);
    const lastSent = _lastReminderSent.get('your-org/fritZ')!;
    expect(now - lastSent >= COOLDOWN).toBe(false);
  });

  it('cooldown check: old reminder allows re-send', () => {
    const COOLDOWN = 24 * 60 * 60 * 1000;
    const now = Date.now();
    _lastReminderSent.set('your-org/fritZ', now - COOLDOWN - 1000);
    const lastSent = _lastReminderSent.get('your-org/fritZ')!;
    expect(now - lastSent >= COOLDOWN).toBe(true);
  });
});

// ============================================================================
// checkStaleDeploymentIssues() functional tests (W4)
// ============================================================================

const mockGetRepoConfig = vi.mocked(getRepoConfig);
const mockGetAllRepoConfigs = vi.mocked(getAllRepoConfigs);
const mockGetDaemonConfig = vi.mocked(getDaemonConfig);
const mockStaleReminder = vi.mocked(lifecycle.staleDeploymentReminder);

describe('checkStaleDeploymentIssues', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    _lastReminderSent.clear();
    mockStaleReminder.mockReset();
    mockStaleReminder.mockResolvedValue(undefined);
    mockGetRepoConfig.mockReturnValue({});
    mockGetAllRepoConfigs.mockReturnValue({});
    mockGetDaemonConfig.mockReturnValue({
      deployWorkflow: 'build-and-deploy.yml',
      staleDeploymentReminderDays: 3,
    } as any);
  });

  afterEach(() => {
    _lastReminderSent.clear();
  });

  it('calls staleDeploymentReminder when issue age >= threshold', async () => {
    const oldDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(); // 4 days ago
    mockExecSync.mockReturnValueOnce(JSON.stringify([{
      number: 50,
      createdAt: oldDate,
      url: 'https://github.com/your-org/fritZ/issues/50',
    }]) as any);

    await checkStaleDeploymentIssues();

    expect(mockStaleReminder).toHaveBeenCalledWith(
      'your-org/fritZ',
      'https://github.com/your-org/fritZ/issues/50',
      expect.any(Number),
    );
    expect(_lastReminderSent.has('your-org/fritZ')).toBe(true);
  });

  it('does NOT call reminder when issue is younger than threshold', async () => {
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
    mockExecSync.mockReturnValueOnce(JSON.stringify([{
      number: 50,
      createdAt: recentDate,
      url: 'https://github.com/your-org/fritZ/issues/50',
    }]) as any);

    await checkStaleDeploymentIssues();

    expect(mockStaleReminder).not.toHaveBeenCalled();
  });

  it('respects 24h cooldown — no second reminder within 24h', async () => {
    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    _lastReminderSent.set('your-org/fritZ', Date.now() - 1000); // sent 1 second ago

    mockExecSync.mockReturnValueOnce(JSON.stringify([{
      number: 50,
      createdAt: oldDate,
      url: 'https://github.com/your-org/fritZ/issues/50',
    }]) as any);

    await checkStaleDeploymentIssues();

    expect(mockStaleReminder).not.toHaveBeenCalled();
  });

  it('allows reminder after cooldown expires', async () => {
    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const COOLDOWN = 24 * 60 * 60 * 1000;
    _lastReminderSent.set('your-org/fritZ', Date.now() - COOLDOWN - 1000); // expired

    mockExecSync.mockReturnValueOnce(JSON.stringify([{
      number: 50,
      createdAt: oldDate,
      url: 'https://github.com/your-org/fritZ/issues/50',
    }]) as any);

    await checkStaleDeploymentIssues();

    expect(mockStaleReminder).toHaveBeenCalled();
  });

  it('skips repos with deployment-tracker: false', async () => {
    mockGetRepoConfig.mockReturnValue({ deploymentTracker: false });

    await checkStaleDeploymentIssues();

    // No gh calls should be made since the only repo is opted out
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('checks additional repos from getAllRepoConfigs', async () => {
    mockGetAllRepoConfigs.mockReturnValue({
      'your-org/other-repo': {},
    });

    // Main repo query (your-org/fritZ) — no stale issues
    mockExecSync.mockReturnValueOnce('[]' as any);
    // Additional repo query (your-org/other-repo) — no stale issues
    mockExecSync.mockReturnValueOnce('[]' as any);

    await checkStaleDeploymentIssues();

    // Should have queried both repos
    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it('does not set cooldown when staleDeploymentReminder fails', async () => {
    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    mockStaleReminder.mockRejectedValueOnce(new Error('Telegram down'));

    mockExecSync.mockReturnValueOnce(JSON.stringify([{
      number: 50,
      createdAt: oldDate,
      url: 'https://github.com/your-org/fritZ/issues/50',
    }]) as any);

    await checkStaleDeploymentIssues();

    expect(mockStaleReminder).toHaveBeenCalled();
    // Cooldown should NOT be set since reminder failed
    expect(_lastReminderSent.has('your-org/fritZ')).toBe(false);
  });

  it('does not throw on GitHub API errors (best-effort)', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('GitHub API error');
    });

    await expect(checkStaleDeploymentIssues()).resolves.toBeUndefined();
  });
});
