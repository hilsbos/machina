# Current fritZ Architecture (Baseline)

> **Status:** Baseline snapshot of the system as it exists today, written as the grounding reference for the fritZ v2 ("Janus") evolution. This document describes what *is*, names what is genuinely good and must survive any redesign, and catalogues the concrete costs that motivate change. It does not propose the future — that is the job of the later docs in this set.
>
> **One-line frame for what v2 builds on:** fritZ v2 (Janus) keeps **ONE Docker substrate** and adds a **SECOND in-container entrypoint** — a workflow program that fans out N in-process subagents in the same container, synthesizes, and reports — selected by the `fritz.engine` label at the `startAgent` seam. No second engine, no host execution. Crucially, the substrate v2 builds on **already exists**: every container today injects `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (`agents.ts:413`) and the daemon already counts in-container teammates (`agents.ts:197-204`, `:688-692`). In-container multi-agent fan-out is **already live**; v2 *structures* it, it does not invent it.

fritZ is a Telegram-driven, GitHub-label-orchestrated agent pipeline. It moves a GitHub issue through a fixed software-delivery lifecycle (`define → implement → review → validate → merge`, with a rework loop and several standalone gates) by spawning one containerized Claude Code agent per stage. There is **no separate state store and no message bus**: the *durable* per-issue state machine lives entirely in GitHub labels. A thin layer of *ephemeral* in-process coordination state (in-memory maps, a file pause flag) sits on top, is lost on daemon crash, and is reconstructed by reconciliation — see §5. Two independent engines drive label transitions, and they never call each other.

The three things fritZ does are deliberately separable, and this separation is the central fact of the baseline:

1. **A label-driven state machine** — the good, durable part.
2. **A single Docker-container-per-stage execution substrate** — the expensive, brittle part. Today its in-container program is a **single agent**; the substrate itself already ships in-container multi-agent capability (see §2).
3. **Hand-rolled `stream-json` messaging** between daemon and agent — the incidental-complexity part.

The sections below describe each, then characterize what to preserve and what hurts.

---

## 1. The Two-Engine State Machine

> **Note on "engine":** this section's two engines are the *coordination* axis — the autoloop **pull** engine and the agent-completion **push** engine. They are **distinct from the single *execution* substrate** of §2 (the one Docker-container-per-stage model). v2 adds a second in-container *entrypoint*, **not** a second execution engine; these pull/push coordination engines are preserved unchanged.

fritZ's orchestration is two loosely-coupled engines that coordinate *exclusively* through `fritz.status:*` labels on the issue. Neither engine knows the other exists; both read and write the same label and obey the same contract: **claim on start, release on completion.**

```
                         GitHub Issue Labels
                  (the only durable source of truth)
                                 │
          ┌──────────────────────┴───────────────────────┐
          │                                               │
   ENGINE 1: PULL                                  ENGINE 2: PUSH
   autoloop.ts (setInterval)                       github.ts releaseAgent
          │                                               │
   detect fritz.status:for-{role}                  agent container exits
          │                                               │
   spawnIfNoAgent(issue, role)                     getNextStatus(role,success,
          │                                          outcome,invocationMode)
   agents.startAgent({role,issue})                        │
          │                                         remove fritz.status:active
   claimIssue() ──► sets fritz.status:active ──────► add next fritz.status:*
```

### Engine 1 — Autoloop Pull (`agents/autoloop.ts`)

A `setInterval` loop (period from `fritz.yaml autoloop.intervalSec`, first run after a 5 s `setTimeout` at `autoloop.ts:900`) calls `check()` each cycle. Each cycle:

- **Re-entrancy & circuit-breaker guards:** bail if `isProcessing`, `isManuallyPaused()` (a file flag under `workspacesDir`), usage-paused (with an optional P0-only bypass), or `isRateLimited()`.
- **One read:** a single GraphQL call `fetchAllOpenIssues(owner, name)`, then **client-side** `filterByStatus`. The actionable status set totals **14** = **12 always-actionable** (`for-define`, `for-implement`, `for-architect`, `for-ux`, `for-budget`, `for-review`, `for-validate`, `for-security-review`, `for-pentest`, `for-rework`, `for-merge`, `discussion`) **+ 2 auto-pipeline-gated** (`defined`, `validated`, included only when `fritz.auto-pipeline` is set). Results cache into `lastKnownQueue` (dashboard SSE).
- **Sort then serial dispatch:** issues are `sortByPriority`'d, then `processIssue(number, status, labels)` (`autoloop.ts:122`) runs them **sequentially** in a for-loop. Per-issue guards: skip if `hasActiveAgent` (local registry already has an agent for this issue), skip `fritz.paused`, skip if `areDependenciesMet` is false (`fritz.depends-on:NNN` parsing + `isDependencyClosed`).
- **`processIssue` is a switch:** each `for-<role>` status maps to `spawnIfNoAgent(issue, role)` (`autoloop.ts:543`) → `agents.startAgent({role, issue})`. `for-rework` routes to the `implement` agent. Special agent-less handlers exist for `handleForReview`, `handleForMerge` (find PR → CI check → mergeability → squash-merge → close → remove label), `handleDiscussion`, and the auto-pipeline pass-throughs.
- **`handleForReview` mergeability pre-check:** before spawning a reviewer it reads PR mergeability — `MERGEABLE` → spawn review; `CONFLICTING` → post a conflict comment + transition to `for-rework`; **`UNKNOWN` → one retry next cycle via the `mergeableRetries` map** (keyed by issue, recording the first-seen cycle), then proceed as mergeable if still unknown so it never blocks indefinitely.
- **Periodic maintenance** every Nth cycle (`cleanupEveryNthCycle`): `cleanupStaleDependsOnLabels`, `detectAndReportCycles` (DFS over the `fritz.depends-on` graph, with cooldown), and stale-deployment checks. This pull-side housekeeping is part of what "the autoloop does" beyond pure dispatch.

The autoloop **only ever pushes an issue *into* execution** (sets it `active` via `claimIssue`). It never decides what comes *after* a stage.

### Engine 2 — Agent-Completion Push (`github.ts` `releaseAgent`)

When an agent container exits — detected by `agents.ts` (the `docker wait` watcher / `stopAgentDocker`) or by `watchdog.ts` `syncProcesses` — the caller invokes:

```
releaseAgent(issue, agentName, role, finalStatus, outcome, invocationMode, teammateCount)
```

`releaseAgent` (`github.ts:654`) is the *entire* forward-transition authority:

- **Idempotent** via the in-memory `releasedAgents` map (`github.ts:630`; key `agentName:issue`, TTL-pruned ~1 h), so a duplicated exit signal is a no-op.
- Removes `fritz.status:active` + `fritz.skill:<role>` (+ `blocked` if present) and **adds the next status computed by `getNextStatus`**, ideally in one combined `gh issue edit` (high-priority on the rate-limited write queue), with a fallback to separate calls so an issue is never left status-less.

`getNextStatus(role, success, outcome, invocationMode)` (`github.ts:551`) is a **pure function** encoding the whole transition table:

| Condition | Result |
|---|---|
| `success === false` | `for-human` |
| `outcome === 'rejected'` from review/validate | `for-rework` |
| `outcome === 'rejected'` from other roles | `for-human` |
| success: `define` | `defined` |
| success: `implement` | `for-review` |
| success: `review` | `for-validate` |
| success: `validate` | `validated` |
| success: `security-review` / `pentest` | `for-human` |
| success: `architect`/`ux`/`budget`, mode `standalone` | `defined` |
| success: `architect`/`ux`/`budget`, mode `orchestrated` | `for-define` (define synthesizes) |

> **Undefined-mode edge:** for `architect`/`ux`/`budget`, an *absent* `invocationMode` defaults to **`orchestrated`** (`→ for-define`) "for backwards compatibility" (per the source comment). Only an explicit `standalone` yields `defined`. This matters because any future parity check keys on `(role, success, outcome, mode)`, and the undefined-mode default is a real case the table must reproduce.

**Rework & safety valves**, all inside `releaseAgent`/`getNextStatus`:
- Cycle count via `fritz.rework:N`; when `nextStatus === for-rework` and `count > MAX_REWORK_CYCLES` (`=3`, `github.ts:173`), it is overridden to `for-human` + escalation comment + Telegram.
- `resetReworkCycle` clears the counter on `validated`.
- **PR verification:** if `implement` reports success but `findIssuePR` returns null, the result is forced to `for-human` (`prVerificationFailed`).
- Every `for-human` transition fires `lifecycle.system` Telegram + `logEvent('issue.attention')`.

### Orphan Recovery (the third, reconciliation-only path)

`getOrphanRestoreStatus(role, hadActivity=true)` (`github.ts:611`) maps a role to the status to restore when an agent dies abnormally (`implement` → `for-rework`, or `for-implement` if 0-turn; `review` → `for-review`; etc.; unknown → `for-human`). Two callers:

1. **Startup** `cleanupOrphanAgents()` — leftover containers from a crashed daemon; uses local registry `lastActivity` to detect 0-turn (`hadActivity`).
2. **Runtime** watchdog `cleanupOrphanedLabels(githubActive)` — issues `fritz.status:active` on GitHub with no matching local agent; **cannot** detect 0-turn (no GitHub-side activity signal) so defaults `hadActivity=true`.

> **The single seam.** Both engines, and orphan recovery, route execution through exactly one place: `agents.startAgent(options)` (`agents/agents.ts:948`). It is a **near-thin router** — a best-effort `refreshIssuesCache(...)` preamble (load-bearing: it freshens labels/state via an ETag-cheap call before boot) followed by a single dispatch tail:
> ```
> export async function startAgent(options) {        // :948
>   const repo = config.githubRepo;                  // refresh cache preamble
>   if (repo) {                                       //   (load-bearing, not removable)
>     const [owner, name] = repo.split('/');
>     refreshIssuesCache(owner, name).catch(() => {});// best-effort, non-blocking
>   }
>   return startAgentDocker(options);                // :957 — the one dispatch tail
> }
> ```
> Everything in §2 below sits behind the dispatch at `:957`. The seam selects **which in-container entrypoint runs**, not which engine: today the only entrypoint is the single-agent Docker program; v2's `fritz.engine:<docker|workflow>` label routes here to choose between the **legacy single-agent entrypoint** and a **workflow-program entrypoint** that fans out N in-container subagents — *same container, same substrate*. The transition layer of §1 (`getNextStatus`, `releaseAgent`, `getOrphanRestoreStatus`, `claimIssue`, rework counting, PR-verification) is **entrypoint-agnostic** — it does not know or care which in-container program ran the stage.

---

## 2. The Container-Per-Stage Execution Substrate

A pipeline stage = **one GitHub issue at one `fritz.status`, executed by exactly one Docker container** running Claude Code. The container's entrypoint is `sleep infinity` — the container is a long-lived shell, and Claude is *not* the container's entrypoint; the daemon drives `claude` *inside* the container via `docker exec`. The daemon (a single Node process) orchestrates the full lifecycle from outside the container.

This **Docker-container-per-stage model is the one execution substrate.** v2 does not add a second execution engine and does not move execution to the host — it changes the *program the container runs* (its in-container entrypoint), not the substrate. The single seam at `startAgent` (§1) selects that entrypoint.

### Lifecycle

```
 ┌─ startAgentDocker (agents.ts:271) ──────────────────────────────────────┐
 │ 1. enforce getMaxParallelAgents()  ── GLOBAL cap, all stages share it    │
 │      (config daemon.maxParallelAgents; throws when count >= limit)       │
 │ 2. name = role-issue-ts4hex ; resolve TTL (getRoleTtl) & per-agent token │
 │ 3. claimIssue() FIRST  ──► fritz.status:active ; add to pendingClaims    │
 │ 4. bootAgent() prepares host workspace:                                  │
 │      .fritz/identity.md  (role SKILL.md)                                  │
 │      .fritz/assignment.md (issue body+labels, git-workflow, steps)       │
 │      .fritz/report.sh   (curl bridge → /api/notify, /api/ask)            │
 │      CLAUDE.md, state.json, COPIED .fritz/knowledge tree (no symlinks)    │
 │      gh repo clone --depth=50 [-b branch] ./project                      │
 │ 5. credentials: OAuth token via env, OR physically copy host             │
 │      .credentials.json / subscription_token.json into .claude (chmod 444) │
 │ 6. selectAgentImage by fritz.lang: → base|java|cpp|kali|rust (auto-pull) │
 │ 7. docker run -d  (--network fritz, mounts, env tokens, +NET_RAW kali)   │
 │ 8. sleep 2000ms ; docker ps ; docker exec claude --version              │
 │ 9. agentComms.initAgent(name) ; registry.updateContainer ; lifecycle.hello│
 │10. remove from pendingClaims ; watchContainerExit ; send initial prompt  │
 └──────────────────────────────────────────────────────────────────────────┘
```

### Execution — persistent `stream-json` session (`agents/agent-comms.ts`)

The stage's actual work runs through **one persistent process** started lazily on first message:

```
docker exec -i <c> claude -p --input-format stream-json \
       --output-format stream-json --verbose --model <m> --dangerously-skip-permissions
```

- Turns are NDJSON written to stdin; responses detected by **hand-parsing stdout** for a `type:"result"` event (`processStreamBuffer`/`extractResponseFromResult`). `session_id` is captured from the init event and reused.
- Access is **strictly serialized per agent**: an `isBusy` flag + `messageQueue` drained one at a time (1 s gap, capped). Each turn has a timeout; on timeout the *partial buffer* is returned.
- If the persistent process dies, it falls back to **one-shot mode** (`docker exec claude -p ... --continue` per message).
- The agent self-reports progress by shelling `report.sh` → daemon HTTP (`/api/notify`, `/api/ask`). **`report.sh complete` is terminal** — it tells the daemon to stop the container.

### The already-live in-container multi-agent seam (the seam v2 builds on)

The single-agent framing above describes today's *default* in-container program, but the substrate **already ships in-container multi-agent fan-out** — wired on, in every container, today. This is the seam v2's workflow-program entrypoint builds on; it is not something v2 invents.

- **Every agent container already receives the Agent-Teams capability.** During boot, `startAgentDocker` unconditionally injects the experimental Agent-Teams env var into *every* container — `args.push('-e', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1');` (`agents.ts:413`, commented *"Agent Teams: inject env vars for all agents (persistent mode is universal)"*). There is no per-role gate; in-container multi-agent is **universally enabled**.
- **The daemon already counts in-container teammates.** On the exit path it calls `parseAgentSession(...)` and, when `session.subagentCount > 0`, logs `🤝 Agent spawned ${teammateCount} teammate(s)` (`agents.ts:197-204`), and the same count is recomputed on the stop path (`agents.ts:688-692`). The teammate count then flows through `watchContainerExit` into `releaseAgent(..., teammateCount)` (§1). The daemon does not *orchestrate* these teammates — it observes them **post-hoc, from session logs** — but it is fully aware that one container can host more than one agent.

So today's intra-stage fan-out is **Claude's own Agent-Teams teammates inside the one container, spawned ad-hoc and counted post-hoc from session logs.** The v2 workflow-program entrypoint does not add in-container fan-out — it makes that already-present fan-out **explicit, bounded, and synthesized**: same container, same substrate, but a defined set of in-process subagents whose results are merged into one outcome before `report.sh`. (Whether that fan-out is expressed via a Workflow scripting DSL or via this already-wired agent-teams mechanism is an entrypoint-internal detail; *either way it is in-container.*)

### Exit & Watchdog

- `watchContainerExit` runs `docker wait`; on exit it reads the exit code, dumps the last 100 log lines, parses the session for subagent/teammate counts, archives logs, then calls `releaseAgent` (label transition), `destroyAgent`, `deregisterAgent`.
- `core/watchdog.ts` (period `watchdogIntervalSec`, ~60 s): `checkExpired()` kills TTL-elapsed agents; `syncProcesses()` reconciles registry vs `docker ps` and releases vanished processes as `'completed'`; `cleanupOrphanedLabels()` fixes GitHub `active` labels with no local agent; prunes old workspaces.
- **Critical TTL detail:** expiry is **wall-clock from `started`**, not activity-based. `getExpiredAgents()` computes `new Date(a.started).getTime() + a.ttl*1000` (`core/registry.ts:290`), and `lastActivityAt` is explicitly annotated *"display only — does not affect TTL"* (`core/registry.ts:67`). A busy, chatty stage is killed at TTL exactly like an idle one (only `fritz.long-running` → `ttl=0` escapes). The README's claim that the countdown "resets on activity" is contradicted by the code.

### Characterization

| Property | Reality |
|---|---|
| **Isolation** | Strong — separate container, cloned repo, separate `/home/node/.claude`, separate `FRITZ_API_TOKEN`, separate network identity. This *property* is worth preserving (see §4.5). |
| **Cost** | High & coarse — full image pull + `clone --depth=50` + credential copy on *every* stage hop; a `sleep infinity` container holds a global slot for the whole TTL even while blocked on an `ask`. |
| **Startup latency** | High — claim → clone → image inspect/pull → `docker run` → 2 s sleep → version capture → lazy persistent-session start. Orchestrator alone ~60–90 s. |
| **Intra-stage parallelism** | **Ad-hoc, not zero.** The daemon→container channel is one serialized session, one message at a time — but the container is **not** single-agent: Agent-Teams is enabled in every container (`agents.ts:413`) and Claude's own teammates fan out *inside* the one container, counted post-hoc from session logs (`agents.ts:197-204`, `:688-692`). So today's fan-out is real but **unstructured** (ad-hoc spawn, post-hoc count, no synthesis contract). The substrate supports in-container multi-agent; what it lacks is an *explicit, bounded, synthesized* fan-out — which is exactly the v2 workflow-program entrypoint, on this same container. |
| **Cross-stage parallelism** | Bounded by a single **global** `maxParallelAgents` shared across all roles/issues. |
| **Durability** | None — a crashed agent loses all in-container progress; only the shallow clone + committed git state survive; the stage restarts from scratch. |

---

## 3. The Label Vocabulary as State Store

There is no schema, migration, or transaction layer — **the GitHub label set *is* the durable state machine** (the ephemeral in-memory coordination state of §5 sits beside it, not under it). All labels are defined in `ensureLabels`.

**`fritz.status:*` — the state itself (one per issue at a time):**

```
inbox → backlog → for-define → defined ─┐
                                         ├─(human gate OR fritz.auto-pipeline)
                            for-implement ←┘
                                  │
                               [active]            ← transient "claimed" marker
                                  │
                             for-review → for-validate → validated ─┐
                                  ▲            │                     ├─(human OR auto)
                                  └─ for-rework ┘  (reject)      for-merge
                                                                     │
                                                            merged + closed
   standalone gates:  for-architect · for-ux · for-budget
   special gates:     for-security-review · for-pentest · for-human · discussion
```

- **`active`** is the transient claim marker. `claimIssue` (`github.ts:465`) *refuses* to claim if `active` or `blocked` is present — this is the entire mutual-exclusion mechanism.
- **`for-human`** is the universal escalation sink (failure, rework-limit, PR-verification failure, non-review rejection).

**Companion prefixes (modifiers, not states):**

| Label | Role |
|---|---|
| `fritz.skill:<role>` | set while `active`, removed on release — records who is running. |
| `fritz.rework:N` | rework cycle counter; gates `MAX_REWORK_CYCLES=3`. |
| `fritz.depends-on:NNN` | dependency edges parsed by `areDependenciesMet` / cycle detection. |
| `fritz.repo:owner/name[:branch]` | cross-repo PR routing. |
| `fritz.lang:*` | selects the Docker image variant (`base/java/cpp/kali/rust`); `kali` also forces `NET_RAW/NET_ADMIN`. |
| `fritz.auto-pipeline` | enables the `defined → for-implement` and `validated → for-merge` auto-hops. |
| `fritz.paused` / `fritz.long-running` | per-issue pause / `ttl=0` override. |

Everything coordinates through these labels and nothing else — except `invocationMode` (`standalone` vs `orchestrated`), which is threaded through `releaseAgent → getNextStatus` *without* a label (see §4.6).

---

## 4. What Is Genuinely Good (and Must Be Preserved)

This is not legacy to be demolished — several properties are correct, hard-won, and should survive any redesign verbatim:

1. **Labels-as-truth is a real strength.** A single, human-inspectable, human-editable source of truth with zero schema-migration burden. An operator can read and correct pipeline state from the GitHub UI. No second *durable* state store should ever be introduced.

2. **The transition table is pure and entrypoint-agnostic.** `getNextStatus`, `getOrphanRestoreStatus`, `claimIssue`, `releaseAgent`, `MAX_REWORK_CYCLES`, rework counting, PR-verification, and `for-human` escalation (all in `github.ts`) make **no assumption about which program ran inside the container.** Because v2 keeps the same Docker substrate and only swaps the in-container entrypoint, this core is reused **verbatim** — a workflow-program stage emits the same `approved`/`rejected` outcome a legacy single-agent stage does, so `--outcome=rejected → for-rework` and the rest of the table apply unchanged. This is the asset that makes evolution cheap.

3. **Two decoupled engines coordinating only through labels.** The pull engine never decides what comes next; the push engine never decides what to start. The `claim-on-start / release-on-complete` contract is the clean invariant the whole system rests on.

4. **One verified seam.** `startAgent` (`agents.ts:948-958`) is a **near-thin router** — a load-bearing best-effort `refreshIssuesCache(...)` preamble followed by a single dispatch tail `return startAgentDocker(options);` at `:957`. (It is *not* literally one line; the cache refresh must be preserved.) Any new **in-container entrypoint** — e.g. the v2 workflow-program — plugs in at that dispatch tail behind the `fritz.engine` label, without touching the autoloop, the label vocabulary, or the transition table.

5. **Strong per-stage isolation — the *property*, not the *mechanism*.** A separate cloned repo, credentials, network identity, and API token per agent is a genuine safety guarantee worth keeping. But the *way* today's model achieves it — file-copying host credentials into every workspace and re-cloning the repo on every hop — is exactly the cost §5 indicts. Preserve the isolation guarantee; the Docker-copy mechanism is not sacred.

6. **`invocationMode` as label-free routing intent.** The `standalone` vs `orchestrated` signal threaded through `releaseAgent → getNextStatus` lets a design sub-skill (`architect`/`ux`/`budget`) signal how to route on completion *without* expanding the label vocabulary. It is a genuinely good piece of the executor-agnostic contract, not just a vocabulary footnote.

7. **The transport-agnostic `report.sh → /api/notify`/`/api/ask` contract.** Progress/ask/complete semantics — including *"complete is terminal"* — are independent of how the stage executes and survive any executor change.

8. **Defense-in-depth reconciliation.** Idempotent `releaseAgent`, `pendingClaims`, orphan-label cleanup, and rollback-on-claim-failure mean that after a daemon crash the system **reconciles toward a recoverable state** rather than corrupting it. This is lossy, not lossless (see §5 — 0-turn detection degrades, vanished processes are marked `'completed'` on a guess) — but it keeps the durable label store consistent.

---

## 5. Concrete Pain Points & Costs Motivating Evolution

These are specific, code-grounded liabilities — not generic critique.

**Execution model (the dominant cost):**

- **No *structured* intra-stage parallelism.** The daemon→container channel is one serialized session, one message at a time (`agent-comms.ts` `isBusy`/`messageQueue`), and in-container fan-out exists only ad-hoc: Agent-Teams is on in every container (`agents.ts:413`) and teammates are spawned ad-hoc and counted post-hoc (`agents.ts:197-204`), with **no bounded width and no synthesis contract**. The stages that are *most* amenable to fan-out — `security-review` (AppSec/InfraSec), `review` (Correctness/Quality), `validate` (QA/UX) — are read-only, findings-merging pairs that could shard cleanly, yet today get only this unstructured fan-out rather than an explicit, bounded, synthesized one. The substrate already supports the concurrency; what's missing is the *program shape* — which is the v2 workflow-program entrypoint, on the same container.
- **Coarse, redundant per-stage cost.** Every `implement → review → validate → rework` hop re-pays a full image inspect/pull, `clone --depth=50`, and credential file-copy. Nothing is warm-reused across stages of the *same* issue; there is no persistent per-issue workspace.
- **Single global concurrency budget.** `maxParallelAgents` is shared across all roles and issues, so a burst of `implement` agents head-of-line-blocks `review`/`validate`, and N ready issues serialize against one budget.
- **TTL is wall-clock, not activity-based** (`core/registry.ts:290`). A long-but-active stage is killed mid-work; only `fritz.long-running` escapes. The documentation actively misstates this.
- **No durable execution.** A crashed agent loses everything but the committed git state; the stage restarts from a shallow clone. Watchdog reconciliation *compensates* for the absence of resumability rather than providing it (e.g. `syncProcesses` marks vanished processes `'completed'` on a guess).
- **`implement` today is a single writer on a single writable branch.** Every `implement`/`for-rework` stage runs as exactly **one** in-container agent (Driver/Navigator inside one Claude session) that owns and writes the issue's one feature branch, formats/lints before each commit, and opens exactly one PR — the only stage whose program *writes* the merged artifact. This single-writer-on-one-branch shape is the baseline v2 changes: its in-container program is the prime target for a structured fan-out (see §4.2 entrypoint-agnostic transition core and the self-graded-tests gap below), but any such change must preserve the single-writer/one-branch contract that the PR-verification backstop (§1) and `report.sh complete` rely on.
- **Event-loop blocking.** Boot does `execSync` `docker rm/inspect/pull/run/ps/exec/logs` plus a hard-coded 2 s sleep on the daemon's single Node loop; the daemon must be co-located with the Docker socket and stay up for the whole stage.
- **Credential sprawl.** When not using OAuth env injection, host subscription credentials are physically copied (chmod 444) into every workspace dir.

**State machine & coordination:**

- **Non-atomic transitions.** Every transition is a remove-then-add `gh issue edit` that can leave an issue status-less on partial failure — mitigated only by scattered try/catch fallbacks.
- **Non-atomic claim.** `claimIssue` (`github.ts:465`) reads labels then writes; two daemons (or a daemon + a manual edit) could double-claim. A **single-daemon assumption is baked in**: the file pause flag and the in-memory maps (`releasedAgents`, `mergeableRetries`, `reportedCycles`, `pendingClaims`) are process-local and lost on restart, recovered only by the §4.8 reconciliation paths.
- **Orphan 0-turn detection is fragile.** It depends on local registry `lastActivity`, which is lost on daemon crash; the runtime watchdog path *cannot* detect 0-turn and over-restores to `for-rework`, wasting a rework cycle.

**Spend governance:**

- **Coarse and reactive.** The usage-monitor only *pauses the whole autoloop* when an aggregate subscription dimension crosses 80%; there is no per-issue/per-role/per-agent budget, no pre-spend estimate, no cost attribution. Opus is hard-assigned to many roles with no dynamic downgrade.
- **Fail-open monitoring.** A 401/403/error-streak silently disables the usage-monitor, after which the autoloop keeps spending with no backstop.

**Hand-off quality:**

- **No structured inter-stage result.** `report.sh` passes free-text `{type, message, outcome}` and skills write freeform Markdown specs (`UX_SPEC`/`TECH_SPEC`/`ESTIMATE`). Downstream stages parse prose; there is no machine-checkable schema, so handoffs can silently degrade.
- **Tests are self-graded — the weakest gate in the pipeline.** The implement skill instructs only "write tests alongside implementation" (`SKILL.md`), and its pre-PR **Self-Review** is run by *both agents together* walking a prose checklist — the producer grading its own tests. There is no independent test author and no anti-gaming check, so tautological/assert-true tests can turn the bar green without genuinely constraining the spec. This is the one gap that fan-out on the *read side* of implement (an independent, mutation-probe-verified acceptance contract — see 05 §3.5, 06 §4 Phase 6b) closes on quality grounds, without writer fan-out.
- **Brittle parsing throughout.** Turn detection is hand-rolled `stream-json` stdout parsing; rework count and discussion state are reconstructed from comments/labels rather than stored explicitly.

These costs concentrate almost entirely in **the in-container program (§2) and its in-memory coordination**, while the label state machine (§1, §3) and its pure transition core remain sound — which is precisely why the evolution targets the one seam at `startAgent`, swaps only the **in-container entrypoint** behind it, and leaves the rest (substrate, transition core, labels-as-truth) in place. The fact that the substrate already runs in-container multi-agent (§2, `agents.ts:413`, `:197-204`) is what makes that swap a *structuring* of existing capability rather than a new engine.
