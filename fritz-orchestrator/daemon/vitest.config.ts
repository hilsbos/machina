import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',                   // Entry point with side effects
        // Heavy integration modules — tightly coupled to Docker, GitHub API,
        // Telegram SDK, and HTTP server. Tested via behavioral mirrors and
        // integration patterns rather than direct coverage instrumentation.
        'src/telegram/telegram.ts',        // 1940 lines — Telegraf bot wiring (chat ID security tested via behavioral mirror in telegram-security.test.ts)
        'src/dashboard/dashboard.ts',      // 2046 lines — SSE + HTTP routes
        'src/github/github.ts',            // 1231 lines — gh CLI wrapper
        'src/agents/agents.ts',            // 928 lines — Docker container mgmt
        'src/agents/boot.ts',              // 844 lines — workspace/Docker setup
        'src/agents/agent-comms.ts',       // 800 lines — Docker exec IPC
        'src/agents/autoloop.ts',          // 600 lines — GitHub polling loop
        'src/orchestrator/orchestrator.ts', // 582 lines — Claude Code process
        'src/core/lifecycle.ts',           // 534 lines — Telegram notifications (requires injected Telegraf bot; tested via notification-mode.test.ts for mode logic)
        'src/core/watchdog.ts',            // 218 lines — process monitor (depends on registry + agents + lifecycle; key logic like getExpiredAgents tested in registry-cache.test.ts)
        'src/core/diagnose.ts',            // 353 lines — git SHA comparison
        'src/core/event-log.ts',           // 107 lines — file-based event log
        'src/api/api.ts',                  // 447 lines — HTTP server (security paths tested via behavioral mirror in api-security.test.ts)
        'src/config.ts',                   // 113 lines — .env loader (side effects)
        // session-parser.ts — now tested via session-parser.test.ts (Tier 2)
      ],
      thresholds: {
        lines: 70,
        branches: 60,
      },
      reporter: ['text', 'text-summary', 'lcov'],
    },
    // Fake timers by default for deterministic async tests
    fakeTimers: {
      shouldAdvanceTime: false,
    },
    // Isolate tests to prevent module state leakage
    isolate: true,
    // Timeout per test
    testTimeout: 10000,
    // Prevent accidental external calls
    env: {
      VITEST_MODE: '1',
    },
  },
});
