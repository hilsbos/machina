export const meta = {
  name: 'fritz-v2-implement-multiagent',
  description: 'Adversarially challenge whether implement should be a primary multi-agent workflow stage; decide the best fan-out pattern; update all 8 evolution docs and summarize',
  phases: [
    { title: 'Investigate', detail: '5 agents explore multi-agent implement patterns + a steelman of the status quo' },
    { title: 'Decide', detail: '3 judges weigh patterns vs steelman; synthesize the decision/directive' },
    { title: 'Update', detail: 'per-file revise -> consistency-check -> finalize, applying the decision' },
    { title: 'Verify', detail: 'cross-doc consistency capstone' },
  ],
}

const BASE = '/path/to/fritz/docs/evolution'
const SKILL = '/path/to/fritz/.claude/skills/implement/SKILL.md'

const WORKFLOW_PRIMER = `The Claude Code Workflow feature (the fan-out mechanism we would run INSIDE the agent container) offers: agent(prompt,{schema,isolation,model}) to spawn a subagent (schema forces validated JSON; worktree-isolation gives each subagent its OWN git worktree so parallel writers never collide); parallel([...thunks]) (barrier, all run concurrently); pipeline(items, stage1, stage2, ...) (no barrier, each item streams through stages); a token budget cap; and proven quality patterns: judge-panel (generate N independent attempts from different angles, score with judges, synthesize from the winner while grafting best ideas from runners-up), adversarial-verify (N skeptics try to REFUTE a claim, kill on majority), loop-until-dry. CRITICAL fritZ constraint: all of this runs IN-CONTAINER (the container is the trust boundary); worktrees are created inside the cloned repo in the container, NOT on the host.`

const INVESTIGATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['pattern', 'oneLiner', 'howItWorks', 'conflictHandling', 'whenItWins', 'whenItLoses', 'costProfile', 'riskProfile', 'fitWithInContainerModel', 'recommendation'],
  properties: {
    pattern: { type: 'string' },
    oneLiner: { type: 'string' },
    howItWorks: { type: 'string', description: 'the fan-out shape as pseudo-structure: phases, agent count, verify/merge step' },
    conflictHandling: { type: 'string', description: 'how it avoids the shared-writable-branch contention that motivated implement-last' },
    whenItWins: { type: 'string' },
    whenItLoses: { type: 'string' },
    costProfile: { type: 'string', description: 'token/latency cost vs a single implement agent' },
    riskProfile: { type: 'string' },
    fitWithInContainerModel: { type: 'string', description: 'does it work in one container with in-process subagents + in-container worktrees?' },
    recommendation: { type: 'string', description: 'should fritZ adopt this for implement, and in what rollout position?' },
  },
}

const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['rankings', 'promoteImplement', 'bestPatterns', 'verdict'],
  properties: {
    rankings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pattern', 'value', 'feasibility', 'risk', 'total', 'note'], properties: { pattern: { type: 'string' }, value: { type: 'number' }, feasibility: { type: 'number' }, risk: { type: 'number', description: 'higher=lower risk' }, total: { type: 'number' }, note: { type: 'string' } } } },
    promoteImplement: { type: 'boolean', description: 'should implement be promoted as a primary/headline multi-agent stage rather than the cautious last one?' },
    bestPatterns: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
  },
}

const DECISION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['promoteImplement', 'rationale', 'headlinePatterns', 'sharedBranchResolution', 'rolloutChange', 'firstImplementExperiment', 'costControls', 'caveats', 'perDocChanges', 'summary'],
  properties: {
    promoteImplement: { type: 'boolean' },
    rationale: { type: 'string' },
    headlinePatterns: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'shape', 'useWhen'], properties: { name: { type: 'string' }, shape: { type: 'string', description: 'pseudo-structure sketch' }, useWhen: { type: 'string' } } } },
    sharedBranchResolution: { type: 'string', description: 'how the conflict/branch concern that justified implement-last is resolved (e.g. worktree-per-attempt in-container, single-writer integration step)' },
    rolloutChange: { type: 'string', description: 'new position of implement in the migration sequence vs the old last, and why' },
    firstImplementExperiment: { type: 'string', description: 'smallest viable implement slice to prove value' },
    costControls: { type: 'array', items: { type: 'string' } },
    caveats: { type: 'array', items: { type: 'string' } },
    perDocChanges: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'changes'], properties: { file: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } } } } },
    summary: { type: 'string' },
  },
}

const CONSISTENCY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['regressions', 'gaps', 'verdict'],
  properties: {
    regressions: { type: 'array', items: { type: 'string' }, description: 'places where the prior framing (one Docker substrate/two entrypoints, ultrareview deferred) was accidentally broken' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'docs where the implement decision was not fully or consistently applied' },
    verdict: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
phase('Investigate')

const PATTERNS = [
  { key: 'tournament', prompt: 'Investigate the TOURNAMENT / generate-N-attempts pattern for the implement stage: N subagents each implement the WHOLE issue independently, each in its OWN in-container git worktree (worktree-isolation mode), then a judge panel scores them and a synthesis agent picks the best and grafts strong bits from runners-up into the final branch. Focus on how worktree-per-attempt removes the shared-writable-branch contention that the current docs cite to justify implement-goes-last.' },
  { key: 'decompose-parallel', prompt: 'Investigate the DECOMPOSE-AND-PARALLELIZE pattern: a planner subagent splits the issue into conflict-free, file-partitioned components; parallel subagents implement each component (partitioned so they never touch the same files); a single integrator merges them on one branch and runs the build/tests. Focus on how the planner guarantees non-overlapping file ownership and what happens when partitions leak.' },
  { key: 'implement-critic-loop', prompt: 'Investigate the IMPLEMENT + ADVERSARIAL-CRITIC LOOP: one implementer subagent writes the code, then N critic subagents (correctness / security / perf / test-coverage lenses, optionally with ultrathink) try to break it, a fixer applies fixes, loop until critics go quiet (loop-until-dry). This is a single writable branch with a serialized writer — analyze whether the fan-out (critics) is worth it and how it differs from the separate review stage.' },
  { key: 'tdd-pipeline', prompt: 'Investigate the TEST-FIRST PIPELINE for implement: a spec/test-deriver subagent writes acceptance tests from the issue+spec first, the implementer codes until green, an independent verifier subagent confirms the tests actually capture the spec (not gamed). Analyze fit, cost, and how it raises baseline quality.' },
  { key: 'steelman-status-quo', prompt: 'STEELMAN THE STATUS QUO: argue as strongly as possible that implement should STAY a single in-container agent and remain the LAST stage converted (or never converted). Surface the real reasons: shared writable branch / integration risk, nondeterminism of multiple attempts, token cost of N full implementations, debuggability and PR coherence, the fact that a human reviews the PR anyway, and that review/security-review give more value per token. Set recommendation = keep single-agent/last and be persuasive — this is the position the panel must beat.' },
]

const investigations = (await parallel(PATTERNS.map(p => () =>
  agent(
    `${p.prompt}\n\nGround yourself: read the implement skill at ${SKILL} (and a worktree copy under /path/to/fritz/.claude/worktrees/agent-*/.claude/skills/implement/SKILL.md if the top-level is thin) to know what the implement agent does today, and skim ${BASE}/05-stage-mapping.md and ${BASE}/06-migration-and-coexistence.md for the CURRENT treatment (implement is converted LAST, single writable branch cited as the reason).\n\n${WORKFLOW_PRIMER}\n\nfritZ context: a stage runs as ONE Docker container; v2 changes the container PROGRAM (entrypoint) from a single agent to a workflow program that fans out in-process subagents IN-CONTAINER. The state machine, report.sh completion contract, and "container is the trust boundary" are unchanged. The user is specifically interested in making implement a primary multi-agent target. Be concrete and honest.`,
    { label: `investigate:${p.key}`, phase: 'Investigate', schema: INVESTIGATE_SCHEMA }
  )
))).filter(Boolean)
log(`Investigated ${investigations.length} implement patterns (incl. steelman)`)
const investJson = JSON.stringify(investigations)

// ---------------------------------------------------------------------------
phase('Decide')

const judges = (await parallel([0, 1, 2].map(i => () =>
  agent(
    `You are judge #${i + 1}. The user believes implement is the most interesting place to use multi-agent workflows; your job is to test that HONESTLY against the steelman, not rubber-stamp it. Score each pattern on value, feasibility, risk (higher=lower risk). Decide promoteImplement: should implement become a PRIMARY/headline multi-agent stage, or does the steelman win (keep it single-agent/last)? Name the best pattern(s). Weigh: worktree-per-attempt removes branch contention BUT N full implementations cost N times the tokens and add nondeterminism + integration/selection complexity; a human reviews the PR regardless.\n\nPatterns + steelman:\n${investJson}\n\n${WORKFLOW_PRIMER}`,
    { label: `judge:${i + 1}`, phase: 'Decide', schema: JUDGE_SCHEMA }
  )
))).filter(Boolean)
log(`Collected ${judges.length} judge verdicts`)

const decision = await agent(
  `You are the chief architect. Make the final call on implement-as-multi-agent and produce a precise decision that will be applied across 8 design docs. Use ultrathink-level rigor. Honor the judges; if the steelman won, say implement stays single-agent/last and update docs to strengthen that rationale instead. If implement is promoted, specify the headline pattern(s) (with pseudo-structure shapes), how the shared-branch concern is resolved (e.g. worktree-per-attempt in-container + single-writer integration), the new rollout position vs the old last, the smallest first implement experiment, and hard cost controls (per-stage token budget, attempt cap N, skip-on-trivial-diff).\n\nCRITICAL — do NOT regress the established framing: keep "one Docker substrate, two entrypoints" (no second engine, no host execution; worktrees are in-container), keep cloud ultrareview DEFERRED with near-term review = our own in-container judge-panel. Your changes are ADDITIVE to the implement story only.\n\nFor perDocChanges, give targeted edits for EACH of: README.md, 01-current-architecture.md, 02-capabilities-and-opportunity.md, 03-architecture-options.md, 04-target-architecture.md, 05-stage-mapping.md, 06-migration-and-coexistence.md, 07-risks-and-open-questions.md.\n\nPatterns + steelman:\n${investJson}\n\nJudge verdicts:\n${JSON.stringify(judges)}`,
  { label: 'synthesize-decision', phase: 'Decide', schema: DECISION_SCHEMA }
)
log(`Decision: promoteImplement=${decision.promoteImplement}`)
const decisionJson = JSON.stringify(decision)

// ---------------------------------------------------------------------------
phase('Update')

const FILES = [
  { file: 'README.md', hint: 'Update the per-stage table implement row and the rollout/first-experiment summary to reflect the decision. Keep the one-line summary and ultrareview-deferred note intact.' },
  { file: '01-current-architecture.md', hint: 'Baseline only: ensure the implement stage is described as a single in-container writable-branch agent today (the thing v2 changes). Minimal touch.' },
  { file: '02-capabilities-and-opportunity.md', hint: 'Add/adjust the capability to stage mapping so implement appears with its chosen fan-out pattern(s) and where ultrathink fits; keep ultrareview deferred.' },
  { file: '03-architecture-options.md', hint: 'Reflect that the option analysis now treats implement as a (de)prioritized multi-agent target per the decision; update any implement-last / branch-contention reasoning that the decision overturns or reaffirms.' },
  { file: '04-target-architecture.md', hint: 'Update the per-stage decision row for implement and, if promoted, add the implement fan-out shape to the execution model (worktree-per-attempt in-container + single-writer integration). Keep substrate/entrypoint framing.' },
  { file: '05-stage-mapping.md', hint: 'PRIMARY DOC: update the implement row and add/replace its pseudo-structure sketch with the chosen pattern (tournament / decompose / critic-loop / tdd as decided), incl. the fallback envelope to the legacy single-agent entrypoint, in-container worktrees, and cost controls.' },
  { file: '06-migration-and-coexistence.md', hint: 'PRIMARY DOC: update the rollout ORDER to the new position for implement that the decision sets (vs old last), the first implement experiment, and the default-legacy/fallback story.' },
  { file: '07-risks-and-open-questions.md', hint: 'Update implement-specific risks: branch contention now resolved via worktree-per-attempt (or reaffirmed if steelman won), N-times-token cost + the cost controls, selection/integration nondeterminism, debuggability/PR-coherence, and any open questions. Keep the isolation-resolved framing.' },
]

const updated = await pipeline(
  FILES,
  (f) => agent(
    `Apply this implement-multi-agent DECISION to ${BASE}/${f.file}. Read the current file first, apply changes SURGICALLY — preserve structure, depth, tables, ASCII diagrams, code anchors, AND the established framing (one Docker substrate / two entrypoints; ultrareview deferred). Only touch what the decision and this file hint require.\n\nThis file hint: ${f.hint}\n\n=== DECISION ===\n${decisionJson}\n\nAfter editing, WRITE the full updated markdown back to ${BASE}/${f.file} with the Write tool, then return the final content as text.`,
    { label: `revise:${f.file}`, phase: 'Update' }
  ),
  (content, f) => agent(
    `Check the revised ${f.file} against the DECISION and the established framing. Flag: implement changes missing or inconsistent with the decision; ANY regression of "one Docker substrate/two entrypoints" or the ultrareview-deferred stance; lost depth/anchors; internal contradictions.\n\nHint: ${f.hint}\n\n=== DECISION ===\n${decisionJson}\n\n=== REVISED ===\n${content}\n\nReturn a concise numbered fix list, or say it is fully conformant.`,
    { label: `check:${f.file}`, phase: 'Update' }
  ).then(critique => ({ content, critique })),
  async (prev, f) => agent(
    `Finalize ${f.file}: apply valid fixes, ignore wrong ones, preserve structure/depth/anchors and the established framing.\n\n=== FIXES ===\n${prev.critique}\n\n=== DECISION (authority) ===\n${decisionJson}\n\n=== CURRENT ===\n${prev.content}\n\nWRITE the final markdown to ${BASE}/${f.file} with the Write tool, then return the result.`,
    { label: `finalize:${f.file}`, phase: 'Update', schema: { type: 'object', additionalProperties: false, required: ['file', 'changesApplied'], properties: { file: { type: 'string' }, changesApplied: { type: 'array', items: { type: 'string' } } } } }
  )
)
const done = updated.filter(Boolean)
log(`Updated ${done.length}/${FILES.length} docs`)

// ---------------------------------------------------------------------------
phase('Verify')

const consistency = await agent(
  `Cross-doc consistency capstone. Read all 8 docs in ${BASE}/. Verify: (1) the implement decision is applied uniformly (same pattern names, same rollout position, same first-experiment, same cost controls) across README/04/05/06/07 and referenced consistently in 02/03; (2) NO regression of "one Docker substrate, two entrypoints" (no second engine, no host execution; worktrees are in-container); (3) ultrareview still uniformly deferred and near-term review still "our own in-container judge-panel"; (4) no doc contradicts another on implement rollout order or fan-out shape. Flag anything off with file references.\n\n=== DECISION ===\n${decisionJson}`,
  { label: 'cross-doc-consistency', phase: 'Verify', schema: CONSISTENCY_SCHEMA }
)
log('Consistency capstone complete')

return { decision, updated: done, consistency }
