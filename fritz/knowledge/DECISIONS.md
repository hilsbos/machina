# Architectural Decision Log

Key decisions made during development, with context and rationale.

## Format

Each decision follows this template:
- **Date**: When decided
- **Status**: Proposed | Accepted | Deprecated | Superseded
- **Context**: What prompted this decision
- **Decision**: What was decided
- **Consequences**: What this means going forward

---

## Decisions

<!-- AUTO:DECISIONS:START -->
### ADR-001: In-memory registry cache with debounced persistence
- **Date**: 2026-02-11
- **Status**: Accepted
- **Context**: The registry (registry.ts) performed synchronous file reads on every state access and writes on every state change, blocking the event loop. Alternatives considered: SQLite, Redis, event bus. All were over-engineering for current scale (~10 agents).
- **Decision**: Keep the JSON file format but add an in-memory cache as the source of truth during runtime. File persistence is debounced (configurable via `daemon.persistDebounceMs` in fritz.yaml, default 1s). `init()` loads from disk on startup, `flush()` writes immediately on shutdown.
- **Consequences**: Registry reads are instant (no file I/O). Write coalescing reduces disk I/O. 1s window of potential data loss on crash, but registry is reconstructable from Docker state.

### ADR-002: Daemon operational limits in fritz.yaml
- **Date**: 2026-02-11
- **Status**: Accepted
- **Context**: Operational limits (maxParallelAgents, maxQueueSize, persistDebounceMs, agentMessageTimeoutMs) were hardcoded as constants in source files, making them difficult to tune without code changes.
- **Decision**: Move all daemon-level operational limits to a dedicated `daemon:` section in `fritz.yaml`, separate from per-agent `defaults:`. This keeps agent config (TTL, model) cleanly separated from daemon operational limits.
- **Consequences**: Operators can tune limits without code changes. Config is validated at startup with sensible defaults as fallbacks.

### ADR-003: Unified config file (fritz.yaml)
- **Date**: 2026-02-11
- **Status**: Accepted
- **Context**: The config file was originally named `agents.yaml` when it only contained agent settings. After adding daemon-level operational limits (ADR-002), the file name no longer matched its semantic scope.
- **Decision**: Rename `agents.yaml` to `fritz.yaml` to serve as the unified fritZ configuration file. This reflects that it contains both agent settings (defaults, roles) and daemon operational limits (daemon section).
- **Consequences**: All references to `agents.yaml` in source code, tests, docs, and error messages updated to `fritz.yaml`. Dockerfile copies `config/` directory generically, so no deployment changes needed.

### ADR-004: Config file naming convention (config.ts vs fritz-config.ts)
- **Date**: 2026-02-11
- **Status**: Accepted
- **Context**: After renaming `agents.yaml` to `fritz.yaml` (ADR-003), the TypeScript module that loads it was still named `agent-config.ts`. This created a mismatch: the file reads `fritz.yaml` (which contains agent defaults, roles, orchestrator settings, AND daemon limits), but its name implied it only handled agent config.
- **Decision**: Rename `agent-config.ts` to `fritz-config.ts` to match the YAML file it reads. This establishes a clear naming convention: `config.ts` loads `.env` (environment/infrastructure config), `fritz-config.ts` loads `fritz.yaml` (operational config).
- **Consequences**: Clear separation of concerns in naming: environment config (secrets, paths, Docker) in `config.ts`/`.env`; operational config (TTLs, models, daemon limits) in `fritz-config.ts`/`fritz.yaml`. All imports updated across the codebase.

### ADR-005: Move Telegram topics from .env to fritz.yaml
- **Date**: 2026-02-11
- **Status**: Accepted
- **Context**: Telegram topic thread IDs were configured as `TELEGRAM_TOPIC_*` environment variables in `.env`, loaded via `config.ts`. Per the config separation pattern (ADR-003/ADR-004), environment variables hold infrastructure secrets and paths, while `fritz.yaml` holds operational configuration. Topic IDs are operational config — they define which Telegram thread receives messages for each role — and belong in `fritz.yaml`.
- **Decision**: Move topic configuration from `.env`/`config.ts` to `fritz.yaml`/`fritz-config.ts` as a clean migration with no backwards-compatible fallback. The `.env` topic variables were never used in production. New accessor function `getTelegramTopics()` replaces direct `config.telegramTopics` access.
- **Consequences**: Topic IDs now live alongside other operational config in `fritz.yaml`. The `telegramTopics` field is removed from the `Config` interface and `config.ts`. Consumers (`lifecycle.ts`, `api.ts`) import `getTelegramTopics()` from `fritz-config.ts` instead.

### ADR-006: Configuration cleanup — env vars migrated to fritz.yaml
- **Date**: 2026-02-11
- **Status**: Accepted
- **Context**: 11 operational settings (watchdog interval, heartbeat timeout, workspace max age, Claude Code flags, Telegram feedback settings, edit-in-place settings) were stored as env vars in `.env` despite being operational tuning rather than secrets or infrastructure identity. This violated the config layer principle established in ADR-003/004 and made settings harder to discover.
- **Decision**: Migrate all 11 settings to fritz.yaml under new `claude:` (Claude Code behavior), `daemon:` (watchdog/heartbeat/workspace), and `telegram:` (feedback UX) sections. Clean break — no env var fallbacks. Settings are only read from fritz.yaml with hard-coded defaults. Consumers updated to import from fritz-config.ts instead of config.ts. Deprecated fields removed from Config interface and config.ts.
- **Consequences**: Config principle is consistently applied: `.env` = secrets + infra identity, `fritz.yaml` = operational tuning. Existing deployments must update `fritz.yaml` — old env vars are ignored. Docker-compose files simplified (MODEL env var removed).
### ADR-007: Persistent interactive sessions for Agent Teams
- **Date**: 2026-02-16
- **Status**: Superseded by ADR-009
- **Context**: Agent Teams requires a persistent Claude Code session where the lead process stays alive to spawn and coordinate teammates. The existing `claude -p` (one-shot print mode) exits after each turn, destroying all in-process teammates. PR #282 attempted a config-only approach (env var + skill file instructions) but was reverted because the root cause is the communication protocol in `agent-comms.ts`.
- **Decision**: Introduce dual-mode `agent-comms.ts`: one-shot mode (existing, unchanged) and persistent mode (new, for team-enabled roles). Persistent mode uses `docker exec -i claude -p --input-format stream-json --output-format stream-json` to keep a single Claude Code process alive for the entire session. Messages sent as NDJSON on stdin; turn boundary detection via `stream-json` result events; `session_id` captured from init events for conversation continuity. Feature gated behind `teams.enabled` in `fritz.yaml` (disabled by default). If persistent session dies, falls back to one-shot mode automatically.
- **Consequences**: Team-enabled agents get a persistent session where teammates can persist across turns. Non-team agents are completely unaffected (zero regression risk). Two code paths increase maintenance slightly, but clean mode-flag separation keeps them independent. Token cost 3-7x higher for team sessions — operator opt-in required.

### ADR-008: Streamline agent-comms.ts — discriminated union + shared helpers
- **Date**: 2026-02-17
- **Status**: Accepted
- **Context**: `agent-comms.ts` had a flat `AgentCommsState` interface carrying 5 persistent-only fields even in one-shot mode. Container verification and timeout handling were duplicated between the two modes. The dual-mode architecture (ADR-007) was correct, but the implementation had unnecessary coupling.
- **Decision**: (1) Split `AgentCommsState` into a discriminated union (`OneShotState | PersistentState`) with a `BaseCommsState` base. One-shot state carries only `isFirstMessage`; persistent state carries `stdoutBuffer`, `pendingResolve/Reject`, `persistentStarted`, `sessionId`. (2) Extract `verifyContainer(name)` helper for the shared `docker ps` check. (3) Extract `withTimeout(promise, ms, onTimeout)` helper to unify timeout handling. (4) Introduce `fallbackToOneShot()` for clean persistent → one-shot state transitions. No behavioral changes — structural refactor only.
- **Consequences**: Each mode only carries its own state fields, improving type safety. Shared concerns (container verification, timeout) are single-edit. Fallback path is explicit via `fallbackToOneShot()` which replaces the state in the map. Public API surface (`initAgent`, `destroyAgent`, `sendToAgent`, `isAgentBusy`, `getQueueInfo`) is unchanged — consumers are unaffected.
### ADR-009: Persistent mode for all agents (remove teams gate)
- **Date**: 2026-02-17
- **Status**: Accepted
- **Context**: The dual-mode architecture (ADR-007) gated persistent sessions behind `teams.enabled` and `teams.roles` in fritz.yaml. After weeks of battle-testing, persistent mode proved stable for all team-enabled roles. The one-shot/persistent branching added unnecessary complexity — mode selection, conditional env var injection, and display logic all branched on `teamsConfig.enabled && isTeamRole()`. Meanwhile, non-team roles (budget, retro, etc.) missed the latency benefits of persistent sessions for `/tell` messages.
- **Decision**: Make persistent mode the universal default for all agent communication. Remove `teams.enabled` (boolean gate) and `teams.roles` (role whitelist) from fritz.yaml and `TeamsConfig` interface. Remove `isTeamRole()` helper. Always inject `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` for all agents (harmless if unused — actual teammate spawning controlled by skill file instructions). Always apply `ttlMultiplier` to all agents' TTL. Keep `teams.ttlMultiplier` for operational tuning. Parser silently ignores legacy `enabled`/`roles` keys for backwards compatibility. One-shot mode retained as automatic fallback via `fallbackToOneShot()`. (Note: `teams.teammateModel` was also kept here but later removed in ADR-012.)
- **Consequences**: Simpler codebase (−98 lines). All agents benefit from persistent session latency reduction. `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is now universal but safe — container isolation + TTL limits risk. Rollback: re-add `teams.enabled` and `teams.roles` to fritz.yaml and revert code changes.
### ADR-010: Use Sonnet as default model, Opus for complex roles
- **Date**: 2026-02-19
- **Status**: Accepted
- **Context**: All agents ran on `claude-opus-4-6` ($5/$25 per MTok). Sonnet 4.6 ($3/$15 per MTok) matches Opus on SWE-bench (79.6% vs 80.8%) and is sufficient for structured, template-driven tasks (review, validate, define, ux, budget, retro). Roles requiring deep reasoning (implement, architect, security-review) benefit from Opus.
- **Decision**: Change `defaults.model` in fritz.yaml from `claude-opus-4-6` to `claude-sonnet-4-6`. Add explicit `model: claude-opus-4-6` overrides to implement, architect, and security-review roles. Config-only change — zero code modifications. The existing `getRoleModel()` resolution chain (`roleConfig.model ?? config.defaults.model`) already supports per-role overrides.
- **Consequences**: ~30% cost savings per pipeline run ($30 → $21 for define→implement→review→validate). Sonnet's lower latency improves agent turnaround. Rollback is a single YAML revert. Per-issue label override (`fritz.model:`) deferred to a future issue if needed.

### ADR-011: Configurable notification modes (essential/quiet/compact/verbose)
- **Date**: 2026-02-20 (amended 2026-02-25 — added essential mode, issue #506)
- **Status**: Accepted
- **Context**: Telegram lifecycle notifications (agent started, progress, completed, etc.) were always verbose — every event generated a new message. For operators monitoring many agents, this created notification spam. Issue #422 proposed in-place message editing for compact updates, issue #435 generalized this into three modes, and issue #506 added a fourth mode (`essential`) for operators who only want to be interrupted for questions or problems.
- **Decision**: Add a `notificationMode` setting to `fritz.yaml` (`telegram.notificationMode`) with four modes: `essential` (only questions, problems, and direct replies — blocked, failed, agent_response), `quiet` (only warnings/errors), `compact` (one message per agent, updated in-place via `editMessageText`), and `verbose` (every event gets a new message). Runtime toggle via `fritz mode <mode>` Telegram command. Compact mode reuses existing `editNotify()` infrastructure and respects `editMinIntervalMs` throttling. Mode filtering is implemented as a pure function (`shouldNotifyForMode`) in `notification-mode.ts`, keeping lifecycle.ts clean. Essential mode uses an allow-list (`ESSENTIAL_NOTIFY`) rather than a suppress-list, making it the most restrictive mode.
- **Consequences**: Operators can reduce notification noise without code changes. `editInPlaceEnabled` (feedback-manager, chat session progress) and `notificationMode: compact` (lifecycle, agent event notifications) operate on different message streams and coexist safely — no interaction between them. The `ALWAYS_NOTIFY` list ensures critical events (blocked, failed, timeout) bypass mode filtering for quiet/compact/verbose modes. **Important:** `essential` mode overrides `ALWAYS_NOTIFY` — it uses its own allow-list (`ESSENTIAL_NOTIFY`: blocked, failed, agent_response), so `timeout` and `system` events are suppressed even though they are in `ALWAYS_NOTIFY`. This is intentional: essential mode's goal is minimal interruption, and timeouts/system messages are not actionable questions or problems. Runtime override takes precedence over fritz.yaml and resets on daemon restart.
### ADR-012: Remove `teammateModel` config — let agents choose teammate models
- **Date**: 2026-02-21
- **Status**: Accepted
- **Context**: The `teams.teammateModel` config in fritz.yaml was injected as `FRITZ_TEAMMATE_MODEL` env var into agent containers and referenced in skill files with "Use $FRITZ_TEAMMATE_MODEL for teammates." Investigation revealed that Claude Code's Task tool does **not** read env vars for model selection — the `model` parameter accepts only enum values (`sonnet`, `opus`, `haiku`). The env var served as a natural-language hint that the lead agent may or may not interpret correctly, adding config complexity without reliable benefit.
- **Decision**: Remove `teammateModel` from fritz.yaml `teams:` section, `TeamsConfig` interface, and `FRITZ_TEAMMATE_MODEL` env var injection in agents.ts. Remove the teammate model instruction entirely from all 5 skill files (implement, architect, review, validate, security-review) — the agent will choose the appropriate teammate model on its own via Claude Code's Task tool model inheritance or explicit selection.
- **Consequences**: Config surface reduced by one field, one fewer env var per container, and simpler skill file instructions. Teammate model selection is fully delegated to the lead agent — Claude Code defaults to inheriting the parent model when no `model` parameter is specified on the Task tool. Note: Opus-led roles (implement, architect, security-review per ADR-010) will now spawn Opus teammates via inheritance — a known cost tradeoff accepted in favor of simplicity over hardcoding `sonnet`. If cost becomes a concern, a per-role `teammateModel` config can be re-added under `roles:`. Parser silently ignores legacy `teammateModel` key for backwards compatibility.
### ADR-013: Indefinite log archive retention for retro analysis
- **Date**: 2026-02-26
- **Status**: Accepted
- **Context**: The retro agent needs access to historical log archives to perform trend analysis, but `logArchiveMaxAgeDays: 7` deleted archives after one week — before the next retro scan could analyze them. Without historical data, retro analysis is limited to the current week's agents only.
- **Decision**: Set `logArchiveMaxAgeDays: 0` in `fritz.yaml` to disable automatic log archive cleanup. The watchdog's `cleanupOldArchives()` already supports `0 = disabled` (returns early when `maxAgeDays <= 0`), so no code change was needed — only a config change. Disk usage projections show ~1.4GB/year at current scale, which is practical for indefinite retention.
- **Consequences**: Log archives persist forever. Disk usage grows linearly (~30MB/week). If disk becomes a concern, operators can re-enable cleanup by setting `logArchiveMaxAgeDays` to a positive value, or a follow-up could add compression for old archives. The retro agent can now reliably analyze trends across all historical data.
### ADR-014: Dependency-over-waves for pipeline sequencing
- **Date**: 2026-03-22
- **Status**: Accepted
- **Context**: Same-repo issues hitting for-implement simultaneously cause merge conflicts. An earlier design proposed "wave orchestration" — batching issues into waves with a state machine.
- **Decision**: Use `fritz.depends-on` labels instead of a wave planner or repo gate. The owner (or fritZ conversationally) applies `fritz.depends-on:N` labels to sequence work that touches overlapping code. Multiple implement agents can run in parallel on the same repo.
- **Rationale**: Waves add complexity without solving the core problem. A repo-level gate (#616) was tried but was too coarse — it blocked legitimate parallel work on unrelated features. `fritz.depends-on` labels are the correct, explicit mechanism for real sequencing.
- **Consequences**: No wave planner, no repo gate, no wave state. Dependency ordering is handled at triage/define time via `fritz.depends-on:` labels. Phase 2 makes fritZ the conversational planning brain for dependency management.

### ADR-015: GitHub comment notification level
- **Date**: 2026-03-23
- **Status**: Accepted
- **Context**: GitHub issues accumulate 5-10+ bot comments per agent lifecycle (started, progress, finished, auto-pipeline transitions). This creates noise and approaches GitHub API rate limits (#685).
- **Decision**: Add `github.commentLevel` config (essential/quiet/verbose) mirroring Telegram's `notificationMode` pattern. Default `essential` posts only critical events (blocked, rework escalation, dependency cycles, conflicts, skill summaries). `quiet` adds combined start+finish lifecycle comments via edit-in-place. `verbose` preserves all current behavior.
- **Rationale**: 3 levels (not 4 like Telegram) because GitHub doesn't natively support edit-in-place for all comment types. Default `essential` immediately reduces noise ~70-80%.
- **Consequences**: Existing deployments get `essential` automatically. `verbose` is the rollback. Dashboard gains a GitHub Comments runtime control. Skill files now use `report.sh summary` instead of direct `gh issue comment`.
<!-- AUTO:DECISIONS:END -->

---
_Major decisions require human approval before being added._
