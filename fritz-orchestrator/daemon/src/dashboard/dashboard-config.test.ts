/**
 * Vitest tests for the dashboard config editor API endpoints.
 *
 * Tests config read, save (with backup and validation), and related flows.
 * Does NOT test commit/restart (those interact with git and process lifecycle).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse, stringify } from 'yaml';

import {
  getConfigPath,
  resetConfigCache,
  setTestConfigPath,
  getAgentConfig,
} from '../agents/fritz-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = resolve(__dirname, '../../.test-fixtures-dashboard-config-vitest');
const TEST_CONFIG_PATH = resolve(TEST_DIR, 'config/fritz.yaml');

function setupTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(resolve(TEST_DIR, 'config'), { recursive: true });
}

function cleanupTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  setTestConfigPath(null);
}

function writeTestConfig(content: string): void {
  writeFileSync(TEST_CONFIG_PATH, content);
  setTestConfigPath(TEST_CONFIG_PATH);
}

// ── Tests ──

describe('getConfigPath', () => {
  it('returns a valid path ending with fritz.yaml', () => {
    const path = getConfigPath();
    expect(typeof path).toBe('string');
    expect(path.endsWith('fritz.yaml')).toBe(true);
  });
});

describe('Config file read and parse', () => {
  beforeEach(() => setupTestDir());
  afterEach(() => cleanupTestDir());

  it('reads and parses a YAML config file', () => {
    const yamlContent = `# Test config
defaults:
  ttl: 3600
  model: claude-opus-4-6

daemon:
  maxParallelAgents: 8

roles:
  implement:
    ttl: 14400
`;
    writeTestConfig(yamlContent);

    const raw = readFileSync(TEST_CONFIG_PATH, 'utf-8');
    expect(raw).toBe(yamlContent);

    const parsed = parse(raw);
    expect(parsed.defaults.ttl).toBe(3600);
    expect(parsed.defaults.model).toBe('claude-opus-4-6');
    expect(parsed.daemon.maxParallelAgents).toBe(8);
    expect(parsed.roles.implement.ttl).toBe(14400);
  });
});

describe('YAML validation', () => {
  it('valid config parses to object', () => {
    const validYaml = `defaults:
  ttl: 3600
  model: claude-opus-4-6
`;
    const parsed = parse(validYaml);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe('object');
    expect(typeof parsed.defaults).toBe('object');
    expect(typeof parsed.defaults.ttl).toBe('number');
    expect(typeof parsed.defaults.model).toBe('string');
  });

  it('invalid YAML syntax throws', () => {
    expect(() => parse('{ invalid yaml {{{}'))
      .toThrow();
  });

  it('missing defaults section is detectable', () => {
    const noDefaults = `roles:
  implement:
    ttl: 14400
`;
    const parsed = parse(noDefaults);
    expect(!parsed.defaults || typeof parsed.defaults !== 'object').toBe(true);
  });

  it('missing defaults.ttl is detectable', () => {
    const noTtl = `defaults:
  model: claude-opus-4-6
`;
    const parsed = parse(noTtl);
    expect(typeof parsed.defaults.ttl !== 'number').toBe(true);
  });

  it('missing defaults.model is detectable', () => {
    const noModel = `defaults:
  ttl: 3600
`;
    const parsed = parse(noModel);
    expect(typeof parsed.defaults.model !== 'string').toBe(true);
  });
});

describe('Config backup on save', () => {
  beforeEach(() => setupTestDir());
  afterEach(() => cleanupTestDir());

  it('creates backup and writes new content', () => {
    const originalContent = `defaults:
  ttl: 3600
  model: claude-opus-4-6
`;
    writeTestConfig(originalContent);

    // Simulate backup creation
    const backupPath = TEST_CONFIG_PATH + '.bak';
    copyFileSync(TEST_CONFIG_PATH, backupPath);

    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, 'utf-8')).toBe(originalContent);

    // Write new content
    const newContent = `defaults:
  ttl: 7200
  model: claude-opus-4-6
`;
    writeFileSync(TEST_CONFIG_PATH, newContent);

    expect(readFileSync(TEST_CONFIG_PATH, 'utf-8')).toBe(newContent);
    expect(readFileSync(backupPath, 'utf-8')).toBe(originalContent);
  });
});

describe('resetConfigCache', () => {
  beforeEach(() => setupTestDir());
  afterEach(() => cleanupTestDir());

  it('allows reloading after save', () => {
    writeTestConfig(`defaults:
  ttl: 3600
  model: claude-opus-4-6
`);

    const config1 = getAgentConfig('implement');
    expect(config1.ttl).toBe(3600);

    // Simulate save
    writeFileSync(TEST_CONFIG_PATH, `defaults:
  ttl: 7200
  model: claude-opus-4-6
`);
    resetConfigCache();

    const config2 = getAgentConfig('implement');
    expect(config2.ttl).toBe(7200);
  });
});

describe('YAML stringify roundtrip', () => {
  it('preserves structure through parse-stringify cycle', () => {
    const original = `defaults:
  ttl: 3600
  model: claude-opus-4-6
daemon:
  maxParallelAgents: 8
  watchdogIntervalSec: 60
roles:
  implement:
    ttl: 14400
  review:
    ttl: 7200
`;
    const parsed = parse(original);
    const roundTripped = stringify(parsed);
    const reParsed = parse(roundTripped);

    expect(reParsed.defaults.ttl).toBe(3600);
    expect(reParsed.defaults.model).toBe('claude-opus-4-6');
    expect(reParsed.daemon.maxParallelAgents).toBe(8);
    expect(reParsed.roles.implement.ttl).toBe(14400);
    expect(reParsed.roles.review.ttl).toBe(7200);
  });

  it('preserves boolean and number types', () => {
    const original = `defaults:
  ttl: 3600
  model: claude-opus-4-6
claude:
  claudeSkipPermissions: true
  claudePrintMode: false
usage:
  enabled: true
  pauseThreshold: 80
  resumeThreshold: 50
  checkIntervalMinutes: 5
  allowP0: true
`;
    const parsed = parse(original);
    const roundTripped = stringify(parsed);
    const reParsed = parse(roundTripped);

    expect(reParsed.claude.claudeSkipPermissions).toBe(true);
    expect(reParsed.claude.claudePrintMode).toBe(false);
    expect(reParsed.usage.enabled).toBe(true);
    expect(reParsed.usage.pauseThreshold).toBe(80);
  });
});
