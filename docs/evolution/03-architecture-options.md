# Architecture Options Considered

> **fritZ v2 (Janus) keeps ONE Docker substrate and adds a SECOND in-container entrypoint — a workflow program that fans out N in-process subagents in the same container, synthesizes, and reports — selected by the `fritz.engine` label at the `startAgent` seam. No second engine, no host execution. Near-term review is our own in-container judge-panel; cloud ultrareview is a deferred, optional, off-box escalation.**

This document records the four candidate architectures evaluated for fritZ v2, the consensus scoring across the judge panels, and the reasoning behind the recommended option (Hybrid: **Docker substrate, two entrypoints**, codename *Janus*). It is grounded in the verified shape of today's system: a label-driven state machine (`fritz.status:*` as the only source of truth), an executor-agnostic transition layer in `github.ts`, and a single launch chokepoint at `agents.startAgent` (agents.ts:948) — a single delegating function whose body is a best-effort issue-cache refresh followed by `return startAgentDocker(options)` at agents.ts:957.

The central design question is **not** "should fritZ adopt Workflow/ultra features?" — every option says yes. And it is **not** "host vs. cloud" — every option keeps the Docker container as the unit of execution. It is **how the new in-container *entrypoint* relates to the existing single-agent entrypoint**: replace it, demote it, defer it, or add it behind a seam. There is one Docker substrate; what changes is the *program the container runs*.

**The substrate already runs in-container multi-agent.** This is not aspirational. Every agent container is launched with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (agents.ts:413 — "Agent Teams: inject env vars for all agents (persistent mode is universal)"), and the daemon already parses `session.subagentCount` and logs `🤝 Agent spawned ${teammateCount} teammate(s)` on both the spawn path (agents.ts:197-204) and the stop path (agents.ts:688-692). The container is driven from the daemon via `docker exec -i <container> claude --input-format stream-json --output-format stream-json` (agent-comms.ts:5-9 doc; persistent session at :442-468; one-shot fallback at :357-368), with the container itself parked on `sleep infinity`. So in-container fan-out is **already live** — today as Claude's own ad-hoc Agent-Teams teammates, counted post-hoc from session logs. The v2 workflow entrypoint does not *invent* in-container fan-out; it makes that fan-out **explicit, bounded, and synthesized** — same container, same substrate.

---

## The Shared Frame: What Is and Isn't on the Table

All four proposals agree on several points, which are therefore not differentiators:

- **Keep labels as the state store.** The `fritz.status:*` vocabulary and the autoloop pull engine are good and stay.
- **Keep the transition core.** `getNextStatus` (github.ts:551), `releaseAgent` (654), `getOrphanRestoreStatus` (611), `claimIssue` (465), `MAX_REWORK_CYCLES=3` (173), rework counting, PR-verification, and for-human escalation are executor-agnostic and are reused, not rewritten.
- **Keep the Docker substrate as the unit of execution.** The container-per-stage model, the credential-copy path (env OAuth token or chmod-444 copy of `.credentials.json`/`subscription_token.json`), the watchdog/activity-TTL machinery, the image variants (including Kali/pentest under `fritz.lang:kali` + `NET_RAW`/`NET_ADMIN`, and all hard-pins for pentest/retro/for-merge), and the `report.sh → /api/notify` + `/api/ask` completion contract are unchanged. **No option moves execution to the host.**
- **Adopt native features.** Workflow `pipeline()/parallel()/agent()`-shaped fan-out, JSON-schema structured output, ultracode, ultrathink, and our own in-container judge-panel review all map onto real stage seams. (Cloud ultrareview is reclassified below as a deferred, optional, off-box escalation — not a near-term path.)

What differs is **stance toward the legacy single-agent entrypoint** and **how aggressively the container's program is changed**. That single axis is what the scoring below measures. The substrate — Docker, container-per-stage, in-container `claude` — is constant across all four.

```
                   DEMOTE/DELETE LEGACY ENTRYPOINT  <----->  KEEP IT CO-EQUAL
   big-bang rewrite    Workflow-Native ──┐         ┌── Hybrid: 2 Entrypoints
                       Thin Router ───────┤         │
   surgical change                        └─────────┴── Conservative Stage-Swap
                       ── ONE Docker substrate underneath all four ──
```

A point that constrains every option's end-state: some stages always run the **legacy single-agent entrypoint** and never gain a workflow-program entrypoint. `fritz.lang:kali`/`pentest` needs a privileged Kali container (NET_RAW/NET_ADMIN, PTES tooling) and runs a single pentest agent; `retro` consumes the post-hoc docker session audit trail (exit code + log lines + subagent parse) and loses its primary input without an equivalent structured run-log; and `for-merge` is agent-less (find PR → CI → merge → close) and is touched by neither entrypoint. The consequence: the single-agent entrypoint cannot be *fully* removed while these stages exist, so "drop the legacy entrypoint" is never a clean end-state for any option. (Note: this is about *which program runs in the container*, not about Docker — Docker is the permanent substrate either way.)

---

## Option A — Workflow-Native ("default to the workflow-program entrypoint everywhere")

**Stance:** Bold rewrite of the container's *program*. Make the in-container fan-out entrypoint the default for every stage; the legacy single-agent entrypoint survives only as a demoted/compat path. **Execution stays in the same Docker container** — what changes is that the container's program is the workflow fan-out rather than the single assignment.

**Summary.** The daemon keeps babysitting the same container, but the in-container `claude` runs a fan-out program instead of the one assignment. Each stage's program fans out N in-process subagents *inside the same container* via an in-container fan-out shape (`parallel()/pipeline()/agent()` if the Workflow DSL is exposed to the containerized CLI, else the already-wired agent-teams/teammate mechanism — `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, agents.ts:413), synthesizes one result, validates JSON-schema structured output, and calls `report.sh`. The default entrypoint is the workflow program (ultracode-capable); the legacy single-agent entrypoint is selectable per-issue but second-class. Incidental machinery that the single-agent path leans on (hand-parsed one-shot stream-json, some `boot.ts` prep) is demoted where the workflow entrypoint supersedes it — but the container, credential-copy, watchdog, and `report.sh` contract remain.

**Pros**
- Captures the full in-container fan-out upside on every stage at once: bounded intra-stage fan-out, per-stage token budgets, and a run-journal for resume — all inside the existing container.
- Pushes the cleanest end-state mental model: one default program (the workflow fan-out) over the one substrate.
- Forces early proof of the synthesis-and-report contract uniformly across stages.

**Cons**
- Makes the workflow-program entrypoint the *default*, directly contradicting the owner's explicit mandate to keep the legacy single-agent entrypoint as a co-equal default.
- "Bold rewrite" framing front-loads the highest-risk work (uniform fan-out + synthesis on every stage) before per-stage parity is proven.
- Treats hardening (atomic claim, run-status orphan recovery) as implicit rather than as gated prerequisites.
- **DSL exposure is unverified** — if the literal Workflow scripting DSL is *not* reachable from the containerized `claude`, every stage's fan-out must instead be expressed via the agent-teams mechanism. The proposal assumes the DSL as a given; that assumption is not yet verified. (Either way the fan-out is in-container.)
- **One container now hosts N concurrent subagents** — each container must be sized for N concurrent in-process subagents (CPU/RAM), not 1, and the per-stage token budgets must be applied at the container level.

**Risks**
- ~~Host-worktree isolation regression~~ — **resolved by in-container execution.** Earlier framings treated this as the top unmitigated risk; it does not exist. Because the fan-out runs *in-container*, the container remains the trust boundary: untrusted external-repo code (`fritz.repo:owner/name[:branch]`) never touches the host, and v2 introduces no host worktree. v2 keeps the container trust boundary.
- A single big switch means a systematically broken workflow entrypoint has no transparent fallback to the legacy single-agent program for in-flight work.
- **Durable resume requires a mounted volume.** The run-journal must live on a *mounted* volume; container-ephemeral storage is lost on crash, which would defeat resume. Resume means "from the last journaled step on a mounted volume" — in-flight uncheckpointed reasoning is not guaranteed.

---

## Option B — Hybrid: Docker Substrate, Two Entrypoints ("label-routed entrypoint selection at the startAgent seam") — RECOMMENDED

**Stance:** For a hybrid, **but only because** the codebase already has exactly one clean router point (`startAgent`) and a fully executor-agnostic transition layer, *and* the substrate already runs in-container multi-agent. The whole design reduces to: keep labels as the shared coordination plane, keep one Docker substrate, and make exactly one function choose between two **in-container entrypoints** based on a label.

**Summary.** Preserve the legacy single-agent entrypoint byte-for-byte. Add a second **workflow-program entrypoint** behind the same `startAgent(options)` seam — a program that, *inside the same container*, fans out N in-process subagents, synthesizes one result, validates structured output, and calls `report.sh`. Route per-stage via a `fritz.engine:<docker|workflow>` label (default absent = legacy single-agent entrypoint), re-read on every `for-{role}` transition so one issue can mix entrypoints (e.g. `define` on the legacy entrypoint, `review` on the workflow entrypoint). Both entrypoints drive the identical label state machine because all push-side logic lives in `github.ts` and is reused verbatim. New code is narrow: (a) a router inside `startAgent`, (b) a workflow-program entrypoint implementing the same claim/send/complete/status lifecycle, (c) backend-aware status seams (`isAgentRunning`, `listRunningProcesses`, `getExpiredAgents`, `stopAgent`) — all still observing the *same container* (the backend-tag generalization is cosmetic; both entrypoints are a container). Because `startAgent` today also fires a best-effort `refreshIssuesCache` before delegating (agents.ts:948-958, with the dispatch tail `return startAgentDocker(options)` at agents.ts:957), the router must **preserve** that pre-boot cache refresh — it is load-bearing — so both entrypoints see fresh labels. The seam is not literally one line, and it must not be regressed to one.

```
  autoloop: detect fritz.status:for-{role}
            └─ spawnIfNoAgent(issue, role)
               └─ agents.startAgent({role, issue})          ← UNCHANGED call site
                  ├─ refreshIssuesCache(owner, name)         ← preserved pre-boot step
                  └─ resolveEntrypoint():
                        fritz.engine:workflow  → workflow-program entrypoint ─┐
                                                  (in-container fan-out of N) │
                        absent / :docker       → legacy single-agent entry ──┤
                        kali/pentest/no-template → forced single-agent ──────┤
                        kill-switch active      → drain to single-agent ─────┘
                                    │ both paths run IN THE SAME CONTAINER ↓
                        github.claimIssue (hardened) → releaseAgent → getNextStatus
                                    │ (executor-agnostic, reused verbatim)
```

Adoption follows the verified **fan-out-amenability ranking** because per-stage routing makes it free to advance one stage at a time. The two read-only, findings-emitting stages migrate first — `security-review`, then `review` — because their in-container subagents never contend for a writable branch and their outputs merge additively into one synthesized report, so the new entrypoint on those stages has the lowest blast radius. `validate` is the next mover but a **bounded** one: its QA/UX pair parallelizes in-container, yet it needs one shared running app, so it advances only once the in-container shared-runtime workspace is proven (see "bounded/deferred wins" below) — it is not a fully free read-only advance the way `security-review`/`review` are. Generative/convergent stages migrate last in their **single-agent** shape, after the in-container worktree workspace and the structured-output contract are proven end-to-end: `define` because it converges one coherent artifact, and `implement` because of **single-writer rework sequentiality and write blast-radius** (one branch, one PR, ordered feedback, max-3 cycles; the only near-term stage whose write becomes the merged artifact) — **not** because of an unavoidable shared-branch merge hazard, which is a *choice* of write topology, not intrinsic (see "bounded/deferred wins" below). `implement` does not stop there: once its single-agent shape is proven (Phase 5), it is *promoted* to a first-class multi-agent target (Phase 5b) via **single-WRITER read-side fan-out** which keeps exactly one writer on the one branch and therefore needs no new worktree-isolation prerequisite.

Three independent reversibility levers: **default-off** (no label = legacy single-agent entrypoint), **transparent fallback** to the legacy entrypoint on any workflow-program submission/health failure for the already-claimed stage (with a loud signal), and a global **fritz.yaml kill-switch** that drains in-flight runs to the legacy entrypoint. All three are *entrypoint* switches over the same container — no fallback ever changes the substrate.

**Pros**
- The *only* stance that satisfies the non-negotiable mandate: keep the legacy single-agent entrypoint working, *add* the workflow-program entrypoint incrementally.
- Mechanically cheap where it counts — `startAgent` is a single delegating seam (a best-effort cache refresh, then `return startAgentDocker(options)` at agents.ts:957), so the router is a true single-seam change that preserves the cache-refresh preamble.
- Builds on a substrate that **already** fans out in-container (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, agents.ts:413; teammate counting at agents.ts:197-204, :688-692) — the workflow entrypoint *structures* an existing capability rather than introducing a new runtime.
- Per-stage routing lets adoption follow the verified fan-out ranking (security-review → review first as free read-only advances; `validate` next but bounded on shared-runtime; single-agent implement/define last, with `implement` then promoted to a first-class single-WRITER read-side fan-out target in Phase 5b), for the structural reason above.
- Reversibility is structural, not procedural: three levers, all default-safe, all entrypoint-level.
- A parity test asserts identical `(role, success, outcome, mode) → nextStatus` for both entrypoints, so dual operation can never silently diverge.

**Cons**
- Two entrypoints coexist indefinitely — more surface area than a single-program end-state, and the incidental single-agent machinery is superseded only later (the patient end-state), not now. Pentest, retro, and kali keep the single-agent entrypoint regardless, so the convergence target is "incidental single-agent machinery," not "all of Docker" (Docker is permanent).
- Backend-aware watchdog seams add a conditional dimension (single-agent container vs. workflow-program container run status) that did not exist before — though both remain `docker ps`-observable containers.
- **One container now hosts N concurrent subagents** under the workflow entrypoint — sized-for-1 containers must be re-sized for N concurrent in-process subagents, and per-stage token budgets applied at the container level (see cross-cutting Concurrency).

**Risks**
- **Silent divergence between entrypoints** — mitigated by the parity test as a hard gate.
- **Mid-stage human label edits** (someone editing `fritz.engine` while a run is in flight) — mitigated by storing authoritative entrypoint attribution on the registry run-handle (generalize `updateContainer`'s containerId at registry.ts:189 to a backend-tagged handle); the live label governs only the *next* stage.
- **Fallback masking a broken entrypoint** — mitigated by a loud Telegram/log/metric signal on every fallback-to-single-agent.
- **DSL exposure is unverified** — the workflow entrypoint expresses its fan-out via the Workflow DSL *if* it is reachable from the containerized `claude`, else via the already-wired agent-teams/teammate mechanism; the design does not depend on the DSL being available, and the fan-out is in-container either way.

---

## Option C — Conservative Stage-Swap ("our own in-container judge-panel at the review gate + ultrathink in define/architect")

**Stance:** Conservative. Keep the entire legacy orchestrator, the label-driven state machine, and the label store exactly as-is. Make only two surgical substitutions to the *program the container runs* for two stages — no new entrypoint, no new substrate.

**Summary.** (1) Strengthen what the **review** stage does with **our own in-container judge-panel** — a small fan-out of in-process subagents (correctness + quality + security lenses, **"all must approve"**) running *inside the existing agent container* against the PR/diff that `implement` already opened, emitting the **same** `approved`/`rejected` outcome the legacy review agent does so the `--outcome=rejected → for-rework` contract is reused verbatim and `getNextStatus`/`releaseAgent` are unchanged. The judge-panel expresses its fan-out via the Workflow DSL **if** that DSL is exposed to the containerized `claude`, else via the already-wired agent-teams/teammate mechanism (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, agents.ts:413); either way the fan-out is in-container, so this stage swap does not depend on the DSL being available. (2) Add **ultrathink** to the `define` orchestrator and its `architect` sub-phase (in-container, subscription-billed, no cloud). Both changes are confined to per-stage agent behavior (skill prompt + one daemon dispatch branch) — no new entrypoint runtime, no autoloop change, no claim/release change, no label vocabulary change. Two SKILL.md prompts plus one config flag. *(Cloud ultrareview is explicitly **not** in this option's near-term path; see "Future / optional cloud escalation" in the experiment plan — it is the one genuinely non-Docker, billed, cloud-triggered, git-remote-requiring path and is deferred.)*

**Pros**
- Lowest-risk step in the set (feasibility 9–10); banks the two highest value-per-stage features cheaply, entirely in-container on subscription billing.
- Zero new entrypoint runtime; fully reversible by config; the review judge-panel is a *small* in-container fan-out, so concurrency growth is minimal and bounded.

**Cons**
- Caps out on impact (scored 5) *as an architecture*: it defers the general workflow-program entrypoint and ultracode entirely and fixes **no** structural pain — wall-clock TTL, global concurrency cap, ad-hoc-only intra-stage fan-out, brittle orphan recovery all remain.
- Not an architecture; it is a first move dressed as one.

**Risks**
- The in-container judge-panel adds a few concurrent subagents to the review container — size and token-budget it accordingly (small fan-out, but not zero).
- Solves nothing durable, so the real architectural decision is merely postponed.

**Verdict:** universally judged the ideal **Phase 0**, not the target architecture. Note the apparent tension — a step that scores *low* on architectural impact is nonetheless the mandated opener — is deliberate and resolves cleanly: Conservative's value is low *as an architecture* but high *as a risk-free value down-payment*. That is exactly why Hybrid grafts it as Phase 0 rather than choosing it as the target.

---

## Option D — Thin Router ("workflow-program entrypoint over a label state store")

**Stance:** Greenfield redesign, surgical at the seams. Keep labels as the state store and keep the `(role, success, outcome, mode) → nextStatus` table; **demote** the legacy single-agent entrypoint and make the workflow-program entrypoint the dispatch default. The daemon becomes a thin scheduler + event-router — but it still launches and babysits the **same container**; only the container's program changes.

**Summary.** Inverts the design from "daemon orchestrates a single-agent container" to "daemon routes events; the in-container program orchestrates its own fan-out." Keeps and hardens the two things fritZ does well; supersedes the incidental single-agent machinery (one-shot stream-json plumbing, some `boot.ts` prep, wall-clock TTL, global `maxParallelAgents`) where the workflow entrypoint replaces it. The autoloop's per-status switch still picks which stage to run, but launches a container whose program is the workflow fan-out instead of the single assignment. Crucially, this proposal is the only one that flags **claimIssue's non-atomicity** (github.ts:465, read-then-write) and **run-status-based orphan recovery** as *required* work, not freebies.

**Pros**
- Highest impact (scored 9) — same powerful end-state as Workflow-Native: the workflow-program entrypoint everywhere it applies.
- Most technically honest proposal: the only one to surface the real pre-existing liabilities (non-atomic claim, display-only `lastActivityAt` at registry.ts:67, wall-clock TTL at registry.ts:286–290) as prerequisites.

**Cons**
- "Demote the legacy entrypoint by default" greenfield framing directly contradicts "keep the legacy single-agent entrypoint as a co-equal default" — and overstates the removal, since pentest/retro/kali keep the single-agent entrypoint permanently.
- Removes the safe fallback to the legacy entrypoint entirely; there is no default-off lever.
- **One container hosts N concurrent subagents** under the workflow entrypoint — containers must be sized for N, with per-stage token budgets applied at the container level.
- **Durable resume requires a mounted volume** — any run-journal/checkpoint must live on a mounted volume, or it is lost on container crash.

**Risks**
- Penalized on reversibility/risk (6 / 5–6): demoting the proven single-agent entrypoint before parity is established is irreversible in practice.
- ~~Same isolation-regression exposure as Workflow-Native~~ — **not a risk: the fan-out is in-container.** This proposal does not introduce a host worktree; the container remains the trust boundary, so untrusted external-repo code never touches the host.

---

## Comparison and Scoring

Scores are the judge-panel consensus (1–10 per axis). The panels were highly consistent; the **Total** column reports the panel totals **as reported by the panels** (multiple panels per option, hence ranges), and is *not* a re-sum of the per-axis cells below it — per-axis cells are representative midpoints, while the totals are the authoritative panel verdicts. Higher is better on every axis. The Risk axis scores **residual risk after mitigation** (high = little risk left); note this deliberately overlaps with Reversibility for the reversible options, since their mitigations *are* reversibility levers.

> **Re-scoring note (in-container reframe).** The original panels scored the bold proposals (A/D) against a **host-worktree isolation regression** they treated as the top *unmitigated* risk. That risk is **removed** by in-container execution — there is no host worktree in v2; the container is the trust boundary. The Risk-axis penalty that put Workflow-Native "last place" on unmitigated isolation no longer applies on those grounds. A's Risk stays at 5 and D's at 5–6 **not** because the isolation penalty is silently retained, but because *entrypoint-demotion independently justifies the same residual figure*: both proposals make the workflow-program entrypoint the default and remove the safe fallback to the proven single-agent path, an irreversibility/blast-radius cost of the same magnitude the isolation worry used to carry. The penalty's *ground* changed (isolation → entrypoint-demotion); the *number* is warranted afresh by the new ground, not inherited. A and D are therefore penalized on the mandate-coherence and reversibility axes, with their residual-Risk figure now resting on entrypoint-demotion rather than isolation.

| Option | Feasibility | Impact | Risk (residual) | Reversibility | Coherence w/ mandate | Total (panels) |
|---|---|---|---|---|---|---|
| **B — Docker Substrate, Two Entrypoints** ⭐ | 8 | 8 | 8 | **9–10** | **9** | **44 / 43 / 43** (won every scorecard; anchor of the 4th) |
| C — Conservative Stage-Swap | **9–10** | 5 | 9 | 9 | 8 | 40 / 39 / 41 (2nd) |
| D — Thin Router | 7 | **9** | 5–6 (was isolation; now *entrypoint-demotion* risk only) | 6 | 6 | no single panel total reported — verdict: high-impact, low-reversibility (3rd, see note) |
| A — Workflow-Native | 6 | 8 | 5 (was "unmitigated isolation"; isolation now resolved in-container — residual is entrypoint-demotion) | 5 | 5 | 34 / 33 / 34 (last — on mandate coherence, not isolation) |

**How to read this table.** Conservative wins *feasibility* but is capped on *impact* because it fixes no structural pain. Thin Router wins *impact* (9) and *engineering honesty* but loses *reversibility* (6) and *risk* (5–6) because it demotes the legacy entrypoint by default — **not** because of any isolation regression, which is moot once fan-out is in-container. (Thin Router is the one option the panels recorded as a qualitative verdict — high-impact, low-reversibility — rather than a single numeric total range, which is why its Total cell carries that verdict in place of a number; its per-axis cells remain the representative midpoints.) Workflow-Native shares Thin Router's end-state but packages it as a big-bang that makes the workflow-program entrypoint the default; with the isolation risk resolved by in-container execution, its last-place finish rests on **mandate coherence and reversibility**, not on the previously-cited unmitigated isolation risk. Hybrid wins where the mandate lives — **reversibility and coherence** — while still capturing the in-container fan-out value on the fan-out-amenable stages first.

One caveat on the Risk axis: Hybrid scores high there *and* on Reversibility, and these are not fully independent — its three reversibility levers (default-off, fallback, kill-switch) *are* its risk mitigations. The table does not treat that as two separate wins; Reversibility is the structural property and Risk is the residual after applying it.

---

## Why Hybrid Wins, and What It Grafts From the Others

Hybrid is the only synthesis that satisfies the owner's explicit, non-negotiable intent — **keep the legacy single-agent entrypoint working and *add* a workflow-program entrypoint (in-container fan-out, ultracode/ultrathink-capable, with our own in-container judge-panel review) for some-or-all stages** — while still capturing the in-container fan-out value on the fan-out-amenable stages first (with `validate` as an acknowledged bounded win and `implement` as a deferred-then-promoted win — single-agent last, then first-class via single-WRITER read-side fan-out — below). Every judge panel reached this conclusion independently. Source verification confirms it is mechanically cheap and low-risk where it counts: `startAgent` (agents.ts:948-958) is a single delegating seam — a best-effort cache refresh, then `return startAgentDocker(options)` at agents.ts:957 — so the two-entrypoint router is a true single-seam change (with the cache-refresh preamble preserved), and the entire risky transition table in `github.ts` is genuinely executor-agnostic, so it is reused verbatim and never rewritten. It also builds on a substrate that *already* fans out in-container (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, agents.ts:413; teammate counting at agents.ts:197-204, :688-692), so the workflow entrypoint structures existing capability rather than bolting on a new runtime.

The win is not just "pick the safe one." Hybrid is explicitly a **synthesis** that grafts the best of the three losers while rejecting their big-bang framing:

**Grafted from Conservative (as the literal Phase 0):** Ship **our own in-container judge-panel review** at the `review` gate against the PR `implement` already opened — a small fan-out of in-process subagents (correctness + quality + security, "all must approve") inside the agent container, emitting the same `approved`/`rejected` outcome the legacy review agent does, so it maps onto the existing `--outcome=rejected → for-rework` contract verbatim with a mandatory single-agent fallback; add ultrathink to `define`/`architect`. The judge-panel's fan-out is expressed via the Workflow DSL **if** it is exposed to the containerized `claude`, else via the already-wired agent-teams mechanism (agents.ts:413) — in-container either way. Two SKILL.md prompts + one config flag, zero new entrypoint runtime — banking the value *before* any general entrypoint swap, entirely in-container on subscription billing. Its low *architectural* impact is precisely what makes it a safe down-payment. **Cloud ultrareview is *not* part of Phase 0** — it is reclassified as an optional future cloud escalation (see below), the one genuinely non-Docker, billed, cloud-triggered path.

**Grafted from Thin Router (its rigor, treated as prerequisites — not freebies):** These three hardenings are gated to land *before* any workflow-entrypoint stage that increases concurrency, because added in-container concurrency will expose them:
- **Harden `claimIssue`** (github.ts:465). Today it reads labels cache-first then calls `assignAgent` to edit — a verified read-then-write, despite the aspirational "check + assign atomically" comment. The fix is an optimistic-concurrency retry: re-read on conflict, condition the claim on absence of `active`/`blocked`, combine into a single edit. Note GitHub provides **no atomic label compare-and-set** — `gh issue edit --add-label` is not conditional server-side — so the retry loop *narrows* but cannot fully eliminate the daemon-vs-manual-edit race; that residual is accepted and observable, not closed.
- **Re-ground orphan/0-turn recovery on a reliable `hadActivity` signal** exported from the workflow entrypoint's run status, since `getOrphanRestoreStatus` already takes `hadActivity` (github.ts:611) but `lastActivityAt` is display-only (registry.ts:67) and won't carry the in-container fan-out's progress unless wired — otherwise the watchdog over-restores to `for-rework` and wastes a cycle.
- **Make completion idempotent and reconcilable** (extend the existing `releasedAgents` map; poll run status) so a lost/duplicated `/api/notify` webhook can't strand a stage at `fritz.status:active` with no container for the watchdog to find.

**Grafted from Thin Router / Workflow-Native (as the *patient* end-state, never the opening move):** Hold the supersession of incidental single-agent machinery (one-shot `agent-comms.ts` stream-json hand-parsing, some `boot.ts` prep, watchdog reconciliation special-cases) as the target the hybrid converges toward *only after* every stage has a proven workflow-entrypoint equivalent — and only for stages that *have* one. Pentest, retro, and kali keep the single-agent entrypoint permanently, so the convergence target is the incidental single-agent machinery, not the Docker substrate (which is permanent for both entrypoints).

**Grafted from Workflow-Native (the typed-handoff discipline):** Replace `report.sh`'s free-text `{type,message,outcome}` and the markdown `UX_SPEC/TECH_SPEC/ESTIMATE` with JSON-schema structured output, and **hard-fail** (route to `for-human`) any stage whose synthesized result doesn't validate, so handoffs cannot silently degrade back to prose-parsing.

**Hybrid's own contributions:**
- the **parity test** (identical transitions for both entrypoints) — anchored on the verified `getNextStatus` table (github.ts:551–611), whose happy-path mappings (not-success → for-human; security-review/pentest → for-human; architect/ux/budget standalone → defined, else for-define) are confirmed against the code;
- the **loud fallback signal** (so a broken workflow entrypoint is visible rather than masked behind a silent drop to the single-agent entrypoint);
- **backend-tagged run-handle attribution** (registry.ts:189, defending against mid-stage label edits) — still a container handle, just tagged with which entrypoint owns it;
- **activity-based TTL** via the existing `report.sh → /api/notify` heartbeat. This is *wiring up* signal the system already records, not new behavior: `touchAgent`/`lastActivityAt` already capture activity but are deliberately decoupled from expiry (`getExpiredAgents` at registry.ts:286–290 is wall-clock from `started`; `lastActivityAt` is commented "display only — does not affect TTL" at registry.ts:67). The change *connects* them — and it is the same underlying work as the orphan-recovery `hadActivity` graft above, since both depend on a trustworthy activity signal for the workflow entrypoint's in-container fan-out.

**On the workflow entrypoint's fan-out mechanism (verify before building):** the workflow program expresses its in-container fan-out via the Workflow scripting DSL (`pipeline()/parallel()/agent()`) **if and only if** that DSL is actually exposed to the containerized `claude` CLI. **If it is not**, the identical fan-out is expressed via the already-wired agent-teams/teammate mechanism (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, agents.ts:413), which the daemon already counts (agents.ts:197-204, :688-692). Either way, **the fan-out is in-container** and the synthesize-then-`report.sh` contract is identical; nothing here is a cloud/durable-run submission.

**On container sizing and concurrency (cross-cutting):** because the workflow entrypoint runs N in-process subagents in a single container, each such container must be **sized for N concurrent subagents** (CPU/RAM), not 1, and the **per-stage token budgets** (fan-out width cap + run-budget) must be applied **at the container level**. The global `maxParallelAgents` cap now governs *containers*, each of which may itself host N subagents — so effective concurrency is `containers × N`.

**On durability (cross-cutting):** any "resume" claim for the workflow entrypoint means *resume from the last journaled step, where the run-journal lives on a **mounted volume***. Container-ephemeral storage is lost on crash and would defeat resume; in-flight uncheckpointed reasoning is not guaranteed.

**On spend governance (scope discipline):** per-stage token budgets are **not** added to the Phase-1 read-only stages (security-review/review/validate are cheap relative to `implement`, and the subscription usage-monitor's coarse global pause suffices there). Budget accounting is scoped to the **billed cloud paths only** — *cloud* ultrareview as a deferred future escalation, which the subscription usage-monitor genuinely cannot see — gated on issue priority and rework-cycle count, skipped on the existing rebase-only diff-hash fast-track, with `for-human` as the hard backstop. Our own in-container judge-panel review is subscription-billed and needs only the container-level token budget above. Per-issue token budgeting on `implement` is deferred until `implement` itself migrates.

**On bounded/deferred wins (honesty about the ceiling):** Hybrid does not capture *all* in-container fan-out value on the two highest-cost stages. `validate` is a **bounded** win — it sits in the read-only adoption group *after* `security-review` and `review`, but unlike those two it is not a fully free advance: its QA/UX pair parallelizes in-container, yet it needs one shared running app (gh pr checkout + npm run dev), so it can only migrate once the in-container shared-runtime workspace is provisioned. Once that workspace exists, validators share it read-mostly, so shared-runtime contention is *reduced, not eliminated* — which is exactly why `validate` is the gated/bounded member of the first-mover group, not a free one. `implement` is a **deferred-then-promoted** win, and the deferral rationale is corrected here. It shares one feature branch and rework is inherently sequential (one branch, one PR, ordered feedback, max-3 cycles), so the **single-agent** shape stays on the legacy entrypoint and migrates **last** (Phase 5). But the docs were conservative on the wrong axis: implement-last is justified by **single-writer rework sequentiality and write blast-radius**, NOT by an unavoidable shared-branch merge hazard — that hazard is a *choice*. So after single-agent implement is proven, implement becomes a **first-class multi-agent target** (Phase 5b) via **single-WRITER read-side fan-out** that keeps exactly one writer on one branch and never re-introduces the merge hazard:

- **TEST-FIRST PIPELINE (headline).** read-only test-deriver → single writer-to-green against **locked** acceptance tests → independent mutation-probe verifier. Closes fritZ's weakest gate (self-graded tests, 01 §5) at ~2–2.5× cost, not N×. Uses adversarial-verify exactly where a genuine producer/critic asymmetry exists.
- **ADVERSARIAL-CRITIC LOOP (second).** one serialized writer + N read-only critics on the warm diff, looped-to-dry and capped. Read-only fan-out front-loads review catch-rate to collapse cross-container rework hops.

Neither needs the per-subagent worktree-isolation that the **rejected writer-fan-out** shapes are load-bearing on. Those writer-fan-out shapes — **TOURNAMENT** (N full-issue attempts → judge panel → synthesis+graft) and **DECOMPOSE-AND-PARALLELIZE** (planner → file-partitioned parallel implementers → integrator) — were scored against the single-agent steelman by an independent 3-judge panel and **lost**: worktree-per-attempt converts one shared branch into N private branches but only *relocates* implement's real cost (semantic merge at synthesis), which is precisely the documented **issue #486** context-loss failure (`SKILL.md` Merge-Conflict-Recovery: three PRs, each agent lost context and reintroduced already-caught bugs, +4 rework cycles) industrialized; they cost N× tokens on the highest-volume stage, maximize nondeterminism on the one stage that writes the merged artifact, and a human reviews the PR regardless. They are retained **only** as default-off, budget-gated, opt-in escalations (P0 ∨ ambiguous-spec ∨ auto-merge ∨ security-sensitive), **never on rework** (contract violation), **never on trivial diffs**, with a hard attempt cap (N=2–3). (Note: the old "host-worktree isolation" worry that previously gated `implement` is moot — the fan-out is in-container regardless; the remaining gate is shared-branch convergence for *writer* fan-out, which the single-writer shapes sidestep entirely.)

**On cloud ultrareview — deferred, optional, off-box escalation (NOT near-term):** `/code-review ultra` is reclassified out of the near-term plan. It is the one genuinely **non-Docker, billed, cloud-triggered, git-remote-requiring** path — the only place the "real git remote + PR" and "separate billing axis" constraints actually bite — and it is **not** on the near-term review path. Near-term review is **our own in-container judge-panel** (above). Cloud ultrareview remains available later as an explicitly-labeled **optional future cloud escalation** at the review gate, budget-gated on priority/rework count, with `for-human` as backstop — never the primary review path.

**In one line:** Docker substrate, two entrypoints, one seam — legacy single-agent entrypoint as the default, workflow-program (in-container fan-out) entrypoint added behind the `startAgent` router; conservative stage-swap (our own in-container judge-panel review + ultrathink) as Phase 0; thin-router's honesty as the engineering discipline; thin-router's supersessions as the patient end-state; big-bang rewrites and any host execution rejected; cloud ultrareview deferred as optional off-box escalation.
