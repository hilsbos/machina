# machina Testing Guide

Test-suite reference for the machina daemon. See the [orchestrator README](../README.md) for the daemon overview.

## Overview

The daemon uses [Vitest](https://vitest.dev/) as its test framework. Tests are organized by module alongside their source files using the `*.test.ts` naming convention.

> [!NOTE]
> 1,369 tests across 53 files. Coverage is enforced via Vitest thresholds (see [Coverage](#coverage) below).

## Quick Start

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode (re-run on file change)
npm run test:coverage # Run with coverage report
```

## Test Architecture

Tests are organized into three tiers based on their dependency complexity:

### Tier 1 — Pure Unit Tests

Test pure functions with no external dependencies. These import the source module directly and test input/output behavior.

| Test File | Source Module | Coverage |
|-----------|-------------|----------|
| `types.test.ts` | `types.ts` | 100% |
| `runtime.test.ts` | `runtime.ts` | 100% |
| `priority-utils.test.ts` | `agents/priority-utils.ts` | 100% |
| `version-utils.test.ts` | `agents/version-utils.ts` | 100% |
| `focus.test.ts` | `agents/focus.ts` | 100% |
| `telegram-helpers.test.ts` | `telegram/telegram-helpers.ts` | 100% |
| `message-formatter.test.ts` | `telegram/message-formatter.ts` | 95% |
| `message-sanitizer.test.ts` | `telegram/message-sanitizer.ts` | 87% |
| `message-tracker.test.ts` | `telegram/message-tracker.ts` | 100% |

### Tier 2 — Stateful Unit Tests

Test modules with internal state or file system dependencies. Use `vi.mock()` to isolate from external systems, and `beforeEach`/`afterEach` for state cleanup.

| Test File | Source Module | Coverage |
|-----------|-------------|----------|
| `fritz-config.test.ts` | `agents/fritz-config.ts` | 95% |
| `registry-cache.test.ts` | `core/registry.ts` | 90% |
| `session-parser.test.ts` | `agents/session-parser.ts` | Tier 2 |
| `notification-mode.test.ts` | `telegram/notification-mode.ts` | 89% |
| `feedback-manager.test.ts` | `agents/feedback-manager.ts` | 83% |
| `usage-monitor.test.ts` | `agents/usage-monitor.ts` | 90% |
| `autoloop-pause.test.ts` | `agents/autoloop.ts` (pause) | imported |

### Tier 3 — Integration / Behavioral Tests

Test modules tightly coupled to Docker, GitHub API, Telegram SDK, or HTTP servers. These use behavioral mirrors (inline logic replicating source behavior) and mock all I/O boundaries.

| Test File | Source Module | Approach |
|-----------|-------------|----------|
| `agents.test.ts` | `agents/agents.ts` | Behavioral mirror |
| `boot.test.ts` | `agents/boot.ts` | Mock child_process |
| `api-security.test.ts` | `api/api.ts` | Token validation mirror |
| `github.test.ts` | `github/github.ts` | Label parsing mirror |
| `telegram-buttons.test.ts` | `telegram/telegram-buttons.ts` | 100% direct import |
| `orchestrator.test.ts` | `orchestrator/knowledge.ts` | Direct import |
| `diagnose.test.ts` | `core/diagnose-utils.ts` | Direct import |

## Patterns

### Mocking Dependencies

Use `vi.mock()` at the top of test files to intercept module imports:

```typescript
vi.mock('../config.js', () => ({
  config: {
    workspacesDir: '/tmp/test',
    telegramBotToken: 'test',
    telegramChatId: '-100123',
  },
}));
```

### Testing with File System

For modules that read config files (like `fritz-config.ts`), use temp directories:

```typescript
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resetConfigCache, setTestConfigPath } from './fritz-config.js';

const TEST_DIR = '/tmp/vitest-test';

beforeEach(() => {
  resetConfigCache();
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  setTestConfigPath(null);
});
```

### Testing with Timers

Use `vi.useFakeTimers()` for timer-dependent tests:

```typescript
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('expires after TTL', () => {
  vi.advanceTimersByTime(3600_000);
  expect(isExpired(agent)).toBe(true);
});
```

### Module Re-import Pattern

For modules with side-effect state (like `runtime.ts`), use `vi.resetModules()` + dynamic import:

```typescript
beforeEach(async () => {
  vi.resetModules();
  delete process.env.FRITZ_RUNTIME_MODE;
  const mod = await import('./runtime.js');
  isRunningInDocker = mod.isRunningInDocker;
});
```

### Behavioral Mirrors

Some modules are too tightly coupled to external services (Docker, Telegram SDK, HTTP server) to unit test via direct import. These are tested via behavioral mirrors — tests that replicate the source logic inline and verify the expected behavior.

Current mirrors:
- `api-security.test.ts` — mirrors token validation logic from `api.ts`
- `telegram-security.test.ts` — mirrors chat ID middleware from `telegram.ts`
- `concurrency.test.ts` — mirrors parallel agent limit and queue bounds from `agents.ts` / `agent-comms.ts`

**Developer responsibility:** When changing logic in an excluded module (e.g., token validation in `api.ts`), the corresponding behavioral mirror test must be updated to match. Mirrors are not auto-synced with the source — it is the developer's responsibility to keep them in sync when modifying the source module.

## Coverage

Coverage is enforced via Vitest configuration with v8 provider:

- **Lines threshold:** 70%
- **Branches threshold:** 60%

Coverage is measured on testable modules (pure logic, config, state). Heavy integration modules (1940-line telegram.ts, Docker container management, GitHub CLI wrappers) are excluded from coverage metrics but have behavioral tests.

Run `npm run test:coverage` to generate the report (output: `coverage/` directory).

## Out-of-Scope Tests

`fritz-orchestrator/dashboard-dropdown-position.test.ts` is a standalone test file that uses a hand-rolled assertion framework (no Vitest). It tests the dropdown positioning algorithm extracted from `dashboard-ui.html` as a pure-logic mirror. It is intentionally excluded from the Vitest suite (`src/**/*.test.ts` include path) because it tests inline DOM logic and runs independently with `npx tsx dashboard-dropdown-position.test.ts`.

## Adding New Tests

1. Create `src/module-name.test.ts` alongside the source file
2. Import from `vitest`: `import { describe, it, expect, vi } from 'vitest'`
3. Mock external dependencies with `vi.mock()`
4. Use `describe` blocks for logical grouping
5. Run `npm test` to verify
