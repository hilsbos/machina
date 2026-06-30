# fritZ v2 Evolution — Session Handoff

> **Purpose:** persistent context so this design work can be resumed in a fresh
> conversation. Everything here lives in git on branch
> `feat/fritz-v2-evolution-design`. Read this first, then the docs it points to.
> Nothing about this work is stored in agent memory — this file IS the memory.

**Last updated:** 2026-05-31

---

## 1. What this is

A **design-only** exploration (no production code changed) of the next evolution
of fritZ. It lives entirely under `docs/evolution/` and was produced through a
series of multi-agent Claude Code **Workflow** runs (map → competing-proposal
panels with independent judges → adversarially-reviewed authoring). The
workflow scripts that generated it are saved under
[`docs/evolution/workflows/`](workflows/) so they can be re-run or adapted.

**fritZ today (one paragraph):** a Telegram-driven, GitHub-label-orchestrated
agent pipeline. A daemon watches `fritz.status:*` labels; for each `for-{role}`
label it spawns ONE Docker container running ONE Claude Code agent for that
stage (define/implement/review/validate/…). The agent reports completion → the
daemon flips the label → the next agent spawns. Labels are the only durable
state store. See [`01-current-architecture.md`](01-current-architecture.md).

---

## 2. The design conclusion (fritZ v2 "Janus") in a nutshell

**One Docker substrate, two entrypoints.** v2 does **not** add a second
execution engine and does **not** move execution to the host. The
container-per-stage model is unchanged (credentials, watchdog, activity-TTL,
image variants, the `report.sh → /api/notify` contract). What changes is the
container's **program (entrypoint)**:

- **Legacy entrypoint** = single agent (`claude -p "<assignment>"`) — today's behavior.
- **Workflow entrypoint** = a workflow program that fans out **N in-process
  subagents inside the SAME container**, synthesizes one result, and reports.

A `fritz.engine:<docker|workflow>` label, read at the single `startAgent` seam
(`agents.ts:957`), selects the entrypoint. **Default-off, reversible**
(auto-fallback to legacy on failure + a fritz.yaml kill-switch). Labels remain
the source of truth; the `getNextStatus`/`releaseAgent` transition core is
reused **verbatim** (a parity test guards both entrypoints).

Grounding fact: in-container multi-agent fan-out **already exists** — every
container injects `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (`agents.ts:413`) and
the daemon already counts teammates (`session.subagentCount`,
`agents.ts:197-204/688-692`). v2 *structures* that fan-out; it doesn't invent it.

---

## 3. Decisions locked in this session (in order)

1. **Dual-engine framing → corrected to "one Docker substrate, two
   entrypoints."** Originally the design said "two engines"; the user pointed
   out the new path should still run in Docker. Reframed across all docs. This
   also **resolved the biggest risk** (host-worktree isolation regression) —
   fan-out runs in-container, so the container stays the trust boundary.

2. **Defer cloud `ultrareview`.** Near-term review = **our own in-container
   judge-panel** (correctness + quality + security lenses, all-must-approve),
   reusing the `rejected → for-rework` contract verbatim. Cloud
   `/code-review ultra` is reclassified as the one optional, billed, off-box
   future escalation — NOT on the near-term plan.

3. **`implement` promoted to a first-class multi-agent stage — but only via
   single-WRITER, read-side fan-out.** An adversarial panel found the obvious
   idea (N parallel full implementations / "tournament" / "decompose") scores
   *below* the status quo because worktree-per-attempt only **relocates** the
   semantic-merge cost (the documented #486 scar). Winner = **TEST-FIRST
   PIPELINE**: independent test-deriver writes locked acceptance tests (RED) →
   the existing single writer codes to green on ONE branch → independent
   verifier checks coverage + runs a mutation probe (anti-gaming). ~2–2.5×
   cost, not N×. Single-agent implement still migrates LAST; the multi-agent
   promotion is a new strictly-downstream phase (5b/6b), default-off, gated on
   the review judge-panel proving catch-rate. Writer fan-out
   (tournament/decompose) stays a default-off, budget-gated opt-in escalation,
   not a migration phase.

4. **Workflow-run observability designed** (doc 08). Since the local
   `/workflows` TUI does not exist in the headless/remote deployment, surface
   in-container workflow runs as a live **run tree** on the existing web
   dashboard. Key seam: the container **already bind-mounts its workspace to
   the host**, so the harness's per-subagent JSONL transcripts + run journal
   already land where the daemon can read them. Extend `session-parser.ts`
   (which already counts subagent files) into a run-tree builder; reuse the
   existing SSE/event-log rail (`notifyClients`/`broadcastSSE`) and the
   nginx-mTLS proxy. Firm part = fan-out tree + per-subagent tokens
   (JSONL-grounded); inferred part = phase grouping (open question).

---

## 4. The document set

| Doc | Covers |
|-----|--------|
| [`README.md`](README.md) | Index + the recommendation + per-stage table + prerequisites + first experiment |
| [`01-current-architecture.md`](01-current-architecture.md) | Baseline: state machine, container-per-stage substrate, what to preserve, what hurts |
| [`02-capabilities-and-opportunity.md`](02-capabilities-and-opportunity.md) | What Workflow/ultracode/ultrathink/ultrareview offer; capability→stage mapping |
| [`03-architecture-options.md`](03-architecture-options.md) | The 4 options, judge scoring, why hybrid wins |
| [`04-target-architecture.md`](04-target-architecture.md) | The "Janus" design: substrate, entrypoints, `startAgent` seam, routing, labels-as-truth |
| [`05-stage-mapping.md`](05-stage-mapping.md) | Per-stage entrypoint decisions + pseudo-structure sketches (incl. implement TEST-FIRST) |
| [`06-migration-and-coexistence.md`](06-migration-and-coexistence.md) | Zero-big-bang rollout order, fallback, observability, what stays identical |
| [`07-risks-and-open-questions.md`](07-risks-and-open-questions.md) | Cost/auth/determinism risks, cost controls, open questions, first experiment |
| [`08-workflow-observability.md`](08-workflow-observability.md) | Run-tree visibility on the web dashboard; external research (OTel GenAI, Langfuse, Temporal, etc.) |
| [`workflows/`](workflows/) | The 4 multi-agent Workflow scripts that produced these docs (re-runnable) |

---

## 5. Recommended rollout (from doc 06)

```
Phase 0  ultrathink on design stages (define/architect)      ← model setting, no entrypoint change
Phase 1  security-review  → workflow entrypoint              ← FIRST mover: read-only, shardable, lowest risk
Phase 2  review           → workflow (our in-container judge-panel; ultrareview deferred)
Phase 3  validate         → workflow
Phase 4  architect / ux / budget → workflow + ultrathink
Phase 5/6   define, implement (single-agent) → workflow      ← migrate last
Phase 5b/6b implement (multi-agent, TEST-FIRST) → workflow   ← strictly downstream, default-off, gated
Never    pentest, retro, for-merge → stay legacy
```

**Non-negotiable prerequisites before any concurrency-increasing stage:**
CAS-harden `claimIssue` (`github.ts:465`); re-ground orphan recovery on a real
`hadActivity` signal; idempotent + reconcilable completion; a parity test for
both entrypoints; a loud fallback signal on every workflow→legacy re-dispatch.

**Smallest first experiment:** convert `security-review` to the workflow
entrypoint behind `fritz.engine:workflow` (default-off) with legacy fallback —
and, in parallel, the doc-08 MVP: render that one fan-out live as a run tree in
the dashboard.

---

## 6. Open questions / decisions still pending from the owner

- **Push the branch / open a draft PR?** Currently 100% local (see §7).
- **Is the Claude Code Workflow run-journal parseable for phase boundaries?**
  (Doc 08 §6.) If yes, the run-tree gets clean phase headers; if no, you still
  get tree + tokens + logs without phases. Worth a small spike.
- **OQ#3 — per-subagent worktree isolation in-container:** unverified in the
  codebase. Not needed for TEST-FIRST (single writer), but it gates the
  default-off writer-fan-out escalation. (Doc 07 §5.)
- **Is design-only enough for now, or start a thin implementation slice?**
  (E.g. the `startAgent` branch + security-review workflow script.)

---

## 7. Git state

- **Branch:** `feat/fritz-v2-evolution-design` (NOT pushed; no PR).
- **Base:** `main`.
- **Commits on the branch:**
  - `c4b6912` Add fritZ v2 evolution design docs (initial 7 docs)
  - `28f4673` Reframe: one Docker substrate, two entrypoints; defer ultrareview
  - `8aadf77` Promote implement (single-writer, read-side fan-out / TEST-FIRST)
  - `de5915d` Add doc 08: workflow-run observability
  - *(plus the commit that adds this handoff + the workflow scripts)*
- The repo also has unrelated modified agent worktrees under
  `.claude/worktrees/` — left untouched; not part of this work.

## 8. How to resume in a new conversation

1. `git checkout feat/fritz-v2-evolution-design`
2. Read this file, then `docs/evolution/README.md`, then the doc(s) for the
   area you want to continue.
3. To re-run or extend the analysis, the generating Workflow scripts are in
   [`docs/evolution/workflows/`](workflows/) — invoke them with the Workflow
   tool (they are self-contained; absolute paths inside assume this repo at
   `/path/to/fritz`).
4. Pick up from the open questions in §6.
