# Risks, Costs & Open Questions

> **fritZ v2 (Janus) keeps ONE Docker substrate and adds a SECOND in-container entrypoint** — a workflow program that fans out N in-process subagents in the same container, synthesizes, and reports — selected by the `fritz.engine` label at the `startAgent` seam. No second engine, no host execution. Near-term review is our own in-container judge-panel; cloud ultrareview is a deferred, optional, off-box escalation.

This is doc 07 of the fritZ v2 "Janus" design set. It assumes the architecture established in docs 01–06: keep GitHub labels as the single source of truth, keep the executor-agnostic transition core (`getNextStatus`/`releaseAgent`/`getOrphanRestoreStatus`) verbatim, and add a **second in-container entrypoint** behind the `startAgent` seam (agents.ts:948-958 — a thin router whose dispatch tail is `return startAgentDocker(options)` at :957, preceded by a load-bearing `refreshIssuesCache` preamble), routed per-stage by a `fritz.engine` label, default-off and reversible.

Janus = **two entrypoints, one substrate, one seam.** The two faces are the legacy single-agent entrypoint and the workflow fan-out entrypoint — both over the same Docker-container-per-stage substrate. The substrate already runs Claude Code *inside* a container, driven from outside via `docker exec -i <container> claude` with stream-json I/O (agent-comms.ts:5-9 doc, :357-368 one-shot, :442-468 persistent); the container runs `sleep infinity` while the daemon orchestrates. v2 does **not** add a second execution engine and does **not** move execution to the host — it changes the container's PROGRAM, not its substrate. And the in-container fan-out capability is **already wired on**: every container receives `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (agents.ts:413), and the daemon already parses `session.subagentCount` and logs `Agent spawned N teammate(s)` (agents.ts:197-204, :688-692). The workflow entrypoint does not *invent* fan-out — it makes the fan-out the substrate already ships **explicit, bounded, and synthesized**.

This doc is the honest counterweight to those six. It catalogs what can go wrong, what it costs, where the design risks becoming clever for its own sake, what the owner still has to decide, and the single smallest experiment that proves or kills the whole thesis.

---

## 1. Cost & Token Blow-Up Risk from Fan-Out

### 1.1 The mechanism of the blow-up

The entire value proposition of the workflow entrypoint is intra-stage fan-out — the thing the legacy single-agent entrypoint structures rather than leaves ad-hoc. Today's fan-out is Claude's own Agent-Teams teammates inside the one container, spawned ad-hoc and counted post-hoc from session logs (agents.ts:413, :197-204); the workflow entrypoint makes that fan-out explicit, bounded, and synthesized — **same container, same substrate**. That same fan-out is the cost risk. Spend is a product of five factors, two of which the workflow entrypoint **newly inflates** and one of which it **newly unbounds**:

```
  total spend  ≈  (issues in flight)                       ← was bounded at 4; workflow entrypoint REMOVES the bound
               ×  (stages per issue, incl. rework re-runs)  ← unchanged
               ×  (parallel subagents per stage)            ← NEW: was ad-hoc/counted post-hoc; now explicit & bounded
               ×  (tokens per agent, incl. ultrathink)      ← NEW: inflated on design stages
               ×  (cloud multiplier on billed paths)        ← FUTURE/optional: ultrareview only, off-subscription
```

The three NEW/inflated factors are the parallel-subagents axis (today ad-hoc Agent-Teams teammates inside one container, made explicit and bounded by the workflow entrypoint), the per-agent token axis (ultrathink trades tokens for depth on design stages — in-container, subscription-billed), and the cloud multiplier (which bites on the **deferred, optional** ultrareview path only — see §4). Independently, the workflow entrypoint also **removes the bound on the first factor**: in legacy fritZ the global `maxParallelAgents=4` cap is a single counter that hard-bounds issues-in-flight, but it is also the source of cross-stage head-of-line blocking (an implement burst starves review/validate). The workflow entrypoint lifts that global cap — which is desirable for throughput and is precisely what makes fan-out a cost risk. A review stage that sharded to 5 lens subagents, on a P0 issue that goes 3 rework cycles, is roughly `5 × 3` review-subagent-runs — versus `1 × 3` in-container reviewer pairs today. The win is depth; the risk is that nobody is watching the multiplication. (Note the multiplication is now **N concurrent subagents inside ONE container** — see caveat (b) below: that single container must be CPU/RAM-sized for N, not 1.)

> **Caveat (a) — DSL exposure is unverified; the fan-out is in-container either way.** It is not yet verified whether the literal Workflow scripting DSL/tool (`pipeline()/parallel()/agent()`) is exposed to the containerized `claude` CLI. **If it is not**, express the identical fan-out via the already-wired agent-teams/teammate mechanism (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, agents.ts:413). Either way the fan-out is an **in-container program shape**, not a cloud/durable-run submission.

> **Caveat (b) — one container now hosts N concurrent subagents; size it and budget it.** Because the workflow entrypoint runs N in-process subagents in a single container, **size CPU/RAM per container for N concurrent subagents** (not 1), and **apply the per-stage token budgets — the fan-out width cap and run-budget of §1.3 — at the container level.** The cost axis and the resource-sizing axis are now the same axis.

> **Caveat (c) — durable run-journal/resume requires a MOUNTED volume.** Any resume/run-journal/checkpoint claim in this doc means **resume from the last journaled step, where the journal lives on a mounted volume**; in-flight uncheckpointed reasoning is not guaranteed. Container-ephemeral storage is lost on crash, which would defeat resume.

### 1.2 Why the existing controls are NOT enough

The legacy backstop is the `usage-monitor` (usage-monitor.ts) querying the Anthropic OAuth usage API and pausing the *entire* autoloop at 80% of a subscription dimension. Three reasons this does not cover the workflow entrypoint:

1. **It is subscription-only.** The deferred cloud `ultrareview` path (§4) is billed on a separate axis the usage-monitor literally cannot see. It will read green while a cloud bill climbs. (The in-container workflow fan-out itself is subscription-billed like everything else — it is the *deferred* cloud escalation that introduces the blind spot.)
2. **It is global and reactive.** It pauses *everything* at 80% — it has no per-issue, per-role, or per-stage attribution, and no pre-spend estimate. It is a circuit breaker, not a budget. And the dimension it bounds (issues-in-flight via `maxParallelAgents=4`) is exactly the bound the workflow entrypoint removes.
3. **It is fail-open.** On a 403 (long-lived tokens lack usage-API permission), a 401 it can't refresh, or `MAX_CONSECUTIVE_ERRORS=5`, it disables itself and explicitly does *not* change pause state. If monitoring silently dies, spend continues unbounded.

### 1.3 The controls this architecture adds

```
 Layer 0  usage-monitor (KEEP)         global subscription circuit breaker, 80% pause
 Layer 1  workflow run-budget          token-budget primitive; hard-stops one runaway run (per-container)
 Layer 2  per-stage concurrency cap    replaces the global maxParallelAgents=4 slot counter
 Layer 3  fan-out width cap            max parallel subagents per stage, per role (sized into the container)
 Layer 4  cloud-spend gate (FUTURE)    deferred ultrareview gated on priority + rework count
 Layer 5  for-human (KEEP)             the hard backstop — a stuck/expensive issue escalates
```

- **Workflow run-budget (Layer 1)** is the token-budget primitive — a hard ceiling enforced *inside* a single workflow run that stops the run when it overspends. It is distinct from the daemon-side policy in Layer 2/3 and from the legacy `usage-monitor`: it is the program itself refusing to keep spending on one run. It gives per-*stage* cost attribution fritZ has never had (per-*issue* attribution still requires summing a stage's runs across the issue's lifecycle and rework cycles — see OQ #1). Per caveat (b), this budget is also the container's spend ceiling for its N concurrent subagents.
- **Per-stage concurrency cap (Layer 2)** is the explicit replacement for the global `maxParallelAgents=4` counter the workflow entrypoint removes. Concurrency becomes a per-stage / per-role budget (so an implement burst can no longer starve review/validate), resolved at the `getRoleModel`/`getRoleTtl` policy seam in boot.ts — not new infrastructure, a new policy at existing seams.
- **Fan-out width cap (Layer 3)** bounds the genuinely new parallel-subagents axis. A review stage may shard, but to N subagents, not "however many lenses the agent invents." This cap is also the input to container sizing (caveat (b)): it fixes how many concurrent subagents one container must hold.
- **Cloud-spend gate (Layer 4) is FUTURE/optional.** It is load-bearing only *if* the deferred cloud ultrareview path is ever adopted (§4). When/if adopted, billed paths fire only when justified: gate on issue priority and rework-cycle count, and **skip entirely on the existing rebase-only diff-hash fast-track** (re-running a deep cloud review on a rebase-only diff is pure waste — the fast-track already proves the substantive diff is unchanged). Near-term, this layer is dormant: our own in-container judge-panel (§4) is subscription-billed and needs no cloud gate.
- **for-human (Layer 5)** is the backstop that already exists: `MAX_REWORK_CYCLES=3` escalates to `for-human`. A pathological issue cannot loop forever burning tokens; it lands on the owner's desk.

### 1.4 Residual risk

A misconfigured fan-out width, an absent concurrency cap, an under-sized container (caveat (b)), or a missing run-budget on a newly-migrated stage can still blow up *within* one stage before Layer 5 catches the issue. Mitigation: a new workflow stage ships with a conservative run-budget, concurrency cap, width cap, and container size by default; raising any of them is a deliberate edit, never the default. Treat the first production run of any migrated stage as a metered experiment (see §6).

---

## 2. Auth & Headless Constraints for Cloud "Ultra" Features

> **Scope note:** the constraints in this section bite on the **deferred, optional** cloud ultrareview path (§4) — the one genuinely non-Docker, billed, cloud-triggered, git-repo-requiring path. They are recorded here as things to weigh **IF/when ultrareview is adopted**, not commitments for the near-term plan. The near-term review story (our own in-container judge-panel, §4) is subscription-billed, runs in-container, and needs none of this. `ultrathink` on design stages is likewise in-container and subscription-billed — it carries **no** cloud constraint.

The deferred cloud feature (`ultrareview` / `/code-review ultra`) carries constraints the in-container subscription model never had. fritZ runs **headless** — the daemon autoloop spawns work with no human present — and this feature was designed around an interactive, user-triggered, billed session. That mismatch is why ultrareview is deferred rather than near-term.

| Constraint | Legacy / in-container | Cloud "ultra" path (deferred) | Implication IF/when adopted |
|---|---|---|---|
| **Trigger** | autoloop label, fully headless | user-triggered, explicit | Cannot be a silent autoloop default; needs an explicit gate/label |
| **Billing** | subscription token (OAuth env) | billed per run, off-subscription | usage-monitor blind to it; separate spend axis |
| **Git requirement** | always satisfied (branch+PR per agent) | requires a real git remote + PR | Satisfiable but with a real edge: docker-pinned and cross-repo stages (below) |
| **Auth surface** | `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` env | may need distinct cloud credentials/permissions | New credential to provision, rotate, and fail gracefully on |

Consequences to weigh **IF/when** the cloud path is adopted:

- **No silent default.** Were `ultrareview` adopted, it would be wired as a *budget-gated escalation* at the review gate (mapping its verdict onto the existing `--outcome=rejected` → `for-rework` contract), **never** the default reviewer. The **near-term** mandatory reviewer is our own in-container judge-panel (§4); a cloud-feature outage must degrade to that in-container review, loudly.
- **The git-repo requirement is satisfiable but not free.** Every fritZ agent works on a branch and opens a PR, so a real repo/PR always exists. Two real edges remain: (1) cross-repo issues carry `fritz.repo:owner/name[:branch]`, so a cloud review must target the PR's *actual* remote, not the daemon's host repo; and (2) any stage hard-pinned to docker (pentest/`fritz.lang:kali`, or a `fritz.lang` variant with no workflow template) cannot escalate to a cloud path that can't reach that remote — so for those stages, cloud ultrareview is simply unavailable.
- **Headless trigger maps to a label, not a session.** The user-triggered nature would be modeled as a `fritz.status:for-ultrareview` / escalation label or an explicit Telegram `/review`, decided by the gate in §1.3 (Layer 4) — not as the autoloop reflexively calling a billed cloud endpoint on every PR.
- **`report.sh ask` is the human-in-the-loop seam** that already suspends an agent until a human answers. Any cloud feature requiring interactive confirmation must route through that existing suspend/await contract, not block the daemon event loop.

Open auth question for the owner is in §5.

---

## 3. Determinism vs Nondeterminism, and How the State Machine Contains It

### 3.1 The honest admission

Almost everything the workflow entrypoint adds is *more* nondeterministic than the single-agent entrypoint it sits beside:

- **Fan-out** introduces ordering and merge nondeterminism (which of N parallel subagents finishes first, how findings merge).
- **`ultrathink`** deliberately trades deterministic output text for reasoning depth — same input, different (better) spec each run.
- **In-container judge-panels** are multi-subagent outputs; consensus is emergent, not fixed.
- **(Deferred) cloud runs** would add infrastructure nondeterminism (run scheduling, transient failures, fallback firing or not) — but only if the optional ultrareview path is ever adopted.

A naive reading concludes fritZ becomes less predictable. That conclusion is wrong, and the reason it is wrong is the core architectural bet.

### 3.2 The containment: nondeterminism lives *inside* a stage; the seams between stages stay deterministic

```
   ┌─────────────────────────────────────────────────────────┐
   │  DETERMINISTIC SHELL (unchanged, executor-agnostic)      │
   │                                                          │
   │   label ──► claimIssue (CAS) ──► [ entrypoint runs stage]│
   │                                        │                 │
   │                                  NONDETERMINISTIC         │
   │                                  in-container fan-out     │
   │                                  / ultrathink / judge     │
   │                                        │                 │
   │                                        ▼                 │
   │   getNextStatus(role,success,outcome,mode) ──► next label│
   │                          (pure function, github.ts:551)  │
   └─────────────────────────────────────────────────────────┘
```

The transition table — `getNextStatus` (github.ts:551), `releaseAgent` (github.ts:654), `getOrphanRestoreStatus` (github.ts:611), `claimIssue` (github.ts:465), `MAX_REWORK_CYCLES=3` (github.ts:173), rework counting, PR-verification, for-human escalation — is a set of pure functions over `(role, success, outcome, invocationMode)`. It does not care *how* a stage produced `success` or `rejected`; it only maps the verdict to the next label. So however nondeterministic the *interior* of a stage becomes, the *transitions between* stages remain a deterministic, finite, auditable state machine over a fixed label vocabulary.

Three further containment mechanisms make this real rather than aspirational:

1. **Verdicts are reduced to a closed enum.** A fan-out review's emergent output must collapse to exactly one of `success` / `--outcome=rejected` / failure before it touches the transition layer. The nondeterminism is forced through a deterministic gate.
2. **JSON-schema structured output, hard-failed.** Every workflow stage emits schema-validated structured output (the typed successor of report.sh's `{type,message,outcome}` and the UX_SPEC/TECH_SPEC/ESTIMATE artifacts). A stage whose output does not validate routes to `for-human` — it cannot silently degrade back to prose-parsing. This bounds the *shape* of the handoff (structure, not semantics): a fan-out review can still emit a schema-valid `rejected` for nondeterministic reasons, but a downstream stage can always *parse* what it receives.
3. **The parity test.** A test asserts identical `(role, success, outcome, mode) → nextStatus` for both entrypoints. Dual-entrypoint operation can never silently diverge: whatever the workflow entrypoint does inside a stage, it must drive the *same* transitions as the legacy entrypoint for the same verdict, or CI fails.

### 3.3 What is genuinely not contained

The *content* of a spec or review is not reproducible run-to-run (that is the point of ultrathink). If the owner ever needs bit-reproducible stage output for audit, ultrathink and judge-panels are the wrong tool for that stage. The architecture contains *control-flow* nondeterminism, not *content* nondeterminism — and only the former was ever a correctness property of fritZ.

---

## 4. Where This Could Be Over-Engineering (and When Legacy Is Simply Better)

This design earns its keep only where fan-out pays. It is important to name where it does not, so the rollout dial does not get turned past the point of value.

- **Near-term review is our OWN in-container judge-panel; cloud ultrareview is a deferred, optional escalation.** Security-review and review sit at the top of the fan-out ranking and genuinely earn the workflow entrypoint — and the **near-term target is an in-container judge-panel of in-process subagents** (correctness + quality + security lenses, **"all must approve"**) running inside the agent container against the PR/diff, emitting the **same `approved`/`rejected` outcome the legacy review agent does** (so `--outcome=rejected → for-rework` is reused verbatim; `getNextStatus`/`releaseAgent` unchanged). The legacy single-agent reviewer remains the **mandatory** in-container fallback on any cost, outage, or width-cap condition. Cloud `ultrareview` is **not** on this path: it is a deferred, optional, off-box escalation (its auth/billing/git/cloud-trigger constraints in §2 are things to weigh *if/when* adopted, not now). "Migrate" never means "delete the legacy path," even at the top of the ranking.

- **Single-threaded stages gain almost nothing from fan-out.** `ux`, `budget`, and `define` are single-coherent-artifact stages — one designer on one `UX_SPEC.md`, one estimator on one `ESTIMATE.md`, one orchestrator doing a sequential UX→Architect→Budget join. They are migrated *last* and only for durable resume (from the last journaled step, journal on a mounted volume — caveat (c)) + activity-based TTL + typed output — **not** for parallelism. If those three secondary benefits don't materialize for a given stage, migrating it is pure churn. Legacy single-agent entrypoint is fine.

- **`implement` is *write*-fan-out-bound, not multi-agent-bound — and the distinction is the whole correction.** The earlier framing ("implement is conflict-bound; fan-out is a merge-conflict generator") was right about **writer** fan-out and wrong as a blanket claim. The honest decomposition: implement-last is justified by (1) **single-writer rework sequentiality** (one branch, one PR, ordered feedback, max-3 cycles) and (2) **write blast-radius** (implement is the only near-term stage whose write becomes the merged artifact) — **not** by an unavoidable shared-branch merge hazard. That hazard is a *choice* of write topology, not intrinsic.
  - **Writer fan-out stays rejected as a default.** TOURNAMENT (N full-issue worktree attempts → judge panel → synthesis+graft) and DECOMPOSE-AND-PARALLELIZE (planner → file-partitioned implementers → integrator) convert one shared branch into N private branches but only **relocate** the cost to a serial graft/integrate step — which is the documented **issue #486** context-loss failure (`SKILL.md` Merge-Conflict-Recovery: three PRs, each agent lost context and reintroduced already-caught bugs, +4 rework cycles) industrialized. File-disjoint ≠ behavior-disjoint, so the integrator still hits *semantic* merge conflicts (compiles in isolation, breaks unified) that no partition prevents. They cost N× tokens on the highest-volume stage and maximize nondeterminism (§3) on the one stage that writes the merged artifact. **Retain them ONLY as default-off, budget-gated, opt-in escalations** (P0 ∨ ambiguous-spec ∨ auto-merge ∨ security-sensitive), hard attempt cap N=2–3, **never on rework**, **never on trivial diffs**, with mandatory full-gate-after-graft and ship-winner-un-grafted-on-graft-failure (06 §4 note).
  - **But implement IS promoted to a first-class multi-agent stage — via single-WRITER read-side fan-out.** Keeping **exactly one serialized writer** on **one branch** and fanning out only on the **read side** dissolves the branch-contention objection *structurally* — not by relocating it. Because writes stay serialized there is no concurrent-write contention to resolve and **no per-subagent worktree-isolation prerequisite** (and that prereq is *unverified in the codebase anyway* — §5 OQ #3); the test-deriver writes only new, criterion-partitioned acceptance-test files (trivially conflict-free), and the verifier/critics write nothing to the tree. Headline: the **TEST-FIRST PIPELINE** — a read-only test-deriver writes acceptance tests from the spec before code, the single writer codes to green against **locked** tests (the verifier diffs the test files against the deriver's commit and **rejects on any writer edit** — without that lock the pattern collapses back to today's self-grading), an independent **mutation-probe** verifier proves the suite genuinely constrains the spec — closing fritZ's weakest gate (self-graded tests, 01 §5; doc 02's "self-review theater") at ~2–2.5× cost, not N×. Second: the **ADVERSARIAL-CRITIC LOOP** — one writer + N read-only critics on the warm diff, looped-to-dry and capped (lenses de-duped vs the review judge-panel so the review is not paid twice; advisory-only, never the approval of record). The remaining durable-resume + typed-output wins still motivate the **single-agent** migrate-last baseline (Phase 5); the multi-agent promotion is Phase 5b/6b, default-off, shipped after the review judge-panel proves catch-rate, promoted only on a measured drop in rework cycles. (Note: there is **no host worktree** in v2 — the workflow entrypoint runs in-container exactly like the legacy entrypoint, so the old host-worktree isolation concern does not apply here; see §5 OQ #3.)

- **`pentest` and `retro` are pinned to the legacy entrypoint on purpose, indefinitely.** pentest needs a privileged Kali container (`fritz.lang:kali`, `NET_RAW`/`NET_ADMIN`, PTES tooling) with no workflow environment-template parity. retro consumes the post-hoc docker logs/session audit trail as its primary input; without an equivalent structured workflow run-log export (on a mounted volume — caveat (c)), retro loses its input. These are not "not yet" — they are "not unless the environment gap closes." Forcing them onto the workflow entrypoint would be over-engineering that *removes* capability.

- **`for-merge` is already agent-less.** findPR → CI check → mergeability → squash → close → remove label. Neither entrypoint touches it. Any proposal to "Workflow-ify" it is solving a non-problem.

- **The deletions are the patient end-state, not the opening move.** Retiring boot.ts container prep is *not* on the table at all — the container substrate is unchanged. What is eventually simplified (agent-comms.ts stream-json hand-parsing into a typed handoff, watchdog reconciliation tightened) is the *destination* — reached only after every migrated stage has a proven workflow equivalent. Deleting working fallbacks early is the over-engineering trap: it demotes a working entrypoint before the replacement is proven. The legacy entrypoint is a permanent co-equal default, never deprecated on a timeline.

The general rule: **fan-out-amenability ranking is also the over-engineering ranking, inverted** — but even the top of the ranking keeps its legacy fallback. Security-review/review/validate earn the workflow entrypoint; define/budget/ux/implement (bottom) must justify it on durability grounds alone, and pentest/retro must not migrate at all yet.

---

## 5. Open Questions Requiring a Decision from the Owner

These are genuine forks the design intentionally leaves open. Each needs a call before the corresponding work starts.

1. **Cloud-spend authority (only relevant IF cloud ultrareview is adopted).** What is the actual budget gate for the deferred billed path? Concretely: which priorities (P0 only? P0–P1?) and which rework-cycle thresholds would unlock `ultrareview`? And what is the per-day / per-issue hard cloud-spend ceiling above which the gate hard-fails to in-container review? The architecture provides the *mechanism* (Layer 4, dormant near-term); only the owner can set the *numbers* — and only if/when the cloud path is on the plan.

2. **Cloud credentials & isolation (only relevant IF cloud ultrareview is adopted).** Would the deferred cloud ultrareview path run under the same subscription identity, or a separate billed account/credential? This determines provisioning, rotation, and whether a cloud-auth failure is isolated from the subscription path that drives all of in-container fritZ. (If they share an identity, a cloud-side auth problem can poison the subscription path.) Moot until/unless ultrareview is adopted.

3. **DSL exposure & fan-out mechanism (the live one — caveat (a)).** Is the literal Workflow scripting DSL/tool (`pipeline()/parallel()/agent()`) exposed to the containerized `claude` CLI? **If not**, the identical fan-out is expressed via the already-wired agent-teams/teammate mechanism (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, agents.ts:413). Either way the fan-out is in-container — this question decides the *mechanism*, not the *location*. **This is also the question behind the worktree-isolation prereq for the rejected writer-fan-out shapes (§4):** whether per-attempt isolation is expressible in-container is unverified, which is one more reason writer fan-out stays a default-off escalation and the headline `implement` promotion uses single-writer read-side fan-out, which needs no such isolation.

   > **Note — the former "host-worktree trust boundary" question is moot for v2:** v2 keeps the container as the trust boundary and never introduces a host worktree, so it is only relevant if one ever ran the workflow program on the host, which v2 explicitly does not — and it no longer governs §4's `implement` recommendation.

4. **Container sizing for N concurrent subagents (caveat (b)).** The workflow entrypoint runs N in-process subagents in ONE container. What CPU/RAM per container is provisioned for N concurrent subagents (not 1), and how does the fan-out width cap (Layer 3) feed that sizing? Under-sizing a container is a within-stage blow-up vector (§1.4); the number must be set per migrated stage.

5. **Default rollout posture.** `fritz.yaml engine.byRole` is the dial. Does it start at *all-legacy-entrypoint* (every workflow run requires an explicit `fritz.engine:workflow` label — maximally conservative) or does security-review default to the workflow entrypoint once proven (faster adoption)? I.e., is the default opt-in per issue, or opt-out per stage?

6. **ultrathink scope: design stages only, or also triage?** ultrathink is gated to the design stages (architect/ux/budget + define synthesis) via the `getRoleModel`/`getRoleTtl` policy seam — all in-container, subscription-billed, no cloud. The one genuinely open part is the orchestrator's *triage/dependency reasoning*: it is reasoning-heavy and compounds downstream, and the design context already names it as an ultrathink seam — but it runs on *every* issue, so the token cost is broad. Include triage in scope, or hold ultrathink to the per-issue design stages only? Yes/no.

7. **Structured-output hard-fail blast radius.** A stage whose JSON-schema output fails validation routes to `for-human`. During early rollout, schemas will be wrong sometimes. Is `for-human` the right response, or should an invalid-output stage *fall back to the legacy entrypoint* (re-run the same stage single-agent) before escalating to a human? This trades human toil against double-spend.

---

## 6. The Recommended FIRST Experiment

### 6.1 What it is NOT

The first experiment is **not** the full workflow entrypoint across all stages. Standing up workflow dispatch, the durable run-journal on a mounted volume (caveat (c)), backend-aware watchdog seams, and structured-output validation across the board is the *architecture*, not the *first slice*. Leading with all of it means the three named hardening prerequisites (CAS-harden `claimIssue`, run-status orphan recovery, idempotent/reconcilable completion — see §6.4) must land *before* any value can, coupling the value-proof to the riskiest infrastructure.

### 6.2 The smallest viable slice: Phase 0 = in-container judge-panel review behind `fritz.engine:workflow`, default-off

The cheapest near-term proof is **our own in-container judge-panel review** on the `review` stage — *not* cloud ultrareview. It proves the workflow-entrypoint value (explicit, bounded, synthesized fan-out) on the single most fan-out-amenable read-only gate, while staying entirely inside the existing container substrate:

```
  CHANGES:  1 workflow-program entrypoint (review)  +  1 startAgent dispatch branch  +  1 config flag
  NEW ENGINE:        none (same Docker substrate, second entrypoint)
  NEW LABELS:        fritz.engine:workflow (default-off)
  STATE MACHINE:     unchanged
  CLAIM/RELEASE:     unchanged
  ENTRYPOINT FALLBACK: legacy single-agent reviewer (entrypoint fallback)
  CLOUD:             none — subscription-billed, in-container
```

- **At the review gate (in-container):** behind `fritz.engine:workflow` (default-off), the workflow-program entrypoint runs an **in-container judge-panel** of in-process subagents — correctness + quality + security lenses, **"all must approve"** — inside the agent container against the PR the implement stage *already opened*. It emits the **same `approved`/`rejected` outcome the legacy review agent does**, so `--outcome=rejected → for-rework` is reused verbatim and `getNextStatus`/`releaseAgent` are unchanged. **Entrypoint fallback** to the legacy single-agent reviewer on any failure or when the label is absent — fired loudly. Express the fan-out via the DSL if it is exposed to the containerized `claude`, else via the already-wired agent-teams mechanism (agents.ts:413) — caveat (a); either way it is in-container.
- **At define/architect (in-container):** add `ultrathink` to the design reasoning (TECH_SPEC depth, 10x-scale stress). In-container, subscription-billed, no cloud — unaffected by the cloud constraints of §2.
- **Sizing/budget ship with it (caveats (b), (c)):** the review container is sized for the judge-panel's N concurrent subagents (Layer 3 width cap feeds the sizing), with a conservative per-container run-budget (Layer 1). No durable run-journal is required for this stateless read-only stage; if any resume is later wanted, the journal must live on a mounted volume.

### 6.3 Why this is the right first experiment

| Criterion | Phase 0 result |
|---|---|
| Smallest diff | 1 entrypoint + 1 dispatch branch + 1 flag; zero new engine, same substrate |
| Proves value | Banks explicit/bounded/synthesized in-container fan-out on the top-ranked review gate, plus better specs via ultrathink |
| Reversible | Flip the flag off / omit `fritz.engine:workflow` → exact legacy single-agent behavior |
| Risk to legacy | Near-zero; runs *inside* the existing container substrate with the legacy entrypoint as fallback |
| No cloud exposure | Subscription-billed, in-container — none of §2's auth/billing/git/cloud-trigger constraints apply |
| Exercises the seam | Proves the `fritz.engine` label selects the entrypoint at the `startAgent` seam (agents.ts:957) without touching the transition core |

Phase 0 deliberately defers cloud ultrareview, the durable run-journal, the per-day cloud-spend ceiling, and every infrastructure hardening item — and *fixes no structural pain*. That is the point: it is the cheapest possible proof that the workflow entrypoint's in-container fan-out is worth the larger investment in the Janus architecture. If the in-container judge-panel does not demonstrably improve review catch-rate (and `ultrathink` spec quality) on real issues, the entrypoint-expansion program should be reconsidered before more dispatch surface is written.

### Future / optional cloud escalation (NOT near-term)

Cloud `ultrareview` (`/code-review ultra`) is an **explicitly deferred, optional, off-box augmentation** — the one genuinely non-Docker, billed, cloud-triggered, git-repo-requiring path. It is **not** part of Phase 0 and **not** on the near-term plan. *If/when* adopted later, it would slot in as a budget-gated escalation **above** the in-container judge-panel (mapping its verdict onto the same `--outcome=rejected → for-rework` contract), and only then do the constraints catalogued in §2 (auth surface, separate billing axis, real git remote + PR, headless cloud trigger) and the dormant Layer 4 cloud-spend gate (§1.3) and OQ #1–#2 (§5) come into play. Near-term review needs none of it.

### 6.4 The very next slice after Phase 0 proves value

Only once Phase 0 banks value, migrate the **single most fan-out-amenable, lowest-blast-radius stage — `security-review` — to the workflow entrypoint** (still in-container, same substrate), because it is read-only, already a partitioned AppSec/InfraSec pair, never contends for a writable branch, and merges additively. Crucially, the three hardenings below are **prerequisites for even this**, not freebies, and must land first:

- CAS-harden `claimIssue` (github.ts:465 is a verified non-atomic read-then-write).
- Re-ground orphan/0-turn recovery on a run-status `hadActivity` signal (registry `lastActivityAt` is display-only at registry.ts:67; `getOrphanRestoreStatus` at github.ts:611 already takes `hadActivity`, but it must be sourced from the in-container run, and any resume state must sit on a mounted volume — caveat (c)).
- Make completion idempotent (extend the existing `releasedAgents` map) and reconcilable by polling run/container status, so a lost/duplicated `report.sh`→`/api/notify` completion can't strand a stage at `fritz.status:active` with no container for the watchdog to find.

These fix pre-existing liabilities (non-atomic claim at github.ts:465; wall-clock TTL at registry.ts:286-290) that *added concurrency will expose*. Doing them before, not after, the first concurrent workflow stage is the difference between a controlled experiment and a debugging fire.

### 6.5 The smallest first implement experiment (Phase 5b proof slice)

The first implement multi-agent experiment is **NOT** the full TEST-FIRST PIPELINE across all languages, and it is emphatically **not** writer fan-out. It is the **smallest slice that proves the single-writer read-side fan-out earns its keep on QUALITY**: stand up the **TEST-FIRST PIPELINE on ONE language** (the repo's own Rust or TS), behind `fritz.engine:workflow` default-off, on a handful of issues with **concrete, testable acceptance criteria** (CRUD endpoint / parser / bugfix-with-reproducer — never a UX-feel or spike issue). The load-bearing new primitive to build and prove is **test-file locking + a mutation-probe harness** (re-run the suite under injected faults via the per-language tooling the implement skill already shells out to — `cargo test` / `npm test` / `ruff`). Keep the single writer phase byte-identical to the legacy implement so the only new surface is derive + verify.

**Hard cost controls on this slice (and on Phase 5b generally):**
- **Per-stage token budget** at the container level (07 §1.3 Layer 1 run-budget + Layer 3 width cap), sized for the N concurrent read-only subagents — derive/verify are cheap reads, so a conservative ceiling is fine.
- **Skip-on-trivial-diff:** a complexity predicate falls straight through to the legacy single-agent writer for config bumps / one-line fixes / renames (the SKILL solo-execution rule), so derive+verify never tax mechanical changes.
- **Attempt/iteration cap:** TEST-FIRST has no N (one writer); for the ADVERSARIAL-CRITIC LOOP variant, a hard loop-iteration cap (2–3) with "still-dirty-at-cap" surfaced as a residual-findings outcome, never an infinite loop. For the default-off writer-fan-out escalation, a hard attempt cap **N=2–3**.
- **Promotion gate:** advance the `engine.byRole` dial for implement to 5b only on a **measured drop in downstream review→for-rework cycles** on real issues — the same fallback-rate/quiet-window discipline as every other stage (06 §4) — and only **after** the in-container review judge-panel (Phase 0/2) has proven catch-rate, since the read-side critic loop is literally that panel run early.
- **Loud mandatory fallback** to the legacy single-agent implement entrypoint on any health failure, and **schema-invalid → for-human**. `rejected` from the verifier maps to implement's **existing** rework path (a parity-test item — there is no new transition).

**Two failure modes this slice must prove out (or it is not safe to promote):**
- **Locked tests can ossify a wrong interface.** Committing RED tests *before* discovery can lock in the wrong shape. The slice needs a **deriver-re-invoke escape distinct from implementer rework**, or the locked-files rule fights the max-3 rework cap — a wrong test should re-derive, not burn a rework cycle.
- **Mutation-probe has a false-positive tail.** Equivalent mutants (mutations that don't change behavior) can read as "survived" and wrongly reject. Use the **deterministic mutation signal as the PRIMARY gate** and skeptic prose as secondary, so the verifier does not block correct work on a behavior-neutral mutant.

---

**Bottom line:** v2 is **one Docker substrate, two entrypoints, one seam** — the legacy single-agent entrypoint and a workflow entrypoint that fans out N in-process subagents *in the same container*, synthesizes, and reports, selected by `fritz.engine` at the `startAgent` seam (agents.ts:948-958). The cost and nondeterminism risks are real but containable — by the per-container run-budget, a per-stage concurrency cap that replaces the global slot counter, container sizing for N concurrent subagents, and a transition core that keeps control-flow deterministic no matter how chaotic a stage's interior gets. The old host-worktree isolation risk is **resolved**: there is no host worktree; the container stays the trust boundary. And on `implement` specifically, the shared-writable-branch hazard that once justified implement-last is dissolved *structurally* by single-writer read-side fan-out (TEST-FIRST + critic loop) rather than relocated by worktree-per-attempt — single-agent implement still migrates last, then a default-off Phase 5b promotes it to first-class multi-agent, with N-writer tournament/decompose kept only as a budget-gated, never-on-rework escalation. Cloud ultrareview is a **deferred, optional, off-box escalation** whose auth/billing/git/cloud-trigger constraints we weigh only if/when we adopt it — near-term review is our own in-container judge-panel. Open questions await the owner. And the first move is not the engine and not the cloud — it is one in-container judge-panel entrypoint behind a default-off label, with the legacy entrypoint as fallback, proving the fan-out earns its keep before anything structural changes.
