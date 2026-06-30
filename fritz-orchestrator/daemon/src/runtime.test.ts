/**
 * Vitest unit tests for runtime.ts.
 *
 * Tests isRunningInDocker() and getRuntimeMode() with mocked fs module.
 * Covers FRITZ_RUNTIME_MODE env var override, /.dockerenv detection,
 * and /proc/1/cgroup detection with docker/containerd content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';

// Mock fs module before importing the module under test
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

describe('runtime', () => {
  let isRunningInDocker: typeof import('./runtime.js').isRunningInDocker;
  let getRuntimeMode: typeof import('./runtime.js').getRuntimeMode;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.FRITZ_RUNTIME_MODE;
    mockedExistsSync.mockReset();
    mockedReadFileSync.mockReset();
    // Re-import to get fresh module (avoids cached state)
    const mod = await import('./runtime.js');
    isRunningInDocker = mod.isRunningInDocker;
    getRuntimeMode = mod.getRuntimeMode;
  });

  afterEach(() => {
    delete process.env.FRITZ_RUNTIME_MODE;
  });

  describe('isRunningInDocker', () => {
    it('returns true when FRITZ_RUNTIME_MODE=docker', () => {
      process.env.FRITZ_RUNTIME_MODE = 'docker';
      expect(isRunningInDocker()).toBe(true);
    });

    it('returns false when FRITZ_RUNTIME_MODE=native', () => {
      process.env.FRITZ_RUNTIME_MODE = 'native';
      expect(isRunningInDocker()).toBe(false);
    });

    it('returns true when /.dockerenv exists', () => {
      mockedExistsSync.mockImplementation((path) => path === '/.dockerenv');
      expect(isRunningInDocker()).toBe(true);
    });

    it('returns true when /proc/1/cgroup contains docker', () => {
      mockedExistsSync.mockImplementation((path) => path === '/proc/1/cgroup');
      mockedReadFileSync.mockReturnValue('12:devices:/docker/abc123\n');
      expect(isRunningInDocker()).toBe(true);
    });

    it('returns true when /proc/1/cgroup contains containerd', () => {
      mockedExistsSync.mockImplementation((path) => path === '/proc/1/cgroup');
      mockedReadFileSync.mockReturnValue('12:devices:/containerd/abc123\n');
      expect(isRunningInDocker()).toBe(true);
    });

    it('returns false when no Docker indicators found', () => {
      mockedExistsSync.mockReturnValue(false);
      expect(isRunningInDocker()).toBe(false);
    });

    it('returns false when /proc/1/cgroup exists but has no docker content', () => {
      mockedExistsSync.mockImplementation((path) => path === '/proc/1/cgroup');
      mockedReadFileSync.mockReturnValue('12:devices:/user.slice\n');
      expect(isRunningInDocker()).toBe(false);
    });

    it('handles read error on /proc/1/cgroup gracefully', () => {
      mockedExistsSync.mockImplementation((path) => path === '/proc/1/cgroup');
      mockedReadFileSync.mockImplementation(() => { throw new Error('permission denied'); });
      expect(isRunningInDocker()).toBe(false);
    });
  });

  describe('getRuntimeMode', () => {
    it('returns docker when running in Docker', () => {
      process.env.FRITZ_RUNTIME_MODE = 'docker';
      expect(getRuntimeMode()).toBe('docker');
    });

    it('returns native when not running in Docker', () => {
      mockedExistsSync.mockReturnValue(false);
      expect(getRuntimeMode()).toBe('native');
    });
  });
});
