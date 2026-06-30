# Codebase Knowledge

Project-specific knowledge discovered by agents.

## Project Overview
<!-- AUTO:OVERVIEW:START -->
fritZ is an AI agent orchestration system that enables Claude Code agents to be spawned and managed via Telegram. The daemon watches for commands and GitHub issues, spawns Docker containers running Claude Code for specific tasks (implement, review, validate, etc.), and monitors their lifecycle.
<!-- AUTO:OVERVIEW:END -->

## Architecture
<!-- AUTO:ARCHITECTURE:START -->
The system consists of:
- **fritZ Daemon** (`fritz-orchestrator/daemon/`) - Node.js process that orchestrates everything
- **Agent Containers** - Docker containers spawned for each task
- **GitHub Integration** - Labels and comments track agent status
- **Telegram Bot** - User interface for commands and notifications

The daemon is organized into modules:
- `core/` - Registry, watchdog, lifecycle notifications
- `agents/` - Container management, workspace setup, auto-loop
- `telegram/` - Bot, buttons, message formatting
- `github/` - GitHub API operations
- `api/` - HTTP server for agent notifications
- `dashboard/` - Web dashboard with SSE real-time updates and operational controls (kill agent, boot from queue, toggle autoloop)
- `orchestrator/` - Persistent Claude Code process
<!-- AUTO:ARCHITECTURE:END -->

## Key Files & Directories
<!-- AUTO:KEYFILES:START -->
| Path | Purpose |
|------|---------|
| `fritz-orchestrator/daemon/src/index.ts` | Entry point, startup sequence |
| `fritz-orchestrator/daemon/src/config.ts` | Environment configuration (.env — secrets & infra identity) |
| `fritz-orchestrator/daemon/src/core/registry.ts` | Agent state tracking (in-memory cache with debounced file persistence, includes `claudeCodeVersion` for agent containers) |
| `fritz-orchestrator/daemon/src/agents/agents.ts` | Docker container management |
| `fritz-orchestrator/daemon/src/agents/boot.ts` | Workspace setup, credential copying |
| `fritz-orchestrator/daemon/src/agents/fritz-config.ts` | Loads operational configuration from fritz.yaml (agent defaults, roles, daemon limits, telegram UX, github comment level, agent behavior) |
| `fritz-orchestrator/daemon/src/telegram/telegram.ts` | Telegram bot, command handlers |
| `fritz-orchestrator/daemon/src/github/github.ts` | GitHub API, labels, comments, `getTargetRepoInfo()` for multi-repo, `shouldPostComment()` comment-level gating, edit-in-place lifecycle comments |
| `fritz-orchestrator/daemon/src/core/diagnose.ts` | System freshness diagnosis (git blob SHA-1 hashing, GitHub tree API comparison, report generation) |
| `fritz-orchestrator/daemon/src/agents/autoloop.ts` | Auto-orchestration loop, spawns agents based on issue status (priority-sorted: `priority:pN` labels). Dual-gate pause: manual (`autoloop.paused`) + usage (`usage-paused`) |
| `fritz-orchestrator/daemon/src/agents/usage-monitor.ts` | Subscription usage monitoring — queries Anthropic OAuth API, auto-pauses autoloop at threshold, hysteresis resume, P0 bypass, file-based state (`usage-paused`, `usage-override`) |
| `fritz-orchestrator/daemon/src/agents/log-archive.ts` | Persistent log archive — archives agent.log + summary.json on exit, survives workspace cleanup |
| `fritz-orchestrator/daemon/src/agents/session-parser.ts` | JSONL session log parser — parses Claude Code session data, exports `findJsonlFiles()` |
| `fritz-orchestrator/config/fritz.yaml` | Centralized fritZ configuration (agent TTL/model, daemon limits, telegram UX, agent behavior) |
| `.claude/skills/` | Agent role definitions (implement, review, etc.) |
| `fritz/knowledge/` | Shared knowledge base (agents + orchestrator) |
| `.claude/orchestrator/SKILL.md` | Orchestrator identity/prompt (replaces hardcoded identity, with fallback) |
| `.claude/orchestrator/knowledge/` | Orchestrator-only knowledge files (copied after shared, can override) |
| `fritz-orchestrator/daemon/src/dashboard/dashboard.ts` | Dashboard route handler + SSE manager — serves SPA, provides real-time updates, operational controls (agent-log, issue-trail, agent stop, boot, autoloop toggle, usage, issues management with label whitelist, workflow oversight with pipeline funnel + attention panel, retro metrics via `getRetroMetrics()` (async, GitHub Contents API with local-filesystem fallback, single-flight coalescing, 120s cache TTL) + `parseRetroMetricsContent()` (extracted pure parser) + `/api/dashboard/retro` and `/api/dashboard/retro/scans` endpoints with `source` field). `SystemStatus` includes `usageAuthMode` and `usageMonitorRunning`; `subscription-usage` endpoint returns `authMode` and `monitorRunning` |
| `fritz-orchestrator/dashboard-ui.html` | Single-file SPA (HTML/CSS/JS) for the dashboard — workflow (pipeline funnel + attention panel with inline actions), agent cards, queue, issues management (grouped/flat view, inline status/priority/dependency management), history, usage |
| `fritz-orchestrator/nginx/nginx.conf` | nginx reverse proxy config template — TLS 1.3, LE wildcard cert, selective proxy for `/dashboard` and `/api/dashboard/*` only |
| `.claude/skills/retro/SKILL.md` | Retro agent — log-driven analysis, consumes archive API (`/api/archive`), creates improvement PRs per category |
| `fritz/knowledge/RETRO-METRICS.md` | Retro metrics history — tracks scan/analysis data over time (created on first retro run; may not exist yet) |
| `fritz/knowledge/OPERATIONS.md` | Data lifecycle & retention guide — documents all 11 cleanup/retention mechanisms with config, triggers, and key files |
| `fritz-orchestrator/docs/API.md` | HTTP API reference — all agent and dashboard endpoints with auth model and request/response schemas |
| `fritz-orchestrator/daemon/src/agents/feedback-manager.ts` | Chat-mode feedback (typing indicators, progress updates, timeout warnings, edit-in-place) |
| `fritz-orchestrator/daemon/src/agents/focus.ts` | Per-chat agent focus for Telegram message routing (chatId → agentName map) |
| `fritz-orchestrator/daemon/src/agents/priority-utils.ts` | Priority label parsing and issue sorting for autoloop (p0-p3 extraction) |
| `fritz-orchestrator/daemon/src/agents/version-utils.ts` | Claude Code version detection and tracking (parse + latest version query) |
| `fritz-orchestrator/daemon/src/core/event-log.ts` | Structured event log (append-only JSONL, 500-entry retention, SSE push) |
| `fritz-orchestrator/daemon/src/core/scheduler.ts` | Periodic task scheduler (hourly/daily/weekly GitHub issue creation, state persistence) |
| `fritz-orchestrator/daemon/src/telegram/telegram-buttons.ts` | Inline button factory (agent/role selection, confirmations, callback encoding, 64-byte limit) |
| `fritz-orchestrator/daemon/src/telegram/message-sanitizer.ts` | 6-stage Markdown v1 sanitization pipeline, message chunking, entity preservation |
| `fritz-orchestrator/daemon/src/telegram/message-formatter.ts` | Message formatting with rich metadata headers, 4096-char splitting |
| `fritz-orchestrator/daemon/src/telegram/message-tracker.ts` | Agent-to-message association for reply routing (1000-message LRU) |
| `fritz-orchestrator/daemon/src/telegram/notification-mode.ts` | Notification mode filtering (essential/quiet/compact/verbose event lists) |
| `fritz-orchestrator/daemon/src/agents/agent-comms.ts` | Agent communication (persistent NDJSON sessions, one-shot fallback, message queue, drain timer) |
| `fritz-orchestrator/daemon/src/github/github-write-queue.ts` | Token bucket write queue — rate-limits all GitHub mutation operations to prevent secondary rate limits |
<!-- AUTO:KEYFILES:END -->

## Dependencies
<!-- AUTO:DEPS:START -->
| Package | Purpose |
|---------|---------|
| `telegraf` | Telegram bot framework |
| `dotenv` | Environment variable loading |
| `tsx` | TypeScript execution for development |
| `typescript` | Type checking and compilation |
<!-- AUTO:DEPS:END -->

## Environment Setup
<!-- AUTO:ENV:START -->
Required environment variables:
- `TELEGRAM_BOT_TOKEN` - Bot token from @BotFather
- `TELEGRAM_CHAT_ID` - Target chat/group ID

Optional but recommended:
- `GH_TOKEN` - GitHub token for API access
- `GITHUB_REPO` - Default repository (owner/repo)
- `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` - Authentication

See `fritz-orchestrator/.env.example` for full list.

Telegram topic thread IDs are configured in `config/fritz.yaml` under the `telegram.topics` section (not in `.env`).
<!-- AUTO:ENV:END -->

---
_Last updated: 2026-02-27_
_Contributors: implement-107, implement-271, implement-338, implement-543_
