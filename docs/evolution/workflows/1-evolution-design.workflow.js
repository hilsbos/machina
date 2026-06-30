export const meta = {
  name: 'fritz-v2-evolution-design',
  description: 'Explore how fritZ should evolve to harness Claude Code Workflow/ultracode/ultrathink/ultrareview; author design docs (markdown only, no code)',
  phases: [
    { title: 'Map', detail: 'parallel readers map current architecture + harnessable cloud capabilities' },
    { title: 'Design', detail: '4 competing evolution proposals, 3 independent judges, synthesize target architecture' },
    { title: 'Author', detail: 'draft -> adversarial review -> revise+write each design doc' },
  ],
}

const BASE = '/path/to/fritz/docs/evolution'

const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['area', 'summary', 'keyFiles', 'painPoints', 'evolvableSeams'],
  properties: {
    area: { type: 'string' },
    summary: { type: 'string', description: 'dense factual summary of this area as it works today' },
    keyFiles: { type: 'array', items: { type: 'string' } },
    painPoints: { type: 'array', items: { type: 'string' } },
    evolvableSeams: { type: 'array', items: { type: 'string' }, description: 'specific seams where a Workflow/cloud engine could plug in' },
  },
}

const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'stance', 'summary', 'howStagesExecute', 'legacyCoexistence', 'whatToHarness', 'pros', 'cons', 'risks'],
  properties: {
    name: { type: 'string' },
    stance: { type: 'string' },
    summary: { type: 'string' },
    howStagesExecute: { type: 'string', description: 'how a pipeline stage executes under this proposal' },
    legacyCoexistence: { type: 'string', description: 'what happens to the legacy container engine' },
    whatToHarness: { type: 'array', items: { type: 'string' }, description: 'which of Workflow/ultracode/ultrathink/ultrareview and how' },
    pros: { type: 'array', items: { type: 'string' } },
    cons: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rankings', 'bestIdeas', 'verdict'],
  properties: {
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['proposal', 'feasibility', 'impact', 'risk', 'reversibility', 'coherence', 'total', 'rationale'],
        properties: {
          proposal: { type: 'string' },
          feasibility: { type: 'number' },
          impact: { type: 'number' },
          risk: { type: 'number', description: 'higher = lower risk (invert so total is sum-better)' },
          reversibility: { type: 'number' },
          coherence: { type: 'number' },
          total: { type: 'number' },
          rationale: { type: 'string' },
        },
      },
    },
    bestIdeas: { type: 'array', items: { type: 'string' }, description: 'strongest individual ideas worth grafting regardless of winner' },
    verdict: { type: 'string', description: 'which proposal should anchor the target architecture and why' },
  },
}

const ARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'oneLiner', 'principles', 'executionModel', 'routing', 'stageDecisions', 'scoringSummary', 'graftedIdeas', 'whyThisWins'],
  properties: {
    name: { type: 'string' },
    oneLiner: { type: 'string' },
    principles: { type: 'array', items: { type: 'string' } },
    executionModel: { type: 'string', description: 'how the new Workflow-native engine executes a stage end-to-end' },
    routing: { type: 'string', description: 'how an issue/stage is routed to legacy vs new engine' },
    stageDecisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['stage', 'engine', 'rationale'],
        properties: {
          stage: { type: 'string' },
          engine: { type: 'string', description: 'legacy | workflow-native | ultrareview | hybrid' },
          rationale: { type: 'string' },
        },
      },
    },
    scoringSummary: { type: 'string', description: 'short comparison of the 4 proposals and the judge consensus' },
    graftedIdeas: { type: 'array', items: { type: 'string' } },
    whyThisWins: { type: 'string' },
  },
}

const DOC_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'title', 'summary', 'wordCount'],
  properties: {
    file: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    wordCount: { type: 'number' },
  },
}

// ---------------------------------------------------------------------------
phase('Map')

const AREAS = [
  { key: 'state-machine', prompt: 'Map the fritZ state machine. Read fritz-orchestrator/daemon/src/agents/autoloop.ts (the pull engine) and fritz-orchestrator/daemon/src/github/github.ts (getNextStatus, releaseAgent, rework cycle, getOrphanRestoreStatus). Explain the two-engine model (autoloop pull + agent-completion push), the fritz.status:* label vocabulary, rework/escalation/orphan recovery, and exactly which seams a new execution engine could plug into without touching the state store.' },
  { key: 'execution-model', prompt: 'Map how a pipeline stage executes TODAY. Read fritz-orchestrator/daemon/src/agents/boot.ts, agents/agents.ts (Docker container per stage, image variants), agent-comms.ts (persistent stream-json session), core/watchdog.ts (activity TTL). Characterize the container-per-stage model: isolation, cost, latency, parallelism-within-a-stage (there is none), credential copying, failure modes. Identify the seams where a Workflow run could replace a container.' },
  { key: 'stage-skills', prompt: 'Read the stage skill definitions in .claude/skills/*/SKILL.md (implement, review, validate, define, architect, ux, budget) AND the worktree copies if the top-level ones are thin (check .claude/worktrees/agent-*/.claude/skills/). Summarize what each stage agent is instructed to do, and rank which stages are MOST amenable to multi-agent fan-out / cloud review (e.g. review, security-review, validate) vs which are inherently single-threaded.' },
  { key: 'ops-pain', prompt: 'Identify concrete operational pain points and costs of the current single-agent-per-container model. Look at config/fritz.yaml (TTLs, models, limits), agents/usage-monitor.ts, core/watchdog.ts, and the README. Be specific: review depth is limited to one agent; no intra-stage parallelism; latency of container boot+credential copy; token spend governance; reliability/TTL backstops. Cite files.' },
  { key: 'harness-capabilities', prompt: 'Research the native Claude Code cloud/multi-agent features that fritZ could harness, and how each maps onto a software-delivery pipeline stage: (1) the Workflow orchestration tool — pipeline()/parallel()/agent() subagents, JSON-schema structured output, worktree isolation, token budget, adversarial-verify and judge-panel patterns; (2) ultracode — the standing opt-in to author/run workflows by default; (3) ultrathink — extended reasoning for design/spec stages; (4) ultrareview / "/code-review ultra" — deep multi-agent CLOUD review of a branch or PR (user-triggered, billed, needs a git repo). Use your knowledge of these features plus the repo. For each, state: what it does, what stage it could replace/augment, and its constraints (auth, headless, cost, determinism).' },
]

const map = await parallel(AREAS.map(a => () =>
  agent(a.prompt, { label: `map:${a.key}`, phase: 'Map', schema: MAP_SCHEMA })
))
const mapClean = map.filter(Boolean)
const mapDigest = JSON.stringify(mapClean.map(m => ({ area: m.area, summary: m.summary, painPoints: m.painPoints, evolvableSeams: m.evolvableSeams })))
log(`Mapped ${mapClean.length} architecture areas`)

// ---------------------------------------------------------------------------
phase('Design')

const STANCES = [
  { key: 'full-native', prompt: 'Propose a FULL Workflow-native fritZ: every pipeline stage becomes a Claude Code Workflow script that fans out subagents; the Docker-container-per-stage model is retired entirely. Be bold about what the daemon becomes.' },
  { key: 'hybrid-dual-engine', prompt: 'Propose a HYBRID dual-engine fritZ: the legacy container engine is preserved unchanged, a new Workflow-native execution engine is added alongside it, and each issue/stage is routed to one engine via a label (e.g. fritz.engine:workflow). Both coexist indefinitely; legacy is the safe fallback.' },
  { key: 'review-first-conservative', prompt: 'Propose a CONSERVATIVE, lowest-risk evolution: keep the legacy orchestrator and state machine intact, and swap only the highest-value stages to cloud ultra features first — replace the review stage with ultrareview (/code-review ultra), and add ultrathink to define/architect. Minimal disruption, maximum near-term value.' },
  { key: 'greenfield-v2', prompt: 'Propose a GREENFIELD fritZ v2: a clean redesign where the autoloop dispatches Workflow runs directly per stage, GitHub labels remain the single source-of-truth state store, and the daemon shrinks to a thin scheduler/event-router around Workflow + ultrareview. Reimagine the daemon role and what code gets deleted.' },
]

const proposals = (await parallel(STANCES.map(s => () =>
  agent(
    `${s.prompt}\n\nGround your proposal in this map of how fritZ works today:\n${mapDigest}\n\nfritZ today: a daemon watches GitHub issue labels (fritz.status:*), and for each "for-{role}" label spawns ONE Docker container running ONE Claude Code agent for that stage (implement/review/validate/define/architect/ux/budget). Agents report completion -> daemon flips the label -> next agent spawns. The user wants to harness Workflow orchestration, ultracode, ultrathink, and ultrareview as a NEW way of executing some or all stages, while KEEPING legacy fritZ available. No code — this is architecture design.`,
    { label: `proposal:${s.key}`, phase: 'Design', schema: PROPOSAL_SCHEMA }
  )
))).filter(Boolean)
log(`Generated ${proposals.length} architecture proposals`)

const proposalsJson = JSON.stringify(proposals)

const judges = (await parallel([0, 1, 2].map(i => () =>
  agent(
    `You are judge #${i + 1} on a design panel. Independently and skeptically score these ${proposals.length} proposals for evolving fritZ. Think hard (ultrathink-level rigor). Score each on feasibility, impact, risk (higher score = LOWER risk), reversibility, coherence (0-10 each), sum to total. Then name the single best anchor and the strongest individual ideas worth grafting regardless of winner.\n\nProposals:\n${proposalsJson}\n\nContext: the user explicitly wants to KEEP legacy fritZ and ADD a Workflow/ultracode/ultrathink/ultrareview execution path for some or all stages. Penalize big-bang rewrites with no fallback; reward incremental, reversible, observable designs.`,
    { label: `judge:${i + 1}`, phase: 'Design', schema: JUDGE_SCHEMA }
  )
))).filter(Boolean)
log(`Collected ${judges.length} independent judge scorecards`)

const arch = await agent(
  `You are the chief architect. Synthesize the TARGET architecture for fritZ v2 from these competing proposals and the judge panel's scores. Use ultrathink-level reasoning. The user's intent is explicit: keep legacy fritZ working, and add a NEW execution engine that harnesses Claude Code Workflow orchestration + ultracode + ultrathink + ultrareview for some or all pipeline stages. The state store (GitHub fritz.status:* labels) must remain the source of truth. Favor a hybrid, incrementally-adoptable, reversible design. Decide per-stage which engine should run it (legacy container vs workflow-native vs ultrareview vs hybrid) and why. Produce a coherent named target architecture with principles, the new engine's execution model, routing, per-stage decisions, a short scoring summary of the 4 proposals, and the best ideas grafted from non-winning proposals.\n\nProposals:\n${proposalsJson}\n\nJudge scorecards:\n${JSON.stringify(judges)}\n\nArchitecture map of today's system:\n${mapDigest}`,
  { label: 'synthesize-architecture', phase: 'Design', schema: ARCH_SCHEMA }
)
log(`Synthesized target architecture: ${arch.name}`)

const CONTEXT = JSON.stringify({ architecture: arch, map: mapClean.map(m => ({ area: m.area, summary: m.summary, painPoints: m.painPoints, evolvableSeams: m.evolvableSeams })), proposals: proposals.map(p => ({ name: p.name, stance: p.stance, summary: p.summary })) })

// ---------------------------------------------------------------------------
phase('Author')

const DOCS = [
  { file: '01-current-architecture.md', title: 'Current fritZ Architecture (Baseline)', mustCover: ['the two-engine state machine: autoloop pull + agent-completion push (cite autoloop.ts, github.ts getNextStatus/releaseAgent)', 'the container-per-stage execution model and lifecycle (boot, credential copy, persistent stream-json session, activity TTL, watchdog)', 'the fritz.status:* / fritz.* label vocabulary as the state store', 'what is genuinely good and must be preserved', 'concrete pain points & costs that motivate evolution'] },
  { file: '02-capabilities-and-opportunity.md', title: 'New Capabilities: Workflow, ultracode, ultrathink, ultrareview', mustCover: ['what Claude Code Workflow orchestration provides (pipeline/parallel/agent subagents, JSON-schema structured output, worktree isolation, token budget, adversarial-verify & judge-panel patterns)', 'what ultracode standing-opt-in means and when it applies', 'what ultrathink extended reasoning offers for design/spec stages', 'what ultrareview / /code-review ultra (cloud multi-agent branch/PR review) provides and its trigger/billing/git constraints', 'a mapping table: capability -> which fritZ pipeline stage it best serves', 'constraints: auth, headless/cron limits, cost, determinism vs nondeterminism'] },
  { file: '03-architecture-options.md', title: 'Architecture Options Considered', mustCover: ['the 4 candidate approaches (full-native, hybrid dual-engine, review-first conservative, greenfield v2) each with stance and summary', 'a comparison/scoring table (feasibility, impact, risk, reversibility, coherence) reflecting the judge consensus', 'pros / cons / risks per option', 'why the recommended option wins and which ideas were grafted from the others'] },
  { file: '04-target-architecture.md', title: 'Target Architecture — fritZ v2 (Dual-Engine)', mustCover: ['north-star principles', 'the preserved legacy container engine + the new Workflow-native execution engine, side by side', 'how a single stage executes as a Workflow run (fan-out -> verify -> synthesize), in prose + an ASCII diagram (NO real code, pseudo-structure only)', 'routing: how an issue/stage is dispatched to legacy vs workflow-native vs ultrareview (e.g. a fritz.engine: label)', 'how GitHub fritz.status:* labels remain the source of truth across both engines', 'where ultrareview replaces the review stage and where ultrathink slots into define/architect', 'at least one ASCII architecture diagram'] },
  { file: '05-stage-mapping.md', title: 'Per-Stage Execution Mapping', mustCover: ['a table: each pipeline stage (define, architect, ux, budget, implement, review, validate, security-review) -> legacy vs workflow-native vs ultrareview, with rationale (use the architecture stageDecisions)', 'for the most-improved stages, a SKETCH of the Workflow script shape in pseudo-structure (phases, fan-out count, verify pattern) — NOT runnable code', 'where ultrathink and ultrareview slot in', 'expected quality / latency / cost deltas vs the legacy single-agent stage'] },
  { file: '06-migration-and-coexistence.md', title: 'Migration & Coexistence Strategy', mustCover: ['how legacy and v2 coexist with zero big-bang (label-based routing, default-legacy)', 'an incremental, stage-by-stage rollout order (which stage to convert first and why)', 'fallback / escape hatch back to legacy on failure', 'observability & dashboard implications (how a Workflow run surfaces vs a container)', 'what stays identical (the state machine, the issue-as-source-of-truth)'] },
  { file: '07-risks-and-open-questions.md', title: 'Risks, Costs & Open Questions', mustCover: ['cost/token blow-up risk of fan-out and the controls (Workflow budget, usage-monitor integration, per-stage caps)', 'auth/headless constraints for cloud ultra features (interactive triggers, billing, git-repo requirement)', 'determinism vs nondeterminism and how the state machine contains it', 'where this could be over-engineering / when legacy is simply better', 'open questions that need a decision from the owner', 'the recommended FIRST experiment — the smallest viable slice to prove value'] },
]

const authored = await pipeline(
  DOCS,
  (doc) => agent(
    `Draft the markdown design doc "${doc.title}" for the fritZ v2 evolution design set (file ${doc.file}). This is one of 7 cohesive docs. Audience: the owner (the fritZ author) and future implementers. Tone: precise, concrete, grounded in the real codebase — not generic AI-architecture fluff. NO source code; ASCII diagrams and pseudo-structure are allowed and encouraged. It MUST cover:\n${doc.mustCover.map(c => '- ' + c).join('\n')}\n\nUse this shared design context (the agreed target architecture, the map of today's system, and the proposals considered):\n${CONTEXT}\n\nReturn ONLY the markdown body (starting with a single H1 "# ${doc.title}"). Be substantive but tight.`,
    { label: `draft:${doc.file}`, phase: 'Author' }
  ),
  (draft, doc) => agent(
    `Adversarially review this draft of "${doc.title}". You are an ultrareview-style skeptic. Find: factual errors about how fritZ works today, claims about Workflow/ultracode/ultrathink/ultrareview that are wrong or overstated, missing required coverage, internal contradictions with the agreed architecture, hand-waving, and over-engineering. Be specific and actionable. The doc MUST cover:\n${doc.mustCover.map(c => '- ' + c).join('\n')}\n\nShared design context:\n${CONTEXT}\n\nDraft:\n${draft}\n\nReturn a concise, numbered critique. If the draft is already strong, say what specifically to tighten — do not invent problems.`,
    { label: `review:${doc.file}`, phase: 'Author' }
  ).then(critique => ({ draft, critique })),
  async (prev, doc) => {
    const final = await agent(
      `Revise the markdown doc "${doc.title}" by applying this critique. Fix every valid point; ignore any point that is wrong or would harm the doc. Keep it grounded, concrete, no source code, ASCII diagrams ok. Ensure it still covers all required points:\n${doc.mustCover.map(c => '- ' + c).join('\n')}\n\nShared design context:\n${CONTEXT}\n\nCritique to apply:\n${prev.critique}\n\nCurrent draft:\n${prev.draft}\n\nThen WRITE the final markdown to the absolute path ${BASE}/${doc.file} using the Write tool (start the file with "# ${doc.title}"). After writing, return the result.`,
      { label: `revise:${doc.file}`, phase: 'Author', schema: DOC_RESULT }
    )
    return final
  }
)

const docs = authored.filter(Boolean)
log(`Authored ${docs.length}/${DOCS.length} design docs`)

return { architecture: arch, docs }
