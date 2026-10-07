# Known Gotchas

Issues, quirks, and workarounds discovered during development.

## Build & Tooling
<!-- AUTO:BUILD:START -->
<!-- AUTO:BUILD:END -->

## Runtime Issues
<!-- AUTO:RUNTIME:START -->
### Registry requires init() and flush() lifecycle

**Problem:** The registry uses an in-memory cache. If `init()` is not called before first access, it auto-initializes (lazy), but `flush()` must be called on graceful shutdown to persist pending writes.

**Key points:**
- `init()` is called during daemon startup (`index.ts`)
- `flush()` is called during graceful shutdown (`index.ts`)
- Between `init()` and `flush()`, all reads/writes go through the in-memory cache
- File persistence is debounced (configurable via `daemon.persistDebounceMs` in fritz.yaml)
- On crash, up to 1s of registry changes may be lost (reconstructable from Docker state)

### maxParallelAgents is in daemon section, not defaults

**Problem:** `maxParallelAgents` is a daemon-level operational limit, not a per-agent default. It lives under `daemon:` in fritz.yaml, not under `defaults:`.

**Key points:**
- All daemon operational limits are in `daemon:` section: `maxParallelAgents`, `maxQueueSize`, `persistDebounceMs`, `agentMessageTimeoutMs`, `startupReadinessTimeoutMs`, `watchdogIntervalSec`, `workspaceMaxAgeHours`, `logArchiveMaxAgeDays`
- Claude Code behavior flags are in `claude:` section: `claudeSkipPermissions`, `claudePrintMode`
- Telegram UX tuning is in `telegram:` section: `chatFeedbackEnabled`, `typingIndicatorIntervalMs`, `progressUpdateIntervalMs`, `timeoutWarningThreshold`, `editInPlaceEnabled`, `editMinIntervalMs`, `notificationMode`
- Per-agent settings (TTL, model) remain in `defaults:` with role-specific overrides in `roles:`
- Access via `getDaemonConfig()`, `getClaudeConfig()`, `getTelegramConfig()`, or `getMaxParallelAgents()` from `fritz-config.ts`

### Config split: .env vs fritz.yaml

**Principle:** `.env` is for secrets and infrastructure identity only. `fritz.yaml` is for operational tuning.

**When adding new config:**
- Tokens, API keys, passwords → `.env`
- Host paths, ports, registry URLs → `.env`
- Timeouts, intervals, limits, feature toggles → `fritz.yaml`
- Add typed accessor in `fritz-config.ts`, not in `config.ts`

### Task Tool Not Available in Containers (Issue #206)

**Problem:** Skill definitions that use `Task:` commands to dispatch sub-skills don't work in containers — Claude CLI running in Docker does not have the Task tool available.

**Solution:** Execute sub-skills inline (sequentially) within the same session. Read each sub-skill's SKILL.md and follow its process directly.

**Tradeoffs:**
- Inline: sequential only, but simple (spec change only), natural context sharing
- Container dispatch: true parallelism, but requires infrastructure changes (days-weeks)

**Learning:** Design skill definitions with container constraints in mind. Assume Task tool and other desktop-only features are unavailable.

### Telegram topics are in fritz.yaml, NOT in .env

**Problem:** Telegram topic thread IDs were historically in `.env` as `TELEGRAM_TOPIC_*` variables. They are now configured in `config/fritz.yaml` under `telegram.topics`.

**Key points:**
- Topic IDs are operational config (not secrets), so they belong in `fritz.yaml` per ADR-003/ADR-004
- Access topics via `getTelegramTopics()` from `fritz-config.ts`, NOT from `config.ts`
- The `.env` file should NOT contain `TELEGRAM_TOPIC_*` variables

### Autoloop priority sorting — unprioritized issues are processed last

**Problem:** When the autoloop spawns agents and `maxParallelAgents` is reached, low-priority issues may consume agent slots while high-priority issues wait.

**Solution:** The autoloop sorts issues by `priority:pN` labels before spawning agents (p0 first, p3 last). Issues without a priority label are processed after all prioritized issues.

**Key points:**
- Priority is extracted from existing `priority:p0`–`priority:p3` GitHub labels (no new config)
- Issues with unknown priority labels (e.g., `priority:p5`) are treated as unprioritized
- If an issue has multiple priority labels, the first match wins
- No additional GitHub API calls — labels are fetched in the same `gh issue list` query

### TELEGRAM_CHAT_ID misconfiguration silently blocks all messages

**Problem:** The Telegram chat ID middleware (issue #290) compares every incoming update's `ctx.chat.id` against `config.telegramChatId`. If `TELEGRAM_CHAT_ID` in `.env` is wrong, the bot will silently ignore ALL messages — including from the correct group.

**Symptoms:** Bot appears online but never responds to any command.

**Fix:** Verify `TELEGRAM_CHAT_ID` in `.env` matches the actual group ID. You can check the group ID by temporarily removing the middleware or using Telegram's API.

**Key points:**
- The middleware runs before any command handler (`bot.use()` in `telegram.ts`)
- Mismatched messages are silently dropped (no error reply, to avoid confirming bot existence to probers)
- Outbound messages (`sendMessage`) are unaffected — they always use `config.telegramChatId`
### `fritz.repo:` clone failures: fail-fast for labels, warning for default repo

**Problem:** When a `fritz.repo:` label points to a non-existent repository or branch, the agent boots with an empty `./project/` directory and flounders until timeout.

**Solution:** Clone failures are now fail-fast when the repo came from a `fritz.repo:` label. The boot aborts, the issue is set to `for-human`, and a warning comment with the error details is posted.

**Key points:**
- Only `fritz.repo:` label-specified repos trigger fail-fast. The default repo (`config.githubRepo`) clone failures remain warnings to avoid blocking agents during transient network issues.
- The distinction is tracked via a `repoFromLabel` boolean in `bootAgent()` (`boot.ts`)
- On clone failure with `repoFromLabel=true`, an error is thrown with the prefix `"Failed to clone repository"` — this prefix is matched in `agents.ts` Phase 4 rollback to set `forceStatus: 'for-human'`
- `unclaimIssue()` accepts optional `{ errorMessage, forceStatus }` to include error details in the GitHub comment and override the restored status

### `fritz.long-running` label and TTL=0

**Concept:** Issues labeled `fritz.long-running` set TTL=0 for their agents, meaning no TTL expiration. The watchdog's `getExpiredAgents()` skips `ttl === 0` agents.

**Key points:**
- TTL=0 means "disabled" (not "zero seconds") — same pattern as `workspaceMaxAgeHours: 0`
- Detection is boot-time only (label read once via `fetchBootContext()`)
- Docker container health monitoring still works — the watchdog's `syncProcesses()` detects dead containers regardless of TTL
- Long-running agents still get progress update instructions in `assignment.md` (every ~30 min)
- User can always `/stop` a long-running agent manually

### `fritz-agent-kali` uses an independent base image

**Problem:** Unlike `fritz-agent-java` and `fritz-agent-cpp` which inherit from `fritz-agent` (`FROM fritz-agent`), the Kali variant uses `FROM kalilinux/kali-rolling` because Kali security tools require Kali's APT repositories.

**Key points:**
- `Dockerfile.agent.kali` reinstalls Node.js, Claude Code CLI, and gh CLI independently
- The `fritz-agent-kali` docker-compose service has **no `depends_on: [fritz-agent]`**
- The CI `build-kali-agent` job runs in parallel (no dependency on `build-base-agent`)
- Changes to `Dockerfile.agent` (base) do **not** propagate to Kali — update both files if prerequisites change

### `lang:` labels migrated to `fritz.lang:`

**Change:** Language labels (`lang:java`, `lang:cpp`) were renamed to `fritz.lang:java`, `fritz.lang:cpp` to follow the `fritz.*` prefix convention for daemon-owned labels.

**Key points:**
- `LABEL_TO_VARIANT` in `agents.ts` now uses `fritz.lang:` prefix via `LANG_PREFIX` constant
- `ensureLabels()` in `github.ts` creates `fritz.lang:*` labels (not `lang:*`)
- Existing issues with `lang:*` labels need manual migration (remove `lang:java`, add `fritz.lang:java`)

### All agents use persistent mode — `claude -p` one-shot is fallback only

**Problem:** Agent Teams (teammates) are in-process threads that only live as long as the lead Claude Code process. Using `claude -p` (one-shot print mode) kills teammates when the process exits after each turn.

**Solution:** All agents use persistent interactive sessions via `docker exec -i claude -p --input-format stream-json --output-format stream-json`. The process stays alive, teammates persist across turns. One-shot mode exists only as an automatic fallback. (See ADR-009)

**Key points:**
- All agents use persistent mode by default — no opt-in required (changed in #329)
- If persistent session dies, agent falls back to one-shot mode automatically via `fallbackToOneShot()` which replaces the `PersistentState` in the map with a fresh `OneShotState`
- Turn boundary detected via `stream-json` result events (type: "result")
- `--teammate-mode in-process` is the only option in Docker (no TTY available)
- Persistent sessions use 3-7x more tokens — configured via `teams.ttlMultiplier` for extended TTL
- State is modeled as a discriminated union: `OneShotState` carries `isFirstMessage`; `PersistentState` carries `stdoutBuffer`, `pendingResolve/Reject`, `persistentStarted`, `sessionId`

### Persistent mode requires `--input-format stream-json` — plain text stdin hangs

**Problem:** Claude Code's `-p` mode with default `--input-format text` reads ALL of stdin until EOF before processing. If stdin is a pipe that stays open (like `docker exec -i` with `stdio: ['pipe', ...]`), Claude waits for EOF forever — the session hangs and produces no output.

**Solution:** Use `--input-format stream-json` which accepts newline-delimited JSON (NDJSON) messages on stdin without waiting for EOF. Each JSON line is processed as a separate user turn.

**Key points:**
- Messages must be NDJSON: `{"type":"user","message":{"role":"user","content":"..."},"session_id":"...","parent_tool_use_id":null}`
- `-p` flag is required alongside `--input-format stream-json`
- Plain text `stdin.write("hello\n")` will NOT work — must be structured JSON
- This was the root cause of Issue #305: persistent mode had `--output-format stream-json` but was missing `--input-format stream-json` and sending plain text

### Agent Teams env var and mode selection

**Problem:** Two things must happen for Agent Teams to work: (1) the env var `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` must be set in the container, and (2) the communication mode must be `persistent` instead of `oneshot`.

**Key points:**
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is injected for all agents unconditionally (harmless if unused — actual teammate spawning is controlled by skill file instructions)
- All agents use persistent mode by default; mode controlled by `initAgent()` default parameter in `agent-comms.ts`
- Env var injection happens in `startAgentDocker()` in `agents.ts`
- TTL multiplier (`teams.ttlMultiplier`) is applied to all agents and before GitHub claim so the "Agent Started" comment shows correct TTL (operators can set to 1.0 to disable)

### `logArchiveMaxAgeDays: 0` means indefinite retention (not "disabled cleanup")

**Problem:** The `logArchiveMaxAgeDays` setting in `fritz.yaml` uses `0` to mean "keep archives forever" (indefinite retention). This follows the same `0 = disabled` pattern as `workspaceMaxAgeHours: 0`, but could be misread as "delete immediately" or "cleanup disabled with no retention".

**Key points:**
- `logArchiveMaxAgeDays: 0` → archives persist forever (watchdog's `cleanupOldArchives()` returns early when `maxAgeDays <= 0`)
- This was set intentionally in issue #509 to ensure retro agents always have historical log data available
- Disk usage grows at ~1.4GB/year at current scale (~200 agents/week) — practical for indefinite retention
- To re-enable cleanup, set `logArchiveMaxAgeDays` to a positive value (e.g., `7` for weekly cleanup)
- See `watchdog.ts` → `cleanupOldArchives()` for the guard: `if (maxAgeDays <= 0) return 0;`

### Log archive retention is independent from workspace cleanup

**Problem:** Workspace cleanup (`workspaceMaxAgeHours`) deletes the entire agent workspace, including logs. Without archiving, logs of completed agents become unavailable.

**Solution:** `log-archive.ts` copies `agent.log` and writes `summary.json` to `{workspacesDir}/logs/archive/{agent-name}/` on every agent exit. These archives have their own retention policy (`daemon.logArchiveMaxAgeDays`, default 7).

**Key points:**
- Archives are written asynchronously to avoid blocking the event loop during mass exit
- `extractToolUsage()` uses async `readFile` (not sync) for the same reason
- `findJsonlFiles()` is shared between `session-parser.ts` and `log-archive.ts` (exported from session-parser)
- `getArchivedLog()` returns `null` (not a sentinel string) when no archive exists
- `getArchivedSummary()` provides O(1) lookup for a single agent (vs `listArchivedAgents()` which scans all)
- API routes for `/api/archive/:name/*` validate agent name against `^[a-z0-9][a-z0-9-]*$` to prevent path traversal
- The `model` field in summary.json uses `getRoleModel(agent.role)` (role-specific), not `getDefaultModel()`

### `claude --version` output format and version capture timing

**Context:** The daemon captures the Claude Code CLI version from agent containers after boot via `docker exec claude --version` and stores it in the registry as `claudeCodeVersion`.

**Output format:** The command outputs `claude v2.1.39` (or similar). The parsing strips the `claude v` prefix using `/^claude\s+v?/i` regex, leaving just the version number (e.g., `2.1.39`).

**Key points:**
- Version capture runs with a 5s timeout — failure is non-fatal (version becomes `undefined`, display omits the line)
- Version is captured once per agent boot and stored in the registry via `updateClaudeCodeVersion()`
- Displayed in Telegram "Agent Started" notification (🔧 Claude Code: `2.1.39`) and `/status` command
- The GitHub "Agent Started" comment does NOT include the version because `claimIssue()` fires before the container starts (version not yet available)
- If `claude` binary is missing from the container image, the capture silently fails — boot proceeds normally

### Orchestrator API access — FRITZ_API_URL and FRITZ_API_TOKEN

**Problem:** The orchestrator (machina) runs as a separate Docker container and could not access the daemon's HTTP API endpoints (`/api/archive`, etc.) because it had no network connectivity to the daemon and no authentication token.

**Solution:** The orchestrator container now joins the `fritz` Docker network and receives `FRITZ_API_URL` and `FRITZ_API_TOKEN` environment variables at boot.

**Key points:**
- Docker mode: `FRITZ_API_URL` is set to `config.daemonUrl` (typically `http://fritz-daemon:3456`), container joins `fritz` network
- Native mode: `FRITZ_API_URL` is set to `http://localhost:{apiPort}` in the spawned process env
- The orchestrator gets its own API token (generated per daemon lifecycle), separate from agent tokens
- `validateCallerToken()` in `api.ts` accepts both agent tokens and the orchestrator token
- Token is generated in `orchestrator.ts` via `randomBytes(16).toString('hex')` and exposed via `getOrchestratorApiToken()`

**Usage from orchestrator:**
```bash
curl -s -H "Authorization: Bearer $FRITZ_API_TOKEN" $FRITZ_API_URL/api/archive
curl -s -H "Authorization: Bearer $FRITZ_API_TOKEN" $FRITZ_API_URL/api/archive/{name}/log
curl -s -H "Authorization: Bearer $FRITZ_API_TOKEN" $FRITZ_API_URL/api/archive/{name}/summary
```

### Startup readiness timeout is configurable (default 30s, was 5s)

**Problem:** The persistent session startup readiness timeout was hardcoded at 5 seconds, but Docker container startup + Claude Code initialization consistently exceeds this — 100% of agents hit the timeout (issue #630).

**Solution:** The timeout is now configurable via `daemon.startupReadinessTimeoutMs` in `fritz.yaml` (default: 30,000ms). Zero and negative values are rejected and fall back to the default.

**Key points:**
- The timeout is a non-blocking fallback — if it fires, the daemon proceeds anyway (logs a warning)
- Readiness is detected by the first stdout/stderr output from the Claude process
- If the timeout fires, the initial prompt may be sent before the agent is fully ready (potential race condition)
- Access via `getDaemonConfig().startupReadinessTimeoutMs` from `fritz-config.ts`

### Persistent session first-response timeout is expected (3 min)

**Pattern:** All agents using persistent mode (`claude -p --input-format stream-json`) experience a ~3 minute timeout on their first prompt before producing any output. The daemon logs this as `TIMEOUT [persistent]: (no response)` and re-sends the prompt.

**Key points:**
- This is expected behavior, not a failure — 94 out of 95 non-stopped agents completed successfully despite the initial timeout
- The first turn involves heavy context loading (reading CLAUDE.md, identity, assignment, knowledge files, issue context) which exceeds the daemon's response timeout
- Agents recover automatically when the daemon re-prompts after timeout
- The pattern is universal across all roles (implement, review, validate, architect)
- Do NOT treat this as an error or attempt to "fix" it in skill instructions

**Evidence:** Retro scan of 100 agents (2026-02-19 to 2026-02-20) — 94/95 completed agents showed this exact pattern in logs.

### Cross-repo issues require more agent cycles

**Pattern:** Issues that span multiple repositories consistently require more implement and review cycles than single-repo issues.

**Key points:**
- Single-repo issues: typically 1 implement + 1 review + 1 validate = 3 total runs
- Cross-repo issues: typically 2-4 implement + 2-5 review + 1-2 validate = 8-12 total runs
- Some of the additional runs are rework cycles (review rejections), others are planned re-runs for different repos
- Issues #172 (12 runs), #349 (11 runs), #403 (9 runs), #405 (8 runs) all involved cross-repo work
- Architects should anticipate this when estimating and plan for multi-repo coordination

**Evidence:** Retro scan of 100 agents across 19 issues (2026-02-19 to 2026-02-20). 4 cross-repo issues averaged 10 total agent runs vs 3-4 for single-repo issues.

### Review re-reviews consume 2-3x more cache tokens

**Pattern:** Review agents running re-reviews (after rework) consume significantly more cache_read tokens than first-pass reviews because they must load the full PR diff plus all prior review comments and history.

**Key points:**
- First-pass review median: ~2.5M cache_read tokens
- Re-review agents: 5-8M cache_read tokens (2-3x higher)
- This is expected — re-reviews read more context (previous findings, rework comments)
- 6 review agents exceeded 2x the median token usage, all on re-reviews
- Not actionable at the skill level, but worth tracking for cost awareness

**Evidence:** Retro scan of 36 completed review agents. 6 exceeded 2x median (5.0M threshold): review-406-c8f0 (7.8M), review-405-a4e4 (7.2M), review-402-6759 (6.1M), review-398-94ec (6.6M), review-425-dba6 (5.2M), review-172-50a5 (5.8M).


### GitHub Secondary Rate Limit & Write Queue

- GitHub's secondary rate limit (~10-15 writes/min) is NOT tracked by `x-ratelimit-remaining`
- All write operations in `github.ts` go through `ghQueued()` → `github-write-queue.ts`
- Token bucket config: 5/sec sustained, burst 15, max queue depth 50/40/20 (high/normal/low)
- Circuit breaker backoff tiers: 60s → 120s → 300s, resets after 1 hour clean
- When changing write operations, always use `ghQueued()` instead of `gh()` for mutations
- Read operations still use `gh()` directly (they don't trigger secondary limits)

### `github.commentLevel` and Telegram `notificationMode` are independent
These two settings control different channels and operate independently:
- `telegram.notificationMode` (essential/quiet/compact/verbose) — controls Telegram messages
- `github.commentLevel` (essential/quiet/verbose) — controls GitHub issue comments

Changing one does NOT affect the other. The dashboard has separate runtime controls for each. Both support runtime override without daemon restart.

Note: GitHub has 3 levels (no `compact`) because GitHub doesn't support edit-in-place for arbitrary message types like Telegram does.

### Phase 3 Eventual Consistency (Future)

**Note:** If Phase 3 (local-first state) is implemented, GitHub labels may lag up to 120s behind the local registry.

**Key points:**
- During Phase 1+2 (current), labels update in real-time through the write queue — no consistency lag
- If Phase 3 is adopted, the dashboard remains real-time via local registry + SSE (not dependent on GitHub label state)
- GitHub becomes an eventual-consistency mirror, not the source of truth for active agent state
- External tools reading GitHub labels directly would see stale data during the lag window
<!-- AUTO:RUNTIME:END -->

### Git blob SHA-1 hash format for GitHub comparison

**Problem:** GitHub's tree API returns git blob SHA-1 hashes, which are NOT plain SHA-1 of file content. A plain `sha1(content)` will never match GitHub's hashes.

**Format:** `sha1("blob {content_length}\0{content}")` — includes a "blob" header, content size in bytes, and a null byte separator before the actual content.

**Example (Node.js):**
```typescript
import { createHash } from 'crypto';
function gitBlobHash(content: Buffer): string {
  const header = `blob ${content.length}\0`;
  const store = Buffer.concat([Buffer.from(header), content]);
  return createHash('sha1').update(store).digest('hex');
}
```

**Verify:** `echo -n "hello" | git hash-object --stdin` → `b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0`

**Used by:** `diagnose.ts` for comparing local files against GitHub's tree API response.

### Dashboard shares port 3456 with agent API

**Problem:** The dashboard (`/dashboard`, `/api/dashboard/*`) and the agent API (`/api/notify`, `/api/ask`, `/api/archive`) all run on the same HTTP server (port 3456) in `api.ts`.

**Key points:**
- Dashboard endpoints are read-only and do NOT require agent API tokens — they are path-scoped outside the token validation middleware
- nginx proxy only forwards `/dashboard` and `/api/dashboard/*` — agent API endpoints are never exposed externally
- No Docker port mapping changes needed — agents already reach port 3456 on the internal Docker network

### NEVER add icons or emojis to dashboard labels

**Rule:** Persistent labels, badges, status text, and tier headers in `dashboard-ui.html` (e.g., table columns, tier badges, status pills) must NEVER have emoji or icon prefixes. The core dashboard chrome is text-only for consistency and scannability.

**Key points:**
- Do NOT add `icon` fields to config objects (e.g., `TIER_CONFIG`)
- Do NOT add `getStatusIcon()`, `getLabelIcon()`, or similar helper functions
- Do NOT prepend emoji characters to `label.value`, `badge.textContent`, or `header.textContent`
- CSS-drawn indicators (e.g., `.stale-icon` clock) are fine — they are structural UI, not label decorations
- Transient UI like toast messages, dropdown items, or rejection/modal body text may use Unicode icons if desired — this rule only governs labels/badges/status/tier headers
- This rule is permanent — icons have been repeatedly removed and keep being re-introduced by agents

**Enforcement:** The `dashboard-ui.html` file contains a prominent comment at the top of the JS section: `// IMPORTANT: NO ICONS`. Any PR that adds icons to labels will be rejected.

### nginx requires `proxy_buffering off` for SSE

**Problem:** By default, nginx buffers upstream responses. For Server-Sent Events (SSE), this means the client receives nothing until the buffer fills — effectively breaking real-time updates.

**Solution:** The nginx config must include `proxy_buffering off`, `proxy_cache off`, `chunked_transfer_encoding off`, and `proxy_http_version 1.1` in the SSE proxy location.

**Key points:**
- The dashboard also sends `X-Accel-Buffering: no` header from the SSE endpoint as an additional safeguard
- `proxy_read_timeout 86400s` (24h) prevents nginx from closing long-lived SSE connections
- Without `proxy_http_version 1.1`, nginx defaults to HTTP/1.0 which doesn't support chunked transfer encoding

### Dashboard access requires Tailscale

**Context:** Remote dashboard access is via `https://fritz.example.com/dashboard` through the edge-router (L4 SNI proxy on Tailscale IP). The domain resolves to the Tailscale IP `100.x.x.x` which is only routable from within the tailnet.

**Key points:**
- Tailscale must be running on the client device to reach the dashboard
- TLS is handled by a Let's Encrypt wildcard cert (`*.example.com`), auto-renewed via certbot dns-route53
- No client certificates needed — Tailscale network membership is the auth layer

## Usage Monitor Gotchas

### Dual-gate pause: manual vs usage

`autoloop.isPaused()` returns true if EITHER manual or usage-paused. The `pause()`/`resume()` functions operate only on the manual pause file. When only usage-paused, `pause()` still works (creates manual file), and `resume()` is correctly a no-op (no manual file to remove). Both must be clear for agents to spawn.

### Long-lived OAuth tokens get 403 on usage API — automatic credentials file fallback

**Problem:** The `CLAUDE_CODE_OAUTH_TOKEN` env var may contain a long-lived OAuth token that lacks permission to access the usage API (`/api/oauth/usage`). The API returns 403 Forbidden for these tokens.

**Solution:** `fetchUsageWithFallback()` catches the 403 and automatically tries the credentials file token (`~/.claude/.credentials.json`) as a fallback. If the fallback succeeds, the env token is marked as forbidden (`envTokenForbidden = true`) so future cycles skip directly to the credentials file token.

**Key points:**
- The fallback only triggers once — the result is remembered for the lifetime of the monitor
- If both tokens get 403, the monitor disables itself with an actionable error message suggesting `claude login`
- `authMode` switches from `'oauth_token'` to `'credentials_file'` on successful fallback (visible in dashboard status)
- Fix for the user: run `claude login` on the host to create a credentials file with a proper OAuth token

### Automatic OAuth token refresh — daemon refreshes tokens proactively

**Problem:** OAuth access tokens expire after ~8-12 hours. Claude Code has a known bug where it doesn't use refresh tokens automatically ([#21765](https://github.com/anthropics/claude-code/issues/21765)). Previously, the daemon would detect the 401 and disable monitoring, requiring manual `claude login` on the host.

**Solution:** `refreshTokenIfNeeded()` in `usage-monitor.ts` proactively refreshes the token when it's within 10 minutes of expiry, and reactively on 401 errors. The refresh uses `POST https://console.anthropic.com/v1/oauth/token` with Claude Code's client ID.

**Key points:**
- Refresh tokens are single-use — the response includes a new refresh token that is persisted to `.credentials.json` if possible
- The credentials file is volume-mounted from the host, so refreshed tokens survive daemon restarts and are usable by local `claude` CLI too
- **Permissions:** The entrypoint adds the `node` user to the credentials file's owning group (`usermod -aG <GID> node`) and sets `g+rw`, so the daemon can write back refreshed tokens. If the write still fails (e.g., `claude login` recreated the file after container start), the refreshed token is still returned and used for the current session — it just won't be persisted
- No race condition: Claude Code doesn't refresh on its own (confirmed bug), so the daemon is the only consumer
- On refresh failure (e.g., revoked refresh token), the monitor disables itself and notifies via Telegram
- The `expiresAt` field in `.credentials.json` is read to determine when to refresh; if missing, refresh is attempted unconditionally
- `CLAUDE_CODE_OAUTH_TOKEN` (env var / long-lived tokens) do NOT have refresh tokens and are NOT refreshed — only the credentials file token is refreshed
- Token refresh uses the client ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code's registered OAuth client)

### OAuth API is undocumented

The `api.anthropic.com/api/oauth/usage` endpoint is not part of Anthropic's public API docs. It requires an OAuth bearer token (not an API key). If the endpoint changes or is removed, the usage monitor will fail-open (no state change on errors) and auto-disable after 5 consecutive failures.

### Usage monitor only tracks archived agents internally

The OAuth API reports real subscription utilization (including web/mobile usage, accurate to all dimensions). The internal `calculateDailyUsage()` from `log-archive` only counts completed agents. Active agents are NOT counted internally — this is by design since the OAuth API covers real usage.

### `hello_chat` event type — chat-mode hello is always delivered

**Problem:** In essential notification mode, chat-mode agents produced no Telegram notifications because `hello` (the only event they emit at boot) was suppressed. Users had no indication a chat agent was booted and waiting.

**Solution:** A distinct `hello_chat` event type was introduced for chat-mode hello messages. It is included in both `ALWAYS_NOTIFY` and `ESSENTIAL_NOTIFY`, so it is delivered regardless of notification mode. Auto-mode `hello` remains suppressible.

**Key points:**
- `lifecycle.ts` `hello()` uses `'hello_chat'` when `mode === 'chat'`, `'hello'` otherwise
- `notification-mode.ts` has `hello_chat` in both `ALWAYS_NOTIFY` and `ESSENTIAL_NOTIFY` arrays
- Chat mode is user-initiated (`/boot -chat`), so the user expects interaction — the hello is necessary
- Auto-mode hello is still suppressed in essential mode (no change)

### Dashboard retro metrics fetched from GitHub API (not local filesystem)

**Problem:** RETRO-METRICS.md was read from the local filesystem, but in Docker the file is only written at container startup via tarball download. After retro agents merge PRs updating the file, the dashboard showed stale data until a full redeploy.

**Solution:** `getRetroMetrics()` in `dashboard.ts` fetches RETRO-METRICS.md from the GitHub Contents API on cache miss, with a local-filesystem fallback for resilience.

**Key points:**
- Requires `GH_TOKEN` and `GITHUB_REPO` for fresh data; falls back to stale local copy without them
- 120s cache TTL (RETRO-METRICS.md changes at most once per day)
- Single-flight coalescing prevents concurrent cache refreshes from duplicating API calls
- 3s GitHub API timeout; on timeout, falls back to local file instantly
- `source` field in API response (`'github'`, `'local'`, or `'cache'`) indicates data freshness
- `parseRetroMetricsContent()` is the extracted pure parser (no I/O); `getRetroMetrics()` is the async orchestrator

### Scheduler state persists across restarts

**Concept:** `scheduler-state.json` in the workspaces directory stores last-run timestamps for each scheduled job. This file persists across daemon restarts.

**Key points:**
- If you delete `scheduler-state.json`, all jobs will be detected as overdue and execute on the next cycle
- Job schedule calculations use the last-run timestamp, not the daemon start time
- The state file is NOT cleaned up by workspace cleanup (it's in the root workspaces dir, not an agent workspace)

### Feedback manager and notification mode are independent systems

**Problem:** Two separate systems edit Telegram messages, which can be confusing:
1. **Feedback manager** (`feedback-manager.ts`): Progress updates during chat-mode agent interaction (typing indicators, elapsed time)
2. **Notification mode** (`notification-mode.ts`): Agent lifecycle events (started, completed, failed) in compact mode

**Key points:**
- `editInPlaceEnabled` (fritz.yaml) controls the feedback manager
- `notificationMode: compact` controls lifecycle notification editing
- They operate on different message streams and don't interfere
- Both respect `editMinIntervalMs` for rate limiting

### Event log trimming only happens on daemon startup

**Concept:** The event log (`.workspaces/logs/events.jsonl`) is append-only during runtime and only trimmed to 500 entries on startup.

**Key points:**
- During a long daemon uptime, the file can grow beyond 500 entries
- The file is re-read and truncated at the next daemon restart
- This is by design — trimming mid-run would require file locking
- At ~500 bytes per event, 500 entries is ~250KB (negligible disk impact)

### Kali tool name mismatches: `testssl.sh` binary is `testssl`, CrackMapExec is now `netexec`

**Problem:** The `testssl.sh` APT package installs the binary as `/usr/bin/testssl` (no `.sh` suffix). CrackMapExec was forked/renamed to NetExec in 2024; Kali replaced the package with `netexec`.

**Key points:**
- `apt install testssl.sh` → binary at `/usr/bin/testssl` (not `testssl.sh`)
- `apt install netexec` → binary at `/usr/bin/netexec` (not `crackmapexec`)
- `netexec` has the exact same CLI interface as `crackmapexec` — 1:1 substitution
- The Dockerfile creates backward-compat symlinks (`testssl.sh` → `testssl`, `crackmapexec` → `netexec`) as defense-in-depth
- When referencing these tools in skill files, use the actual binary names: `testssl` and `netexec`

### paramspider is installed from GitHub, not PyPI

**Problem:** `pip3 install paramspider` (from PyPI) silently fails — the PyPI listing is unreliable/broken. The `2>/dev/null || echo` pattern in the Dockerfile masked this failure, and paramspider was excluded from the build-time verification loop.

**Solution:** Install from the canonical GitHub source: `pip3 install --break-system-packages git+https://github.com/devanshbatham/ParamSpider.git`. paramspider is now included in the verification loop so missing installs fail the build.

**Key points:**
- `devanshbatham/ParamSpider` is the canonical repository (referenced by Kali docs, OWASP, security training)
- If the GitHub repo becomes unavailable, consider replacing with `arjun` (available in Kali APT repos)
- The install uses `--break-system-packages` to allow pip to install alongside system packages

## Pipeline Gotchas
<!-- AUTO:PIPELINE:START -->
### Rebase-only changes trigger full review+validate cycles

**Problem:** When a PR is rebased to resolve merge conflicts (no code changes), the pipeline treats it as new work and spawns full review and validate agents. This wastes significant agent time and API tokens.

**Impact:** In issue #589, the PR was validated at 19:55 on Mar 22. It then went through 2 full review+validate cycles (4 agent spawns) purely due to rebases — the code was identical each time. In issue #486, similar rebase loops added ~12 hours of unnecessary pipeline time.

**Solution:** Review and validate skills now include a "Rebase-Only Fast-Path" that compares the PR diff hash before and after rebase. If identical, the agent re-approves immediately without full re-review.

**Key points:**
- The fast-path compares `git diff base...head` hashes, excluding lock files
- Review agents check against the last APPROVED review commit SHA
- Validate agents check against the last "Validation Passed" comment
- If the diff hash differs (even slightly), the full review/validate runs as normal

### Context loss when merge conflicts force new PRs

**Problem:** When a PR has unresolvable merge conflicts and the implement agent creates a fresh branch/PR, all previous review findings are lost. The new agent starts from scratch and often reintroduces the same bugs that were already caught.

**Impact:** In issue #486, three PRs were created (#627, #668, #719). Each new PR reintroduced previously-caught bugs (tests testing wrong function, missing cache TTL), adding 4+ unnecessary rework cycles.

**Solution:** The implement skill now requires agents to read ALL previous PR review comments before creating a new PR, and to document a checklist of previous findings that must be addressed in the new implementation.

**Key points:**
- Use `gh pr list --search "[ISSUE_NUMBER]" --state all` to find prior PRs
- Read review comments from each prior PR before starting fresh
- Reference superseded PRs in the new PR description
- This is documented in the "Merge Conflict Recovery" section of the implement skill

### Git identity not configured in agent containers

**Problem:** Agent containers start with no git identity. `git commit` and `git rebase` fail with "Please tell me who you are" or "Committer identity unknown."

**Impact:** In issues #486 and #589, git operations failed inside containers, requiring manual cycles to fix.

**Solution:** The implement skill now configures git identity at container startup:
```bash
git config user.name "machina Agent"
git config user.email "fritz-agent@users.noreply.github.com"
```
<!-- AUTO:PIPELINE:END -->

## Testing Gotchas
<!-- AUTO:TESTING:START -->
<!-- AUTO:TESTING:END -->

## Third-Party Issues
<!-- AUTO:THIRDPARTY:START -->
<!-- AUTO:THIRDPARTY:END -->

---
_Gotchas are added when agents encounter and solve unexpected issues._

## Self-Update & Restart

How machina can update and restart itself.

### Trigger Redeployment

To apply changes from the repo (knowledge, skills, daemon code):

```bash
gh workflow run "build-and-deploy.yml" --repo your-org/machina
```

This will:
1. Build new Docker images
2. Deploy to your VPS provider server
3. Restart machina daemon with latest changes

### When to Use

- After updating knowledge files (`fritz/knowledge/`)
- After updating skill definitions (`.claude/skills/`)
- After daemon code changes (`fritz-orchestrator/`)
- After Dockerfile changes

### Check Workflow Status

```bash
gh run list --repo your-org/machina --workflow=build-and-deploy.yml --limit 5
```

### Issue Status Labels

Understanding the difference between status labels:

| Label | Meaning |
|-------|---------|
| `for-*` (e.g. `for-implement`) | Issue is **ready** to be picked up by autoloop |
| `active` | Agent is **actually running** right now |
| `fritz.depends-on:NNN` | Blocks agent spawn even if `for-*` is set |

**Important:** `for-*` does NOT mean an agent is running. The autoloop checks `fritz.depends-on` labels before spawning, so an issue can have `for-implement` but still be waiting if dependencies are unmet.


### `lifecycleCommentIds` stale entries on mid-lifecycle mode transitions

In `quiet` mode, `lifecycleCommentIds` tracks GitHub comment IDs so that `agent-started` and `agent-finished` can be combined into a single edited comment. If the comment level is changed via the dashboard during an agent's lifecycle, edge cases arise:

- **quiet → essential (mid-lifecycle):** Handled correctly — the cleanup path in `releaseAgent` deletes stale entries when the finished comment is skipped.
- **essential → quiet (mid-lifecycle):** The agent started without posting a lifecycle comment (essential skips it), so no comment ID exists. When the agent finishes in quiet mode, it falls through to posting a standalone `agent-finished` comment with no paired `agent-started`. This is cosmetically imperfect but functionally harmless.

Both cases are safe — no data is lost, no errors are thrown. The worst outcome is a standalone lifecycle comment without its pair.


### Session Log vs Agent Log in fridge History — distinct sources

Two log panels appear in the fridge dashboard's History expand view:

| Panel | Source (live agent) | Source (archived agent) |
|-------|---------------------|-------------------------|
| **Session Log** | Parsed Claude Code JSONL via `getSessionTimeline()` (turns + tool calls) | `<workspacesDir>/logs/archive/<name>/session.txt` only |
| **Agent Log**   | Raw `agent.log` via `getAgentLogs()` (stdout/stderr) | Archived `agent.log` |

**Key invariants (issue #926):**
- `getSessionTimeline()` is **JSONL-only by contract** — never falls back to `agent.log`. The previous fallback caused both panels to show identical content for archived agents.
- `session.txt` is written by `archiveAgentLogs()` at agent-exit time. **It only exists for agents archived after the #926 fix shipped** — older archives have no `session.txt` and the panel hides itself (frontend treats empty content as "no data").
- `/api/dashboard/session-log/:name` returns `200 { log: '' }` (not 404) when no timeline exists. The frontend's existing `if (data.log && data.log.trim())` guard hides the panel silently — no error toast for old archives.
- DOM uses stable `log-section-label--session` / `log-section-label--agent` modifier classes; never re-introduce `querySelectorAll('.log-section-label')[0]/[1]` index-based selectors.

**Operator debugging tip:** if an old archived agent shows only the Agent Log panel (Session Log missing), this is expected — `session.txt` was never written. No backfill is possible; the JSONL is gone with the workspace.


## Retro Analysis Gotchas

### Pentest agents always show empty toolUsage (by design)

**Observation:** Every pentest agent has `toolUsage: {}` in its archive summary, regardless of duration or whether the run completed successfully.

**Why:** Pentest agents run inside a Kali Linux container and use native security tools (nmap, nikto, gobuster, sqlmap, curl, etc.) via shell execution. These tools are invoked through the Kali container's own processes, NOT through Claude's standard tool API (Read, Write, Bash, Grep, etc.). The archive's `toolUsage` field only tracks Claude tool API calls.

**Key points:**
- Empty `toolUsage` for pentest is correct and expected — not a logging bug
- Pentest agents do substantial work despite showing 0 tool calls: avg duration 16m, up to 46m for complex engagements
- The `lastActivity` field shows findings (e.g., "2 critical, 3 high, 4 medium findings") confirming work was done
- `subagentCount` may be 0 even for complex engagements (pentest orchestrates Kali tools directly)
- When interpreting retro metrics, exclude pentest from tool usage analysis

### Architect dead rate is a classification artifact, not a skill failure

**Observation:** The architect role consistently shows ~20-24% dead rate across all retro scans, far higher than any other autonomous role.

**Why:** Architect agents are frequently started in chat/interactive mode (e.g., `fritz architect` without an issue number, or via direct Telegram conversation). These sessions:
1. Start as persistent sessions with no issue assignment
2. Get classified as `dead` when the user closes the session or the conversation ends
3. Are counted the same as autonomous failures in the metrics

**Key points:**
- Architect agents with `issue: null` in their summary are chat-mode sessions — exclude them from autonomous failure analysis
- Agents with `duration < 10s` and `turns ≤ 1` and `lastActivity: null` are infrastructure restarts or zero-turn stops
- True autonomous architect failure rate has been ≈0% across all 4 retro scans
- When computing architect failure rate for skill quality analysis, filter: `select(.issue != null and .duration > 60s and .turns > 0)`
- Example: Scan 4 shows 24.1% architect dead rate, but all 13 dead architects = 9 confirmed chat-mode sessions + 4 zero-turn infra restarts
