# Workflow-Run Observability — Surfacing In-Container Workflow Runs to the Web Dashboard

> **fritZ v2 (Janus) keeps ONE Docker substrate and adds a SECOND in-container entrypoint** — a workflow program that fans out N in-process subagents in the same container, synthesizes, and reports — selected by the `fritz.engine` label at the `startAgent` seam. No second engine, no host execution. Near-term review is our own in-container judge-panel; cloud ultrareview is a deferred, optional, off-box escalation.

> **Design set:** fritZ v2 "Janus" — design doc 08, the observability companion to docs 01–07.
> **Audience:** the owner + implementers.
> **Scope:** how the operator *sees* a workflow-entrypoint run — its phases, its subagent fan-out, per-subagent status/tokens, and per-subagent logs — live, on the existing remote web dashboard, with no local TUI. This is a telemetry-and-UI design, not a routing one; the seam mechanics (`startAgent` router, `claimIssue`/`releaseAgent` contract) are described in docs 04–06 and referenced here only where the run-tree anchors to them.
> **Non-goals:** no source code; ASCII diagrams and pseudo-structure only. No changes to the closed Workflow harness. No new transport, broker, or WebSocket in the MVP.

---

## 0. Why this doc exists

Docs 02–05 establish that the workflow entrypoint fans out **N in-process subagents inside ONE container**, synthesizes, and reports. Doc 06 establishes that v2 ships always-on and **remote** — a Docker stack on a Linux VM (`docker-compose.prod.yml`), reached only through an nginx sidecar over Tailscale + Let's Encrypt, with the daemon's dashboard/API/SSE on internal port `:3456`. Those two facts collide here.

Today's dashboard gives **excellent single-agent visibility**: a live card per agent, a 5s-polled live log, a parsed session timeline, durable archives, all over one SSE rail behind the mTLS/Tailscale proxy. But that visibility model is **flat**. The registry and the live `DashboardAgent` shape carry `name`/`role`/`issue` and a single free-text `lastActivity` string — **no `runId`, no parent/child, no per-subagent identity**. `subagentCount` is a *scalar* — computed (live, at completion, in `agents.ts`, and again post-mortem at archive time in `log-archive.ts`) by *counting* subagent JSONL files, not by attributing anything per-child.

So when the workflow entrypoint fans out, the operator loses exactly the visibility the single-agent dashboard gives them:

- A fan-out **collapses to one agent card** whose `lastActivity` is one overwriting string.
- They **cannot see phases**, the **subagent fan-out tree**, **per-subagent status or tokens**, or **drill into a child's logs while the run is live**.
- Locally this is what the Claude Code `/workflows` TUI is for — **but there is no TUI in the headless/remote/in-container deployment.**

The job of this doc: **capture the harness's JSONL artifacts (and, if it exists, a run journal) from inside the container and project them as a live, nested RUN TREE on the existing dashboard** — reusing fritZ's SSE / event-log / log-archive / registry rails and inventing only the two genuinely missing pieces: **(1) a nested run-tree representation with real per-subagent attribution** and **(2) the in-container telemetry capture seam**. The registry stays flat; the run *anchors* to the existing agent card.

```
TODAY (single agent)                  v2 WORKFLOW RUN (what the operator can't see)
┌───────────────────────────┐         ┌───────────────────────────────────────────┐
│ agent: security-review-42 │         │ agent: security-review-42                   │
│ role: security-review     │         │   ▼ Workflow: ~2 phases?, 3 subagents       │
│ lastActivity: "scanning…" │   -->   │     Phase 1: recon       [done]             │
│ (one card, one string)    │         │       ├─ appsec-shard    [done]  12.4k tok  │
└───────────────────────────┘         │       └─ infrasec-shard  [done]   9.1k tok  │
                                       │     Phase 2: synthesize  [running]          │
                                       │       └─ synthesizer     [running] 3.2k tok │
                                       └───────────────────────────────────────────┘
        (phase grouping is INFERRED/assumed — see §1.4, §3.1, §6 Q2; the
         fan-out tree + per-subagent tokens are the firm, JSONL-grounded part)
```

---

## 1. How fritZ surfaces agent progress TODAY (grounded in source)

A single agent's live progress reaches the dashboard through **three parallel channels that all converge on one SSE stream**. This is the rail we reuse; understanding it is the whole design.

### 1.1 The live rail = one long-lived SSE connection

The browser opens **one** `EventSource('/api/dashboard/events')` (`dashboard-ui.html`, `connect()`). Server side, `handleSSE()` (`dashboard.ts`):

1. Immediately writes the headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, **`X-Accel-Buffering: no`** (the proxy-buffering defeat).
2. Pushes one **`state`** event = the full `getFullState()` snapshot (`{agents, history, system, timestamp}`).
3. If the client passed `?since=<seq>`, **replays** missed `event-log-entry` events via `getEventsSince(seq)` from the 200-entry ring buffer — *before* registering the client, so there is no gap between replay and live.
4. Only then adds `res` to the module-level `Set<ServerResponse> sseClients`.
5. Deletes the client on `req 'close'`.

There is **no per-client filtering** — every event is a fire-hose broadcast to all clients via `broadcastSSE(event, data)`, which loops `sseClients` writing the wire frame `event: <name>\ndata: <JSON>\n\n` (`sendSSE`). The **exported `notifyClients(event, data)`** wraps `broadcastSSE` so any module can push a new event type with zero transport changes. **This is the explicit reuse seam.** Note: every existing event ships the **full** object (e.g. `agent-update` ships the entire `toAgent(agent)`); there is **no JSON-Patch / delta wire format anywhere in the codebase today** (load-bearing for §3.2 / fix-in §8).

The live event taxonomy (`dashboard.ts` `init()` subscriptions):

```
state          (snapshot, once per connect)   <- getFullState()
agent-started  full DashboardAgent            <- registry.onAgentChange 'registered'
agent-update   full DashboardAgent            <- registry.onAgentChange 'updated'
agent-stopped  full HistoryEntry              <- registry.onAgentChange 'deregistered'
heartbeat      SystemStatus (every 30s)
usage-update   SystemStatus                   <- usageMonitor.onUsageChange
system-update  SystemStatus                   <- agents/max POST
issues-update  {type:'label-change', …}       (a hint; SPA re-fetches)
event-log-entry EventLogEntry {seq,ts,type,msg,meta?}  <- onEventLogEntry
pipeline.agent-deferred   (SPA listens by RAW type name — the precedent we copy)
```

The SPA dispatches by raw event name and **patches the DOM in place** (`updateAgentsInPlace()`, `buildCard()`), never rebuilding the grid. Reconnect is solved: `onerror` with `readyState CLOSED` → `scheduleSSEReconnect()` with exponential backoff `2s→4s→8s→16s→30s`; `onopen` resets it.

### 1.2 The three channels feeding that rail

**(a) Push status: `report.sh` → `/api/notify` → registry → SSE.** Each container runs a generated `.fritz/report.sh` (built inline in `boot.ts`, written to `<workspace>/.fritz/report.sh`, chmod 755). For `progress|blocked|complete|summary` it POSTs `{agent,type,message,outcome}` to `/api/notify` with `Authorization: Bearer ${FRITZ_API_TOKEN}` (the per-agent token injected at boot, `agents.ts`, stored as `apiToken` on the registry entry). `handleNotify` (`api.ts`) validates the token against `registry.listAgents()`, then `touchAgent` (TTL reset) + `lifecycle.issueComment`, and calls `registry.updateActivity(name, message)` → sets `lastActivity`/`lastActivityAt`, persists (debounced 1s), fires `notifyChange(agent,'updated')` → `agent-update` SSE. **A progress update is a single free-text string overwriting `lastActivity`. There is no structured per-step progress.**

**(b) registry change → SSE.** `registry.onAgentChange(onRegistryChange)` maps `registered/updated/deregistered` → `agent-started`/`agent-update`/`agent-stopped`. `toAgent()` builds the live `DashboardAgent` (`name, role, issue, issueUrl, repo, branch, started, ttl, elapsed, remaining, lastActivity, lastActivityAt, model, claudeCodeVersion, autoPipeline`). **The live shape has NO token/turn/subagent fields** — those exist only on the post-mortem `HistoryEntry`.

**(c) Structured event log → SSE.** `event-log.ts` is an append-only JSONL at `{workspacesDir}/logs/events.jsonl`, monotonically sequenced, capped 500 entries (`MAX_ENTRIES=500`), 200-entry in-memory ring (`EVENT_BUFFER_SIZE=200`) for replay. `logEvent()` appends + notifies `onEventLogEntry` → `broadcastSSE('event-log-entry', entry)`. Events are **coarse lifecycle one-liners** (`agent.started`, `agent.stopped`, `pr.merged`, `pipeline.agent-deferred`), not fine-grained progress — but they are **durable and replay-safe via `?since`**.

### 1.3 Live logs are POLLED, not streamed

When an active card is expanded, `buildActiveExpandedContent()` starts a 5s `setInterval` in `autoRefreshTimers[name]` that calls `loadAgentLiveLog(name)` → `GET /api/dashboard/agent-log/:name?lines=80` (server tails `agent.log`). The SPA **diffs against `agentLogCache[name]`**, updates the `<pre>` only on change, and auto-scrolls if the user was at the bottom. The timer is torn down on collapse and on `agent-stopped`. Archived agents use `GET /api/dashboard/log/:name` (raw tail) + `GET /api/dashboard/session-log/:name` (parsed JSONL timeline). All three name-bearing endpoints validate `:name` against `AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/` for path-traversal prevention (`dashboard.ts`).

### 1.4 Where the subagent data half-exists — and where it does NOT

`session-parser.ts` `parseAgentSession(workspace)` reads Claude Code session JSONL under `<workspace>/.claude/projects/-workspace/<session-id>/*.jsonl` **plus `subagents/agent-*.jsonl`**. Concretely:

- `findJsonlFiles()` **recursively lumps** the parent session JSONL **and every `subagents/agent-*.jsonl` into ONE flat list**.
- `parseJsonlFile()` parses each into **one merged, summed total**: `input/cacheRead/cacheCreation/output` tokens (deduped per message `id`), turns, tool-use entries. **Subagent tokens are summed straight into the parent totals.**
- `countSubagents()` (`f.includes('/subagents/')`) yields a **single scalar** count.

So the parser **reads** subagent files but **collapses them into aggregate totals plus a count.** There is **NO per-subagent identity, NO per-subagent token attribution, NO per-subagent enumeration**, and **NO pairing of `tool_use` with `tool_result` by `tool_use_id`** (it dedupes `tool_use` by `id`/message-id but never pairs a result). **Per-subagent attribution and tool_use/result pairing must be BUILT — they do not exist today.** This is the doc's central capture claim: the file-*reading* plumbing is reusable; the per-child *projection* is new work.

On exit, `archiveAgentLogs()` (`log-archive.ts`) writes `summary.json` (turns, tokens, **subagentCount**, toolUsage, exit info) under `logs/archive/{name}/`, which **survives workspace cleanup** and feeds `/history`, `/log/:name`, `/session-log/:name`, `/issue-trail/:issue`.

### 1.5 Remote/mTLS access today

The daemon serves on `:3456` (no auth on localhost). nginx (`nginx/nginx.conf`) is the only ingress. **Doc/impl drift, called out explicitly:** the *docs* (`DEPLOYMENT.md`, `DASHBOARD.md`) describe an **mTLS** model (port 8443, `mtls-init` container, `client.p12`, `X-SSL-Client-CN`); the *live* `docker-compose.prod.yml` + `nginx.conf` implement a **newer Tailscale + Let's Encrypt** model (nginx `ports: []`, reached via external `edge-router` on Tailscale, TLS 1.3 on 443, `config/mtls/` does not exist). **Either path proxies the new events identically** — this design is agnostic to which is wired. Both already SSE-tune the proxy: `proxy_http_version 1.1`, `proxy_buffering off`, `proxy_read_timeout 86400s`, and proxy exactly `/dashboard`, `/api/dashboard/` (incl. the SSE stream), returning `444` elsewhere.

```
in-container                 HOST                          remote operator
┌──────────────┐  bind mount ┌──────────────────┐  :3456  ┌─────────────┐ 443/TLS ┌─────────┐
│ claude (CLI) │ ──────────► │ daemon            │ ◄────── │ nginx       │ ◄────── │ browser │
│ writes JSONL │ /workspace  │  SSE + event-log  │  proxy  │ (TS + LE)   │  SSE    │ EventSrc│
│ report.sh ───┼─POST /notify│  registry/parser  │         │ buffering   │         │         │
└──────────────┘  (Bearer)   └──────────────────┘         │ off, 86400s │         └─────────┘
                                                           └─────────────┘
```

---

## 2. How others solve it (and what's worth stealing)

Two adjacent fields have already solved most of this. The patterns below are the load-bearing ones; full source list in §9. **Sourcing note:** the engine/platform behaviors in the tables below are summarized from each project's public docs/issue trackers (linked in §9 where a row is load-bearing) and from general training knowledge of these tools; treat any unlinked row as *training-knowledge, verify before relying on it*. They inform direction, not implementation.

### 2.1 Durable-workflow / orchestration UIs

| Engine | Run model | Live transport | Nested runs |
|--------|-----------|----------------|-------------|
| **Temporal** Web UI | Event History (append-only log) → Timeline/Compact views | **Polling** for the run view; app-facing live = Queries / external pub-sub *(training-knowledge)* | Relationships **tree** (parent/child) |
| **Prefect** 3.x | flow-run/task-run states; events underlie the UI | **App WebSocket** (UI + events sockets; logs over a WS endpoint) *(training-knowledge)* | subflows = child flow-run **tree** |
| **Dagster** | asset graph + run views from the instance event log | **GraphQL subscriptions over WebSocket** (Apollo) *(training-knowledge)* | nested in graph |
| **Airflow** 3.x | Grid (tasks × runs) + Graph + Gantt | **Polling**, gated: `refetchInterval = hasActiveRun ? interval : false` *(training-knowledge)* | task groups = expandable nodes |
| **Windmill** | flow DAG + per-step status + 0-100 progress | **SSE per job** streaming `new_logs`/`progress`/`flow_status` (see §9 issue) | `flow_status` raw JSON tree |
| **Inngest** | auto-traced **waterfall** of execution bars | trace post-hoc; **Realtime** = channel/topic pub-sub over WebSocket *(training-knowledge)* | child fns = nested spans |
| **Hatchet** | DAG dashboard, real-time status | dashboard **polls** (gated by terminal state); streaming = separate `subscribe_to_stream`, recommend proxy → SSE (see §9) | child workflows |

**Patterns worth stealing:**

- **Event-log-as-source-of-truth.** Nearly every engine rebuilds its run view from an append-only event/history log; "live" is a thin replay layer on top. → fritZ already has this rail (`event-log.ts` + `?since`).
- **Polling gated by activity state** is the *simplest* dominant pattern (`isRunning ? interval : false`). → exactly fritZ's 5s log poll (torn down on stop). **This is also the strongest argument for NOT adding a second capture mechanism** — see §3.1 on poll-reuse vs. a new watcher.
- **SSE for one-run detail, deltas + cursor.** Windmill returns logs *since last update*, not full snapshots. → send deltas, keep a cursor — but only *after* the simple full-object MVP works (§3.2).
- **Backend-as-proxy for engine streams** (Hatchet): never expose the engine's internal stream to the browser; tail in the daemon, re-emit over SSE. → exactly our in-container → daemon → browser seam.
- **Two-tier model:** the durable run-history view is separate from the opt-in "stream progress to MY UI" primitive. → keep coarse phase boundaries on the durable event-log; keep fine token-ticks on SSE-only.

### 2.2 LLM-agent observability platforms

| Platform | Data model | Fan-out rendering | Ingestion |
|----------|------------|-------------------|-----------|
| **OTel GenAI semconv** | `invoke_workflow` (coordinated multi-agent op) wrapping N `invoke_agent` children; linked by `parent_span_id` in a `trace_id` (see §9) | — (the substrate) | — |
| **OpenInference / Phoenix** | trace = tree of spans (AGENT/TOOL/LLM…); AGENT spawns child spans | **tree/waterfall + inferred Agent Graph** *(training-knowledge)* | OTLP, post-hoc + fast refresh |
| **LangSmith** | run-tree (root run + child runs) | trace tree + flattened Messages view *(training-knowledge)* | async, near-real-time |
| **Langfuse** | Sessions > Traces > Observations (`parentObservationId`) | **nested tree + Agent Graphs + Log View** (see §9) | async batched |
| **AgentOps** | session trace (LLM/tool/action) | **Session Waterfall + Session Replay** *(training-knowledge)* | post-hoc |
| **AutoGen Studio** | event-driven message model | **LIVE streamed control-flow graph + token usage** *(training-knowledge)* | WebSocket, true-live |
| **AG-UI** (CopilotKit) | `RUN_STARTED/FINISHED`, `TOOL_CALL_*`, **`STATE_SNAPSHOT` + `STATE_DELTA` (JSON-Patch)** (see §9) | — | **SSE** |

**Patterns worth stealing:**

- **The OTel/OpenInference trace tree** is the canonical model: root span = run, children linked by `parentId` in one `trace_id`, with an explicit `invoke_workflow` parent wrapping N `invoke_agent` children. The GenAI semconv describes `invoke_workflow` as "a coordinated process composed of multiple agents" (see §9) — that *is* the workflow entrypoint. → adopt the run-as-tree-of-spans model conceptually (each node = id + parentId + start/end + status + tokens), even though we project it from JSONL rather than emit real OTLP.
- **Two-view UI:** a vertical nested **tree/waterfall** PLUS a derived **node-graph**, both from the *same* span data. → tree is MVP; node-graph is a stretch toggle. Maps cleanly onto fritZ's existing **Session Log (linear) + Agent Log (per-subagent)** split.
- **`STATE_SNAPSHOT` + `STATE_DELTA` (JSON-Patch)** wire model: full tree once on connect, targeted patches thereafter. → a worthwhile *fast-follow* once token-tick volume justifies it; **the MVP ships full objects to match fritZ's existing `agent-update` pattern** (§3.2).
- **Status must be INFERRED, not read** (claudectl): permission-prompts and waiting states are invisible in the transcript; use a precedence ladder.
- **Live-streaming is the exception** (AutoGen Studio); backend platforms favor async-write + fast post-hoc render. → our default is passive tailing; live boundaries are an accelerator.

### 2.3 The closest precedent: Claude Code session-monitors

The strongest reference is the existing ecosystem that **parses the same family of artifacts** — `~/.claude` JSONL transcripts + `subagents/agent-<id>.jsonl` (today produced by the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` flag fritZ already sets at `agents.ts`; see §3.1 / §6 Q on whether the *workflow entrypoint* emits the identical layout):

- **hoangsonww / Claude-Code-Agent-Monitor** — dual capture: native hooks (push) **plus** JSONL backfill. On each `SubagentStop` it parses each `subagents/agent-*.jsonl` and **pairs `tool_use` with `tool_result` by `tool_use_id`**, re-emitting activity under the subagent's own id. *This `tool_use`/`tool_result` pairing is the NEW capture work fritZ must build — it is **not** present in `session-parser.ts` today (§1.4).* (See §9.)
- **patoles / agent-flow** — HTTP hook relay → **SSE node-graph** of the fan-out tree; tails Codex `rollout-*.jsonl` through the *same* pipeline, demonstrating the dual-capture (hooks OR jsonl-tail) model. (See §9.)
- **claudectl** — byte-offset incremental tail: persist a per-session offset, seek to it, read only appended lines, reset on truncation (`offset > file_len`); infer status from a precedence ladder (permission prompts are invisible). (See §9.)

**The single load-bearing gotcha (reported across these monitors — training-knowledge corroborated by the linked projects):** *subagent tool calls do NOT fire parent hooks.* Hooks can only mark phase/spawn/stop boundaries — **the tree, per-subagent tokens (`message.usage`), and tool activity MUST come from parsing `subagents/agent-<id>.jsonl`.** Hooks are an accelerator; **the JSONL tail is authoritative.** The entire "hooks are an accelerator, JSONL is authoritative" thesis rests on this claim; if a future Workflow harness *does* fire parent hooks for subagent tools, the design still works (hooks just become more useful) — but we do not assume it.

---

## 3. Recommended design

The shape, end to end:

```
CONTAINER (workflow entrypoint)            HOST (daemon)                      BROWSER (SPA)
──────────────────────────────             ─────────────────────             ──────────────
claude writes:                             poll-gated parse (or watcher)     EventSource
  .claude/projects/.../*.jsonl  ──bind──►  on .workspaces/<name>/.claude/     /api/dashboard/events
  .../subagents/agent-<id>.jsonl  mount     **/subagents/agent-*.jsonl
  run journal? (ASSUMED — §6 Q2)           + run journal IF it exists         on 'state':       full
                                              │                                 workflowRuns[]
                                              ▼  byte-offset tail               on 'workflow-run-
report.sh phase-start  ──POST /notify──►  NEW run-tree builder                   started': append
  (OPTIONAL, accelerator)  (Bearer)         (read subagent files,             on '…-update': patch
                                             attribute PER child, infer         the run in place
                                             status, pair tool_use/result —    on '…-stopped': freeze
                                             ALL new), sum tokens               + unshift history
                                              │
                                              ▼
                                           notifyClients('workflow-run-…')  ──► drill-down: reuse
                                           logEvent('workflow.phase.…')          5s log poll on
                                           summary.json runTree (on exit)        /run/:id/subagent/:sid/log

   Firm inputs:  subagents/agent-*.jsonl (proven to exist via agent-teams today)
   ASSUMED:      run journal path/schema + explicit phase structure (§6 Q2)
                 + that the workflow entrypoint emits the SAME subagents/ layout
```

### 3.1 Telemetry source — two-tier capture

This mirrors the dual-capture consensus of the Claude Code monitor ecosystem (§2.3, training-knowledge corroborated by the linked monitors).

**SOURCE OF TRUTH — JSONL-tail (no harness changes).** The container already bind-mounts the workspace `${hostWorkspacePath}:/workspace` (`agents.ts`). So everything the Workflow harness writes — the per-subagent transcripts at `/workspace/.claude/projects/-workspace/<session>/subagents/agent-<id>.jsonl`, the parent session JSONL, **and a run journal IF one is written** — **lands on the HOST** under `.workspaces/<agent-name>/`, directly readable by the daemon with **zero new volume plumbing**. *The mount is the in-container → host seam the task asks for; it already exists.* (This is the Kubernetes sidecar-on-a-shared-volume idea, but the daemon already shares the volume, so no sidecar is needed.)

> **Two grounded caveats on the artifacts (do not skip):**
>
> 1. **The `subagents/agent-<id>.jsonl` layout is, today, the agent-teams artifact.** fritZ produces those files only because it sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (`agents.ts`). That the **v2 workflow entrypoint** emits the *identical* `subagents/agent-<id>.jsonl` path/schema is an **assumption to verify**, not an established fact (the README even notes the literal Workflow path may differ and may fall back to agent-teams). Build the parser tolerant of a path/shape difference and confirm against a real workflow run before relying on it.
> 2. **The "run journal" is an ASSUMPTION, not a known harness output.** "Run journal" appears in *fritZ's own design docs 03/04/05* as a **durable-resume design concept** on a mounted volume — it is **not** an established Claude Code Workflow artifact, and **nothing in the codebase or any cited source proves the harness writes a journal with explicit phase structure** we can read. Every phase-from-journal claim in this doc is therefore **provisional** (see §6 Q2). The firm, JSONL-grounded part of the design is the *fan-out tree + per-subagent tokens*; **phases may have to be inferred** if no journal materializes.

**LOW-LATENCY PUSH — boundaries (optional, additive).** Extend the per-agent `.fritz/report.sh` (generated in `boot.ts`) with workflow verbs — `report.sh phase-start <name>`, `phase-end`, `subagent-spawned <id> <role>`, `subagent-done <id>` — and/or register a Workflow lifecycle hook that POSTs the same shape. These reach the **existing** `POST /api/notify` (per-agent Bearer token), the same auth+relay path single agents already use, giving zero-latency phase/spawn/stop boundaries. **But (the gotcha): hooks can only mark boundaries; the tree, tokens, and tool activity still come from the JSONL tail.**

**Who parses — and what is genuinely new.** Extend `session-parser.ts` — which today **reads** `subagents/` files but **collapses them into aggregate totals + a scalar count** (§1.4) — into a **run-tree builder.** The reused part is the file discovery + line parsing + token-summing plumbing. The **NEW** part (does not exist today) is: per-subagent identity, **per-subagent token attribution**, **`tool_use`↔`tool_result` pairing by `tool_use_id`**, and **persisted per-file byte offsets** (claudectl pattern: seek to last offset, read only appended lines, reset when `offset > file_len`). Handle the documented **orphan-agent race** (a subagent file can appear *before* the parent's spawning `tool_use`) with **phased linking**: `toolUseResult` match → team/description match → positional fallback.

**Capture mechanism — prefer reusing the existing poll; justify any watcher.** fritZ's established live-progress mechanism is the **5s activity-gated poll** (`autoRefreshTimers`), which §2.1 itself names the simplest dominant pattern and which we reuse verbatim for drill-down. **The MVP should first try driving the run-tree parse off that same gated cadence** (parse only for *active* agents, re-using the existing tail rhythm) rather than introducing a *second*, different capture subsystem. A daemon-side **chokidar file-watcher** on `…/subagents/agent-*.jsonl` (+ a run journal if it exists) is an option **only if** poll-reuse proves insufficient (e.g. boundary latency unacceptable) — and if added, it must come with explicit teardown (see §3.6 / §5). Either way the byte-offset tail logic is identical; the open choice is *what triggers a re-parse*.

### 3.2 Transport — reuse the existing SSE rail verbatim

No new transport, no broker, no WebSocket. SSE is the right default for server→browser-only feeds and already survives the proxy.

**Container → daemon:** (a) artifacts flow passively over the existing bind mount; (b) optional boundaries flow over the existing `POST /api/notify`. **No new ingress.**

**Daemon → browser:** the parser calls the **existing exported `notifyClients(event, data)`** → `broadcastSSE` to push a **new event family** on the **same single** `GET /api/dashboard/events` the SPA already opens:

```
workflow-run-started  -> RunNode  (root, status=running, phases=[])
workflow-run-update   -> the UPDATED RunNode (full object) in the MVP
                          (matches the existing agent-update pattern: ship the whole node,
                          SPA patches the DOM in place)
workflow-run-stopped  -> final RunSummary
```

**On full-object vs. JSON-Patch (deliberate MVP choice):** every existing fritZ SSE event ships the *full* object and the SPA patches the DOM in place; **there is no JSON-Patch precedent in the codebase.** So the MVP sends the **full `RunNode` on update**, exactly like `agent-update`. A `STATE_DELTA`-style targeted `{runId, op, path, value}` patch (AG-UI snapshot+delta model, §2.2) is the **throttling fast-follow** — introduce it only when token-tick volume on a wide fan-out actually justifies the new wire machinery, not before. Adding JSON-Patch in the MVP would contradict "reuse the rail verbatim."

Durable, replay-safe **phase boundaries** also ride the existing event-log:
`logEvent('workflow.phase.started', msg, {runId, phaseId})` → fans out as `event-log-entry` and **replays on reconnect via `?since=<seq>`** (the `pipeline.agent-deferred` precedent — the SPA already dispatches by raw type). The 5s live-log poll pattern (`autoRefreshTimers` + `agentLogCache` diff + auto-scroll) is **reused unchanged** for per-subagent drill-down via a new `GET /api/dashboard/run/:id/subagent/:sid/log`.

### 3.3 Data model — a nested RUN TREE projected from the JSONL

This is the OTel/OpenInference trace-tree model: root span = run, children linked by parent id. `RunNode` is **the one genuinely missing first-class concept**.

```
RunNode                       <- the new concept; anchors to the existing flat agent card
  runId            stable (derive from Workflow session id / journal id — see §6 Q3)
  parentAgentName  the container's registry name (so it ALSO shows as a normal card)
  issue / issueUrl
  status           pending | running | completed | failed | stopped
  startedAt / endedAt / model
  phases: PhaseNode[]                <- ASSUMED from a run journal OR a phase-start hook;
                                        if neither exists, INFERRED or a single implicit
                                        phase (§6 Q2). NOT guaranteed readable.
    phaseId, name, status, startedAt/endedAt, order
    subagents: SubagentNode[]        <- children of a phase (FIRM: from subagents/*.jsonl)
      sid              = agent-<id> file id
      role/description
      status           running | idle/waiting | done | error   (INFERRED, see ladder)
      startedAt/endedAt
      tokens           {input, cacheRead, cacheCreation, output}  (message.usage) — NEW per-child
      turns
      toolCalls        (paired by tool_use_id — NEW; not in session-parser today)
      logRef           path to its agent-<id>.jsonl
```

The **firm, JSONL-grounded** part is the subagent layer: identity, per-child tokens, turns, tool calls. The **phase layer is the soft part** — it depends on a run journal or a phase hook that we have **not confirmed exists** (§6 Q2). The MVP is consistent about this: §4 ships **a single implicit phase** and treats phase grouping as optional, and the §0 diagram marks phase grouping as inferred/assumed. Do not draw a clean phase tree as if it were guaranteed.

Each node is modeled as a **span** (id + parentId + start/end + status + tokens) so the UI can render **both** a tree/waterfall **and** an inferred node-graph from the same data (the Phoenix/Langfuse two-view pattern).

**Status is INFERRED, not read** — the claudectl ladder, adapted for a headless container (no CPU heuristic):
```
1. explicit hook/heartbeat signal  (if low-latency push is wired)   -> highest
2. message.stop_reason + age       (end_turn + old -> idle/done)
3. stale tool_use with no result   -> likely waiting (permission prompt — invisible in JSONL)
4. recent appended lines           -> running
```

**State integration.** `DashboardState` gains a top-level `workflowRuns: RunNode[]`, so runs appear **on first paint and on every reconnect** with zero new transport.

**Persistence.** Extend `log-archive.ts` `summary.json` with a **`runTree` block** (phases + child sids + per-child tokens) alongside the existing `subagentCount`, written on exit — so the tree **survives the 24h workspace cleanup** and stays queryable indefinitely (`logArchiveMaxAgeDays=0` in prod). A new `GET /api/dashboard/run/:id` **lazily hydrates** one run's full tree (active from the live parser, archived from `summary.json`) — the agent-log / issue-trail hydration pattern.

### 3.4 The dashboard UI

A new collapsible **run-tree / waterfall card** in the existing SPA (`dashboard-ui.html`), rendered as a projection of `workflowRuns` — no framework, same `buildCard`/`updateAgentsInPlace` idiom.

- The container's **existing** agent card gets a badge **"Workflow: 5 subagents"** (and a phase count *only when phases are actually known*) and an expander. Expanded → a vertical nested tree `Run > [Phase >] Subagent`, each row showing a **status dot** (running/idle/done/error), **elapsed**, **live token count**, **turns**.
- **Live:** `workflow-run-started` appends the run; `workflow-run-update` **patches the run in place** (status flip, token tick, new phase) via the existing in-place DOM-patch approach — no grid rebuild; `workflow-run-stopped` freezes it and unshifts a history entry.
- **Drill-down:** clicking a subagent row expands its log pane, reusing the **exact** `autoRefreshTimers` + `agentLogCache` diff/auto-scroll logic against `GET /api/dashboard/run/:id/subagent/:sid/log` (parsed from that child's `agent-<id>.jsonl`, same contract as session-log). Clicking the run root shows a **phase waterfall** with aggregate tokens (degrading to a flat subagent list when phases are unknown).
- A small **inferred node-graph toggle** (orchestrator → subagents) is a **stretch view** derived from the same `parentId` + timing data; **the tree is the MVP** and the node-graph is explicitly out of MVP scope (§4).
- **Reconnect/replay is already solved:** the `state` snapshot includes `workflowRuns`; phase event-log entries replay via `?since`.

**Net:** the operator gets the same live cards + log drill-down they have for a single agent, **plus** the nested fan-out they currently cannot see at all.

### 3.5 Reuse vs. new

**REUSED (the bulk):**
- the `${hostWorkspacePath}:/workspace` bind mount (artifacts already reach the host — **no new volume**)
- `session-parser.ts` file *discovery* + line parsing + token-summing plumbing (the per-child *attribution* and tool_use/result *pairing* are NEW — §1.4)
- the SSE endpoint + `handleSSE` `?since` replay + `sseClients` fan-out
- **`notifyClients` / `broadcastSSE`** (push new event types with zero transport changes — *the* reuse seam), shipping **full objects** as every existing event does
- the event-log (`logEvent` / `onEventLogEntry` / seq ring-buffer / `getEventsSince`) for durable replay-safe phase events
- `POST /api/notify` + per-agent Bearer auth + `report.sh` as the in-container reporting surface
- the 5s activity-gated live-log poll pattern (`autoRefreshTimers` / `agentLogCache` / auto-scroll) for per-subagent drill-down — and, preferentially, as the run-tree re-parse trigger (§3.1)
- `log-archive` `summary.json` for durable, indefinitely-retained run telemetry
- `getFullState` / `state` snapshot for first-paint + reconnect
- the nginx Tailscale + Let's Encrypt proxy (already SSE-tuned)
- `AGENT_NAME_RE` path-traversal validation for the new name/id-bearing endpoints (§3.6)
- the registry stays **flat**; the run anchors to the existing card via `parentAgentName`

**GENUINELY NEW (minimal):**
1. the `RunNode` / `PhaseNode` / `SubagentNode` tree type + `workflowRuns` on `DashboardState` — the first-class nested-run concept that exists nowhere today
2. a run-tree builder extending `session-parser` with **per-subagent attribution, `tool_use`/`tool_result` pairing by `tool_use_id`, incremental byte-offset tailing, orphan-linking, and inferred status** (all new), plus its re-parse trigger (gated poll, or a watcher with teardown)
3. three SSE event types (`workflow-run-started`/`-update`/`-stopped`, full-object payloads) + a documented event-log **meta contract** `{runId, phaseId, sid, status}`
4. `GET /api/dashboard/run/:id` and `/run/:id/subagent/:sid/log` hydration endpoints (with input validation — §3.6)
5. a `runTree` block in `summary.json`
6. the SPA run-tree card + drill-down rendering
7. *(optional)* `report.sh` workflow verbs / a Workflow hook for low-latency boundaries
8. *(fast-follow)* `STATE_DELTA` JSON-Patch deltas to replace full-object updates under high fan-out

### 3.6 Remote / mTLS access, and endpoint hardening

Works over the always-on remote setup with **no new exposure**. nginx already proxies exactly `/dashboard` and `/api/dashboard/` (incl. the SSE stream) and is already SSE-tuned. **The new SSE events ride the SAME `/api/dashboard/events` connection**, so they traverse the proxy unchanged; the new REST endpoints live under the already-proxied `/api/dashboard/` prefix. Auth for in-container telemetry reuses the existing per-agent Bearer token on `/api/notify`; the dashboard itself is protected by network isolation (Tailscale) exactly as today. The append-only journal + SSE `?since` replay + exponential-backoff reconnect mean a dropped remote connection **resumes the run-tree view without loss or dupes**. *(Drift note: docs still describe the older mTLS/8443/`client.p12` model; the live compose uses Tailscale + LE — either path proxies the new events identically.)*

**Endpoint authz / path-traversal (REQUIRED, not optional).** The new `GET /api/dashboard/run/:id` and `GET /api/dashboard/run/:id/subagent/:sid/log` read files off disk keyed by `:id` and `:sid`, which are **attacker-influenced path segments** — exactly the surface the existing dashboard already guards with `AGENT_NAME_RE`. Therefore:
- **Validate `runId` and `sid` against the same `/^[a-z0-9][a-z0-9-]*$/` allowlist** before any filesystem access (reuse `AGENT_NAME_RE`); reject otherwise.
- **Resolve and confine** the derived log path under the agent's workspace root (`resolve()` + prefix check), so a crafted id cannot escape via `..` or absolute paths — the same discipline `dashboard.ts` already applies to `:name` endpoints.
Without this, the file-tailing design opens a traversal hole the rest of the dashboard does not have.

---

## 4. The MVP slice

The smallest slice to see **ONE workflow run live in the web UI**, touching only the daemon parser + `dashboard.ts` + `dashboard-ui.html`, and **nothing in the closed Workflow harness**:

1. Define `RunNode`/`PhaseNode`/`SubagentNode`; add `workflowRuns: RunNode[]` to `DashboardState`/`getFullState` (default `[]`).
2. Run-tree parse for **active agents only**, driven (preferentially) off the existing activity-gated cadence (§3.1), over `.workspaces/<name>/.claude/projects/**/subagents/agent-*.jsonl`. Extend `session-parser` to build a `RunNode` with **per-subagent attribution + token summing** (new) and persisted byte offsets. Status inferred from `stop_reason` + age. **Phases optional in MVP — a single implicit phase is fine** (consistent with §3.3: phases are not guaranteed readable).
3. On change, call `notifyClients('workflow-run-started'|'-update'|'-stopped', node)` — **full `RunNode` on update** (no JSON-Patch in MVP). **NO `report.sh`/hook changes in MVP** — pure passive tailing of the already-mounted artifacts (zero harness coupling).
4. SPA: when an agent has a non-empty run, render a collapsible tree (`Run > Subagent` rows with status dot + live token count) under its existing card; handle the three SSE events with in-place patching; reuse the live-log poll for subagent drill-down via a thin `/api/dashboard/run/:id/subagent/:sid/log` (with `AGENT_NAME_RE` validation on `:id`/`:sid`).

This shows **the fan-out tree, per-subagent status + tokens, and per-subagent log drill-down — live, remotely** (and ≥1 phase, real or implicit). **Out of MVP scope:** the inferred node-graph toggle, `report.sh` verbs / Workflow hook, JSON-Patch deltas, and the `summary.json` `runTree` block — all fast-follows.

---

## 5. Risks

| Risk | Mitigation |
|------|------------|
| **Undocumented/unstable JSONL schema** — fields are optional polymorphic fragments | Parse defensively; treat *every* field as optional; version the parser; **degrade to `subagentCount`** on parse failure. |
| **`subagents/` layout / run-journal are assumptions** — the layout is today's agent-teams artifact; the journal is a fritZ *design concept*, not a proven harness output (§3.1) | Verify both against a real workflow run *before* relying on phases-from-journal; keep the firm subagent-tree path working even if the journal never materializes. |
| **Orphan-agent race** — subagent file appears before the parent's spawning `tool_use` | Phased linking (`toolUseResult` → description → positional); never assume parent-first ordering. |
| **Status is inferred, not read** — permission/waiting states are invisible; CPU heuristics don't apply in-container | The inference ladder + (ideally) optional hook/heartbeat signals as the top precedence. |
| **SSE fire-hose** — high-frequency fan-out broadcasts every update to every client, no per-client scoping | MVP ships full `RunNode` objects (matching `agent-update`); **throttle/coalesce** server-side (1–2s debounce); promote to JSON-Patch deltas only if volume demands. |
| **File-watcher / poll load** — many `subagents/*.jsonl` with byte-offset reads | Handle truncation/rotation (reset offset only when `offset > file_len`); never re-parse whole files each tick. Prefer the existing gated poll over a new watcher (§3.1). |
| **Watcher + offset-state teardown** — if a chokidar watcher is added, it (and the per-file byte-offset map) must be disposed | Tear down the watcher and clear offsets on `agent-stopped` and on 24h workspace cleanup — mirror how the 5s poll is torn down on stop. Poll-reuse avoids this risk entirely. |
| **Archive/cleanup race** — on exit the workspace is parsed once for `summary.json` and then reclaimed (24h); a live reader can race file deletion mid-watch | On `agent-stopped`, stop tailing *before* `archiveAgentLogs()` runs; tolerate ENOENT/file-deleted mid-read as a normal terminal condition, not an error. |
| **Run identity** — deriving a stable `runId` across resume | Must be reliable, or the tree fragments on reconnect/resume (see §6 Q3). |
| **Event-log churn** — routing every phase/spawn through the 500-entry/200-ring log evicts unrelated lifecycle events | Keep fine-grained per-token activity **OUT** of the event log (SSE-only); put only **coarse phase boundaries** in it. |
| **Doc/impl drift on remote exposure** (mTLS docs vs Tailscale+LE compose) | Harmless to this design — the SSE/REST path is identical either way; flagged so operators wiring access aren't confused. |

---

## 6. Open questions

1. **Native lifecycle hooks?** Does the v2 Workflow harness expose hooks inside the container (`SessionStart`/`SubagentStop`) we can register, or is pure JSONL-tail the only option for boundaries?
2. **Does a run journal even exist, and where?** "Run journal" is a fritZ design concept (docs 03/04/05), **not** a confirmed harness artifact. Does the v2 Workflow harness actually write a journal under `/workspace/.claude/...` on the same mount, and does it encode **explicit phase structure** we can read directly — or must phases be inferred / collapsed to one implicit phase? **This is load-bearing: §3.3's phase layer and the §0 diagram both depend on the answer.**
3. **`runId` stability/resume.** Is `runId` stable and resume-safe across a container restart (does anything on disk carry it), so the tree **reconstructs** rather than fragments?
4. **Synthetic registry children? (presumptively NO.)** Could a run register its subagents as synthetic registry children (auto-surfacing as cards + in issue-trail)? **The flat registry is a v2 commitment** (README + §7 here); synthetic children would relitigate a settled framing decision and expand surface area. Keep this open only as a *deliberate* future reconsideration — the default answer is **no, stay a projected tree under the parent card.**
5. **Does the workflow entrypoint emit the agent-teams `subagents/` layout?** Today those files come from `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (`agents.ts`). Is the path/schema identical under the workflow entrypoint, or does it differ / fall back? (§3.1 caveat.)
6. **Throttle/coalescing policy** for token-tick updates, and whether to add per-client **run-scoped SSE subscriptions** if multiple operators watch concurrently.
7. **Operator → run control?** Do we need pause/cancel a phase or subagent in MVP? That requires a WebSocket-or-HTTP-POST control side-channel beyond read-only SSE. (Out of MVP.)
8. **Retention shape.** Store the full `runTree` in `summary.json`, or only aggregate counts + pointers to child archives, given indefinite retention and ~1.4 GB/year growth?

---

## 7. Where this sits in the set

This is the observability counterpart to doc 06's "what stays identical": the **transition core, substrate, and credential paths are unchanged**, and so is the **observability transport** — one SSE rail, one event-log, one archive. What changes is the *shape of what flows over that rail when the container runs the workflow entrypoint instead of the legacy one*: a flat `lastActivity` string becomes a nested run tree. Per the v2 frame, this is the same container, the same substrate, the same rails — we **structure** the visibility, we do not invent a second telemetry plane, and **the registry stays flat (a v2 commitment — §6 Q4)**: the run is a *projection* anchored to the existing agent card, not new registry entries. It depends on **no** change to the closed Workflow harness (pure artifact tailing — modulo the §3.1 assumptions to verify), so it can ship alongside the **security-review** first-mover (doc 05) and gives that experiment its eyes.

---

## 8. Pseudo-structure summary

```
DashboardState
  agents:       DashboardAgent[]     (unchanged, flat)
  history:      HistoryEntry[]       (unchanged)
  system:       SystemStatus         (unchanged)
  workflowRuns: RunNode[]            (NEW — appears on first paint + every reconnect)

SSE events (same /api/dashboard/events connection)
  + workflow-run-started  RunNode
  + workflow-run-update   RunNode (FULL object, like agent-update)   [JSON-Patch = fast-follow]
  + workflow-run-stopped  RunSummary
  (durable phase boundaries also ride event-log-entry, replay via ?since)

REST (under already-proxied /api/dashboard/, AGENT_NAME_RE-validated + path-confined)
  + GET /run/:id                      lazily hydrate full tree (live | summary.json)
  + GET /run/:id/subagent/:sid/log    per-subagent log tail (reuse 5s poll contract)

Capture
  passive:  gated re-parse (preferred) | chokidar (only if needed, with teardown)
            -> session-parser run-tree builder
               REUSED:  file discovery + line parse + token summing
               NEW:     per-subagent attribution, tool_use/result pairing,
                        byte-offset tail, orphan-link, inferred status
  optional: report.sh {phase-start|phase-end|subagent-spawned|subagent-done} -> POST /api/notify
  ASSUMED:  run journal (phase structure) — verify it exists before relying on it

Persistence
  summary.json += runTree {phases[]?, child sids[], per-child tokens}   (survives 24h cleanup)
```

---

## 9. Sources

Links are to the projects'/specs' public docs. Behaviors not directly linked below should be treated as **training-knowledge** (noted inline in §2) and verified before relying on them. None of these are required to *build* the MVP — they inform direction; the build rests on the in-repo source cited throughout §1/§3.

**OTel / agent-observability model**
- OTel GenAI agent spans (semconv) — https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
- OpenInference span spec (Phoenix) — https://arize-ai.github.io/openinference/spec/
- Langfuse data model — https://langfuse.com/docs/observability/data-model
- AG-UI (CopilotKit) `STATE_SNAPSHOT`/`STATE_DELTA` over SSE — https://docs.copilotkit.ai/ag-ui

**Claude Code session-monitor precedents (the closest references)**
- hoangsonww / Claude-Code-Agent-Monitor (hooks + JSONL, tool_use/result pairing) — https://github.com/hoangsonww/Claude-Code-Agent-Monitor
- patoles / agent-flow (hook relay → SSE node-graph) — https://github.com/patoles/agent-flow
- claudectl TUI dashboard (byte-offset tail + status inference) — https://mercurialsolo.github.io/posts/claudectl-tui-dashboard/
- Parsing Claude Code's JSONL session logs — https://medium.com/@ywian/what-i-learned-parsing-claude-codes-jsonl-session-logs-268248be0a2c

**Durable-workflow UI / transport**
- Windmill per-job SSE (`new_logs`/`progress`/`flow_status`) — https://github.com/windmill-labs/windmill/issues/6470
- Hatchet streaming (`subscribe_to_stream` → proxy via SSE) — https://docs.hatchet.run/home/streaming
- SSE for LLM dashboards (SSE vs WebSocket) — https://procedure.tech/blogs/sse-for-llms/
- Sidecar tailing on a shared volume — https://github.com/SumoLogic/tailing-sidecar
