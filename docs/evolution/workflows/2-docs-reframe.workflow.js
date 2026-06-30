export const meta = {
  name: 'fritz-v2-docs-reframe',
  description: 'Reframe the fritZ v2 evolution docs to "Docker substrate, two entrypoints" (in-container fan-out) and defer ultrareview in favor of our own in-container judge-panel review',
  phases: [
    { title: 'Ground', detail: 'verify code anchors, crystallize the canonical change directive' },
    { title: 'Edit', detail: 'per-file revise -> consistency-review -> finalize-write, in parallel' },
    { title: 'Verify', detail: 'cross-doc consistency capstone' },
  ],
}

const BASE = '/path/to/fritz/docs/evolution'
const REPO = '/path/to/fritz/fritz-orchestrator/daemon/src'

const DOC_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'changesApplied', 'wordCount'],
  properties: {
    file: { type: 'string' },
    changesApplied: { type: 'array', items: { type: 'string' } },
    wordCount: { type: 'number' },
  },
}

const CONSISTENCY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['contradictions', 'staleFraming', 'verdict'],
  properties: {
    contradictions: { type: 'array', items: { type: 'string' }, description: 'cross-doc contradictions or claims that still conflict with the directive' },
    staleFraming: { type: 'array', items: { type: 'string' }, description: 'leftover "two engines" / "ultrareview as near-term" framing that was not fully reframed, with file refs' },
    verdict: { type: 'string', description: 'overall: are the 8 docs internally consistent with the directive? what (if anything) still needs a touch-up' },
  },
}

// ---------------------------------------------------------------------------
phase('Ground')

const directive = await agent(
  `You are crystallizing an authoritative CHANGE DIRECTIVE that 8 markdown design docs will be reframed against. First VERIFY these claims against the real code, then write the directive.\n\nVerify by reading:\n- ${REPO}/agents/agents.ts around line 413 (expect: injects env CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 into every agent container) and around lines 197-204 / 688-692 (expect: daemon parses session.subagentCount and logs "Agent spawned N teammate(s)").\n- ${REPO}/agents/agents.ts startAgent (~line 948) — confirm it is a thin one-line router (return startAgentDocker(options)).\n- ${REPO}/agents/agent-comms.ts — confirm agents are driven via docker exec -i <container> claude with stream-json (in-container).\nQuote the real line numbers you find.\n\nThen also Read all 8 docs in ${BASE}/ (README.md, 01..07) so the directive references their actual current framing.\n\nThe directive MUST codify these decisions precisely and unambiguously:\n\n1. REFRAME "two engines" -> "ONE Docker substrate, TWO entrypoints". The existing model already runs Claude Code INSIDE a Docker container per stage. v2 does NOT add a second execution engine and does NOT move execution to the host. It changes the container's PROGRAM (entrypoint): legacy = single-agent entrypoint (claude -p "<assignment>"); v2 = workflow-program entrypoint that fans out N in-process subagents inside the SAME container, then synthesizes and calls report.sh. The container, credential copy, watchdog, activity-TTL, image variants (incl. Kali/pentest), and the report.sh -> /api/notify + /api/ask completion contract are ALL UNCHANGED. The fritz.engine:<docker|workflow> label and the startAgent seam select the ENTRYPOINT, not a separate engine.\n\n2. EVIDENCE the substrate already exists: every container already gets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 and the daemon already counts in-container teammates (session.subagentCount, "Agent spawned N teammate(s)"). In-container multi-agent fan-out is ALREADY LIVE; the workflow-program entrypoint just structures it. Cite the verified line numbers.\n\n3. ISOLATION RISK DOWNGRADE: because fan-out runs IN-CONTAINER, the container remains the trust boundary and untrusted external-repo (fritz.repo:) code never touches the host. The "host-worktree isolation regression" that the judge panel raised against the bold Workflow-Native proposal is RESOLVED by in-container execution and must be downgraded from a top risk to a non-issue (note: only relevant if one ever runs Workflow on the host, which v2 does not).\n\n4. DEFER ULTRAREVIEW — DO OUR OWN REVIEW NOW. The near-term review stage is our OWN in-container workflow-driven review: a judge-panel of in-process subagents (e.g. correctness + quality + security lenses, "all must approve") running inside the agent container against the PR/diff, emitting the same approved/rejected outcome the legacy review agent does. Cloud ultrareview (/code-review ultra) is RECLASSIFIED as a FUTURE, OPTIONAL, off-box augmentation — it is the one genuinely non-Docker, billed, cloud-triggered, git-repo-requiring path, and it is NOT on the near-term plan. Everywhere a doc currently puts ultrareview on the primary/near-term review path, change it to "our own in-container judge-panel review (near-term); ultrareview = optional future cloud escalation".\n\n5. CAVEATS to thread through where relevant: (a) verify whether the literal Workflow scripting DSL/tool is exposed to the containerized claude CLI; if not, express the same fan-out via the already-wired agent-teams/teammate mechanism — either way it is in-container; (b) one container now hosts N concurrent subagents, so size CPU/RAM and apply the per-stage token budgets; (c) durable run-journal/resume requires the journal on a MOUNTED volume (container-ephemeral storage would lose it on crash).\n\n6. The codename "Janus" still fits, but reframe its meaning to "two entrypoints" rather than "two engines".\n\nWrite the directive as crisp, numbered, copy-pastable guidance an editor can apply mechanically. Include a short "what does NOT change" list and the verified code anchors. Return ONLY the directive text.`,
  { label: 'change-directive', phase: 'Ground' }
)
log('Change directive crystallized')

// ---------------------------------------------------------------------------
phase('Edit')

const FILES = [
  { file: 'README.md', focus: ['Rewrite the one-line recommendation and "recommendation in one line" section to "Docker substrate, two entrypoints" (not two engines).', 'Update the per-stage table: review -> "our own in-container judge-panel review (workflow entrypoint); ultrareview = optional future cloud escalation"; security-review/validate/etc -> note fan-out is in-container. Remove ultrareview from the near-term review cell.', 'Add a one-line note that ultrareview is deferred and is the only off-box/billed path.', 'Keep the first-experiment (security-review in-container fan-out behind fritz.engine:workflow, default-off).'] },
  { file: '01-current-architecture.md', focus: ['ADD a subsection documenting the existing seam: every container already injects CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 and the daemon already counts in-container teammates (session.subagentCount / "Agent spawned N teammate(s)") with verified line numbers — i.e. in-container multi-agent fan-out is ALREADY LIVE and is the seam v2 builds on.', 'Otherwise keep the baseline accurate; do not reframe history, just add this fact where the execution model is described.'] },
  { file: '02-capabilities-and-opportunity.md', focus: ['Reclassify: the in-container Workflow fan-out (driving in-process subagents) is the SUBSTRATE and runs in Docker; ultrareview is a cloud/billed/off-box augmentation that is DEFERRED.', 'Update the capability->stage mapping table so the near-term review approach is "our own in-container judge-panel review", with ultrareview marked future-optional.', 'Add the caveat: verify the Workflow DSL is exposed to the containerized CLI; otherwise use the agent-teams/teammate mechanism (still in-container).'] },
  { file: '03-architecture-options.md', focus: ['Note that the winning hybrid is reframed as "Docker substrate, two entrypoints".', 'Explicitly record that the Workflow-Native proposal main con (host-worktree isolation regression) is REMOVED by in-container execution — update its cons / the scoring narrative accordingly.', 'Record the decision to defer ultrareview in favor of our own in-container review as an option-level consideration.'] },
  { file: '04-target-architecture.md', focus: ['THE PRIMARY REFRAME. Recast "Janus / two engines" as "one Docker substrate, two entrypoints". Replace engine-vs-engine language with single-agent-entrypoint vs workflow-program-entrypoint, BOTH inside the same Docker container.', 'Replace/redo the main ASCII diagram to show today (claude -p one agent) vs v2 (claude driving a workflow program -> N in-process subagents -> synthesize -> report.sh), with the container/creds/watchdog/TTL/report.sh boundary explicitly UNCHANGED.', 'startAgent remains the seam but selects the ENTRYPOINT. Keep labels-as-truth and the executor-agnostic transition core verbatim.', 'Review stage = our own in-container judge-panel (defer ultrareview); mention ultrareview only as an optional future cloud escalation.'] },
  { file: '05-stage-mapping.md', focus: ['Update the stage table engine column to make clear all fan-out is IN-CONTAINER (workflow entrypoint), not a separate engine.', 'review row: "in-container judge-panel (workflow entrypoint), all-must-approve" near-term; ultrareview = optional future cloud escalation (remove it from the primary cell).', 'Keep/adjust the pseudo-structure sketches to show in-process subagents inside the container; add the fallback envelope reverting to the single-agent entrypoint.', 'Add a note on container resource sizing for N concurrent subagents and durable run-journal on a mounted volume.'] },
  { file: '06-migration-and-coexistence.md', focus: ['Reframe rollout as an ENTRYPOINT SWAP (single-agent -> workflow-program) inside the unchanged Docker substrate, NOT introducing a new engine.', 'Default = legacy single-agent entrypoint; fallback/escape hatch = revert the entrypoint (and the loud signal).', 'Emphasize what does NOT change: the container infra, credential copy, watchdog/TTL, the state machine, issue-as-source-of-truth.', 'Note the review stage migrates to our own in-container judge-panel; ultrareview is explicitly out of near-term scope.'] },
  { file: '07-risks-and-open-questions.md', focus: ['DOWNGRADE the host/worktree isolation-regression risk: resolved by in-container execution (container stays the trust boundary). Keep a one-line residual note only.', 'ADD caveats as real open questions: (a) is the Workflow DSL available to the containerized claude CLI, or do we express fan-out via agent-teams? (b) container resource sizing for N concurrent subagents; (c) durable run-journal must live on a mounted volume.', 'Reclassify ultrareview as a DEFERRED, optional, off-box/billed/cloud augmentation; list its (auth, billing, git-repo, cloud-trigger) constraints as things to weigh IF/when adopted, not now. Near-term review is our own in-container judge-panel.', 'Keep the first-experiment recommendation (security-review in-container fan-out behind fritz.engine:workflow, default-off, with entrypoint fallback).'] },
]

const edited = await pipeline(
  FILES,
  // stage 1: revise + write
  (f) => agent(
    `Reframe the design doc ${BASE}/${f.file} to conform to this CHANGE DIRECTIVE. Read the current file first, apply the directive SURGICALLY — preserve the doc's structure, depth, tables, ASCII diagrams, and all file:line code anchors; do NOT shorten or regress quality; only change what the directive and this file's focus require.\n\nThis file's specific focus:\n${f.focus.map(c => '- ' + c).join('\n')}\n\n=== CHANGE DIRECTIVE ===\n${directive}\n\nAfter revising, WRITE the full updated markdown back to ${BASE}/${f.file} using the Write tool. Then return the final markdown content as your text output.`,
    { label: `revise:${f.file}`, phase: 'Edit' }
  ),
  // stage 2: consistency review
  (content, f) => agent(
    `Adversarially check this revised doc (${f.file}) against the CHANGE DIRECTIVE. Find: any leftover "two engines" framing that should be "two entrypoints"; any place ultrareview is still on the near-term/primary review path instead of deferred; any claim that fan-out runs on the host rather than in-container; missing required focus items; internal contradictions; lost depth or dropped code anchors vs what the directive wanted preserved.\n\nThis file's required focus:\n${f.focus.map(c => '- ' + c).join('\n')}\n\n=== CHANGE DIRECTIVE ===\n${directive}\n\n=== REVISED DOC ===\n${content}\n\nReturn a concise numbered list of concrete fixes. If it's already fully conformant, say so explicitly.`,
    { label: `check:${f.file}`, phase: 'Edit' }
  ).then(critique => ({ content, critique })),
  // stage 3: finalize + write
  async (prev, f) => agent(
    `Apply these fixes to finalize ${f.file}. Fix every valid point; ignore any that is wrong or would harm the doc. Preserve structure, depth, diagrams, and code anchors.\n\n=== FIXES ===\n${prev.critique}\n\n=== CHANGE DIRECTIVE (authority) ===\n${directive}\n\n=== CURRENT DOC ===\n${prev.content}\n\nWRITE the final markdown to ${BASE}/${f.file} using the Write tool, then return the result.`,
    { label: `finalize:${f.file}`, phase: 'Edit', schema: DOC_RESULT }
  )
)

const done = edited.filter(Boolean)
log(`Reframed ${done.length}/${FILES.length} docs`)

// ---------------------------------------------------------------------------
phase('Verify')

const consistency = await agent(
  `Cross-doc consistency capstone. Read all 8 final docs in ${BASE}/ (README.md, 01-current-architecture.md, 02-capabilities-and-opportunity.md, 03-architecture-options.md, 04-target-architecture.md, 05-stage-mapping.md, 06-migration-and-coexistence.md, 07-risks-and-open-questions.md). Verify they are now MUTUALLY consistent with the CHANGE DIRECTIVE: (1) framing is uniformly "one Docker substrate, two entrypoints" — no stray "two engines"; (2) fan-out is uniformly described as in-container; (3) ultrareview is uniformly deferred/optional/off-box and the near-term review is uniformly "our own in-container judge-panel"; (4) the isolation risk is downgraded; (5) the three caveats appear where relevant; (6) no doc contradicts another on routing, the startAgent seam, or labels-as-truth. Flag anything still off with a file reference.\n\n=== CHANGE DIRECTIVE ===\n${directive}`,
  { label: 'cross-doc-consistency', phase: 'Verify', schema: CONSISTENCY_SCHEMA }
)
log('Consistency capstone complete')

return { directive, edited: done, consistency }
