# Migration & Coexistence Strategy

> **fritZ v2 (Janus) keeps ONE Docker substrate and adds a SECOND in-container entrypoint** — a workflow program that fans out N in-process subagents in the same container, synthesizes, and reports — selected by the `fritz.engine` label at the `startAgent` seam. No second engine, no host execution. Near-term review is our own in-container judge-panel; cloud ultrareview is a deferred, optional, off-box escalation.

## 1. Purpose and the One Rule

This document specifies how the legacy single-agent entrypoint and the new workflow-program entrypoint (Janus) run side by side **inside the same Docker substrate** with **no big-bang cutover**, how adoption advances stage by stage, and how every stage retains a safe path back to the legacy entrypoint.

**One Docker substrate, two entrypoints.** The legacy entrypoint runs a single in-container agent; the workflow entrypoint runs an in-container fan-out of N subagents that synthesize and report. The container, not a cloud run, is still the unit of execution. v2 does **not** add a second execution engine and does **not** move execution to the host — it changes the container's *program*, not its *substrate*.

The whole strategy rests on one structural fact that source verification confirmed: `startAgent` is a single dispatch point. Its body (agents.ts:948–958) is *not* literally one line — it splits `config.githubRepo`, fires a best-effort `refreshIssuesCache(...).catch()` for side effects, and *then* tail-calls `return startAgentDocker(options)` at agents.ts:957. That tail-call is the only place an entrypoint is chosen. Equally important, the entire push-side transition layer in `github.ts` (`claimIssue` at :465, `releaseAgent` at :654, `getNextStatus` at :551, `getOrphanRestoreStatus` at :611, `MAX_REWORK_CYCLES=3` at :173) is already executor-agnostic. Coexistence is therefore not an architectural retrofit; it is teaching exactly one dispatch tail-call to choose between two in-container programs that both speak the same label contract.

**Implementation note for whoever inserts the router:** the entrypoint selection goes *after* the existing `refreshIssuesCache` call, replacing only the `return startAgentDocker(options)` tail — not the whole function body. Dropping the cache refresh would regress freshness; the router is an addition at the dispatch tail, not a rewrite of `startAgent`.

**The substrate already ships the fan-out primitive.** This reframe is not speculative. Every agent container is *already* started with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` injected by `agents.ts:413` ("Agent Teams: inject env vars for all agents (persistent mode is universal)"), and the daemon *already* parses `session.subagentCount` and logs `🤝 Agent spawned ${teammateCount} teammate(s)` (`agents.ts:197-204`, duplicated on the stop path at `agents.ts:688-692`). Agents are driven **in-container** via `docker exec -i <container> claude` with `--input-format stream-json --output-format stream-json` (persistent session at `agent-comms.ts:442-468`, one-shot fallback at `agent-comms.ts:357-368`); the container runs `sleep infinity` and the daemon orchestrates from outside (`agent-comms.ts:5-9`). In-container multi-agent fan-out is therefore not invented by v2 — the workflow entrypoint **structures** capability the substrate already ships. Today's fan-out is Claude's own Agent-Teams teammates inside the one container, spawned ad-hoc and counted post-hoc from session logs; the workflow entrypoint makes that fan-out **explicit, bounded, and synthesized** — same container, same substrate.

**The One Rule:** the two entrypoints never call each other. They coordinate *only* through `fritz.status:*` labels, claiming on start and releasing on completion. Everything else in this document follows from that rule.

```
                 GitHub Issue Labels  (THE ONLY STATE STORE)
                 fritz.status:*  fritz.skill:*  fritz.rework:N
                            ▲                  ▲
            claimIssue /    │                  │   claimIssue /
            releaseAgent    │                  │   releaseAgent
                            │                  │
              ┌─────────────┴───┐      ┌───────┴─────────────────┐
              │ LEGACY ENTRYPOINT│      │ WORKFLOW ENTRYPOINT     │
              │ single in-cont.  │      │ in-container fan-out of │
              │ agent (1 claude) │      │ N subagents + synthesis │
              │ startAgentDocker │      │ startAgentWorkflow      │
              └──────────────────┘      └─────────────────────────┘
                            ▲                  ▲
                            │   SAME Docker    │
                            │  container per   │
                            │     stage        │
                            └────────┬─────────┘
              startAgent dispatch tail (agents.ts:957)
                                     │
                          autoloop.spawnIfNoAgent(issue, role)
```

Neither entrypoint knows the other exists. The autoloop hands a `(role, issue)` to `startAgent`; the router decides which in-container program to launch; the program drives the label. That is the seam. **Janus = two entrypoints, one substrate, one seam.**

## 2. What Stays Identical (the load-bearing invariants)

Nothing below is rewritten, forked, or wrapped per-entrypoint. Both entrypoints share these verbatim, because the substrate underneath them is identical:

- **The Docker container per stage.** Both entrypoints run inside the *same* Docker-container-per-stage substrate. v2 does not add a runtime; it changes the program that the in-container `claude` executes. The container remains the unit of execution.
- **The credential copy path.** Env OAuth token, or the chmod-444 file-copy of `.credentials.json` / `subscription_token.json` into the container, is unchanged. Both entrypoints authenticate the same way.
- **The watchdog, activity-TTL, and registry handle mechanics.** Still a container; the backend-tag generalization (§3) is cosmetic naming, not a new runtime.
- **The image variants and hard-pins.** All image variants — including **Kali/pentest** (`fritz.lang:kali` + `NET_RAW`/`NET_ADMIN`) — and every hard-pin (pentest, retro, for-merge) are unchanged.
- **The state machine.** The 14-status `filterByStatus` set and the `processIssue` switch (autoloop.ts) are unchanged. A workflow-entrypoint stage and a legacy-entrypoint stage are *the same issue at the same `fritz.status:for-{role}`*; the autoloop cannot tell them apart and does not need to.
- **The issue as single source of truth.** There is no second state store. No run database becomes authoritative over labels. A workflow-entrypoint stage that completes flips a label exactly as a legacy-entrypoint stage exit does.
- **The transition table.** `getNextStatus(role, success, outcome, invocationMode)` (github.ts:551), `getOrphanRestoreStatus` (611), the rework counter, `MAX_REWORK_CYCLES=3` (173), the PR-verification backstop, and every `for-human` escalation that `getNextStatus` computes are pure functions of `(role, success, outcome, mode)`. Both entrypoints feed them identical inputs.
- **The claim/release contract.** Start → `claimIssue` (reads labels, checks for `active`/`blocked`, sets `fritz.status:active`, registers `pendingClaims` watchdog protection, and on failure rolls back to `previousStatus` via its existing `catch`). Complete → `releaseAgent` (idempotent via `releasedAgents`, removes `active`+`skill`, adds the computed next status).
- **The reporting contract.** `report.sh` → `/api/notify` + `/api/ask` is transport-agnostic, `complete` is terminal, and `--outcome=rejected → for-rework` is reused verbatim. Progress, `blocked`, `ask` (human-in-the-loop suspend), and the terminal `complete --outcome=…` mean the same thing whether the body of `report.sh` shells to the daemon from a single-agent run or from a fan-out workflow run — both run inside the same container.

A **parity test** is a hard CI gate on this section: it asserts that for every `(role, success, outcome, mode)` tuple, both entrypoints produce the *same* `nextStatus`. Dual-entrypoint operation can never silently diverge on the transition table, because divergence fails the build.

**Scope of "identical."** Parity covers `getNextStatus` — the mapping from a *given* `(role, success, outcome, mode)` to a next status. It does **not** cover *input validation*: as §5 details, the workflow entrypoint has one *additional* `for-human` trigger (structured-output schema-invalidation) that the legacy entrypoint lacks, because a single-agent stage emitting free-text never reaches schema validation. So the set of inputs is the same, the transition function is the same, but the workflow program can reject a malformed synthesized result before it ever becomes a parity input. That is intentional, not a divergence in the table.

## 3. Routing: Per-Stage, Default-Legacy

Routing is resolved **per stage, not per issue**, at the single `startAgent` seam, and re-read on every `for-{role}` transition. One issue can run `define` on the legacy entrypoint and `review` on the workflow entrypoint — that is the mechanism that lets adoption advance one stage at a time. The `fritz.engine:<docker|workflow>` label name is retained; only its *meaning* shifts from "which engine" to "which in-container entrypoint/program."

Resolution order inside `startAgent`:

```
startAgent({role, issue}):
  1. HARD PINS (override everything):
       fritz.lang:kali / pentest      -> docker   (permanent; NET_RAW/NET_ADMIN + Kali image)
       fritz.lang:* w/o WF template   -> docker   (no in-container program parity yet)
       global kill-switch engaged     -> docker   (NEW stages only; in-flight drains -- see §6)
  2. EXPLICIT LABEL:  fritz.engine:workflow -> startAgentWorkflow   (workflow-program entrypoint)
                      fritz.engine:docker   -> startAgentDocker     (legacy single-agent entrypoint)
  3. YAML DEFAULT:    engine.byRole[role] in fritz.yaml   (the rollout dial)
  4. FALLBACK:        no label, no default -> startAgentDocker   (DEFAULT-LEGACY)
```

Note the tier distinction inside the hard pins: `fritz.lang:kali` is a *permanent* pin (the entrypoint split there never closes until a privileged-environment workflow-program template exists for the same Kali container). The **kill-switch is not permanent and not the same kind of pin** — it forces only *new* stage starts to the legacy entrypoint while already-running workflow-entrypoint stages drain to completion (§6, Lever 3). It is listed in this block because it overrides labels at *start time*, but it never reconciles an in-flight run to the legacy entrypoint.

**Default-legacy is the safety floor.** An issue with no `fritz.engine` label and a role with no `engine.byRole` entry runs exactly as it does today, byte for byte: a single in-container agent. Adoption is opt-in at three granularities: a single issue (label), a whole stage across the fleet (`engine.byRole` dial), or never (hard pin). The escape hatch is simply to revert the entrypoint back to legacy — and the revert is loud (§6).

**Authoritative attribution lives on the registry handle, not the live label.** When a stage starts, the entrypoint that actually ran it is recorded as a backend tag on the registry run-handle. This generalizes `updateContainer`'s `containerId` (registry.ts:189; typed `containerId?: string` and commented "For Docker mode") into a backend-tagged `runId`. This is a **no-migration** change, not a no-schema change: there is no data migration, but it does overload a Docker-named field, so the field name and its comment must be updated to reflect dual-entrypoint use. Both handles still point at a container — the tag records *which program* that container ran. The in-flight watchdog reconciles against *that tag*, never the live `fritz.engine` label. This defends against a human editing `fritz.engine` mid-stage: the edit governs the *next* stage only; the running stage is reconciled against the entrypoint that truly launched it.

The watchdog status seams (`isAgentRunning`, `listRunningProcesses`, `getExpiredAgents`, `stopAgent`) become backend-aware: both still inspect the same container via `docker ps`, but the daemon parses workflow-run progress (the fan-out's synthesized step state) for workflow-tagged handles and the single serialized session for legacy-tagged handles. The only case where the backend tag is missing is a handle created *before* the registry generalization — i.e. a stage in flight across the upgrade itself. For exactly that transitional window, an untagged handle defaults to conservative legacy reconciliation. Once attribution is written at claim time, the tag is always present, so this clause defends a real upgrade-boundary state, not a steady-state impossibility.

## 4. Rollout Order: Fan-Out Amenability, First to Last

Adoption follows the verified fan-out-amenability ranking. The principle: **migrate read-only, findings-emitting stages first, because their in-container parallel subagents never contend for a writable branch and their outputs merge additively when synthesized. Migrate branch-writing, convergent stages last.** Every stage below runs in the **same container** it runs in today; what changes is whether that container's program is a single agent or a synthesized fan-out.

**Phase 0 is separate from coexistence.** It swaps no entrypoint and changes no router. It is listed first only because it is the cheapest value to bank *before* the dual-entrypoint work begins:

> **Phase 0 (pre-coexistence — no router change).** Ship `ultrathink` on the design stages, all inside today's single-agent in-container model. `ultrathink` is in-container, subscription-billed, and triggers no cloud path: add it to `define`/`architect` via the `getRoleModel`/`getRoleTtl` policy seam (two SKILL prompts + one config flag). **Near-term review is our own in-container judge-panel review** — not cloud ultrareview (see §4 Phase 2 and the deferral below). Cloud ultrareview (`/code-review ultra`) is **out of near-term scope**; it is an optional future cloud escalation, covered separately under "Future / optional cloud escalation."

The entrypoint-swap phases proper:

| Phase | Stage(s) | Entrypoint target | Why this order |
|---|---|---|---|
| **1** | `security-review` | workflow-program (in-container) | Rank #1. Already an AppSec/InfraSec pair, read-only static analysis, no shared mutable artifact, trivially shardable, additive findings merge. Lowest blast radius; also promotes the least-integrated stage into a first-class in-container judge-panel gate. |
| **2** | `review` | workflow-program (our own in-container judge-panel) | Rank #2. Our own in-container judge-panel — correctness + quality + security lenses, **"all must approve"**, running inside the agent container against the PR/diff and emitting the **same `approved`/`rejected` outcome the legacy review agent does**, so `--outcome=rejected → for-rework` is reused verbatim and `getNextStatus`/`releaseAgent` are unchanged. Cloud ultrareview is **not** on this path; it is an optional future cloud escalation, deferred (see below). |
| **3** | `validate` | workflow-program (bounded) | Rank #3. QA/UX pair is parallel and findings merge, BUT needs ONE shared running app (`gh pr checkout` + `npm run dev`) inside the container. The container provisions the env once; contention is *reduced, not eliminated*. An honest, bounded win. |
| **4** | `architect`, `ux`, `budget` | workflow-program + ultrathink | Design stages. `architect` = Builder/Breaker with an in-container synthesis join; `ux`/`budget` = single in-container subagent. All gain activity-based TTL and JSON-schema'd specs. `ultrathink` here is in-container and subscription-billed — no cloud. |
| **5** | `define` | workflow-program pipeline | Migrated late. Its whole job IS the sequential `ux→architect→budget` join; expressed in-container as a `ux→[architect‖budget]`+synthesis fan-out it finally lifts Issue #206's inline-sequential constraint — but only after the in-container fan-out + structured-output stability is proven. |
| **6** | `implement` (single-agent) | workflow-program single-agent | **Migrated last.** Single-writer rework is inherently sequential (one branch, one PR, ordered feedback, max-3 cycles), and implement is the only near-term stage whose write becomes the merged artifact — so the single-agent shape ships last, banking durable resume + in-container worktree + typed output at near-zero risk. Note: the old "host-worktree isolation" concern does **not** apply — execution stays in-container, so the container remains the trust boundary (see §8; the old 07 §5 host-worktree question is moot for v2). |
| **6b** | `implement` (multi-agent) | workflow-program **single-WRITER read-side fan-out** | **First-class multi-agent target.** Headline **TEST-FIRST PIPELINE** (read-only test-deriver → single writer-to-green against LOCKED acceptance tests → independent mutation-probe verifier), then **ADVERSARIAL-CRITIC LOOP** (one writer + N read-only critics, loop-to-dry, capped). Corrected rationale: implement-last is justified by single-writer rework sequentiality + write blast-radius, **not** by an unavoidable shared-branch merge hazard — keeping exactly ONE writer and fanning out only on the read side dissolves that hazard structurally (no worktree-isolation prereq). Default-off; ships **after** the in-container review judge-panel proves catch-rate (the critic loop is "the review panel, run early"); de-dupe critic lenses vs the review gate; promote **only** on a measured drop in rework cycles. **Writer fan-out (tournament/decompose) is NOT this phase** — it is a default-off, budget-gated, never-on-rework, never-on-trivial-diff opt-in escalation, capped at N=2–3 (see §4 note below). |
| **never** | `pentest`, `for-merge`, `retro` | legacy / agent-less | `pentest` hard-pinned to the privileged Kali container. `for-merge` is already agent-less (CI → mergeability → squash → close). `retro` consumes the post-hoc Docker session audit trail until the workflow program exports an equivalent structured run-log. |

> **Deferred: cloud ultrareview (Future / optional cloud escalation, OUT of near-term scope).** `ultrareview` (`/code-review ultra`) is the one genuinely **non-Docker, billed, cloud-triggered, git-repo-requiring** path — the only place the "real git remote + PR" and "separate billing axis" constraints actually bite. It is **NOT on the near-term plan**. If it is ever added, it runs `/code-review ultra` against the PR `implement` already opened, its verdict maps onto the existing `--outcome=rejected → for-rework` contract with mandatory fallback to our in-container judge-panel, and it is a budget-gated *escalation* triggered on issue priority + rework-cycle count — never an autoloop reflex. Standard placement for the whole review story: **our own in-container judge-panel review (near-term); ultrareview = optional future cloud escalation.**

> **Writer fan-out for implement is a default-off escalation, NEVER a migration phase.** Phase 6b promotes implement via *single-writer read-side* fan-out only. The *writer*-fan-out shapes — **TOURNAMENT** (N full-issue worktree attempts → judge panel → synthesis+graft) and **DECOMPOSE-AND-PARALLELIZE** (planner → file-partitioned implementers → integrator) — were scored against the single-agent steelman by an independent 3-judge panel and **lost**: worktree-per-attempt only relocates implement's real cost (semantic merge = the documented #486 context-loss scar), costs N× tokens on the highest-volume stage, and maximizes nondeterminism on the one stage whose write becomes the merged artifact. They are retained **only** as an opt-in escalation behind a dedicated label/yaml dial, with these **hard cost controls**: (1) **default-OFF**, gated on a complexity/priority predicate (P0 ∨ ambiguous-spec ∨ `fritz.auto-pipeline` auto-merge ∨ security-sensitive); (2) **hard attempt cap N=2–3** (the fan-out width cap, §4 sizing); (3) **skip-on-trivial-diff** — the SKILL solo-execution rule already covers config bumps / one-line fixes / renames; (4) **per-stage token + run-budget** enforced at the container level (07 §1.3 Layers 1/3); (5) **NEVER on rework** (the continue-from-existing-PR / no-new-branch contract forbids it); (6) the synthesis/graft step **must re-run the full gate** (tests + format --check + lint --check) and **must be allowed to ship the winner un-grafted** if grafting fails the gate; (7) loud fallback to the legacy single-agent entrypoint on any health failure. Exactly **one** branch ever pushes, so the PR-verification backstop and `report.sh complete` contract are unchanged.

**Per-phase promotion gate.** This is what makes the rollout incremental rather than a staged big-bang: **Phase N's `engine.byRole` dial advances to "workflow" for role N only after the parity test holds green in CI *and* the production fallback-to-legacy signal rate for roles `1..N` stays below the agreed threshold across a full pipeline window.** ("Full pipeline window" and the fallback-rate threshold are operational rollout parameters agreed at promotion time, not fixed constants pinned in this document; the point here is that promotion is gated on a sustained-quiet observation period spanning a complete `define→…→for-merge` traversal, not on a single green run.) The fallback signal (§6 Lever 2, surfaced per §7) is the observable promotion criterion — a sustained spike of fallbacks on an already-promoted stage is the signal to *hold* the dial, not advance it. No phase advances on a calendar; each advances on a green parity gate plus a quiet fallback channel.

**Container sizing for N concurrent subagents.** Because the workflow entrypoint runs N in-process subagents in a single container, **size CPU/RAM per container for N concurrent subagents** (not 1), and **apply the per-stage token budgets** (the fan-out width cap + run-budget) at the container level. A legacy-entrypoint container is sized for one agent; a workflow-entrypoint container for the same stage must be sized for the fan-out width it will spawn.

**Hardening is a prerequisite, not part of the phase reward.** Before *any* workflow-entrypoint stage that raises in-container concurrency (i.e. before Phase 1 ships at scale), three pre-existing liabilities must be fixed, because added concurrency will expose them:

1. **CAS-harden `claimIssue`** into a compare-and-set. The defect is the *check-then-act race*: `claimIssue` (github.ts:465) reads labels, checks for absence of `active`/`blocked`, then writes — two daemons or a daemon-plus-manual-edit can interleave and double-claim. Rollback-on-failure already exists (the `catch` restores `previousStatus`); this work is *not* adding rollback. It is making the check-and-set atomic: conditional on absence of `active`/`blocked`, single combined edit, optimistic-concurrency retry.
2. **Re-ground orphan recovery on run status.** `getOrphanRestoreStatus` already takes `hadActivity` (github.ts:611), but `lastActivityAt` is display-only (registry.ts:67). Make `hadActivity` reliable for a fan-out run (synthesized from the subagents' heartbeats), or the watchdog over-restores to `for-rework` and burns a cycle.
3. **Make completion idempotent and reconcilable.** Extend the existing `releasedAgents` map and poll the container's run status, so a lost or duplicated `/api/notify` webhook can't strand a stage at `fritz.status:active` with a live container the watchdog can't correlate.

## 5. Structured Output as a Migration Tripwire

Each workflow-entrypoint stage emits **JSON-schema structured output** — the typed successor of `report.sh`'s `{type,message,outcome}` and the `UX_SPEC`/`TECH_SPEC`/`ESTIMATE` artifacts — synthesized in-container from the fan-out's subagents. The daemon validates it *before* calling `releaseAgent`. **Invalid output hard-fails to `for-human`.** This is deliberate: it prevents machine-checkable handoffs from silently degrading back into prose-parsing as stages migrate. A single-agent stage that emits free-text and a workflow stage that emits an invalid schema are treated differently *on purpose* — the workflow entrypoint is held to a stricter contract so the migration buys real structure, not just a different program shape. This schema-invalidation path is the one *additional* `for-human` trigger the workflow entrypoint carries beyond the shared `getNextStatus` table (see §2, "Scope of identical").

**How the fan-out is expressed (DSL exposure is unverified).** The shapes above are described as `parallel()`/`pipeline()`/`agent()`-style fan-outs, but **whether the literal Workflow scripting DSL is exposed to the containerized `claude` CLI is unverified**. The fan-out must be expressed via whichever mechanism is actually wired: if the Workflow DSL is exposed to the in-container CLI, use it; **if it is not, express the identical fan-out via the already-wired agent-teams/teammate mechanism** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `agents.ts:413`, already counted at `agents.ts:197-204`). **Either way the fan-out is in-container** — an in-container program shape, never a cloud/durable-run submission.

## 6. Fallback and Escape Hatches

There are **three independent reversibility levers**, each operating at a different scope and time. All three keep execution in the same Docker container; they only change which program that container runs:

```
LEVER 1  DEFAULT-OFF        scope: per stage      time: before start
         No fritz.engine label + no byRole default  ->  legacy entrypoint.
         The natural resting state of every stage.

LEVER 2  TRANSPARENT FALLBACK  scope: one claimed stage   time: at start
         startAgentWorkflow in-container launch / health check fails
         ->  startAgent catches, re-dispatches the ALREADY-CLAIMED
             stage to startAgentDocker (legacy entrypoint), emits a LOUD signal.
         The claim is not lost; the issue does not strand.

LEVER 3  GLOBAL KILL-SWITCH    scope: whole fleet   time: any
         fritz.yaml engine kill-switch  ->  all NEW stages route to the
         legacy entrypoint; in-flight workflow-entrypoint stages DRAIN to
         completion (not killed mid-work, thanks to backend-tagged handles).
```

**Two failure timings, two responses.** Lever 2 covers failure *at start* — the in-container workflow program fails to launch, fails its health check, or fails environment-template resolution before the run is healthy. The already-claimed stage is transparently re-dispatched to the legacy single-agent entrypoint in the same container. But a stage can also fail **mid-run**: it claims, runs for twenty minutes, then the workflow program dies. That path is governed by the §3 backend-aware watchdog plus the §4 hardening, and its semantics are explicit:

```
MID-RUN WORKFLOW-ENTRYPOINT FAILURE
  watchdog (backend-aware) detects the workflow run is dead via run status
  -> it does NOT silently re-dispatch to the legacy entrypoint mid-flight
  -> it restores the issue to the role's getOrphanRestoreStatus(role, hadActivity)
       (e.g. implement -> for-rework, or for-implement if 0-turn;
        review -> for-review; etc.)
  -> the NEXT for-{role} transition re-enters startAgent and re-routes normally
  -> if the workflow entrypoint keeps failing for that stage, the operator flips
       the engine.byRole dial (or fritz.engine label) back to docker, and the
       restored status is then picked up by the legacy entrypoint on the retry
```

The reasoning: a half-completed fan-out has indeterminate partial state, so the safe move is to *release it back to a known label* via the proven orphan-restore table and let the normal routing + retry path decide the entrypoint for the next attempt — not to hot-swap a dead run's in-flight context into the legacy program. This keeps the One Rule intact (no entrypoint resumes another entrypoint's run) and keeps `hadActivity` honest so the restore doesn't waste a rework cycle (§4 hardening #2). Repeated mid-run failures on a stage are exactly the fallback-signal spike that should *hold* that stage's promotion dial (§4 promotion gate).

Legacy is never deprecated on a timeline. The **legacy single-agent entrypoint is a permanent co-equal default**, not a transitional compatibility shim. The hybrid won every judge scorecard precisely because it keeps the legacy entrypoint as a first-class program rather than demoting it.

**Loud over silent.** Every fallback-to-legacy (Lever 2) and every mid-run orphan-restore emits a Telegram + log + metric signal. A *systematically* broken workflow entrypoint that silently absorbs every stage back into the legacy program would otherwise look like "it still works." The loud signal makes the absorption visible so the operator knows the new entrypoint is degraded, not healthy — and it is the same signal the promotion gate watches. Reverting the entrypoint is the escape hatch; the loud signal is how you know it fired.

## 7. Observability and Dashboard Implications

The dashboard's mental model is "issues moving through statuses," fed by the autoloop's `lastKnownQueue` over SSE (`onQueueChange`). That layer is **unchanged** — both entrypoints write the same labels, so the queue view, status counts, and pipeline progression render identically regardless of which program ran.

What differs is what sits *behind* a single active issue — both are the **same container**, but running different programs:

```
LEGACY ENTRYPOINT                   WORKFLOW ENTRYPOINT
fritz.status:active                 fritz.status:active
  └─ 1 container (docker ps)          └─ 1 container (docker ps)
     └─ 1 serialized claude session      └─ 1 in-container fan-out program
        └─ subagents counted                 ├─ N in-process subagents
           POST-HOC from session logs        │  (explicit, bounded, synthesized)
     wall-clock TTL from `started`           └─ activity heartbeats via
     crash = restart from clone                  report.sh -> /api/notify
                                             activity-based TTL (real)
                                             crash = resume from last
                                               journaled step*
```

`*` **Resume granularity (requires a mounted volume).** Resume from the last journaled step is the workflow entrypoint's headline reliability claim, so it must not be hand-waved — and it has a hard prerequisite: **the run-journal must live on a mounted volume.** Container-ephemeral storage is lost on crash, which would defeat resume entirely; so any "durable resume / run-journal / checkpoint" claim depends on a mounted volume, not the container's writable layer. What survives a crashed workflow run is the journaled step state (on the mounted volume) plus the worktree's committed git state — a crashed run resumes from its last completed step rather than re-cloning and restarting the stage from scratch. What is *not* guaranteed to survive is in-flight, uncheckpointed reasoning between steps; resume is at journaled-step boundaries, not arbitrary instruction boundaries. This is still a strict improvement over the legacy entrypoint, where a crash loses everything except the shallow clone's committed state — but the win is "resume from the last journaled step, where the journal is on a mounted volume," not "resume from the exact instruction that crashed." One more contingency: journaled-step resume presupposes that the workflow-program mechanism actually exposes step checkpoints. Whether that comes from the literal Workflow DSL or the already-wired agent-teams fallback is unverified (§5); if the chosen mechanism does not expose step boundaries, the resume granularity degrades to whatever it does emit, and the mounted-volume prerequisite still applies to whatever is journaled.

Dashboard and observability consequences:

- **Attribution badge.** Surface the registry handle's backend tag (docker | workflow) on each active issue. This is the same field the watchdog reconciles against, so the dashboard and the reconciler agree on which program owns a container.
- **Fan-out visibility, where the run-status API exposes it.** Legacy subagent counts are parsed post-hoc from session logs (already, via `agents.ts:197-204`). A workflow stage's in-container subagents are first-class — *if* the run-status seam surfaces per-subagent state to the daemon, the dashboard can show "review: 3/3 judges, synthesis pending" live instead of a single opaque container. Where it does not, the dashboard falls back to a single run-level status badge (running / suspended-on-ask / complete) — still better than the post-hoc count, but not per-agent. This is gated on what the run-status seam actually returns, not assumed.
- **Heartbeat-driven TTL.** Workflow stages report activity through the existing `report.sh → /api/notify` channel, finally making `registry.ts`'s documented-but-false "TTL resets on activity" actually true for the new entrypoint. The dashboard can show real remaining-activity-budget instead of a wall-clock countdown that kills busy agents. Budget the per-stage token caps and the N-subagent CPU/RAM sizing (§4) at the container level here too.
- **The fallback signal is a dashboard event.** Lever-2 fallbacks-to-legacy and mid-run orphan-restores surface as a distinct, loud event class, so a wave of them reads as "workflow entrypoint degraded," not as normal legacy traffic. This is the same channel the §4 promotion gate consumes.
- **Spend is a separate axis.** The subscription-only `usage-monitor` does not track billed cloud paths. The near-term plan has **no billed cloud path**: in-container fan-out, in-container judge-panel review, and `ultrathink` are all subscription-billed. The *only* off-box billed path is the deferred, optional **cloud ultrareview** (§4) — when/if it is ever enabled, it is gated on issue priority + rework-cycle count, skipped on the existing rebase-only diff-hash fast-track, with `for-human` as the hard backstop, and surfaced as its own cost line, not folded into the 80% subscription pause.

## 8. The Patient End-State

The incidental-complexity subsystems — `boot.ts` container prep, `agent-comms.ts` stream-json hand-parsing, the watchdog's container reconciliation, wall-clock TTL, the global `maxParallelAgents` cap — are streamlined, **not** deleted: the container substrate, credential copy, watchdog/TTL, image variants, and the `report.sh` contract all stay. What gets retired is only the *legacy single-agent program* on a per-stage basis, and only after that stage has a proven workflow-entrypoint equivalent and the parity test has held green across a full pipeline, with the per-phase promotion gate (§4) satisfied for the role. Until then the legacy entrypoint remains live, because it is the fallback.

A note on a risk this reframe **retires**: earlier framings flagged "host-worktree isolation regression" as a top unmitigated risk of going workflow-native. That risk is **resolved by in-container execution** — v2 keeps the container trust boundary and does not introduce host worktrees. Because the fan-out runs in-container, untrusted external-repo code (`fritz.repo:owner/name[:branch]`) never touches the host. The "trust boundary for host worktrees" open question is therefore **moot for v2**: it is only relevant if one ever ran the workflow program on the host, which v2 explicitly does not. The `implement` recommendation (§4 Phase 6) is no longer contingent on that question.

The hybrid converges on the thin-router end-state patiently — one substrate, two entrypoints, one seam — and it never starts there; it advances one stage at a time, with the legacy entrypoint as a permanent co-equal default until every stage is proven.
