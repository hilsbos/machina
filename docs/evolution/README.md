# fritZ v2 — Evolution Design

> **One-line summary:** fritZ v2 (Janus) keeps ONE Docker substrate and adds a SECOND
> in-container entrypoint — a workflow program that fans out N in-process subagents in the
> same container, synthesizes, and reports — selected by the `fritz.engine` label at the
> `startAgent` seam. No second engine, no host execution. Near-term review is our own
> in-container judge-panel; cloud ultrareview is a deferred, optional, off-box escalation.

> **Status:** Design exploration. No code. These documents map the next evolutionary
> step for fritZ — adding a **workflow-program entrypoint** (an in-container fan-out of
> N in-process subagents that synthesize and report, harnessing Claude Code Workflow
> orchestration, ultracode, and ultrathink) **alongside** the existing legacy single-agent
> entrypoint, over the **same Docker-container-per-stage substrate**, without retiring
> legacy fritZ.
>
> Produced on branch `feat/fritz-v2-evolution-design` by a multi-agent design workflow
> (34 agents: map → competing-proposal panel with independent judges → adversarially-
> reviewed authoring).

## The recommendation in one line

**fritZ v2 "Labels-as-Truth, Docker substrate, two entrypoints" (codename: Janus):**
keep GitHub `fritz.status:*` labels as the single source of truth and the
executor-agnostic transition table (`getNextStatus`/`releaseAgent`) **verbatim**; keep
the **one Docker substrate** (container-per-stage) as the unit of execution; add a second
**in-container entrypoint** — a workflow program that fans out N in-process subagents in
the SAME container, synthesizes one result, and calls `report.sh` — selected by the
`fritz.engine:<docker|workflow>` label at the `startAgent` seam, **default-off,
reversible, and adopted incrementally** along the fan-out-amenability ranking.

One Docker substrate, two entrypoints. The legacy entrypoint runs a single in-container
agent (today's persistent `docker exec ... claude` stream-json session against
`.fritz/assignment.md`, `agent-comms.ts:442-468`); the workflow entrypoint runs an
in-container fan-out of N subagents that synthesize and report. The container, not a cloud
run, is still the unit of execution. v2 changes the container's **program (its
entrypoint)**, not its substrate — it does **not** add a second execution engine and does
**not** move execution to the host.

The reframe is not speculative: the substrate already ships in-container multi-agent.
Every agent container already receives `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
(`agents.ts:413`), and the daemon already parses `session.subagentCount` and logs
`Agent spawned N teammate(s)` (`agents.ts:197-204`, `:688-692`). Today that fan-out is
Claude's own Agent-Teams teammates inside the one container, spawned ad-hoc and counted
post-hoc from session logs; the workflow entrypoint makes that fan-out **explicit,
bounded, and synthesized** — same container, same substrate. The single `startAgent` seam
(`agents.ts:948-958`) is a near-thin router whose dispatch tail is
`return startAgentDocker(options)` at `:957`, behind a load-bearing `refreshIssuesCache`
preamble; it selects the **entrypoint**, not a separate engine.

The hybrid two-entrypoint stance won every judge scorecard on **reversibility** and
**coherence** because it is the only one matching the mandate: *keep legacy as a permanent
co-equal default, add the workflow entrypoint incrementally.* Source verification
confirmed its central premise — `startAgent` is the single seam and the `github.ts`
transition layer is already executor-agnostic.

## Read in this order

| # | Document | What it answers |
|---|----------|-----------------|
| 01 | [Current Architecture (Baseline)](01-current-architecture.md) | How fritZ works today: the container-per-stage substrate, the in-container single-agent entrypoint, what must be preserved, what hurts. |
| 02 | [New Capabilities](02-capabilities-and-opportunity.md) | What Workflow / ultracode / ultrathink / ultrareview actually provide, and which stage each best serves. |
| 03 | [Architecture Options Considered](03-architecture-options.md) | The four candidate approaches, the judge scoring, and why hybrid wins (with ideas grafted from the rest). |
| 04 | [Target Architecture — fritZ v2](04-target-architecture.md) | The "Janus" design: one Docker substrate, two entrypoints, one `startAgent` seam, per-stage routing, labels-as-truth. |
| 05 | [Per-Stage Execution Mapping](05-stage-mapping.md) | Stage-by-stage entrypoint decisions + pseudo-structure sketches of each in-container fan-out shape. |
| 06 | [Migration & Coexistence](06-migration-and-coexistence.md) | Zero-big-bang rollout order, fallback-to-legacy, observability, what stays identical. |
| 07 | [Risks, Costs & Open Questions](07-risks-and-open-questions.md) | Cost/auth/determinism risks, where this is over-engineering, and the smallest first experiment. |
| 08 | [Workflow-Run Observability](08-workflow-observability.md) | How an in-container workflow run (its phases + subagent fan-out tree + tokens + logs) surfaces live on the remote web dashboard — since the local `/workflows` TUI won't exist. Reuses the existing SSE/event-log rail; informed by how Temporal/Langfuse/OTel-GenAI/Phoenix do it. |

## Per-stage entrypoint decisions (summary)

| Stage | Target entrypoint | Why |
|-------|-------------------|-----|
| `security-review` | **workflow entrypoint** (Phase 1 first mover); fan-out is **in-container** | Already an AppSec/InfraSec pair; read-only; shardable; additive findings merge in-container; lowest blast radius. |
| `review` | **our own in-container judge-panel review** (workflow entrypoint, near-term); ultrareview = optional future cloud escalation | In-container judge-panel "all must approve" (correctness + quality + security lenses) against the PR/diff, emitting the same `approved`/`rejected` outcome the legacy review agent does. |
| `validate` | **workflow entrypoint** (bounded); fan-out is **in-container** | QA + UX validators over one running app inside the one container; shared-runtime bottleneck acknowledged. |
| `architect` / `ux` / `budget` | **workflow entrypoint** + **ultrathink** (in-container) | Design stages benefit from extended in-container reasoning (subscription-billed, no cloud); can overlap where the dependency graph allows. |
| `define` | **hybrid** (workflow fan-out, in-container) + ultrathink | Migrated **last**; synthesizes sub-skill specs. |
| `implement` | **legacy entrypoint first** (single-agent, Phase 5), **then a first-class single-WRITER multi-agent shape** (Phase 5b) | Migrate the single-agent shape last as planned; then promote to a primary multi-agent target via **read-side fan-out around exactly ONE writer** — headline = TEST-FIRST PIPELINE, then the ADVERSARIAL-CRITIC LOOP. Runs in-container; the container stays the trust boundary, no host worktree. Writer fan-out (tournament / decompose) is a default-off, budget-gated, never-on-rework escalation only. |
| `for-merge` | **legacy** (no agent) | Unchanged — CI-check + merge stays in the autoloop. |
| `pentest` | **legacy entrypoint only** (hard pin) | Needs `NET_RAW`/`NET_ADMIN` + Kali image; no Workflow environment parity. |
| `retro` | **legacy entrypoint** | Audit-trail dependent. |

> **Ultrareview is deferred.** Cloud ultrareview (`/code-review ultra`) is the **one
> genuinely off-box, billed, cloud-triggered, git-repo-requiring path** — the only place
> the "real git remote + PR" and "separate billing axis" constraints actually bite. It is
> **NOT on the near-term plan**; near-term review is our own in-container judge-panel.

> **Implement IS a primary multi-agent target — via single-writer read-side fan-out, not
> writer fan-out.** The panel (3 independent judges, unanimous) promoted `implement` from
> "migrate-last single-agent, fan-out only for conflict-partitioned components" to a
> **first-class multi-agent stage**, on one narrow correction: the docs justified
> implement-last partly on an *unavoidable shared writable-branch merge hazard*, but that
> hazard is a CHOICE, not intrinsic. Keeping **exactly ONE serialized writer** on **one
> branch** and fanning out only on the **read side** dissolves the branch-contention
> objection structurally (no worktree-isolation prerequisite) and turns implement's defining
> constraint into a feature. Two shapes earn it: **(1) TEST-FIRST PIPELINE** (headline) — a
> read-only test-deriver writes acceptance tests from the spec BEFORE code, one writer codes
> to green against locked tests, an independent mutation-probe verifier proves the suite is
> not gamed; **(2) ADVERSARIAL-CRITIC LOOP** (second) — one serialized writer + N read-only
> critics on the warm diff, looped-to-dry, capped. The **writer-fan-out** patterns
> (TOURNAMENT, DECOMPOSE) lose to the single-agent steelman because worktree-per-attempt only
> *relocates* implement's real cost — semantic merge / synthesis graft, the documented #486
> context-loss failure industrialized — so they stay **default-off, budget-gated, opt-in,
> never-on-rework** escalations, never the headline. Rollout: ship single-agent implement
> **last** as planned (banking the cheap infra+durability wins at near-zero risk), then add
> TEST-FIRST as **Phase 5b**, default-off behind `fritz.engine:workflow` with mandatory loud
> fallback to the legacy entrypoint, strictly **after** the in-container review judge-panel
> proves catch-rate, promoted only on a **measured drop in downstream rework cycles**.

## The non-negotiable prerequisites (from the panel's rigor)

Before *any* workflow-entrypoint stage that increases concurrency, three pre-existing
liabilities must be fixed because added concurrency will expose them:

1. **CAS-harden `claimIssue`** (`github.ts:465`) — the current claim is not atomic.
2. **Re-ground orphan / 0-turn recovery** on a reliable `hadActivity` signal
   (`getOrphanRestoreStatus`, `github.ts:611`).
3. **Make completion idempotent and reconcilable** (extend the existing
   `releasedAgents` map; poll run status) so a lost/duplicated webhook can't strand a
   stage at `fritz.status:active`.

Plus a **parity test** asserting identical `(role, success, outcome, mode) → nextStatus`
for both entrypoints, and a **loud fallback signal** on every workflow→legacy
re-dispatch. Because the workflow entrypoint runs N in-process subagents in a single
container, **size CPU/RAM per container for N concurrent subagents** (not 1) and apply the
per-stage token budgets at the container level.

## Recommended first experiment

Convert **`security-review`** to a workflow-entrypoint stage behind `fritz.engine:workflow`,
default-off, with transparent fallback to the legacy entrypoint — the smallest slice that
proves the seam end-to-end while touching the lowest-risk, most fan-out-amenable stage.
The fan-out runs **in-container** (the same container, same substrate); if the literal
Workflow scripting DSL is not exposed to the containerized `claude` CLI, express the
identical fan-out via the already-wired agent-teams mechanism
(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `agents.ts:413`) — either way it is in-container.
See [07-risks-and-open-questions.md](07-risks-and-open-questions.md).

The smallest **implement** experiment comes later (Phase 5b, strictly after single-agent
implement ships last and after the review judge-panel proves catch-rate): stand up the
**TEST-FIRST PIPELINE** on **one language** (the repo's own Rust or TS), behind
`fritz.engine:workflow` default-off, on a handful of issues with concrete testable
acceptance criteria (CRUD endpoint / parser / bugfix-with-reproducer — never UX-feel or
spike). Keep the single writer phase **byte-identical** to the legacy implement, so the only
new surface is **derive + verify**; the load-bearing new primitive to build and prove is
**test-file locking + a mutation-probe harness** (re-run the suite under injected faults via
the per-language tooling implement already shells out to — `cargo test` / `npm test` /
`ruff`). Promotion gate: a **measured drop in downstream `review`→`for-rework` cycles** on
real issues, same quiet-window/fallback-rate discipline as every other stage. Loud mandatory
fallback to the legacy single-agent implement entrypoint on any health failure;
schema-invalid → `for-human`; verifier `rejected` maps to implement's **existing** rework
path (a parity-test item, not a new transition).
