# New Capabilities: Workflow fan-out, ultracode, ultrathink, ultrareview

> **Design set:** fritZ v2 "Labels-as-Truth, ONE Docker Substrate, TWO Entrypoints, One Seam" (codename: Janus) — doc 02 of 7.
> **One-line summary:** *fritZ v2 (Janus) keeps ONE Docker substrate and adds a SECOND in-container entrypoint — a workflow program that fans out N in-process subagents in the same container, synthesizes, and reports — selected by the `fritz.engine` label at the `startAgent` seam. No second engine, no host execution. Near-term review is our own in-container judge-panel; cloud ultrareview is a deferred, optional, off-box escalation.*
> **Scope of this doc:** what the four native Claude Code capabilities actually provide, and exactly where each one lands in the existing fritZ pipeline. This is a capabilities-and-opportunity map, not an implementation plan (see docs 03–07 for routing, hardening, and rollout).
> **Non-goals:** no source code; ASCII diagrams and pseudo-structure only. The seam mechanics (`startAgent` router, `claimIssue`/`releaseAgent` contract) are described elsewhere; here they are referenced only where a capability plugs into them.

---

## 0. Why this doc exists

fritZ today couples three things that the rest of the v2 design deliberately separates: a **label state machine** (good — keep it), a **single-agent-per-Docker-container entrypoint** (today's program inside the container), and **hand-rolled stream-json messaging** (incidental). The four native capabilities below are not a rewrite mandate — they are the menu of **in-container program** primitives that the **workflow-program entrypoint** draws on. Each is evaluated for **what it provides**, **what it costs**, and **which pipeline stage it serves**, because the v2 rollout migrates stages one at a time along the fan-out-amenability ranking, not all at once.

**One Docker substrate, two entrypoints.** The legacy entrypoint runs a single in-container agent; the workflow entrypoint runs an in-container fan-out of N subagents that synthesize and report. The container, not a cloud run, is still the unit of execution. v2 does **not** add a second execution engine and does **not** move execution to the host — it changes the container's **program** (its entrypoint), not its substrate.

**The substrate already runs in-container multi-agent — v2 structures it, it does not invent it.** This is verified against live source, not aspirational:

- Every agent container already receives `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (`agents.ts:413` — "Agent Teams: inject env vars for all agents (persistent mode is universal)"). In-container multi-agent is already wired on.
- The daemon already parses `session.subagentCount` and logs `🤝 Agent spawned N teammate(s)` (`agents.ts:197-204`, duplicated on the stop path at `agents.ts:688-692`). The daemon **already counts in-container teammates**.
- Agents are driven **in-container** via `docker exec -i <container> claude` with `--input-format stream-json --output-format stream-json` (`agent-comms.ts:5-9` doc; one-shot fallback at `:357-368`; persistent session at `:442-468`). The container runs `sleep infinity`; the daemon orchestrates it from outside.

So today's intra-stage fan-out is **Claude's own Agent-Teams teammates inside the one container, spawned ad-hoc and counted post-hoc from session logs**. The workflow entrypoint makes that fan-out **explicit, bounded, and synthesized** — *same container, same substrate.*

The single fact that makes all of this cheap to adopt: `startAgent` (`agents/agents.ts:948`) is a **thin router** whose only branching logic is the final `return startAgentDocker(options)` at `:957`. It is *not* a literal one-liner — it runs a small, side-effecting preamble common to both entrypoints before delegating:

```
export async function startAgent(options: BootOptions): Promise<string> {
  const repo = config.githubRepo;                     // agents.ts:951
  if (repo) {
    const [owner, name] = repo.split('/');
    refreshIssuesCache(owner, name).catch(() => {});  // :954  best-effort, pre-boot
  }
  return startAgentDocker(options);                   // :957  the only branch point
}
```

That `refreshIssuesCache` call is load-bearing: it ensures boot sees the latest labels. A workflow-program entrypoint must **preserve (or deliberately relocate) that pre-boot cache refresh**, or it boots against staler labels than the legacy entrypoint. With that caveat, the seam is still a single, near-trivial dispatch point: the entire transition table behind it (`claimIssue:465`, `getNextStatus:551`, `getOrphanRestoreStatus:611`, `releaseAgent:654`, `MAX_REWORK_CYCLES=3` at `:173`) is **entrypoint-agnostic**. Every capability below attaches at or behind that one seam, or as a policy flag on the boot path. Nothing here touches the label vocabulary or the autoloop pull engine. **Janus = two entrypoints, one substrate, one seam.**

---

## 1. Claude Code Workflow fan-out (the workflow-program entrypoint)

**What it is.** The workflow entrypoint is the native orchestration shape *inside the container*: a stage is authored as an **in-container program** — `pipeline()`, `parallel()`, and `agent()` composing **in-process subagents in the SAME container** — which synthesizes one result and calls `report.sh`, rather than running the single legacy assignment. It is the native, structured replacement for fritZ's ad-hoc Agent-Teams teammates: the same in-container fan-out, made explicit, bounded, and synthesized. The daemon keeps babysitting the same container; only the program inside it changes.

> **Caveat (a) — DSL exposure is unverified; express fan-out via whichever mechanism is actually wired.** Verify whether the literal Workflow scripting DSL/tool (`pipeline()` / `parallel()` / `agent()`) is exposed to the containerized `claude` CLI. **If it is not**, express the identical fan-out via the **already-wired agent-teams/teammate mechanism** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `agents.ts:413`) that the daemon already counts (`agents.ts:197-204`). **Either way the fan-out is in-container.** The shapes below are an in-container *program shape*, not a cloud/durable-run submission.

### 1.1 The primitives and what each replaces in fritZ

| Workflow primitive | What it provides | fritZ thing it subsumes |
|---|---|---|
| `agent()` | One in-container subagent on its own working context; resumable from journal (see caveat (c)) | One serialized persistent in-container `claude` session (`agent-comms.ts:442-468`) inside the existing `sleep infinity` container |
| `parallel(a, b, …)` | **Explicit, bounded, synthesized** intra-stage fan-out; findings merge additively | The substrate's **existing** in-container fan-out — today Claude's own Agent-Teams teammates (`agents.ts:413`), spawned ad-hoc and counted post-hoc from session logs (`agents.ts:197-204`); the workflow entrypoint **structures** it, it does not invent it. (Autoloop still processes issues serially.) |
| `pipeline(s1, s2, …)` | Ordered stages with dependency edges | The inline-sequential `ux→architect→budget` join in `define` (the Issue #206 constraint) and the wave-orchestration DAG |
| JSON-schema structured output | Machine-checkable typed stage result | `report.sh`'s free-text `{type,message,outcome}` + the `UX_SPEC`/`TECH_SPEC`/`ESTIMATE` markdown artifacts |
| In-container working context | Per-subagent branch/workspace partitioning **inside the one container** (no host worktree) | Per-container Docker volume mounts + `gh repo clone --depth=50` + credential file-copy — unchanged; the container remains the trust boundary |
| Per-run token budget | Per-stage spend cap and attribution, **applied at the container level** | The coarse global usage-monitor 80% autoloop pause (no per-issue/per-role attribution today) |
| `adversarial-verify` | A separate critic/verifier subagent distinct from the producer | The "mandatory Self-Review phase" that today is the *same* agent critiquing itself |
| `judge-panel` | N independent in-container judges + a consensus join | The "both reviewers must approve" verdict in `review`; could optionally power multi-judge RICE scoring in `define`/`budget` |

> **Caveat (b) — one container now hosts N concurrent subagents; size it and budget it.** Because the workflow entrypoint runs N in-process subagents in a single container, **size CPU/RAM per container for N concurrent subagents** (not 1), and **apply the per-stage token budgets** (the fan-out width cap + run-budget of doc 07 §1.3) at the **container** level. The fan-out is bounded so the container's footprint is bounded.

### 1.2 Structural shape per stage (pseudo-structure, not code — all in-container)

```
security-review := parallel( appsec_auditor, infrasec_auditor, … )
                     -> merge-findings -> JSONSchema<SecurityReport>      # additive, read-only

review         := judge-panel( correctness_reviewer, quality_reviewer, security_reviewer )
                     -> "all must approve" join -> JSONSchema<ReviewVerdict{outcome}>
                     # our OWN in-container judge-panel — emits the same approved/rejected
                     #   outcome the legacy review agent does (ultrareview is future-optional, §4)

validate       := provision-worktree-app (gh pr checkout + npm run dev)   # ONE shared runtime
                     -> parallel( qa_validator, ux_validator )            # share it read-mostly
                     -> merge -> JSONSchema<ValidateVerdict{outcome}>

define         := pipeline( ux, [ architect || budget ], synthesis )      # lifts Issue #206
                     -> JSONSchema<DefinedIssue{rice, specs[]}>

implement      := agent( in-container working context )                   # Phase 5: single writer
                     -> then single-WRITER read-side fan-out (Phase 5b, §1.3):
                          TEST-FIRST PIPELINE | ADVERSARIAL-CRITIC LOOP    # ONE writer, ONE branch
                     -> JSONSchema<ImplementResult{prUrl, outcome}>
                     # writer fan-out (tournament/decompose) = default-off escalation only (03, 07 §4)
```

### 1.3 The two patterns called out by name

These are distinct primitives, but they are **not both required per stage** — most stages use exactly one:

- **adversarial-verify** — the producer/critic split. The win over today's model is that the critic is a *genuinely independent subagent*, not the same context re-reading its own work, so the self-review pass stops being theater. In the pipeline, the cleanest adversarial-verify split is *across* stages: `implement` produces, `review`/`validate` critique. Within a single stage it applies only where a real producer/critic asymmetry exists.
- **judge-panel** — N peer judges + an explicit consensus join. This is the right model for `review` and `validate`, whose agents are *peers on orthogonal axes* (Correctness vs Quality vs Security; QA vs UX) joined by "all must approve" — not a producer and its critic. The pseudo-structure in §1.2 therefore uses `judge-panel` for those stages, **running in-container**. The pattern generalizes: `budget`'s RICE scoring can *optionally* become a multi-judge median to fight anchoring, and `security-review` becomes a real consensus gate instead of an optional `for-security-review` label.

In short: pick **one** pattern per stage. Use judge-panel where the agents are peers (review, validate, security-review); reserve adversarial-verify for genuine producer→critic boundaries (largely the cross-stage implement→review handoff).

**There is also a legitimate *intra*-`implement` producer/critic asymmetry — and it is the basis for promoting implement to a primary multi-agent stage.** adversarial-verify is sanctioned within a single stage "only where a real producer/critic asymmetry exists," and `implement` has two of them, both keeping **exactly ONE writer** so the shared-branch merge hazard that motivates implement-last never arises:

- **TEST-FIRST PIPELINE (headline shape for implement).** A read-only `test-deriver` writes acceptance tests from the issue/`TECH_SPEC`/`UX_SPEC` *before* any code (so the tests encode the spec's intent, not the code's behavior); the single writer codes to green against those **locked** tests; an independent read-only `test-verifier` runs adversarial-verify by *mutation probe* (inject an off-by-one / return a constant / comment out a criterion's production code — a test that stays green under mutation is theater) and confirms every acceptance criterion maps to ≥1 asserting test. This is a genuine producer→critic split that closes fritZ's weakest gate today (tests "written alongside implementation" and self-graded — see 01 §5). Cost is ~2–2.5× a single implement (the two added roles are read-only), **not** N×, because the writer phase is unchanged.
- **ADVERSARIAL-CRITIC LOOP (second shape).** One serialized writer commits the diff; N read-only critics on orthogonal lenses (correctness / security / perf / test-coverage) try to *break* the committed diff; the same single writer fixes; loop until the critics go dry or a hard iteration cap. Read-only fan-out, so no branch contention; it front-loads the review gate's catch-rate onto the warm diff to collapse cross-container rework hops.

Both express their read-side fan-out via the same in-container mechanism as every other stage (Workflow DSL if exposed, else the already-wired agent-teams mechanism — caveat (a)). The key property is that **writes stay serialized**, so neither needs the per-subagent worktree-isolation that the rejected *writer*-fan-out shapes (TOURNAMENT, DECOMPOSE — see 03, 07 §4) are load-bearing on, and which is unverified in the codebase (OQ #3).

### 1.4 How a Workflow stage drives the state machine (no change to the transition core)

```
autoloop sees fritz.status:for-{role}          # autoloop.ts pull engine, UNCHANGED
   -> spawnIfNoAgent -> startAgent({role,issue})          # call site UNCHANGED
        -> [router] fritz.engine:workflow -> workflow-program entrypoint
              (1) refresh issue cache              # SAME pre-boot refresh as legacy path (§0)
              (2) github.claimIssue()              # SAME CAS-hardened claim, github.ts:465
              (3) reuse bootAgent BootResult        # identity/assignment/report.sh/specs
              (4) run the in-container fan-out program (1.2) inside the SAME container
              (5) synthesize -> emit JSON-schema output -> daemon validates
                    valid   -> releaseAgent(... outcome)   # getNextStatus :551, UNCHANGED
                    invalid -> route to for-human          # hard-fail, no prose fallback
```

The `fritz.engine:<docker|workflow>` label and the `startAgent` seam select the **ENTRYPOINT** (which in-container program runs), **not** a separate engine. The label name and the seam are preserved; only their *meaning* shifts from "which executor" to "which in-container entrypoint."

Progress/ask/complete still flow through the transport-agnostic `report.sh → /api/notify + /api/ask` contract (`autoloop.ts` spawn path; `github.ts` transition core). Activity heartbeats on that channel **enable** activity-based TTL — but only *if* `getExpiredAgents` (`registry.ts:286`) is changed to consult the heartbeat. Today that function computes expiry as wall-clock `started + ttl*1000`, and `lastActivityAt` (`registry.ts:67`) is explicitly display-only and does **not** reset TTL; the README's "resets on activity" claim is currently false. Making it true is a registry/watchdog code change (out of scope here), not a free consequence of the workflow entrypoint — the heartbeat channel is the *prerequisite*, not the fix.

> **Caveat (c) — durable resume requires a MOUNTED volume.** "Durable resume / run-journal / checkpoint" is **not** a free consequence of the workflow entrypoint: container-ephemeral storage is lost on crash, which would defeat resume. The honest claim is *"resume from the last journaled step, **where the journal is on a mounted volume**; in-flight uncheckpointed reasoning is not guaranteed."* The entrypoint that ran a stage is recorded as a backend tag on the registry run-handle (generalizing `updateContainer`'s `containerId` at `registry.ts:189` to a backend-tagged `runId` — no schema change), and **that handle, not the live label, is authoritative** for watchdog/orphan reconciliation. The container, not a cloud run, remains the unit of execution.

---

## 2. ultracode — standing opt-in

**What it is.** A *config-level default*: with ultracode on, the orchestrator's planning/triage brain **selects the workflow-program entrypoint by default** for routed work, rather than the human/triage path deciding ad-hoc. It changes the *default entrypoint*, not the routing decision — and never the substrate (still Docker).

**Where it applies in fritZ v2.** ultracode sets the workflow entrypoint as the `fritz.yaml` default *for work already routed to `engine:workflow`*. It does **not** override the entrypoint router. Precisely:

```
ultracode ON  ==  fritz.yaml engine.byRole default leans "workflow" entrypoint
                  AND triage authors an in-container fan-out program by default
            !=  "everything is the workflow entrypoint"   (label + lang hard-overrides still win)
```

**When it does NOT apply.** Any stage hard-pinned to the legacy entrypoint — `fritz.lang:kali`/`pentest` (needs `NET_RAW`/`NET_ADMIN` + Kali image; the single-agent legacy entrypoint is the only fit), any `fritz.lang` variant lacking a workflow-program template, `retro` (audit-trail dependent), and any stage during a kill-switch drain — ignores ultracode and uses the legacy entrypoint. ultracode is the *default-leaning dial*; the three reversibility levers (default-off, fallback-on-failure, kill-switch) sit above it.

**Cost posture.** Low marginal cost, headless-friendly. Its only risk is *determinism-of-launch*: it changes *which in-container program* starts (single-agent vs fan-out), so it ships only after the parity test (identical `(role,success,outcome,mode)→nextStatus` for both entrypoints) is green.

---

## 3. ultrathink — extended reasoning

**What it is.** Extended reasoning depth at call time, **in-container, subscription-billed**. Pure reasoning-time spend — **no new auth, no cloud, no git requirement, no off-box hop**. Higher token cost per call, lower determinism of output *text*, higher *quality* of design judgment. (Note: ultrathink is unaffected by the Janus reframe — it is an in-container reasoning dial on either entrypoint.)

**Where it applies — design/spec stages only.** ultrathink is gated through the existing model/TTL policy seam (`getRoleModel`/`getRoleTtl` resolution in `boot.ts`), not sprinkled everywhere:

| Stage | What ultrathink buys |
|---|---|
| `architect` | Deeper `TECH_SPEC`; Breaker stress-testing at 10x scale and failure modes where spec errors compound downstream |
| `ux` | Better explore→refine reasoning on the single coherent `UX_SPEC` |
| `budget` | Stronger anti-anchoring on the single estimate→validate `ESTIMATE` thread; optional multi-judge RICE |
| `define` (synthesis) | Cross-spec coherence and triage/dependency reasoning |

**Where it does NOT apply.** `implement`, `review`, `validate` — these are execution/checking stages where reasoning depth does not compound the same way and the token cost is not justified. Gating to design stages is deliberate: that is where one good decision pays off across the whole downstream pipeline. (Note: implement's Phase 5b single-WRITER read-side fan-out — §1.3 — earns its quality gain from the *structure* of the producer/critic split, not from extended reasoning depth; ultrathink still does not apply.)

---

## 4. ultrareview / `/code-review ultra` — DEFERRED cloud escalation (off-box)

**Near-term review is our OWN in-container judge-panel — not this.** The `review` stage's near-term target is the **in-container judge-panel** of §1.2: in-process subagents on correctness + quality + security lenses, **"all must approve,"** running inside the agent container against the PR/diff, emitting the **same `approved`/`rejected` outcome the legacy review agent does** (so `--outcome=rejected → for-rework` is reused **verbatim**; `getNextStatus`/`releaseAgent` unchanged). That is the standard near-term placement: **our own in-container judge-panel review (near-term); ultrareview = optional future cloud escalation.**

**What ultrareview is.** A deep, multi-agent **cloud** review of a branch/PR. It is the one genuinely **non-Docker, billed, cloud-triggered, git-repo-requiring** path in this design — the only place the "real git remote + PR" and "separate billing axis" constraints actually bite. It is **RECLASSIFIED as FUTURE, OPTIONAL, off-box augmentation**, and is **NOT on the near-term plan.**

**Why it can fit later.** fritZ *always* has a PR — every implement agent works on a feature branch and opens a PR linked to the issue — so the git constraint is free here (and the constraint is moot until this future escalation is enabled). When/if adopted, ultrareview wires in *above* the in-container judge-panel at the `review` gate as a **budget-gated escalation**, mapping its verdict onto the same `--outcome=rejected → for-rework` contract verbatim.

```
NEAR-TERM (default, in-container, no cloud, no extra billing):
  review := judge-panel( correctness, quality, security )   # in-container subagents
              -> "all must approve" -> approved | rejected   # SAME outcome as legacy review
              -> for-validate | for-rework                   # existing routing, verbatim

FUTURE / OPTIONAL CLOUD ESCALATION (deferred — off-box, billed):
  ultrareview trigger surface (ALL gated):
    PR is P0  OR  large diff  OR  security-sensitive
       AND not on the rebase-only diff-hash fast-track   (skip identical re-work)
       AND rework-cycle count within budget               (gate on fritz.rework:N)
    --> /code-review ultra  on the existing branch+PR        # cloud, billed
          success  -> verdict -> for-rework | for-validate   (existing routing)
          failure/over-budget -> FALL BACK to the in-container judge-panel (mandatory)
    for-human is the hard backstop.
```

**Constraints (load-bearing, apply only when/if the future escalation is enabled).**
- **Trigger:** user/explicit or label escalation (`for-ultrareview` / a Telegram `/review`), **never a silent autoloop default**. It is an escalation above the in-container judge-panel, not a near-term path.
- **Billing:** cloud-billed, separate from the subscription budget. Must be gated on issue priority + rework-cycle count; the subscription usage-monitor will not see this spend.
- **Git:** needs a remote branch + PR (always satisfied in fritZ; the constraint is moot until the feature is enabled).
- **Determinism:** non-deterministic multi-agent cloud output — hence a *gate/escalation*, with the deterministic in-container judge-panel as mandatory fallback **and** as the near-term baseline.

---

## 5. Capability → pipeline-stage mapping

Ordering follows the verified fan-out-amenability ranking (most → least amenable), which is also the v2 migration order. "ultracode default leans workflow entrypoint?" is the *default-launch* lean **subject to the label/lang hard-overrides in §2** — not an unconditional switch. The **review approach** column makes the near-term/future split explicit: near-term review is our own in-container judge-panel; cloud ultrareview is future-optional.

| Stage | Workflow shape (in-container) | ultracode leans workflow entrypoint? | ultrathink | Review approach | Notes |
|---|---|---|---|---|---|
| **security-review** | `parallel()` + judge-panel; shard by AppSec/InfraSec/file | Yes — Phase 1 first mover (subject to override) | — | in-container judge-panel | Rank #1: read-only, no shared writable artifact, additive merge. Lowest blast radius; promotes the least-integrated stage to a first-class gate. |
| **review** | `judge-panel(correctness, quality, security)`, "all approve" join | Yes (subject to override) | — | **our own in-container judge-panel review (near-term); ultrareview = optional future cloud escalation** | Rank #2: comments/verdict only, no branch writes. `--outcome=rejected→for-rework` reused verbatim. |
| **validate** | `parallel(qa, ux)` over **ONE** worktree-provisioned app | Yes — bounded (subject to override) | — | in-container judge-panel | Rank #3: shared-runtime bottleneck reduced, not eliminated. **Distinct concurrency hazard** — see §6 (port/state contention, not a claim-race). |
| **architect** | pair + per-subsystem fan-out; synthesis join | Yes (subject to override) | **Yes** | — | Builder/Breaker convergence limits horizontal fan-out. |
| **ux** | single in-container `agent()` (no fan-out) | Yes (subject to override) | **Yes** | — | One designer, one coherent `UX_SPEC`. Gains journaled resume (mounted volume) + activity-TTL + typed output. |
| **budget** | single `agent()`; optional multi-judge RICE | Yes (subject to override) | **Yes** | — | Single estimate→validate thread; anti-anchoring is one reasoning thread. |
| **define** | `pipeline(ux, [architect‖budget], synthesis)` | Yes — **migrate LAST** (subject to override) | **Yes** (synthesis) | — | Lifts Issue #206 inline-sequential constraint, but produces one coherent artifact → migrate after in-container working-context/structured-output proven. |
| **implement** | single `agent()` (Phase 5), then **single-WRITER read-side fan-out** (Phase 5b): TEST-FIRST PIPELINE, then ADVERSARIAL-CRITIC LOOP | Legacy entrypoint first; **then Yes — a first-class multi-agent target** | — | — | Single-agent migrates last as planned (durability + infra). Then promoted via **ONE writer + read-side fan-out**, which dissolves the shared-branch hazard structurally (no worktree-isolation prereq). TEST-FIRST closes the self-graded-tests gap (01 §5) at ~2–2.5× not N× cost; promote only on a measured drop in downstream rework cycles, after the review judge-panel proves catch-rate. Writer fan-out (tournament/decompose) stays default-off/opt-in/never-rework only — see §1.3 and 03. In-container = container trust boundary preserved (no host worktree). |
| **for-merge** | none (no agent) | n/a | — | — | Already agent-less: findPR→CI→mergeability→squash→close→delabel. Untouched by either entrypoint. |
| **pentest** | none (**hard-pinned legacy entrypoint, Docker**) | No | — | — | `fritz.lang:kali` needs privileged Kali container (`NET_RAW`/`NET_ADMIN`); single-agent legacy entrypoint only. Permanent. |
| **retro** | none (**legacy entrypoint, audit-trail dependent**) | No | — | — | Consumes post-hoc docker logs/session audit trail. Stays on the legacy entrypoint until the workflow program exports an equivalent structured run-log. |

---

## 6. Constraints

**Auth.**
- The workflow entrypoint / ultracode / ultrathink run on the **subscription** path (`CLAUDE_CODE_OAUTH_TOKEN`) **in-container** — same auth fritZ uses today, no new credential path. The boot OAuth-token-env path is *preferred* for the workflow entrypoint, **but only when an OAuth token is configured**: in that case boot skips the per-workspace credential file-copy entirely, removing today's secret-sprawl of `.credentials.json`/`subscription_token.json` across host workspace dirs. An API-key or subscription-file deployment with no OAuth token still copies credentials per workspace (chmod-444 file-copy), so the sprawl-elimination benefit is conditional, not free in every deployment.
- **Headless caveat:** the subscription path depends on a fragile OAuth refresh-token workaround tied to a known upstream Claude Code bug. The usage-monitor that rides this path fail-opens (disables itself on 401/403 or after consecutive errors), and unattended/cron operation depends on that refresh surviving without a human. The workflow entrypoint runs on the *same* in-container token path and does **not** improve this — headless token refresh remains a real liability to gate around.
- **ultrareview is the exception (and it is deferred):** cloud-billed, a **separate cost axis** the subscription usage-monitor does not track, and the **only** off-box path here. Treat it as a distinct credential/billing concern, gated explicitly — and not on the near-term plan (§4).

**Headless / cron limits.**
- The workflow entrypoint / ultracode / ultrathink are headless-friendly — they run unattended off the autoloop with no interactive trigger (subject to the OAuth-refresh fragility above), all in-container.
- **ultrareview is NOT a silent headless default.** It is user/label-triggered and budget-gated; never fire it automatically from the autoloop. `report.sh ask` (blocks for a human answer) and the (future, optional) ultrareview escalation are the two human-in-the-loop seams; both must be modeled as suspendable/awaitable, not silent.

**Cost.**
- Two distinct axes: **(a) subscription tokens** — governed today only by the coarse global 80% usage-monitor pause (fail-open: it disables itself on 401/403/5-consecutive-errors and keeps spending). Per-run workflow-entrypoint **token budgets** replace this with real per-issue/per-role attribution, **applied at the container level for the N concurrent subagents (caveat (b))**. **(b) cloud billing** — ultrareview (deferred, off-box). The subscription monitor is *blind* to axis (b); when/if ultrareview is enabled it must be gated on priority + rework-cycle count, skipped on the rebase-only diff-hash fast-track, with `for-human` as the hard backstop.
- ultrathink raises per-call token cost — accepted *only* at design stages where spec quality compounds downstream.
- implement's Phase 5b single-WRITER read-side fan-out (§1.3) costs ~2–2.5× a single implement, **not** N×, because the writer phase is unchanged — the two added roles (test-deriver, test-verifier) and the critic lenses are read-only; a skip-on-trivial-diff predicate falls mechanical changes straight through to the legacy single writer so derive/verify never tax them.

**Concurrency hazards.**
- **In-container fan-out width.** Because the workflow entrypoint runs N in-process subagents in one container, the container must be **sized for N concurrent subagents** and the fan-out width capped (caveat (b)). This is a per-container resource concern, not a claim-race.
- **`validate`'s shared-runtime hazard.** The hardening prerequisites elsewhere in this design set (CAS-hardened `claimIssue`, idempotent/reconcilable completion, run-status orphan recovery) address **claim races and lost/duplicated webhooks**. They do **not** cover `validate`'s distinct hazard: two validators sharing **ONE** running app (`gh pr checkout` + `npm run dev`) inside the container. That is **runtime contention** — port collisions, shared mutable app state, fixture/DB interference — not a label-claim race. `validate`'s parallel win is therefore *gated on the shared runtime being safe for concurrent read-mostly access*; if it is not, validators must serialize against the app even while their analysis fans out. Flag this as a separate correctness concern from the claim/orphan hardening, addressed at the stage level.
- **Isolation (RESOLVED, not a risk).** Because fan-out runs **in-container**, the container remains the trust boundary. Untrusted external-repo code (`fritz.repo:owner/name[:branch]`) **never touches the host** — there is no host worktree in v2. The "host-worktree isolation regression" that the judge panel flagged against an earlier host-execution framing is **resolved by in-container execution**: v2 keeps the container trust boundary and does not introduce host worktrees. Note that implement's Phase 5b single-WRITER read-side fan-out needs **no** per-subagent worktree at all — writes stay serialized on ONE branch — unlike the rejected *writer*-fan-out shapes (§1.3, 03, 07 §4).

**Determinism vs nondeterminism.**
- **More deterministic than today:** JSON-schema structured output makes stage handoffs machine-checkable; a stage whose output fails to validate **hard-fails to `for-human`** rather than silently degrading to prose-parsing. The parity test pins both entrypoints to identical `(role,success,outcome,mode)→nextStatus`.
- **Newly nondeterministic:** ultracode changes *which in-container program* launches; ultrathink lowers output-text determinism (raises quality); ultrareview (deferred) is non-deterministic multi-agent cloud output. Each is gated, observable (loud Telegram/log/metric signal on every fallback-to-legacy-entrypoint), and reversible (default-off, fallback-on-failure, kill-switch). Determinism is preserved exactly where correctness depends on it — the transition core — and traded for quality only where it pays: design reasoning and high-stakes review.

---

*Files referenced (all relative to repo root, verified against live source): `fritz-orchestrator/daemon/src/agents/agents.ts` (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` injected for every container at `:413`; teammate-count parse/log at `:197-204` and `:688-692`; `startAgent:948` — thin router with a best-effort `refreshIssuesCache` preamble, `return startAgentDocker:957`); `fritz-orchestrator/daemon/src/agents/agent-comms.ts` (in-container `docker exec -i … claude` stream-json drive — module doc `:5-9`, one-shot fallback `:357-368`, persistent session `:442-468`); `fritz-orchestrator/daemon/src/agents/autoloop.ts` (pull engine, `spawnIfNoAgent` spawn path); `fritz-orchestrator/daemon/src/github/github.ts` (`MAX_REWORK_CYCLES:173`, `claimIssue:465`, `getNextStatus:551`, `getOrphanRestoreStatus:611`, `releaseAgent:654`); `fritz-orchestrator/daemon/src/core/registry.ts` (`lastActivityAt display-only:67`, `updateContainer:189`, `getExpiredAgents:286`).*
