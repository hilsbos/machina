# machina HTTP API Reference

HTTP API reference for the machina daemon. See the [orchestrator hub](../README.md) for the big picture and [SECURITY.md](SECURITY.md) for the network posture.

## Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Endpoint index](#endpoint-index)
- [Agent endpoints](#agent-endpoints)
- [Dashboard endpoints](#dashboard-endpoints)

## Overview

The daemon runs an HTTP server on port 3456 (configurable via `API_PORT` in `.env`). Endpoints are split into two categories:

- **Agent API** (`/api/*`) — Used by agents and the orchestrator, requires per-agent/orchestrator token
- **Dashboard API** (`/api/dashboard/*`) — Used by the dashboard SPA, no auth required (protected by TLS and network isolation for remote access)

## Authentication

### Agent API
Agent endpoints require an `Authorization: Bearer <token>` header. Tokens are generated per-agent at boot and stored in the agent's environment as `FRITZ_API_TOKEN`. The orchestrator gets its own token (generated per daemon lifecycle).

`validateCallerToken()` in `api.ts` accepts both agent tokens and the orchestrator token.

### Dashboard API
Dashboard endpoints have no authentication on localhost.

> [!CAUTION]
> Remote access is protected by Let's Encrypt TLS plus Tailscale network isolation — there is **no** client-certificate / mutual-TLS auth. The nginx reverse proxy (`fritz-nginx`) forwards only `/dashboard` and `/api/dashboard/*`, returning 444 for every other path, so agent API endpoints are never exposed externally. The proxy is not published to the host.

## Endpoint index

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/notify` | Agent progress/completion notification |
| `POST` | `/api/ask` | Agent asks a question and blocks until answered |
| `GET` | `/api/archive` | List archived agents (filter + paginate) |
| `GET` | `/api/archive/:name/summary` | `summary.json` for an archived agent |
| `GET` | `/api/archive/:name/log` | `agent.log` for an archived agent |
| `GET` | `/dashboard` | Serve the dashboard single-page app |
| `GET` | `/api/dashboard/state` | Full state snapshot |
| `GET` | `/api/dashboard/workflow` | Pipeline funnel + attention panel |
| `GET` | `/api/dashboard/agents` | Active agents from registry |
| `GET` | `/api/dashboard/agent-log/:name` | Live log for a running agent |
| `GET` | `/api/dashboard/issue-trail/:issue` | Agent trail for one issue |
| `GET` | `/api/dashboard/history` | Paginated execution history |
| `GET` | `/api/dashboard/log/:name` | Archived log + summary metadata |
| `GET` | `/api/dashboard/session-log/:name` | Parsed JSONL session timeline |
| `GET` | `/api/dashboard/issues` | All open issues |
| `GET` | `/api/dashboard/issues/:number` | Single issue detail |
| `POST` | `/api/dashboard/issues/:number/label` | Add/remove whitelisted labels |
| `POST` | `/api/dashboard/issues/:number/comment` | Post an issue comment |
| `POST` | `/api/dashboard/agent/:name/stop` | Kill an active agent |
| `POST` | `/api/dashboard/boot` | Boot a new agent for an issue |
| `POST` | `/api/dashboard/autoloop/toggle` | Toggle autoloop pause/resume |
| `GET` | `/api/dashboard/usage` | Aggregate token usage |
| `GET` | `/api/dashboard/usage/breakdown` | Detailed usage breakdown |
| `GET` | `/api/dashboard/subscription-usage` | Real-time subscription utilization |
| `POST` | `/api/dashboard/subscription-usage/override` | Toggle usage override |
| `POST` | `/api/dashboard/subscription-usage/reload` | Restart the usage monitor |
| `GET` | `/api/dashboard/config` | Read `fritz.yaml` |
| `POST` | `/api/dashboard/config` | Save `fritz.yaml` |
| `POST` | `/api/dashboard/config/redeploy` | Trigger the deploy workflow |
| `POST` | `/api/dashboard/config/restart` | Restart the daemon container |
| `POST` | `/api/dashboard/config/commit` | Commit and push `fritz.yaml` |
| `GET` | `/api/dashboard/env-info` | Env/runtime config (masked) |
| `GET` | `/api/dashboard/event-log` | Recent structured events |
| `GET` | `/api/dashboard/daemon-log` | Daemon stdout tail |
| `GET` | `/api/dashboard/notification-mode` | Current Telegram notification mode |
| `POST` | `/api/dashboard/notification-mode` | Set Telegram notification mode |
| `GET` | `/api/dashboard/comment-level` | Current GitHub comment level |
| `POST` | `/api/dashboard/comment-level` | Set GitHub comment level |
| `GET` | `/api/dashboard/agents/max` | Current max parallel agents |
| `POST` | `/api/dashboard/agents/max` | Set max parallel agents (1–20) |
| `GET` | `/api/dashboard/retro` | Full retro metrics dataset |
| `GET` | `/api/dashboard/retro/scans` | Scan history only |
| `GET` | `/api/dashboard/events` | Server-Sent Events stream |

## Agent endpoints

### POST /api/notify

Agent progress/completion notification. The primary communication channel from agents to the daemon.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | Yes | Agent name |
| `type` | string | Yes | `progress`, `blocked`, `complete`, or `info` |
| `message` | string | Yes | Notification message |
| `outcome` | string | No | For `complete` type: `completed` (default) or `rejected` |

Triggers: Telegram notification, GitHub issue comment. Also records the agent's last-activity timestamp for display only.

> [!NOTE]
> The last-activity timestamp does not affect TTL. TTL is wall-clock from agent start and does not reset on activity (`registry.ts` `getExpiredAgents`).

### POST /api/ask

Agent asks a question and blocks until answered (or 5-minute timeout).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | Yes | Agent name |
| `question` | string | Yes | Question text |
| `options` | string[] | No | Multiple-choice options |

Returns the user's answer or times out with 408.

### GET /api/archive

List all archived agents. Supports filtering and pagination.

| Param | Type | Description |
|-------|------|-------------|
| `role` | string | Filter by agent role |
| `issue` | string | Filter by issue number |
| `since` | string | Filter archives since ISO date |
| `limit` | number | Max results (default: all) |
| `offset` | number | Skip N results (for pagination) |

### GET /api/archive/:name/summary

Get `summary.json` for a specific archived agent. Contains metadata, token usage, tool stats, duration, exit status.

Path parameter `:name` is validated against `^[a-z0-9][a-z0-9-]*$` to prevent path traversal.

### GET /api/archive/:name/log

Get `agent.log` for a specific archived agent.

| Param | Type | Description |
|-------|------|-------------|
| `lines` | number | Max lines to return (default: all) |

## Dashboard endpoints

### GET /dashboard

Serves the dashboard single-page application (`dashboard-ui.html`).

### GET /api/dashboard/state

Full state snapshot: active agents, autoloop queue, system status.

#### Write Queue Stats (in system.rateLimit.writeQueue)

| Field | Type | Description |
|-------|------|-------------|
| `totalProcessed` | number | Total operations processed since startup |
| `queueDepth` | number | Operations currently waiting in queue |
| `queueDepthByPriority` | object | Queue depth by priority (high/normal/low) |
| `tokensAvailable` | number | Available tokens in bucket (max 15) |
| `secondaryLimitActive` | boolean | Whether secondary rate limit circuit breaker is active |
| `secondaryLimitResetsAt` | string\|null | When the secondary limit backoff expires (ISO string, null if not active) |
| `backoffTier` | number | Current backoff tier (0-3) |
| `writesPerMinute` | number | Rolling 60s write rate |
| `totalDropped` | number | Total operations dropped (timeout or overflow) |

### GET /api/dashboard/workflow

Pipeline funnel (issue counts per pipeline stage) and attention panel (issues needing operator input, grouped by urgency tier).

### GET /api/dashboard/agents

Active agents from registry (subset of state).

### GET /api/dashboard/agent-log/:name

Live execution log for an active (running) agent.

| Param | Type | Description |
|-------|------|-------------|
| `lines` | number | Max lines to return |

### GET /api/dashboard/issue-trail/:issue

Agent execution trail for a specific issue — combines active and archived agents for a full history of all agents that worked on the issue.

### GET /api/dashboard/history

Paginated agent execution history from log archives.

| Param | Type | Description |
|-------|------|-------------|
| `role` | string | Filter by role |
| `issue` | string | Filter by issue number |
| `limit` | number | Max results |
| `offset` | number | Pagination offset |

### GET /api/dashboard/log/:name

Archived agent log with summary metadata.

| Param | Type | Description |
|-------|------|-------------|
| `lines` | number | Max log lines |

### GET /api/dashboard/session-log/:name

Parsed Claude Code JSONL session timeline for an agent. JSONL-only — never falls back to `agent.log` (use `GET /api/dashboard/log/:name` for that). When no timeline is available (old archives that pre-date issue #926, or live agents with no JSONL yet), returns `200 { log: '' }` rather than 404 — the frontend hides the panel on empty content. Supports `?full=1` for untruncated output.

### GET /api/dashboard/issues

All open issues with labels, status, priority, and dependency data.

### GET /api/dashboard/issues/:number

Single issue detail (number, title, state, labels, updatedAt).

### POST /api/dashboard/issues/:number/label

Add or remove labels on an issue. Label changes are restricted to a whitelist: `fritz.status:*`, `priority:p*`, `fritz.depends-on:*`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | Yes | `add` or `remove` |
| `label` | string | Yes | Label name (must match whitelist) |

### POST /api/dashboard/issues/:number/comment

Post a comment on an issue (used for feedback/rework instructions).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `body` | string | Yes | Comment body (Markdown) |

### POST /api/dashboard/agent/:name/stop

Kill an active agent.

### POST /api/dashboard/boot

Boot a new agent for a queued issue.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issue` | number | Yes | Issue number |
| `role` | string | Yes | Agent role |
| `force` | boolean | No | Bypass parallel agent limit (manual boots only) |

When `force: true` is used and the parallel limit is reached, the response includes a `warning` field.

<details>
<summary>Force-boot response body</summary>

```json
{
  "ok": true,
  "warning": "⚠️ Force-boot: bypassing parallel limit (currently N/N)"
}
```

</details>

### POST /api/dashboard/autoloop/toggle

Toggle autoloop pause/resume state. Operates on the manual pause file (independent from usage-pause).

### GET /api/dashboard/usage

Aggregate token usage stats (today and past 7 days) from log archives.

### GET /api/dashboard/usage/breakdown

Detailed usage breakdown by role, issue, and day.

| Param | Type | Description |
|-------|------|-------------|
| `since` | string | Filter since ISO date |

### GET /api/dashboard/subscription-usage

Real-time Anthropic subscription utilization from the OAuth API. Includes pause state, override state, auth mode, and monitor running status.

### POST /api/dashboard/subscription-usage/override

Toggle usage override (bypass pause limits).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | Yes | Enable or disable override |

### POST /api/dashboard/subscription-usage/reload

Restart the usage monitor to pick up a refreshed authentication token.

### GET /api/dashboard/config

Read `fritz.yaml` as both structured data and raw YAML text.

### POST /api/dashboard/config

Save `fritz.yaml` (creates backup first). Validates YAML structure and syntax before writing.

### POST /api/dashboard/config/redeploy

Trigger the deploy GitHub Actions workflow (`build-and-deploy.yml`, configurable via `daemon.deployWorkflow` in `fritz.yaml`).

### POST /api/dashboard/config/restart

Restart daemon container (via `process.exit`).

### POST /api/dashboard/config/commit

Commit and push `fritz.yaml` changes to git.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | No | Custom commit message |

### GET /api/dashboard/env-info

Read-only environment/runtime config with sensitive values masked.

### GET /api/dashboard/event-log

Recent structured events from the event log.

| Param | Type | Description |
|-------|------|-------------|
| `limit` | number | Max entries to return |

### GET /api/dashboard/daemon-log

Last N lines of daemon stdout log file.

| Param | Type | Description |
|-------|------|-------------|
| `lines` | number | Number of lines |

### GET /api/dashboard/notification-mode

Current Telegram notification mode.

### POST /api/dashboard/notification-mode

Set Telegram notification mode.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | string | Yes | `essential`, `quiet`, `compact`, or `verbose` |

### GET /api/dashboard/comment-level

Current GitHub comment level.

### POST /api/dashboard/comment-level

Set GitHub comment level.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `level` | string | Yes | `essential`, `quiet`, or `verbose` |

### GET /api/dashboard/agents/max

Current max parallel agents count and active agent count.

**Response:** `{ max: number, active: number }`

### POST /api/dashboard/agents/max

Set the maximum number of parallel agent containers at runtime. Takes effect immediately (no restart required) and persists to `fritz.yaml`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `max` | integer | Yes | New max agent count (1–20) |

**Response:** `{ ok: boolean, max: number, active: number, persisted: boolean }`

### GET /api/dashboard/retro

Full retro metrics dataset parsed from `RETRO-METRICS.md` (fetched from GitHub Contents API with local-filesystem fallback, 120s cache, single-flight coalescing). Response includes `source` field: `'github'`, `'local'`, or `'cache'`.

### GET /api/dashboard/retro/scans

Scan history only — lighter payload than `/retro`.

### GET /api/dashboard/events

Server-Sent Events (SSE) stream for real-time updates. Event types: `agent-started`, `agent-update`, `agent-stopped`, `queue-update`, `issues-update`, `usage-update`, `system-update`, `heartbeat`.

---

_See also: [ARCHITECTURE.md](../../fritz/knowledge/ARCHITECTURE.md) for component design and [SECURITY.md](SECURITY.md) for security model details._

_Last updated: 2026-02-27_
