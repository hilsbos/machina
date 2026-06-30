# Per-Stage Execution Mapping

> fritZ v2 "Janus" — Design Set Doc 05 of 7
> Audience: the owner + future implementers. Scope: how each pipeline stage maps onto the two **entrypoints** of the one Docker substrate, where ultrathink/ultrareview slot in, and the expected deltas vs. today's single-agent container.

> **One-line summary:** fritZ v2 (Janus) keeps ONE Docker substrate and adds a SECOND in-container entrypoint — a workflow program that fans out N in-process subagents in the same container, synthesizes, and reports — selected by the `fritz.engine` label at the `startAgent` seam. No second engine, no host execution. Near-term review is our own in-container judge-panel; cloud ultrareview is a deferred, optional, off-box escalation.

## 1. Purpose & framing

This doc translates the architecture's `stageDecisions` into an implementer-facing map. **One Docker substrate, two entrypoints.** The legacy entrypoint runs a single in-container agent; the workflow entrypoint runs an in-container fan-out of N subagents that synthesize and report. The container, not a cloud run, is still the unit of execution. It answers, per stage:

1. What does the stage run on **today** (legacy entrypoint — single in-container agent)?
2. What is its **workflow-program entrypoint** target shape (in-container fan-out), if any?
3. Does **ultrathink** apply (in-container, subscription-billed), and where? Does **cloud ultrareview** (deferred, optional) apply, and where would it escalate to?
4. What quality / latency / cost change should we expect relative to the legacy single-agent container?

The substrate is not hypothetical — in-container multi-agent fan-out is **already live**. Every agent container is started with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` injected unconditionally (`agents.ts:413`, "persistent mode is universal"), and the daemon already parses `session.subagentCount` and logs `🤝 Agent spawned N teammate(s)` (`agents.ts:197-204`, again on the stop path at `agents.ts:688-692`). The workflow-program entrypoint **does not invent** in-container fan-out — it **structures** capability the substrate already ships: today that fan-out is Claude's own Agent-Teams teammates inside the one container, spawned ad-hoc and counted post-hoc from session logs; the workflow entrypoint makes that fan-out **explicit, bounded, and synthesized** — same container, same substrate.

The governing constraints from the architecture, restated so this doc stands on its own:

- **One seam.** Entrypoint selection happens only inside `startAgent` (`agents.ts:948-958`). The seam is a near-thin router: a best-effort `refreshIssuesCache(...)` preamble (load-bearing — not removed) followed by the single dispatch tail `return startAgentDocker(options)` at `agents.ts:957`. No autoloop, `getNextStatus`, or label-vocabulary change.
- **Per-stage routing.** Resolved on every `for-{role}` transition: explicit `fritz.engine:<docker|workflow>` label → `fritz.yaml engine.byRole` default → fall back to `docker`. The label and seam select the **in-container entrypoint/program**, not a separate engine. One issue can mix entrypoints.
- **Labels are the only state.** Both entrypoints call the same CAS-hardened `claimIssue` (`github.ts:465`) on start and the same `releaseAgent` (`github.ts:654`) → `getNextStatus` (`github.ts:551`) on complete. A parity test asserts identical `(role,success,outcome,mode)→nextStatus` across entrypoints. The transition core is executor-agnostic (`github.ts:173, 465, 551, 611, 654`) and unchanged by which program the container runs.
- **Adoption order follows fan-out amenability.** security-review → review → validate first; define/implement last. Cloud ultrareview is a separate, deferred, optional cost axis — **not** on the near-term path.

Severity/quality of a migration is judged on the verified fan-out ranking (security-review #1 most amenable → define #8 most single-threaded), the shared-runtime cost of the stage (now amplified because one container hosts N concurrent subagents — see §6 "Concurrency"), and whether the stage writes to a branch (write contention = harder). Because fan-out runs **in-container**, the container remains the trust boundary throughout — there is no host worktree in v2, so no stage's untrusted external-repo code ever touches the host.

## 2. The master mapping table

The **Entrypoint (in-container)** column makes explicit that *all* fan-out is the container's own program fanning out N in-process subagents — there is no separate engine and no host execution. The legacy entrypoint runs one in-container agent; the workflow entrypoint runs the in-container fan-out.

| Stage | Legacy entrypoint (single in-container agent, today) | Workflow-program entrypoint (in-container fan-out) | ultrathink (in-container) | Rationale (from `stageDecisions`) |
|---|---|---|---|---|
| **security-review** | 1 container, AppSec+InfraSec "pair" inside one serialized session; loosely wired (on-demand / optional label) | **Phase 1 first mover.** In-container fan-out sharded by AppSec / InfraSec / file-module; additive findings merge → one report. Same container, N in-process subagents. | — | Rank #1: read-only static analysis, no shared mutable artifact, trivially shardable. Lowest blast radius; promotes the least-integrated stage into a first-class in-container `judge-panel` gate. **Success still routes to `for-human`** (`getNextStatus`, `github.ts:551`) — migration changes how findings are *produced*, not the transition; it is a parallel findings gate, not a blocking pipeline gate. |
| **review** | 1 container, Correctness+Quality "pair", "both approve" in prose | **in-container judge-panel (workflow entrypoint), all-must-approve** — correctness + quality + security lenses as in-process subagents in the same container, voting `approved`/`rejected` | — | Rank #2: orthogonal lenses, comments/verdict only (no branch writes), so no conflict. Emits the **same `approved`/`rejected` outcome the legacy review agent does**, so `--outcome=rejected → for-rework` is reused verbatim (review/validate are the only roles whose `rejected` routes to `for-rework`; all others go to `for-human`); `getNextStatus`/`releaseAgent` unchanged. Cloud ultrareview is **not** on this near-term path — it is an optional future off-box escalation (see §4). |
| **validate** | 1 container, QA+UX "pair", `gh pr checkout` + `npm run dev` inside it | in-container fan-out (qaValidator ‖ uxValidator) over **one** running app provisioned inside the same container; test-case sharding | — | Rank #3: lenses are parallel and findings merge, BUT one shared running app. The container provisions the env once; the in-process subagents share it read-mostly. Bounded win — environment stays the bottleneck. `rejected → for-rework` reused verbatim (per code, only review/validate route this way). |
| **architect** | 1 container, Builder/Breaker pair, sequential reasoning | in-container `agent()` (or bounded fan-out per subsystem) with mandatory Builder/Breaker **synthesis join**, all in-process | **Yes** — gated here | Moderately amenable: convergence join caps horizontal fan-out. ultrathink (in-container, subscription-billed) where TECH_SPEC quality compounds downstream (10x-scale stress). |
| **ux** | 1 container, single designer, explore→refine | single durable in-container `agent()` (no fan-out) emitting JSON-schema'd UX_SPEC | **Yes** — gated here | Largely single-threaded by construction. Migration buys durability + activity-TTL + typed output, not parallelism. |
| **budget** | 1 container, single estimator, estimate→validate | single durable in-container `agent()` emitting typed RICE/ESTIMATE | **Yes** — gated here | Single reasoning thread (anti-anchoring is one thread). Same durability/typed-output win; no fan-out. |
| **define** | 1 container running ux→architect→budget **inline & sequential** (Issue #206 constraint) | **Migrated LAST.** in-container `pipeline(ux, [architect ‖ budget])` + synthesis `agent()`, all in-process | **Yes** — on synthesis/triage | Most single-threaded; its *job* is the sequential join. The in-container pipeline lifts #206, but it emits one coherent artifact → migrate only after worktree + structured-output stability is proven. |
| **implement** | 1 container, depth-50 clone + bind mounts + credential file-copy, Driver/Navigator | **Migrate the single-agent shape LAST (Phase 5); then promote to a FIRST-CLASS multi-agent stage (Phase 5b) via single-WRITER read-side fan-out** — headline TEST-FIRST PIPELINE (§3.5), then ADVERSARIAL-CRITIC LOOP. Exactly ONE writer on ONE branch; fan-out is read-only. **Still in the same container** (no host worktree). Writer fan-out (tournament/decompose) is default-off/opt-in/never-rework only. | — | **Corrected rationale:** implement-last is justified by single-writer **rework sequentiality** (one branch, one PR, ordered feedback, max-3) and **write blast-radius**, NOT by an unavoidable shared-branch merge hazard — that hazard is a choice. Single-writer read-side fan-out (independent test-author + mutation-probe verifier, or read-only critic loop) keeps writes serialized, so it needs **no** worktree-isolation prereq and re-introduces no merge hazard. The container trust boundary is preserved — v2 never runs implement on the host. |
| **for-merge** | agent-less (findPR → CI → mergeability → squash → close → unlabel) | unchanged | — | Never an execution stage. Untouched by either entrypoint. |
| **pentest** | privileged Kali container (NET_RAW/NET_ADMIN, PTES tooling) | **legacy entrypoint only (hard pin)** | — | `fritz.lang:kali` hard-pins to the single-agent entrypoint indefinitely; no workflow-program template for the privileged Kali image yet. |
| **retro** | Docker, consumes post-hoc logs/audit trail | legacy entrypoint (until the workflow program exports an equivalent run-log) | — | Its primary input is the docker session audit trail (exit code + log tail + subagent parse). Stays until a structured run-log exists. |

Reading order for rollout: ship the **ultra-feature grafts first** (Phase 0, no entrypoint swap — ultrathink at define/architect, in-container), then turn on the **workflow-program entrypoint** top-down by amenability (starting with our own in-container judge-panel review), gated by the hardening prerequisites in §5. Cloud ultrareview is deferred to an explicitly-optional future escalation.

## 3. In-container workflow-program sketches (most-improved stages)

These are **pseudo-structure**, not runnable code. They describe phases, fan-out count, and the verify pattern only — **all subagents run in-process inside the SAME container** (no host execution, no cloud submission). All stages reuse `bootAgent`'s `BootResult` (identity/assignment/report.sh/knowledge/spec artifacts) as CONTEXT, call the CAS-hardened `claimIssue` first, and emit JSON-schema structured output validated by the daemon before `releaseAgent` (invalid → `for-human`).

> **How fan-out is expressed is mechanism-dependent.** Whether the literal Workflow scripting DSL (`pipeline()/parallel()/agent()`) is exposed to the containerized `claude` CLI is **unverified**. If it is **not** exposed, express the identical fan-out via the **already-wired agent-teams/teammate mechanism** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `agents.ts:413`) — the daemon already counts those teammates (`agents.ts:197-204`). **Either way the fan-out is in-container**: the sketches below describe an in-container program shape, not a cloud/durable-run submission.

**Every sketch below is implicitly wrapped by the mandatory fallback envelope** (architecture principle: transparent fallback-on-failure). If the workflow-program entrypoint fails to start or its subagents fail health, the daemon re-dispatches the already-claimed stage to the **legacy single-agent entrypoint** (`startAgentDocker` — same container substrate, one assignment) and emits a loud signal — shown explicitly once in §3.1, omitted from the rest for brevity. The daemon keeps babysitting the same container in either case; only the program inside it changes.

### 3.1 security-review — the cleanest win (rank #1)

```
WORKFLOW-PROGRAM security_review(issue):        # runs INSIDE the agent container
  context  = BootResult(issue)          # reused verbatim
  shards   = partition(changed_files, by = {AppSec, InfraSec, per-module})
                                         # in-container fan-out: N = |shards|, typically 2–6
  findings = in_container_fanout(        # N in-process subagents, one container
               for shard in shards:
                 subagent(role="security-auditor", scope=shard,
                          emit = FindingSet{severity, file:line, remediation})
             )                           # no shared mutable state → no join hazard
  report   = merge_additive(findings)    # union, dedup by (file,line,rule)
  VERIFY   schema_valid(report) ELSE -> for-human
  REPORT   report.sh --outcome=...       # same completion contract
  RETURN   StructuredOutput{outcome, report}   # outcome -> releaseAgent -> for-human

# --- mandatory fallback envelope: revert to the LEGACY single-agent entrypoint ---
try    run_workflow_entrypoint(security_review, issue)   # in-container fan-out program
catch  entrypoint_start_or_health_failure:
         loud_signal(Telegram + log + metric)            # never silently absorbed
         startAgentDocker(role="security-review", issue) # SAME container, legacy
                                                         # single-agent entrypoint,
                                                         # already-claimed stage
```

Verify pattern: **additive merge + schema validation**. There is no convergence step — findings are a set union. This is why it is the first mover. Note the stage's *success* still lands on `for-human` for triage of findings; the migration parallelizes how findings are gathered in-container, it does not turn security-review into an auto-forwarding gate.

### 3.2 review — in-container judge-panel, "all must approve" (rank #2)

The near-term review target is **our own in-container, workflow-driven judge-panel** of in-process subagents — correctness + quality + security lenses, **all must approve** — running inside the agent container against the PR/diff and emitting the **same `approved`/`rejected` outcome the legacy review agent does**.

```
WORKFLOW-PROGRAM review(issue, pr):              # runs INSIDE the agent container
  context = BootResult(issue)
  IF fast_track(rebase_only_diff_hash): RETURN cached_verdict   # skip layer
  verdicts = in_container_fanout(         # N in-process subagents, one container
               subagent(role="correctness", emit = Verdict{approve, findings}),
               subagent(role="quality",     emit = Verdict{approve, findings}),
               subagent(role="security",    emit = Verdict{approve, findings}),
             )
  panel   = judge_panel(verdicts, rule = ALL_MUST_APPROVE)
  outcome = panel.approved ? "approved" : "rejected"   # rejected -> for-rework (review-specific)
  VERIFY  schema_valid(panel.report) ELSE -> for-human
  REPORT  report.sh --outcome=$outcome   # reused verbatim; rejected -> for-rework
  RETURN  StructuredOutput{outcome, scoped_findings}
```

> The committed v1 shape is the in-container 2-way `parallel(correctness, quality)` pair; the all-must-approve panel above adds a security lens as a third in-process subagent. Finer per-category sharding (correctness / security / perf / dup / docs as separate workers) is a *future* extension, not the v1 target — but every shape is in-container.

`getNextStatus`/`releaseAgent` are **unchanged**: the panel drives the same label transition as the legacy review agent. Because the outcome contract is identical, `--outcome=rejected → for-rework` is reused verbatim — this `rejected → for-rework` mapping holds for review/validate only.

> **Cloud ultrareview is NOT on this path.** `/code-review ultra` is a deferred, optional, off-box escalation (see §4) — it is the one genuinely non-Docker, billed, cloud-triggered, git-repo-requiring path, and it is **not** part of the near-term review story. The near-term win is the in-container judge-panel above.

### 3.3 validate — bounded by shared runtime (rank #3)

```
WORKFLOW-PROGRAM validate(issue, pr):            # runs INSIDE the agent container
  env      = provision_in_container(pr)   # gh pr checkout + npm run dev — ONCE, in-container
                                          # this is the serial bottleneck, acknowledged
  results  = in_container_fanout(         # 2 in-process subagents over ONE shared app
               subagent(role="qa", env, shards=test_cases, emit=QAResult),
               subagent(role="ux", env,                     emit=UXResult{spec_compliance}),
             )
  VERIFY   schema_valid(results) ELSE -> for-human   # schema-invalid hard-fails
  VERIFY   acceptance_criteria_met(results)
           ELSE outcome = "rejected"      # -> for-rework (validate-specific)
  RETURN   StructuredOutput{outcome, merged_findings}
```

Verify pattern: **shared-env fan-out + additive findings**, gated on acceptance criteria. The honest caveat: in-process subagents parallelize across one environment inside one container; provisioning that environment does not parallelize. This is a *bounded* win — called out in the latency delta below.

### 3.4 define — pipeline that lifts Issue #206 (migrate last)

```
WORKFLOW-PROGRAM define(issue):                  # runs INSIDE the agent container
  ux_spec   = subagent(role="ux", ULTRATHINK)        # runs first (dependency root)
  arch      = subagent(role="architect", in=ux_spec, ULTRATHINK)
  est       = subagent(role="budget",    in=[ux_spec, arch], ULTRATHINK)
                                                     # budget consumes architect's scope:
                                                     # it starts on ux-only inputs then
                                                     # gates on arch before final RICE.
  # architect ‖ budget overlap ONLY where the dependency graph allows — budget
  # partially serializes behind architect, so this is partial, not full, parallelism.
  # All four are in-process subagents in the SAME container.
  unified   = subagent(role="synthesis", in=[ux_spec, arch, est], ULTRATHINK)
                                                     # coherence join: ONE artifact
  VERIFY    cross_spec_coherent(unified) AND schema_valid(unified) ELSE -> for-human
  RETURN    StructuredOutput{outcome, rice_scored_body}
```

> `ULTRATHINK` here is the **same `getRoleModel` policy gate already active in Phase 0** (legacy entrypoint), surfaced in the sketch only to mark where it applies — it is in-container and subscription-billed, **not** a workflow-entrypoint-only feature and **not** cloud.

Why last: define's deliverable is one coherent RICE-scored artifact on a shared spec dir, so it inherits every structured-output and worktree risk before it gets to add value. Its only horizontal parallelism is the *partial* architect‖budget overlap (budget needs architect's scope to finalize anti-anchored RICE, so the two cannot fully overlap), and that is gated behind proving the simpler read-only stages first. All of it stays in one container.

### 3.5 implement — single-WRITER read-side fan-out (Phase 5b, the headline multi-agent shape)

The implement stage becomes a **first-class multi-agent target** only via **read-side** fan-out that keeps **exactly ONE writer** on **ONE branch** — never writer fan-out. The headline shape is the TEST-FIRST PIPELINE; the ADVERSARIAL-CRITIC LOOP is an equivalent single-writer alternative. Both are in-container, both wrap (do not replace) the existing single-agent writer phase, so the migrate-last single-agent shape (Phase 5) is the proven baseline they build on.

```
WORKFLOW-PROGRAM implement(issue):              # runs INSIDE the agent container
  context = BootResult(issue)                   # reused verbatim
  IF trivial_diff(complexity_predicate):        # config bump / one-line / rename
       RETURN run_single_agent(issue)           # solo escape — skip derive+verify (SKILL solo rule)

  # ── PHASE A: DERIVE (read-only, fan-out-amenable) ──────────────────────────
  tests = subagent(role="test-deriver",
                   in=[issue, TECH_SPEC, UX_SPEC, acceptance_criteria],
                   emit=TestSuite{cases:[{criterion_ref, test_file, assertion_intent}]})
                                                # writes ONLY new, criterion-partitioned
                                                # acceptance-test files, committed RED.
                                                # may parallel() per criterion-cluster (no
                                                # write contention — disjoint new files).

  # ── PHASE B: IMPLEMENT-TO-GREEN (the SINGLE WRITER — unchanged from legacy) ─
  diff  = single_writer_agent(in=tests)         # the existing implement Driver/Navigator flow:
                                                # code + own unit tests, format/lint before every
                                                # commit, ONE feature branch. MAY NOT edit the
                                                # locked acceptance-test files (anti-gaming spine).

  # ── PHASE C: VERIFY-NOT-GAMED (read-only, adversarial) ─────────────────────
  verdict = subagent(role="test-verifier", isolation=read-only,   # never saw the writer's reasoning
                     checks=[ COVERAGE:  every criterion -> >=1 executed asserting test,
                              ANTI_GAME: mutation_probe(diff) -> each mutant must turn >=1 test RED ],
                     emit=VerifyResult{coverage_map, mutation_survivors})
  outcome = (verdict.ok AND test_files_unchanged_since_derive(tests)) ? "success" : "rejected"
                                                # rejected -> implement's EXISTING rework path
                                                #   (NOT a new transition — parity-test item)
  VERIFY  schema_valid(StructuredOutput) ELSE -> for-human
  REPORT  report.sh --outcome=$outcome ; gh pr create   # exactly ONE PR, as today
  RETURN  StructuredOutput{outcome, prUrl, coverage_map, mutation_survivors}
```

Verify pattern: **read-only/write/read-only sandwich + mutation-based anti-gaming**, gated on a locked-test contract. The fan-out is entirely on the read side (test-derivation, verification) — the writer phase is byte-identical to the legacy single-agent implement, so there is **no branch contention and no worktree-isolation prerequisite**. This is the one place doc 02 sanctions adversarial-verify *intra*-stage: a genuine producer (writer) / critic (independent verifier) asymmetry.

**Equivalent single-writer alternative — the ADVERSARIAL-CRITIC LOOP.** Same single writer + branch; replace Phase A/C with: writer commits → `parallel(critic(correctness), critic(security), critic(perf), critic(test-coverage))` read-only on the warm diff → same writer applies blocker/warning findings → re-commit → re-critique, **loop until dry OR a hard iteration cap (2–3)**. Read-only critics merge additively (no contention). Front-loads the review gate's catch-rate to collapse cross-container rework hops. Caveat: the critic panel is **advisory only** — it must NOT become the approval of record (the downstream review gate stays authoritative), and its lenses must be **de-duped** against the review judge-panel (§3.2) so the review is not paid twice.

**Cost:** TEST-FIRST is ~2–2.5× a single implement (Phase B unchanged; derive is a cheap read; verify scales with mutation-probe count, bounded by the §5 width cap). The critic loop is ~(1 writer) + (N critics × R rounds) + (1 synthesis) — heavier, and lands on the highest-volume stage, so the loop-iteration cap and width cap are load-bearing. Both are **far** cheaper than the rejected writer-fan-out shapes (N× full implementations + judge + graft).

> **Rejected here: writer fan-out.** TOURNAMENT (N full-issue worktree attempts → judge panel → synthesis+graft) and DECOMPOSE-AND-PARALLELIZE (planner → file-partitioned implementers → integrator) **lose to the single-agent steelman**: worktree-per-attempt converts one shared branch into N private branches but only *relocates* the real cost to a serial graft/integrate step — which is the documented #486 context-loss failure (`SKILL.md` Merge-Conflict-Recovery: three PRs, reintroduced bugs, +4 rework cycles) industrialized. They are retained ONLY as default-off, budget-gated, opt-in escalations (P0 ∨ ambiguous-spec ∨ auto-merge ∨ security-sensitive), with a hard attempt cap (N=2–3), **never on rework** (continue-from-existing-PR contract), **never on trivial diffs**, and never the headline.

## 4. Where ultrathink and (deferred) ultrareview slot in

These are orthogonal axes to the entrypoint choice. **ultrathink lands in Phase 0 with no entrypoint swap** (two SKILL.md prompts + one config flag, in-container). **Cloud ultrareview is deferred** — it is the only genuinely off-box path and is not on the near-term plan.

**ultrathink** (extended reasoning, in-container, subscription-billed, no new auth):
- Gated to **design/spec stages only**: `architect`, `ux`, `budget`, and `define`'s synthesis/triage reasoning.
- Wired via the `getRoleModel` / `getRoleTtl` policy seam in `boot.ts` (the same seam that resolves per-role model/TTL from `fritz.yaml`). **No entrypoint dependency** — it works on the legacy single-agent entrypoint today (Phase 0) and on the workflow-program entrypoint later, both **in-container, subscription-billed, no cloud**. The `ULTRATHINK` tags in the §3.4 sketch mark this same gate.
- Rationale: reasoning depth compounds *downstream* (a better TECH_SPEC saves implement/review cycles). It is explicitly **not** applied to implement/review/validate, where it raises cost/non-determinism without proportional payoff.

**Near-term review = our own in-container judge-panel** (see §3.2). The near-term review escalation is **not** cloud — it is the in-container all-must-approve panel emitting the same `approved`/`rejected` contract. No new billing axis, no git remote requirement, no host execution.

**Future / optional cloud escalation — ultrareview** (`/code-review ultra`, deep multi-agent **cloud** review, separately billed) — **DEFERRED, OPTIONAL, OFF-BOX:**
- This is the **one genuinely non-Docker, billed, cloud-triggered, git-repo-requiring** path — the only place the "real git remote + PR" and "separate billing axis" constraints actually bite. It is **NOT on the near-term plan.**
- If/when adopted, it would slot as an *augmentation* on top of the in-container judge-panel review (not a replacement of it), gated against the PR `implement` already opened.
- Hypothetical trigger gate (all hard preconditions, for the future state): (priority P0 ∨ large diff ∨ security-sensitive) **AND** within rework-cycle budget **AND not** on the rebase-only diff-hash fast-track (architecture principle 8 — the fast-track skip is non-optional).
- **Mandatory fallback** to the in-container judge-panel on any cloud failure, with a loud signal.
- It maps onto the *existing* `--outcome=rejected → for-rework` contract — the verdict drives the same label transition, so no state-machine change even in the future state.

Spend posture (architecture principle 8): cloud ultrareview is a **separate cost axis the subscription-only usage-monitor does not track**. Because it is deferred and optional, the near-term plan incurs no such untracked spend — in-container ultrathink and the in-container judge-panel are subscription-billed. If cloud ultrareview is ever turned on, it is gated on issue priority + rework-cycle count, with `for-human` as the hard backstop — never a silent default.

```
        ultrathink ──► design stages   (architect, ux, budget, define-synthesis)
                       via getRoleModel/getRoleTtl seam, IN-CONTAINER, entrypoint-agnostic
                       subscription-billed, no cloud (Phase 0+)

        in-container judge-panel ──► review gate, NEAR-TERM, all-must-approve
                       N in-process subagents (correctness/quality/security), one container
                       ↳ verdict → existing --outcome=rejected→for-rework contract
                       ↳ failure  → fallback to LEGACY single-agent entrypoint + loud signal

  - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
        ultrareview  ──► review gate, FUTURE / OPTIONAL, cloud-billed, off-box  (DEFERRED)
                        only genuinely non-Docker path; requires real git remote + PR
                        gate = (P0 | large | security) & within-rework-budget & !fast-track
                        ↳ verdict → same --outcome contract
                        ↳ failure  → fallback to in-container judge-panel (mandatory) + signal
```

## 5. Hardening prerequisites (gate the concurrency-increasing stages)

Per architecture principle 6, these are **not freebies** — they must land *before* any workflow-program entrypoint that raises in-container concurrency (i.e. before security-review fans out):

1. **CAS-harden `claimIssue`** (`github.ts:465` is a non-atomic read-then-write): conditional-on-absence-of-`active`/`blocked`, single combined edit, optimistic-concurrency retry. Added concurrency will expose the double-claim race.
2. **Re-ground orphan/0-turn recovery on a reliable `hadActivity`** (`getOrphanRestoreStatus` at `github.ts:611` already takes `hadActivity`). With N in-process subagents in one container, the heartbeat must reflect *any* subagent's activity, not just the entrypoint process, or the watchdog over-restores to `for-rework` and burns a cycle.
3. **Idempotent + reconcilable completion** (extend the `releasedAgents` map; poll run status) so a lost/duplicated `/api/notify` webhook can't strand a stage at `fritz.status:active` with no container to find.

Plus the always-on observability requirement: **a loud Telegram/log/metric signal on every fallback to the legacy single-agent entrypoint**, and **hard-fail (→ `for-human`) any stage whose structured output fails schema validation**.

**Container resource sizing & durability** (new with in-container fan-out):

- **Size CPU/RAM per container for N concurrent subagents, not 1.** Because the workflow-program entrypoint runs N in-process subagents in a single container, that one container now carries N concurrent reasoning/tooling loads (and, for validate, a running app alongside them). Provision the container for the configured fan-out width, not for a single agent — under-sizing surfaces as OOM-kills or thrash that the daemon would misread as a stage crash.
- **Apply per-stage token budgets at the container level.** The fan-out width cap and the run-budget bound the cost of N subagents inside one container; enforce both per container so a wide fan-out cannot blow the per-stage budget.
- **Durable run-journal lives on a MOUNTED volume.** Any "durable resume / run-journal / checkpoint" for the workflow-program entrypoint must write the journal to a **mounted volume** — container-ephemeral storage is lost on crash, which would defeat resume. The honest claim is *resume from the last journaled step, where the journal is on a mounted volume; in-flight, uncheckpointed reasoning is not guaranteed.*

## 6. Expected deltas vs. the legacy single-agent stage

Baseline = today's legacy entrypoint: one container per stage running a single in-container agent, full image inspect/pull + `gh repo clone --depth=50` + credential file-copy on **every** hop, a `sleep infinity` container holding 1 of 4 global slots for a wall-clock TTL even while idle, no *explicit* intra-stage parallelism (today's fan-out is Claude's own Agent-Teams teammates inside the one container, spawned ad-hoc and counted post-hoc — `agents.ts:413`, `:197-204`), crash = restart from shallow clone.

| Stage | Quality Δ | Latency Δ | Cost Δ | Notes |
|---|---|---|---|---|
| **security-review** | ↑↑ catches more (N independent in-container shards, first-class gate vs. loosely-wired) | ↓ shards run concurrently in one container; wall-clock ≈ slowest shard, not sum | ↑ token (N subagents) / ↓ infra (no per-hop clone+credential-copy) | Best ROI. Read-only → no contention. Success still → `for-human`. Size the container for N subagents. |
| **review** | ↑ (in-container judge-panel consensus is explicit, not prose; all-must-approve adds a security lens) | ↓ vs. serialized pair | ↑ token only; **no billed cloud spend near-term** (cloud ultrareview deferred/optional) | Fast-track (diff-hash) skip preserved → no spend on rebase-only. Same `approved`/`rejected` contract → `for-rework` reused verbatim. |
| **validate** | ↑ (parallel QA/UX in-container, test sharding) | **≈ / modest ↓** — env provisioning stays serial inside the container (honest: bounded win) | ↑ token / ↓ infra | Shared running app is the floor; don't promise big latency wins. Size container for N subagents + the running app. |
| **architect** | ↑↑ (ultrathink: 10x-scale stress, deeper TECH_SPEC) | ↑ (extended reasoning) — convergence join limits parallel speedup | ↑↑ token (ultrathink, in-container/subscription) | Quality compounds downstream; net pipeline cost often **down**. |
| **ux** | ↑ (typed UX_SPEC, ultrathink) | ↑ reasoning, but ↓ no per-hop boot tax | ↑ token | No fan-out; win is durability + typed output + activity-TTL. |
| **budget** | ↑ (typed RICE) | ↑ reasoning | ↑ token | Single thread; durability + schema are the wins. |
| **define** | ↑↑ (lifts #206 → partial architect‖budget overlap; coherence synthesis) | ↓ vs. inline-sequential (partial overlap; budget partially gated on architect) | ↑ token | Migrated last; biggest *structural* unlock but highest risk. Overlap is partial, not full. All in one container. |
| **implement** (Phase 5, single-agent) | ≈ (single agent; correctness unchanged) | ↓ big — in-container worktree replaces depth-50 clone + bind mounts + credential copy | ↓ infra | Migrated last; durable run *resumes* on crash (from the mounted-volume journal) instead of restarting. Container trust boundary preserved — no host worktree. Quality Δ≈flat — the cheap win, banked first. |
| **implement** (Phase 5b, TEST-FIRST / critic-loop) | ↑ closes the self-graded-tests gap (independent mutation-probe-verified acceptance contract; or read-only critic loop on the warm diff) | ≈ / modest ↑ per issue (derive + verify tail, or capped loop), but ↓ *pipeline* latency via fewer cross-container rework hops | ↑ token (~2–2.5× for TEST-FIRST; N×R for the loop — both bounded by §5 width + run-budget caps) / offset by avoided rework-cycle container hops | Single WRITER, read-side fan-out → no branch contention, no worktree-isolation prereq. Default-off; loud legacy fallback. Promote ONLY on a measured drop in rework cycles. |

Cross-cutting deltas that apply to **every** stage running the workflow-program entrypoint:

- **Latency:** eliminates the per-hop boot tax — image inspect/pull + `gh repo clone --depth=50` + credential file-copy + fixed 2s post-`docker run` wait + `claude --version` capture (all in `boot.ts` / `agents.ts startAgentDocker`). For a multi-hop issue (implement→review→validate→rework→…) this tax is paid once per hop today and largely disappears.
- **Concurrency:** the single global `maxParallelAgents=4` cap can be lifted toward per-stage/per-team budgets; intra-stage fan-out becomes **explicit, bounded, and synthesized** instead of "Claude's own Agent-Teams teammates inside one container, counted post-hoc" (`agents.ts:413`, `:197-204`). **But one container now hosts N concurrent subagents:** size CPU/RAM per container for N (not 1) and apply the per-stage token budgets (fan-out width cap + run-budget, §5) at the container level. The substrate is the same container — only the number of in-process subagents inside it grows.
- **TTL correctness:** activity-based TTL via the existing `report.sh → /api/notify` heartbeat replaces wall-clock-from-`started` expiry (`registry.ts:286-290`) so a long-but-active stage stops being killed mid-work — **contingent on the heartbeat re-grounding in §5 prereq 2** (it must reflect any in-process subagent's activity, not just the entrypoint process; not a freebie).
- **Crash recovery:** durable execution resumes from the last journaled step rather than restarting from a shallow clone — **provided the run-journal is on a mounted volume** (container-ephemeral storage is lost on crash; in-flight uncheckpointed reasoning is not guaranteed). Idempotent completion removes the watchdog's "assume completed if process is gone" guess.
- **Spend visibility:** per-stage token budgets replace the coarse global 80% usage-pause. The near-term path is subscription-billed (in-container ultrathink + in-container judge-panel); the only billed cloud path — ultrareview — is **deferred and optional**, and if ever enabled is gated, not just observed.

**Net:** read-only findings stages (security-review, review, validate) deliver quality-up / latency-down / billed-cost-flat — review's near-term review is our own in-container judge-panel, so it stays subscription-billed (cloud ultrareview is deferred/optional). Design stages trade in-container reasoning-time cost for downstream-cycle savings via ultrathink. Generative/branch-writing stages (implement, define) gain durability (mounted-volume journal) and infra-cost reduction more than raw parallelism, which is exactly why they migrate last. Throughout, **the container — not a cloud run — remains the unit of execution and the trust boundary.**
