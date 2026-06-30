# Target Architecture — fritZ v2 (One Docker Substrate, Two Entrypoints)

> Codename **Janus**. "Labels-as-Truth, Two Entrypoints, One Substrate, One Seam."
> This document describes the target architecture for fritZ v2. It is grounded in the v1 source: file/line anchors below (`agents.ts:948`, `github.ts:551`, etc.) refer to the current codebase and are the seams this design builds on. No source code appears here — only prose, pseudo-structure, and ASCII.

> **One-line summary:** *fritZ v2 (Janus) keeps ONE Docker substrate and adds a SECOND in-container entrypoint — a workflow program that fans out N in-process subagents in the same container, synthesizes, and reports — selected by the `fritz.engine` label at the `startAgent` seam. No second engine, no host execution. Near-term review is our own in-container judge-panel; cloud ultrareview is a deferred, optional, off-box escalation.*

---

## 1. North-Star Principles

These are the non-negotiable invariants. Every later section is a consequence of one of them.

1. **Labels are the only source of truth.** There is no second state store. Both entrypoints coordinate *exclusively* through `fritz.status:*` labels on GitHub issues and drive every transition through the same `claimIssue`-on-start / `releaseAgent`-on-complete contract. The entrypoints **never call each other** — they meet only at the label.

2. **One substrate, two entrypoints, one seam.** There is ONE execution substrate — the Docker-container-per-stage model that already runs Claude Code *inside* a container. Entrypoint selection happens at exactly one chokepoint: `startAgent` (`agents.ts:948-958`, a thin router whose dispatch tail is `return startAgentDocker(options)` at `:957`, preceded by a load-bearing best-effort `refreshIssuesCache(...)` preamble). A `fritz.engine:<docker|workflow>` label, re-read on every `for-{role}` transition, routes the `(role, issue)` pair to one of two **in-container programs**. Nothing in the autoloop, in `getNextStatus`, in the substrate, or in the label vocabulary changes.

3. **Reuse the proven transition core verbatim.** `getNextStatus` (`github.ts:551`), `releaseAgent` (`654`), `getOrphanRestoreStatus` (`611`), `MAX_REWORK_CYCLES=3` (`173`), rework counting, PR-verification, and for-human escalation are *executor-agnostic*. They are not rewritten. A **parity test** asserts identical `(role, success, outcome, mode) → nextStatus` for both entrypoints, so dual-entrypoint operation can never silently diverge.

4. **Legacy is a permanent co-equal default, never deprecated on a timeline.** Three independent reversibility levers: (a) **default-off** — no label means the legacy single-agent entrypoint; (b) **transparent fallback** — a workflow-program failure re-dispatches the already-claimed stage to the legacy entrypoint; (c) a global **kill-switch** in `fritz.yaml` that routes all *new* stages to the legacy entrypoint while letting in-flight workflow-program runs complete (or fail over via the per-stage fallback). Both entrypoints run in the same container; "drain" here means *stop feeding the workflow entrypoint new stages*, not relocate a live run off the substrate.

5. **Adoption follows the fan-out-amenability ranking.** Read-only, findings-emitting stages migrate first (`security-review` → `review` → `validate`) because their parallel in-container subagents never contend for a writable branch and outputs merge additively. `implement` and `define` migrate last.

6. **Hardening is a prerequisite, not a freebie.** CAS-harden `claimIssue`, re-ground orphan recovery on run status, and make completion idempotent **before** any workflow-program stage that increases concurrency. These fix pre-existing liabilities (non-atomic claim at `github.ts:465`; wall-clock TTL at `registry.ts:286-290`) that added concurrency would otherwise expose. (Note: the single-daemon assumption is baked into v1 — file-based pause flag, in-memory `releasedAgents`/`mergeableRetries`/`pendingClaims` maps — which is precisely why these maps are best-effort fast-paths backed by run-status reconciliation, never durable stores.)

7. **Observability over silent absorption.** Every fallback-to-legacy emits a loud Telegram/log/metric signal. Any stage whose JSON-schema structured output fails to validate **hard-fails to `for-human`** — machine-checkable handoffs cannot degrade silently back to prose.

8. **Spend is gated, not just observed.** Billed *off-box* cloud paths (cloud ultrareview — see §4 and §6) are a cost axis the subscription-only usage-monitor does not track. The in-container workflow entrypoint itself is subscription-billed like every other container today; only the *deferred, optional* cloud ultrareview escalation crosses the billing boundary. Gate any such billed path on issue priority and rework-cycle count, skip it on the existing rebase-only diff-hash fast-track, with `for-human` as the hard backstop. Additionally, because the workflow entrypoint runs N in-process subagents in **one** container, apply the per-stage fan-out width cap + run-budget (§7) **at the container level**.

9. **Backend attribution lives on the registry handle, not the live label.** A human editing `fritz.engine` mid-stage cannot make the watchdog reconcile against the wrong backend. The label governs only the *next* stage; the run-handle's backend tag is authoritative for the *in-flight* one. (In v2 both backends are containers; the tag distinguishes which *entrypoint* is in flight, which the watchdog uses for run-status reconciliation.)

---

## 2. One Substrate, Two Entrypoints, Side by Side

There is **one execution substrate**: the Docker-container-per-stage model. It already runs Claude Code *inside* a container via persistent `docker exec -i <container> claude --input-format stream-json --output-format stream-json` (`agent-comms.ts:442-468`, with a one-shot fallback at `:357-368`); the container runs `sleep infinity` and the daemon orchestrates from outside (`agent-comms.ts:5-9`). v2 does **not** add a second execution engine and does **not** move execution to the host. v2 changes the container's **PROGRAM (its entrypoint)**, not its substrate.

Both entrypoints implement the same lifecycle contract: **claim → boot context → execute → report → release**. They differ only in *which program runs inside the same container*: one in-container agent, or an in-container fan-out of N subagents.

**The substrate already ships in-container fan-out.** This is not aspirational:

- Every agent container already receives `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (`agents.ts:413` — "inject env vars for all agents (persistent mode is universal)"). In-container multi-agent is already wired on.
- The daemon already parses `session.subagentCount` and, when `subagentCount > 0`, logs `🤝 Agent spawned N teammate(s)` (`agents.ts:197-204`, duplicated on the stop path at `:688-692`). The daemon **already counts in-container teammates**.

So today's fan-out is **already happening**: it is Claude's own Agent-Teams teammates inside the one container, spawned ad-hoc and counted post-hoc from session logs. The workflow-program entrypoint does **not invent** in-container fan-out — it **structures** capability the substrate already ships, making that fan-out **explicit, bounded, and synthesized** — same container, same substrate.

```
                       ┌─────────────────────────────────────────────┐
                       │         GitHub Issue  fritz.status:*         │
                       │            (SINGLE SOURCE OF TRUTH)          │
                       └───────────────▲───────────────▲─────────────┘
                                       │ claimIssue     │ releaseAgent
                                       │ (active)       │ (getNextStatus)
                  ┌────────────────────┴────────────────┴──────────────────┐
                  │              EXECUTOR-AGNOSTIC TRANSITION CORE          │
                  │  claimIssue · releaseAgent · getNextStatus              │
                  │  getOrphanRestoreStatus · MAX_REWORK_CYCLES=3           │
                  │  rework counting · PR-verify · for-human escalation     │
                  │                   (github.ts — UNCHANGED)               │
                  └────────────────────────────▲───────────────────────────┘
                                               │
                  startAgent(options)  ◄── THE ONE SEAM (agents.ts:948-958)
                  refreshIssuesCache preamble (load-bearing) · selects ENTRYPOINT
                                ┌──────────────┴───────────────┐
                                ▼                              ▼
   ╔═══════════════════════════════════════════════════════════════════════════════╗
   ║              ONE DOCKER SUBSTRATE — container per stage (UNCHANGED)             ║
   ║   docker run (sleep ∞) · cred copy (env OAuth | chmod-444 .credentials.json)   ║
   ║   image variants (incl. Kali +NET_RAW/NET_ADMIN) · watchdog · activity-TTL     ║
   ║   report.sh → /api/notify + /api/ask  (progress · ask · complete — terminal)   ║
   ║                                                                                ║
   ║   ┌─────────────────────────────┐     ┌──────────────────────────────────┐    ║
   ║   │  ENTRYPOINT A — LEGACY       │     │  ENTRYPOINT B — WORKFLOW PROGRAM │    ║
   ║   │  (single in-container agent) │     │  (in-container fan-out)          │    ║
   ║   │  TODAY                       │     │  v2                              │    ║
   ║   │                              │     │                                  │    ║
   ║   │  docker exec -i … claude     │     │  docker exec -i … claude DRIVES  │    ║
   ║   │  stream-json against         │     │  a workflow program in the SAME  │    ║
   ║   │  .fritz/assignment.md        │     │  container:                      │    ║
   ║   │                              │     │   ├─ fan out N in-process        │    ║
   ║   │  one assignment,             │     │   │   subagents (parallel)       │    ║
   ║   │  one serialized session      │     │   ├─ synthesize → ONE structured │    ║
   ║   │                              │     │   │   output object              │    ║
   ║   │                              │     │   └─ call report.sh              │    ║
   ║   └──────────────┬───────────────┘     └────────────────┬─────────────────┘    ║
   ║                  │                                       │                      ║
   ║                  └─────────── report.sh complete ────────┘                      ║
   ╚═══════════════════════════════════════════════════════════════════════════════╝
            container/creds/watchdog/TTL/report.sh boundary = UNCHANGED
```

**What is identical across both entrypoints:**

- The whole Docker substrate: container-per-stage, the credential copy (env OAuth token, or chmod-444 file-copy of `.credentials.json`/`subscription_token.json`), the watchdog, activity-TTL work, image variants (incl. Kali/pentest), and the registry handle mechanics. Only the program inside the container changes.
- The autoloop *pull* engine: `setInterval` → `fetchAllOpenIssues` → `filterByStatus` (14 statuses) → `sortByPriority` → `processIssue` switch → `spawnIfNoAgent(issue, role)`.
- `bootAgent`'s `BootResult` — identity, assignment, `report.sh`, knowledge tree, spec artifacts. `boot.ts` already separates context preparation from container start; the workflow entrypoint consumes the same `BootResult` and hands CONTEXT to the workflow program running *inside the same container*.
- The `report.sh → POST /api/notify + /api/ask` contract, including `complete` as terminal and `--outcome=rejected` routing.
- The registry, generalized: `updateContainer`'s `containerId` (`registry.ts:189`) becomes a **backend-tagged container `runId`** — a no-schema-change, cosmetic generalization. The backend is still a container.

**What is new (in the dispatch path):**

- A router *inside* `startAgent` selecting the **entrypoint** (preserving the `refreshIssuesCache` preamble; it does **not** regress to a literal one-liner).
- `startAgentWorkflow` implementing the same start/send/complete/status lifecycle, but launching the workflow-program entrypoint in the container instead of the single-agent entrypoint.
- Entrypoint-aware status seams: `isAgentRunning`, `listRunningProcesses`, `getExpiredAgents`, `stopAgent` become a small backend interface; both entrypoints query `docker ps`, but the workflow entrypoint additionally accounts for its in-container subagent activity for TTL purposes.

**Cross-cutting additions (outside the dispatch path)** that several principles require: JSON-schema validation with hard-fail-to-`for-human` wiring (P7), the dual-entrypoint parity test (P3), the fallback-signal emitter (P7), per-stage budget gating at the container level (P8), and the `engine.byRole` config plumbing (§4). These are not part of the entrypoint swap itself but are real, new surface area.

---

## 3. A Single Stage as an In-Container Workflow Program

When `startAgent` resolves the effective entrypoint to `workflow`, the stage runs the **workflow-program entrypoint inside the same container the daemon babysits** — the daemon does not stop babysitting, and execution does not leave the container. The container, not a cloud run, is still the unit of execution.

**Flow (prose):** The workflow-program path (1) calls the *same* CAS-hardened `github.claimIssue` first — so the `active` label, `pendingClaims` watchdog protection, and rollback-on-failure are identical to the legacy entrypoint; (2) reuses the `BootResult` for identity/spec/knowledge; (3) starts a per-role workflow *shape* inside the container. The shape's interior is **fan-out → verify → synthesize**: independent in-process subagents run in parallel in the same container, an adversarial verify/judge-panel join gates the result, and a synthesis step emits one JSON-schema-validated structured output, then calls `report.sh`. The daemon validates that output before calling `releaseAgent`; invalid output routes to `for-human`. Progress/ask/complete still flow through `report.sh`; the in-container subagent activity feeds **activity-based TTL** for workflow-routed stages. Completion is idempotent (extend the existing best-effort `releasedAgents` map) and reconcilable by polling container/run status, so a lost or duplicated webhook can't strand a stage at `active` with no container for the watchdog to find.

**Caveat (a) — fan-out mechanism.** Whether the literal Workflow scripting DSL/tool (`pipeline()/parallel()/agent()`) is exposed to the containerized `claude` CLI is **unverified**. Express the fan-out via whichever mechanism is actually wired: **if** the DSL is exposed, use it; **if not**, express the identical fan-out via the already-wired agent-teams/teammate mechanism (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `agents.ts:413`). **Either way the fan-out is in-container** — it is an in-container program shape, not a cloud/durable-run submission. The pseudo-code below uses `parallel()/agent()` notation illustratively for whichever of these is wired.

**Caveat (b) — one container, N subagents.** Because the workflow entrypoint runs N in-process subagents in a single container, **size CPU/RAM per container for N concurrent subagents** (not 1), and **apply the per-stage token budgets** — the fan-out width cap + run-budget of §7 — **at the container level**.

**Caveat (c) — durable resume needs a mounted volume.** Any "durable resume / run-journal / checkpoint" behavior must keep the journal on a **mounted volume** — container-ephemeral storage is lost on crash, which would defeat resume. So the honest claim is: *resume from the last journaled step, where the journal is on a mounted volume; in-flight uncheckpointed reasoning is not guaranteed.*

```
   fritz.status:for-review  (example: review stage on engine:workflow entrypoint)
            │
            ▼
   claimIssue (CAS) ── active ──┐  watchdog-protected via pendingClaims
            │                   │
            ▼                   │
   bootAgent → BootResult ──────┘
            │
            ▼
   START workflow-program entrypoint INSIDE THE SAME CONTAINER
   (docker exec -i … claude drives the program; backend-tagged runId → registry)
   ┌──────────────────────── IN-CONTAINER WORKFLOW SHAPE ───────────────────────┐
   │                                                                            │
   │   ── FAN-OUT ──            ── VERIFY ──            ── SYNTHESIZE ──         │
   │   parallel(                judge-panel join        agent(synthesis)        │
   │     agent(correctness),    "all must approve"      → ONE structured        │
   │     agent(quality),        (adversarial-verify)      output object         │
   │     agent(security)        in-container             → report.sh            │
   │   )  in-container subagents                                                │
   │   findings merge ───────►  pass? ──no──► outcome=rejected                  │
   │   additively (read-only)   │                                              │
   │                            yes                                             │
   │   (journal on MOUNTED volume → resume-from-last-step on crash)             │
   └──────────────┬─────────────────────────────────┬───────────────────────────┘
                  │ report.sh complete --outcome=... │ subagent activity → TTL
                  ▼                                  ▼
   daemon validates JSON-schema output ──invalid──► for-human (HARD FAIL)
                  │ valid
                  ▼
   releaseAgent(issue, name, role, success, outcome, mode)
                  │  getNextStatus(role, success, outcome, mode)  [UNCHANGED]
                  ▼
   fritz.status:for-validate     (or for-rework on outcome=rejected)
```

**Per-role shapes** (the `role → shape` mapping). The **Phase** column ties each shape to the adoption sequence in §7 — these shapes are *not* all available at once. The fan-out in `architect` and `define` is **speculative until validated empirically in its phase**; the prose is deliberately honest about where horizontal fan-out is bounded. All shapes are **in-container**.

| Role | Phase | Shape (in-container) |
|---|---|---|
| `security-review` | 1 | `parallel()` sharded by AppSec / InfraSec / file-module, merging additively into one report |
| `review` | 2 | `parallel(correctness, quality, security)` judge-panel with an "all must approve" join — **our own in-container judge-panel** (near-term); shardable per category |
| `validate` | 3 | `parallel(qaValidator, uxValidator)` over **one** in-container running app (shared-runtime bottleneck acknowledged, not eliminated) |
| `architect` | 4 | Builder/Breaker pair with a mandatory convergence join that limits horizontal fan-out (speculative — validate in Phase 4) |
| `ux` / `budget` | 4 | single in-container `agent()` (no fan-out) for typed output; `budget` consumes completed architect/ux specs as inputs |
| `define` | 4 | `pipeline(ux, [architect ∥ budget where the dependency graph allows])` → synthesis `agent()` — lifting the Issue #206 inline-sequential constraint *once define migrates (Phase 4)* |
| `implement` | 5 | single in-container `agent()` (the migrate-last single-agent shape — durability + infra, quality Δ≈flat) |
| `implement` (multi-agent) | 5b | **single-WRITER read-side fan-out** — headline **TEST-FIRST PIPELINE** `pipeline(test-deriver → writer-to-green[locked tests] → mutation-probe verifier)`, then **ADVERSARIAL-CRITIC LOOP** `writer → parallel(critics) → writer (loop-to-dry, capped)`. Writer fan-out (tournament/decompose) is default-off/opt-in/never-rework only (§7) |

Note on `define`: budget depends on the architect/ux specs, so architect∥budget overlap is *conditional on the dependency graph*, not unconditional parallelism.

Note on `implement` (Phase 5b): both multi-agent shapes keep **exactly ONE serialized writer on ONE feature branch** and fan out only on the **READ side** — the test-deriver writes only new, criterion-partitioned acceptance-test files (trivially conflict-free), and the verifier/critics write nothing to the tree. Because writes stay serialized there is no concurrent-write contention and **no per-subagent worktree-isolation prerequisite** (unverified anyway, OQ#3); exactly one branch ever pushes, so the PR-verification backstop and `report.sh complete` contract are byte-identical. Cost is **~2–2.5× a single implement, not N×**, because the writer phase is unchanged. The TEST-FIRST anti-gaming guarantee rests entirely on **locked acceptance-test files** — the verifier diffs the test files against the deriver's commit and rejects on any writer edit. The **writer**-fan-out shapes (tournament/decompose) only *relocate* implement's real semantic-merge cost into a serial graft step (the #486 context-loss scar) and are therefore **never** a Phase 5b shape — they remain default-off, budget-gated, never-on-rework opt-in escalations (§7).

---

## 4. Routing: Entrypoint Selection (Legacy / Workflow) and the Review Story

Routing operates on **two distinct axes**. The **entrypoint axis** (`fritz.engine:<docker|workflow>`) chooses *which in-container program runs a stage*. The **review-depth axis** (our in-container judge-panel near-term; cloud ultrareview as an optional future escalation) chooses *how deeply a review stage's work is run* — it is **not** a `fritz.engine` value and never appears in the entrypoint resolution table below.

Entrypoint routing is **per-stage, not per-issue**, and resolved at the single `startAgent` seam (`agents.ts:948-958`), preserving its `refreshIssuesCache` preamble. Because the `fritz.engine` label is re-read on every `for-{role}` transition, one issue can mix entrypoints (e.g. `define` on the legacy entrypoint, `review` on the workflow entrypoint). The `fritz.engine` label name and the per-stage routing mechanism are unchanged — only the *meaning* of the value shifts from "which engine" to "which in-container entrypoint."

**Entrypoint resolution order:**

```
resolveEntrypoint(role, issue):
  1. HARD OVERRIDES (win unconditionally):
        fritz.lang:kali / pentest        → legacy   (privileged Kali container,
                                                      NET_RAW/NET_ADMIN — fan-out N/A)
        fritz.lang:<no workflow template>→ legacy   (no in-container program parity)
        global kill-switch (fritz.yaml)  → legacy   (route all NEW stages here; in-flight
                                                      workflow-program runs complete or fail over)
  2. explicit label  fritz.engine:<docker|workflow>  on the issue   → use it
  3. fritz.yaml  engine.byRole[role]  default                       → use it  (rollout dial)
  4. otherwise                                                      → legacy  (default-off)
```

```
         spawnIfNoAgent(issue, role)
                  │
                  ▼
        ┌──────────────────────┐   kill-switch / kali / no-template
        │  resolveEntrypoint   │──────────────────────────────► legacy entrypoint
        │  (at startAgent seam)│                                 (single in-container agent)
        └────────┬─────────────┘
                 │ engine:workflow
                 ▼
        workflow-program entrypoint ──start in-container──► [in-container fan-out]
                 │                          │
                 │   start/health           │ success
                 │   FAILURE (caught)       ▼
                 └──────────────────► legacy entrypoint
                    + LOUD signal       (already-claimed stage,
                    (Telegram/log/metric) transparent fallback, same container model)
```

**Review depth — our own in-container judge-panel (near-term).** The near-term review story is **our own in-container judge-panel review**: the `review` stage's workflow entrypoint fans out correctness + quality + security lens subagents inside the agent container against the PR/diff, joins on **"all must approve,"** and emits the **same `approved`/`rejected` outcome the legacy review agent does**. This means `--outcome=rejected → for-rework` is reused verbatim and `getNextStatus`/`releaseAgent` are unchanged. `security-review` likewise runs its in-container sharded panel.

**Cloud ultrareview — optional future escalation (deferred).** Cloud ultrareview (`/code-review ultra`) is the one genuinely **non-Docker, billed, cloud-triggered, git-repo-requiring** path — the only place the "real git remote + PR" and "separate billing axis" constraints actually bite. It is **reclassified as FUTURE, OPTIONAL, off-box augmentation** and is **NOT on the near-term plan**. If ever enabled, it layers on the `review` stage on the review-depth axis, runs against the branch+PR `implement` opened, maps its verdict onto the existing `--outcome=rejected → for-rework` contract, and — because it is billed cloud spend the subscription usage-monitor does not see — is gated on priority + rework-cycle count and skipped on the rebase-only diff-hash fast-track, with the in-container judge-panel as the mandatory fallback. **Standard phrasing:** *our own in-container judge-panel review (near-term); ultrareview = optional future cloud escalation.*

**Watchdog backend-awareness:** the entrypoint that *actually* ran is recorded as a backend tag on the registry run-handle (generalized from `updateContainer`'s `containerId`). That tag — **not the live label** — is authoritative. The watchdog's status seams (`isAgentRunning`, `listRunningProcesses`, `getExpiredAgents`, `stopAgent`) become backend-aware: workflow-entrypoint stages additionally account for in-container subagent activity; both reconcile against `docker ps` for the underlying container; an undeterminable backend defaults to conservative legacy reconciliation.

---

## 5. Labels Remain the Source of Truth Across Both Entrypoints

Nothing about the state store changes. The `fritz.status:*` vocabulary (`inbox`, `for-define`, `defined`, `for-implement`, `for-review`, `for-validate`, `for-security-review`, `for-rework`, `for-human`, `active`, `validated`, `for-merge`, …) is untouched. The `fritz.engine:*` label is **routing metadata, not state** — it never participates in `getNextStatus`, and its value now selects an *entrypoint*, not an engine.

The shared contract that keeps both entrypoints honest:

```
START:     claimIssue(issue)        → adds  active,  refuses if active|blocked present
           (target: CAS-hardened — conditional combined edit + optimistic retry;
            see the Prereq phase in §7. v1 today is a non-atomic read-then-write at github.ts:465.)
EXECUTE:   report.sh progress/ask   → /api/notify · /api/ask   (in-container subagent activity → TTL)
COMPLETE:  report.sh complete       → releaseAgent(...) → getNextStatus(...)
           removes active + fritz.skill:<role>, adds next status
           (idempotent via best-effort releasedAgents map; reconcilable via run-status poll)
```

Both entrypoints advance the same pipeline edges. Rework still loops `review/validate reject → for-rework → implement → for-review`, the cycle counter (`fritz.rework:N`) still bumps, the `MAX_REWORK_CYCLES=3` safety valve still overrides to `for-human`, and `prVerificationFailed` still forces `for-human` when `implement` reports success with no PR. The **parity test** locks this: for every `(role, success, outcome, mode)`, both entrypoints must produce the identical `nextStatus`. Divergence is a test failure, not a production surprise. (Note for `implement` Phase 5b: the TEST-FIRST verifier's `rejected` verdict maps onto implement's **EXISTING** rework path — `rejected → for-rework` is a parity-test item, not a new transition.)

---

## 6. Review Depth and Where Ultrathink Slots In

The review-depth and reasoning-depth features are gated policy, not entrypoint swaps. They land at existing policy seams (`getRoleModel` / `getRoleTtl` in `boot.ts`) or as the review-depth target on `review`.

| Stage | Depth feature | How it applies |
|---|---|---|
| `define` | **ultrathink** | extended reasoning on triage/synthesis (the sequential UX→Architect→Budget coherence join) — in-container, subscription-billed |
| `architect` | **ultrathink** | TECH_SPEC depth, 10x-scale stress, failure-mode reasoning — in-container |
| `ux` | **ultrathink** | UX_SPEC design reasoning (single designer, explore→refine) — in-container |
| `budget` | **ultrathink** | anti-anchoring RICE estimation — in-container |
| `implement` | — | no depth feature (execution stage; reasoning depth not applied here) |
| `review` | **in-container judge-panel** (near-term) | our own in-container correctness/quality/security panel, "all must approve"; **cloud ultrareview = optional future escalation** |
| `validate` | — | no depth feature (runtime validation, not a reasoning or review-depth gate) |

- **`review`'s near-term depth is our own in-container judge-panel** — correctness + quality + security lens subagents, "all must approve," running inside the agent container against the PR/diff, emitting the same `approved`/`rejected` outcome the legacy review agent does (so `--outcome=rejected → for-rework` is reused verbatim). `security-review` likewise runs its in-container sharded panel. This is in-container, subscription-billed, no cloud, no real-git-remote requirement.
  - **Cloud ultrareview is a deferred, optional, off-box escalation** (see §4): `/code-review ultra` (cloud, billed, PR-scoped) for high-stakes PRs only, gated and with the in-container panel as fallback. It is **not** on the near-term plan and is the only genuinely non-Docker, billed path.
- **Ultrathink slots into the design stages only** — `define` (triage/synthesis reasoning), `architect` (TECH_SPEC, 10x-scale stress), `ux` (UX_SPEC), `budget` (anti-anchoring RICE). It is pure reasoning-time depth where spec quality compounds downstream; it is **in-container and subscription-billed (no cloud)**; it is **not** applied to `implement`/`review` execution. It is gated through the `getRoleModel`/`getRoleTtl` policy seam in `boot.ts`, so it composes with either entrypoint.
- **Workflow as the default entrypoint** can be set in `fritz.yaml` for `engine:workflow`-routed work — a config-level launch default, not a new engine and not a new substrate.

---

## 7. Adoption Sequence (Consequence of Principles 5 & 6)

The architecture is reversible at every step; rollout advances the `engine.byRole` dial along the verified fan-out ranking. The first experiment is the **cheapest near-term proof: our own in-container judge-panel on `review`** — NOT cloud ultrareview.

```
 Phase 0  (near-term proof)  workflow entrypoint on review = our own in-container judge-panel
                            (correctness/quality/security, "all must approve") + ultrathink in
                            define/architect (in-container, subscription-billed). Cheapest proof of
                            the workflow entrypoint; no cloud, no host execution, no new substrate.
 Prereq   (hardening)       CAS claimIssue · run-status orphan recovery · idempotent
                            completion · JSON-schema hard-fail · parity test · fallback signal.
                            Size containers for N concurrent subagents; apply per-stage container-level
                            token budgets (fan-out width cap + run-budget). REQUIRED before any
                            concurrency increase.
 Phase 1  security-review → workflow   (rank #1: read-only, partitioned, additive merge)
 Phase 2  review           → workflow   (rank #2: in-container judge-panel, comments-only)
 Phase 3  validate         → workflow   (rank #3: bounded — shared in-container running app remains bottleneck)
 Phase 4  architect/ux/budget/define → workflow   (single-agent + pipeline; ultrathink stays gated)
 Phase 5  implement        → workflow   (LAST single-agent shape: durability + infra; quality Δ≈flat.
                            Banks the cheap fan-out-free wins at near-zero risk. Justification for
                            migrate-last is single-writer rework sequentiality + write blast-radius —
                            NOT an unavoidable shared-branch merge hazard.)
 Phase 5b implement        → FIRST-CLASS MULTI-AGENT via single-WRITER read-side fan-out.
                            Headline = TEST-FIRST PIPELINE (read-only test-deriver → single
                            writer-to-green against LOCKED acceptance tests → independent
                            mutation-probe verifier). Then ADVERSARIAL-CRITIC LOOP (one writer +
                            N read-only critics, loop-to-dry, capped). Default-off behind
                            fritz.engine:workflow; mandatory loud fallback to legacy single-agent;
                            ships AFTER the in-container review judge-panel (Phase 0/2) proves
                            catch-rate; promote ONLY on a measured drop in downstream rework cycles.
                            Keeps EXACTLY ONE writer on ONE branch → no worktree-isolation prereq
                            (unverified anyway, OQ#3), no merge hazard re-introduced; ~2–2.5×
                            not N× cost (writer phase unchanged). De-dupe critic/verifier lenses
                            against the downstream review judge-panel (advisory only, never the
                            approval of record). verifier 'rejected' → implement's EXISTING rework
                            path (parity-test item, not a new transition).
 Pinned   pentest, retro, for-merge     → legacy/agent-less (see below)

 Default-off escalation, NEVER headline (writer fan-out — rejected as default):
          TOURNAMENT (N full-issue attempts → judge panel → synthesis+graft) and
          DECOMPOSE-AND-PARALLELIZE (planner → file-partitioned implementers → integrator)
          only RELOCATE implement's real cost (semantic merge = the #486 context-loss scar),
          cost N×, and maximize nondeterminism on the merged artifact. They are NOT a migration
          phase. Opt-in only, budget-gated (P0 ∨ ambiguous-spec ∨ auto-merge ∨ security-sensitive),
          hard attempt cap N=2–3, NEVER on rework (continue-from-existing-PR contract), NEVER on
          trivial diffs. If ever run: worktree-per-attempt IN-CONTAINER (N private branches, one
          writer each, no host worktree) + a SINGLE-writer serial integration step that grafts
          judge-blessed hunks, re-runs the FULL gate, and ships the winner un-grafted if grafting
          fails the gate. Exactly one branch ever pushes.

 Future / optional cloud escalation (NOT near-term):
          cloud ultrareview at the review-depth gate — the one off-box, billed, cloud-triggered,
          real-git-remote path. Gated on priority + rework-cycle, in-container panel as fallback.
```

**On the isolation question (resolved).** A bold proposal of this kind historically raised a top *unmitigated* risk: "host-worktree isolation regression." In v2 this is **resolved by in-container execution and is a non-issue**: because fan-out runs **in-container**, the container remains the trust boundary; untrusted external-repo code (`fritz.repo:owner/name[:branch]`) **never touches the host**, and there is **no host worktree in v2**. The lingering open question of a "trust boundary for host worktrees" is therefore **moot for v2** — v2 never runs a stage on the host. It is *only relevant if one ever ran the workflow program on the host, which v2 explicitly does not*; the `implement` recommendation no longer depends on it. (And the single-WRITER Phase 5b shapes never need per-subagent worktree isolation at all — writes stay serialized on one branch.)

**Pinned stages, and why:**

- `pentest` — needs a privileged Kali container (`fritz.lang:kali` + `NET_RAW`/`NET_ADMIN` + PTES tooling). The workflow entrypoint's fan-out is N/A here and `fritz.lang:kali` hard-pins to the legacy entrypoint indefinitely.
- `retro` — log-driven continuous improvement that consumes the post-hoc Docker logs / session audit trail (exit code + last log lines + subagent/teammate parse from `agents.ts:197-204`). Stays on the legacy entrypoint until the workflow program exports an equivalent structured run-log; otherwise retro loses its primary input.
- `for-merge` — already agent-less (findPR → CI check → mergeability → squash → close → remove label). Never an execution stage; untouched by either entrypoint.

The patient end-state — collapsing `boot.ts` container prep, `agent-comms.ts` stream-json hand-parsing, and watchdog reconciliation onto the single, richer workflow entrypoint — is the target the hybrid *converges toward only after every stage has a proven in-container workflow equivalent*. It is never the opening move. The legacy single-agent entrypoint is retained as a permanent, co-equal, A/B-comparable program over the same label store and the same Docker substrate.
