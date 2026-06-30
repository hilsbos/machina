# Patterns

Reusable patterns and conventions used across the fritZ codebase.

## Testing Conventions

### Framework & Configuration

- **Framework:** Vitest v4 with native ESM and TypeScript support
- **Config:** `fritz-orchestrator/daemon/vitest.config.ts`
- **Coverage:** v8 provider, thresholds: 70% lines / 60% branches
- **Co-located tests:** Test files live next to source as `*.test.ts`

### Test Tiers

| Tier | What | Pattern | Examples |
|------|------|---------|----------|
| 1 — Pure Unit | Pure functions, no deps | Direct import, assert input/output | `types.test.ts`, `runtime.test.ts`, `priority-utils.test.ts` |
| 2 — Stateful Unit | Modules with internal state or FS | `vi.mock()` externals, temp dirs, `beforeEach` cleanup | `registry-cache.test.ts`, `fritz-config.test.ts`, `session-parser.test.ts` |
| 3 — Integration | Heavy integration modules | Behavioral mirrors or mock all I/O | `agents.test.ts`, `api-security.test.ts`, `github.test.ts` |

### Key Patterns

**Mocking dependencies** — Use `vi.mock()` at file top, before imports:
```typescript
vi.mock('../config.js', () => ({
  config: { workspacesDir: '/tmp/test' },
}));
```

**Module re-import** — For modules with side-effect state:
```typescript
beforeEach(async () => {
  vi.resetModules();
  delete process.env.SOME_VAR;
  const mod = await import('./module.js');
});
```

**File system testing** — Use temp directories, clean up in afterEach:
```typescript
const TEST_DIR = '/tmp/vitest-test';
beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));
```

**Fake timers** — For timer-dependent tests:
```typescript
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
```

### Behavioral Mirror Pattern

For modules too tightly coupled to external services (Docker, Telegram SDK, HTTP server) to unit test directly, we use behavioral mirrors — tests that replicate the source logic inline and verify the expected behavior.

**When to use:** Only for modules excluded from coverage in vitest.config.ts.

**Developer responsibility:** When changing logic in an excluded module (e.g., token validation in `api.ts`), the corresponding behavioral mirror test (e.g., `api-security.test.ts`) must be updated to match. The mirror is not auto-synced with the source.

**Current mirrors:**
- `api-security.test.ts` — mirrors token validation logic from `api.ts`
- `telegram-security.test.ts` — mirrors chat ID middleware from `telegram.ts`
- `concurrency.test.ts` — mirrors parallel agent limit from `agents.ts` and queue bounds from `agent-comms.ts`

### Conventions

- Import from `vitest`: `import { describe, it, expect, vi } from 'vitest'`
- Use `.js` extensions in import paths (ESM resolution)
- Group tests with `describe` blocks matching the function or module being tested
- One test file per source module (no placeholder stubs)
- External calls are prevented by `vi.mock()` on `child_process`, `fs`, and SDK dependencies (Docker, GitHub, Telegram) — each test file mocks its own I/O boundaries before importing the source module

---
_Last updated: 2026-02-23_
_Contributors: implement-183_
