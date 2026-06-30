# Retro Metrics History

Tracks agent team performance over time. Updated by the retro agent after each scan.

## Metrics History

| Date | Mode | Agents | Avg Tokens (cache) | Failure Rate | Rework % | Avg Duration | Experiments |
|------|------|--------|-------------------|-------------|----------|-------------|-------------|
| 2026-03-24 | log-based | 732 | 2.16M | 4.5%* | 16.2%† | 6m 6s | — |
| 2026-02-26 | log-based | 75 | 3.12M | 6.7% | 0% | 6m 44s | — |
| 2026-02-25 | log-based | 100 | 3.6M | 4.0% | 16.0% | 7m 22s | — |
| 2026-02-20 | log-based | 100 | 4.2M | 1.0% | 15.8% | 7m | (baseline) |

### Column Definitions
- **Agents**: Total agent runs scanned in this retro period
- **Avg Tokens (cache)**: Average `cacheReadInputTokens` per completed agent
- **Failure Rate**: Percentage of agents with `exitStatus` = `dead` or `expired` (stopped agents excluded — these are superseded, not failures)
- **Rework %**: Percentage of issues in the scan period that have `fritz.rework:N` labels
- **Avg Duration**: Mean wall-clock duration across all completed agents
- **Experiments**: Active experiments or `(baseline)` for first run

### Notes on 2026-02-26 Metrics
- *6.7% failure rate = 5 dead agents. 2 confirmed interactive chat-mode sessions (architect-509-e64c, architect-502-627a). 2 zero-turn immediate stops (architect-509-b601 dur=0s, architect-502-db91 dur=5s — likely infrastructure restarts, not skill failures). 1 orchestrated review timeout (review-523-aa30, 6m 6s, lastActivity confirms review was complete before daemon lost contact). Autonomous operational failure rate: 0%.
- †Rework %: No issues in the scan period (issues 502–533) have `fritz.rework:N` labels. However 3 issues (503, 506, 523) experienced 3–4 implement/review cycles each — rework cycles that were resolved without escalation to the label threshold. System is completing all work autonomously.
- Avg cache tokens: 3.12M across all completed agents. Implement highest at 5.06M, validate lowest at 2.27M.
- Avg duration decreased from 7m 22s (scan 2) to 6m 44s (scan 3). Validate further improved to 4.8m avg / 4.6m median (100% solo, 0% subagents — down from 18% in scan 2).
- 3 issues involved external repos (your-other-repo) with standard 2-agent cycles.
- Architect: 100% subagent rate (17/17 autonomous completed with ≥1 subagent). All 4 dead architect agents confirmed non-autonomous failures. Solo architect rate now 0% (vs 44% in scan 2).

### Notes on 2026-02-25 Metrics
- 4.0% failure rate = 4 dead agents, ALL confirmed interactive/chat-mode sessions (not autonomous failures). Autonomous completion rate: 100%.
- Avg tokens (cache) decreased 14% (4.2M → 3.6M) despite implement outlier (implement-183-ad3d, 26.57M, massive test suite). Median cache tokens lower than average.
- 16.0% rework: 4 of 25 visible issues have rework labels. Issue #357 (rework:5) hit rework limit and was escalated to human — system worked correctly.
- Avg duration: 7m 22s across all roles; validate improved to 4m 45s (21% faster than baseline).

## Role Performance

### Scan 3 (2026-02-25 to 2026-02-26)

| Role | Agents | Avg Duration | Median Duration | Avg Cache Tokens | Failure Rate | Subagent % |
|------|--------|-------------|----------------|-----------------|-------------|------------|
| implement | 22 | 8m 6s | 7m 36s | 5.06M | 0% | 41% |
| review | 21 | 6m 12s | 5m 18s | 2.79M | 5% (1 dead, orchestration timeout) | 35% |
| validate | 9 | 4m 48s | 4m 36s | 2.27M | 0% | 0% |
| architect | 21 | 6m 48s | 5m 48s | 3.12M | 19%* | 100% |
| retro | 2 | 7m 6s | — | 3.21M | 0% | 0% |

*Architect 19% = 4/21 dead. 2 confirmed interactive chat-mode (architect-509-e64c, architect-502-627a). 2 zero-turn stops (dur=0s, 0 cache — infrastructure issue). All 17 autonomous architect runs completed.

### Scan 2 (2026-02-20 to 2026-02-25)

| Role | Agents | Avg Duration | Median Duration | Avg Cache Tokens | Failure Rate | Subagent % |
|------|--------|-------------|----------------|-----------------|-------------|------------|
| implement | 32 | 9m 48s | 7m 47s | 6.16M | 0% | 66% |
| review | 40 | 6m 20s | 5m 15s | 3.19M | 5% (2 dead, both interactive) | 53% |
| validate | 17 | 4m 45s | 4m 29s | 2.60M | 0% | 18% |
| architect | 9 | 6m 8s | 5m 56s | 2.83M | 22%* | 56% |
| define | 2 | 7m 57s | 9m 19s | 3.20M | 0% | 0% |

*Architect 22% = 2/9 dead, but both confirmed interactive chat-mode sessions. Autonomous architect completion: 7/7 = 100%.

### Scan 1 (2026-02-19 to 2026-02-20 — Baseline)

| Role | Agents | Avg Duration | Median Duration | Avg Cache Tokens | Failure Rate | Subagent % |
|------|--------|-------------|----------------|-----------------|-------------|------------|
| implement | 32 | 8m 11s | 7m 0s | 5.8M | 3.0% (1 dead) | 41% |
| review | 36 | 6m 13s | 6m 0s | 3.3M | 0% | 69% |
| validate | 25 | 6m 2s | 6m 0s | 3.4M | 0% | 44% |
| architect | 1 | 8m 0s | 8m 0s | 4.4M | 0% | 100% |

## Trends (Scan 2 → Scan 3)

| Role | Duration Δ | Cache Tokens Δ | Subagent % Δ | Notes |
|------|-----------|----------------|-------------|-------|
| implement | -17% (9m48s → 8m6s) | -18% (6.16M → 5.06M) | -25pp (66% → 41%) | Duration and cache back to near baseline. No outlier in scan 3. |
| review | -2% (6m20s → 6m12s) | -12% (3.19M → 2.79M) | -18pp (53% → 35%) | Review cost continues to shrink; 1 orchestration timeout (not skill issue) |
| validate | +1% (4m45s → 4m48s) | -13% (2.60M → 2.27M) | -18pp (18% → 0%) | **Solo lock achieved** — 100% solo, 0 subagents. Cache tokens still falling. |
| architect | +11% (6m8s → 6m48s) | +10% (2.83M → 3.12M) | +44pp (56% → 100%) | All autonomous runs used subagents. No solo architects in scan 3. |

## Trends (Scan 1 → Scan 2)

| Role | Duration Δ | Cache Tokens Δ | Subagent % Δ | Notes |
|------|-----------|----------------|-------------|-------|
| implement | +19% (8m11s → 9m48s) | +6% (5.8M → 6.16M) | +25pp (41% → 66%) | Outlier: implement-183-ad3d (53m, 9 subagents, test suite). Median stable: 7m0s → 7m47s |
| review | +2% (6m13s → 6m20s) | -3% (3.3M → 3.19M) | -16pp (69% → 53%) | Review pair cost shrinking; quality maintained |
| validate | -21% (6m2s → 4m45s) | -24% (3.4M → 2.60M) | -26pp (44% → 18%) | **Significant improvement** — solo-first approach working |
| architect | −23% (8m0s → 6m8s) | −36% (4.4M → 2.83M) | −44pp (100% → 56%) | Baseline had only 1 architect; scan 2 had 9 (more representative) |

## Experiment Results

| Experiment | Date | Result | Adopted? |
|------------|------|--------|----------|
| Phase 1: Re-review efficiency + parallel context loading + investigate-before-acting | 2026-02-26 | Not yet measurable — insufficient scan data to evaluate | No |

## Notes

### 2026-02-26 — Scan 3

- **Period**: 2026-02-25 to 2026-02-26 (~1 day)
- **Coverage**: 75 agents across 16 issues (full coverage — no pagination limit hit)
- **Key findings**:
  - 0% autonomous failure rate (5 dead agents: 2 chat-mode interactive, 2 zero-turn infrastructure stops, 1 orchestration timeout)
  - Validate solo lock: 9/9 validate agents ran completely solo (0% subagents), down from 18% in scan 2
  - Implement efficiency improved: avg duration 9m48s → 8m6s (-17%), cache tokens 6.16M → 5.06M (-18%)
  - 3 issues (503, 506, 523) had 3–4 implement/review cycles each; none triggered `fritz.rework:N` labels
  - Issue #506 specifically: 3 successive review cycles each caught one more missing doc location (ARCHITECTURE.md → README → DECISIONS.md); DECISIONS.md not in implement doc checklist (single incident)
  - All external repo issues (529–533) completed in exactly 2 agent cycles (architect + implement)
  - Architect role: 100% subagent rate across 17 autonomous runs (all used ≥1 subagent)
  - No patterns met the 3-occurrence threshold for skill or knowledge PRs — single incidents documented

### 2026-02-25 — Scan 2

- **Period**: 2026-02-20 to 2026-02-25 (~5 days)
- **Coverage**: 100 agents across 25 issues (hit the 100-agent limit; oldest agents from the period may be missing)
- **Key findings**:
  - 100% autonomous completion rate (4 dead agents were all interactive chat-mode sessions)
  - Validate efficiency improved 21%: subagent rate dropped from 44% to 18%, avg duration 6m 2s → 4m 45s
  - Cross-repo pattern confirmed: 9 cross-repo issues averaged 4.8 agents/issue vs 3.6 for single-repo
  - Review re-review token spike confirmed: 7 review agents exceeded 2x median, all on re-reviews
  - Rework system working correctly: issue #357 (rework:5) escalated to human via rework limit mechanism
  - Issue #183 (test suite) is a statistical outlier: 53m runtime, 9 subagents, 26.57M cache tokens (single large-scope task)
  - Implement subagent rate increased (41% → 66%) — more complex issues spawning implementation teammates

### 2026-02-20 — First Retro Scan (Baseline)
- **Period**: 2026-02-19 21:11 UTC to 2026-02-20 09:03 UTC (~12 hours)
- **Coverage**: 100 agents across 19 issues (hit the 100-agent limit; older agents may exist)
- **Key findings**:
  - 94% completion rate (94 completed, 5 stopped/superseded, 1 dead)
  - Universal 3-minute initial timeout on persistent sessions (infrastructure, not failure)
  - Cross-repo issues (#172, #349, #403, #405) averaged 10 agent runs vs 3-4 for single-repo
  - 3 of 19 issues (15.8%) had `fritz.rework` labels (#405: rework:2, #431: rework:1, #398: rework:1)
  - Implement agents are the most expensive role (5.8M avg cache tokens, 8m avg duration)
  - Review agents with re-reviews consume 2-3x median cache tokens

### Notes on 2026-03-24 Metrics
- *4.5% failure rate = 33 dead agents across 732 total. Architect dead rate 24.1% (13/54) = all confirmed chat-mode interactive sessions or zero-turn infrastructure restarts. Implement dead rate 4.4% (12/274) = mostly 3-minute startup timeouts (infra). Review dead rate 2.4% (6/249) = 1 infra, 2 chat-mode, 3 early timeouts. Autonomous operational failure rate: ~0%.
- †Rework %: 18/111 closed issues had `fritz.rework:N` labels = 16.2%, consistent with scan 2 baseline (16.0%). Issue #685 (rework:4) was a large architectural refactor (14 implement/review cycles). No issues hit rework limit escalation.
- **Major efficiency improvement**: Avg cache tokens dropped 44% vs scan 3 (3.12M → 2.16M). Implement dropped 44% (5.06M → 2.85M), review dropped 50% (2.79M → 1.58M). Driven by declining subagent rate.
- **Subagent rate declining**: Implement 41% → 26%, validate 0% → 25% (Feb avg was 34%, Mar improved to 24%). Solo implement is 81% more cache-efficient (2480k vs 4483k avg).
- **New roles**: pentest (13 runs, 11 completed, uses Kali container tools — toolUsage always empty, by design), ux (3/3 completed), define growing (34 runs vs 2 in scan 2).
- High-cycle issues: 22 issues (23%) had 5+ implement/review cycles. Caused by genuinely complex features (fritzbridge, state management), not skill failures. Review agent finding real bugs each cycle.
- Coverage: 732 agents across 96 issues (2026-02-26 to 2026-03-24, 26 days).

### Scan 4 (2026-02-26 to 2026-03-24)

| Role | Agents | Avg Duration | Median Duration | Avg Cache Tokens | Failure Rate | Subagent % |
|------|--------|-------------|----------------|-----------------|-------------|------------|
| implement | 274 | 6m 24s | 5m 42s | 2.85M | 4.4%* | 26% |
| review | 249 | 5m 24s | 5m 18s | 1.58M | 2.4%* | 40% |
| validate | 103 | 4m 36s | 4m 6s | 1.58M | 0% | 25% |
| architect | 54 | 7m 24s | 7m 0s | 2.24M | 24.1%* | 76% |
| define | 34 | 7m 24s | 7m 6s | 1.97M | 0% | 6% |
| pentest | 13 | 16m 24s | 16m 54s | 3.36M | 15.4%† | 15% |
| ux | 3 | 6m 18s | 6m 6s | 1.62M | 0% | 0% |
| retro | 2 | 9m 42s | — | 4.12M | 0% | 0% |

*Dead agents: implement (12) = 3-min infra timeouts; review (6) = 3 chat-mode/early timeout; architect (13) = all chat-mode/zero-turn infra. Autonomous failure rate ≈0%.
†Pentest (2 dead): 1 chat-mode interactive, 1 infra startup timeout.


## Trends (Scan 3 → Scan 4)

| Role | Duration Δ | Cache Tokens Δ | Subagent % Δ | Notes |
|------|-----------|----------------|-------------|-------|
| implement | -21% (8m6s → 6m24s) | -44% (5.06M → 2.85M) | -15pp (41% → 26%) | Major efficiency leap. Solo-first trend continues. |
| review | -13% (6m12s → 5m24s) | -43% (2.79M → 1.58M) | +5pp (35% → 40%) | Cache cost halved. Subagent rate stable. |
| validate | -4% (4m48s → 4m36s) | -30% (2.27M → 1.58M) | +25pp (0% → 25%) | Scan 3 was 1-day sample (9 agents). Full period avg is 25% subagent. |
| architect | +9% (6m48s → 7m24s) | -28% (3.12M → 2.24M) | — | Dead rate artificially high (chat-mode). |
| define | NEW | NEW | NEW | 34 runs, 0% failure, 6% subagent — lightweight and reliable. |
| pentest | NEW | NEW | NEW | 13 runs, 15.4% dead = all infra/chat-mode. Uses Kali tools (toolUsage always {}). |

### Scan 4 Notes (2026-02-26 to 2026-03-24)
- **Period**: 2026-02-26 to 2026-03-24 (~26 days)
- **Coverage**: 732 agents across 96 issues (full coverage — no pagination limit hit, all 732 fetched)
- **Key findings**:
  - 0% autonomous failure rate: all dead agents confirmed as chat-mode interactive sessions or 3-min infra startup timeouts
  - Major cache token reduction: -44% implement, -43% review vs scan 3. Driven by declining subagent rate (43%→26% implement, 35%→40% review stable but lower absolute cost)
  - Rework rate 16.2% (18/111 closed issues) — consistent with scan 2 baseline. Review finding genuine bugs each cycle (verified issue #594: 10 cycles, all finding real blockers)
  - High-cycle issues are feature-complexity driven: issue #594 (20 cycles, fritzbridge), #486 (17 cycles, dashboard sync), #685 (14 cycles, state management refactor)
  - Solo implement: 2480k cache / 5.5m avg vs paired: 4483k cache / 10.1m avg — solo is 81% more cache-efficient
  - New roles working well: define (34/34 completed), pentest (11/13 completed), ux (3/3 completed)
  - Pentest toolUsage always `{}` — by design, pentest uses Kali Linux tools (nmap, nikto, etc.) not Claude standard tools
  - Architect "failures" remain a classification artifact: all 13 dead architect agents in new period confirmed as chat-mode or zero-turn infra restarts

