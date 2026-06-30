export const meta = {
  name: 'fritz-workflow-observability',
  description: 'Deep-explore how fritZ surfaces agent progress to the web today + research how others expose multi-agent/long-running workflow runs to a web UI; design surfacing in-container Workflow runs to the fritZ dashboard; author doc 08',
  phases: [
    { title: 'Explore', detail: 'parallel: internal code/setup exploration + external web research' },
    { title: 'Synthesize', detail: 'design how in-container Workflow runs surface to the fritZ dashboard' },
    { title: 'Author', detail: 'draft -> adversarial review -> finalize-write doc 08' },
  ],
}

const BASE = '/path/to/fritz/docs/evolution'
const SRC = '/path/to/fritz/fritz-orchestrator/daemon/src'
const ROOT = '/path/to/fritz'

// Context the agents need about the Claude Code Workflow feature's own telemetry artifacts
const WF_TELEMETRY = `Key fact about the Claude Code Workflow feature (the in-container fan-out engine in fritZ v2): when a workflow runs, the harness persists per-subagent transcripts as agent-<id>.jsonl files in a transcript directory, plus a run journal that powers resume. Locally, the user watches progress via the /workflows TUI command, which reads these artifacts. In the fritZ (headless, remote, in-container) setup there is NO TUI — so the open problem is: capture those JSONL/journal artifacts (written inside the agent container, ideally onto a mounted volume) and stream them to the fritZ web dashboard so the operator sees phases, the subagent fan-out tree, per-agent status, tokens, and logs in real time — the same visibility the existing single-agent dashboard gives.`

const CODE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'howItWorks', 'keyFiles', 'eventsOrEndpoints', 'reusableForWorkflowRuns', 'gaps'],
  properties: {
    area: { type: 'string' },
    howItWorks: { type: 'string', description: 'dense, concrete description grounded in the real code' },
    keyFiles: { type: 'array', items: { type: 'string' } },
    eventsOrEndpoints: { type: 'array', items: { type: 'string' }, description: 'SSE event types, API routes, data shapes the UI consumes' },
    reusableForWorkflowRuns: { type: 'array', items: { type: 'string' }, description: 'existing mechanisms that could be reused to surface in-container Workflow runs' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'what is missing to represent a nested fan-out run vs a flat single agent' },
  },
}

const WEB_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['angle', 'approaches', 'patterns', 'applicabilityToFritz'],
  properties: {
    angle: { type: 'string' },
    approaches: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'whatItDoes', 'howUIGetsUpdates', 'sourceUrl', 'confidence'], properties: {
      name: { type: 'string' },
      whatItDoes: { type: 'string' },
      howUIGetsUpdates: { type: 'string', description: 'SSE/WebSocket/polling, trace-span model, run DAG, event sourcing, etc.' },
      sourceUrl: { type: 'string', description: 'URL if web-verified, else "training-knowledge"' },
      confidence: { type: 'string', description: 'web-verified | training-knowledge' },
    } } },
    patterns: { type: 'array', items: { type: 'string' }, description: 'recurring cross-tool patterns worth stealing' },
    applicabilityToFritz: { type: 'string' },
  },
}

const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'problem', 'telemetrySource', 'transport', 'dataModel', 'dashboardUI', 'reuseVsNew', 'remoteAccess', 'mvpSlice', 'risks', 'openQuestions', 'citations'],
  properties: {
    name: { type: 'string' },
    problem: { type: 'string' },
    telemetrySource: { type: 'string', description: 'how progress is captured inside the container (journal/jsonl on mounted volume, report.sh extension, etc.)' },
    transport: { type: 'string', description: 'container -> daemon -> browser; reuse existing SSE/event-log or new' },
    dataModel: { type: 'string', description: 'how a nested run (phases -> subagents) is represented (run tree / spans)' },
    dashboardUI: { type: 'string', description: 'what the operator sees: run-tree view, live phase/agent status, tokens, logs drill-down' },
    reuseVsNew: { type: 'string', description: 'what existing fritZ infra is reused vs what is genuinely new' },
    remoteAccess: { type: 'string', description: 'how this works over the always-on remote/mTLS setup' },
    mvpSlice: { type: 'string', description: 'smallest viable slice to see one in-container workflow run live in the web UI' },
    risks: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    citations: { type: 'array', items: { type: 'string' }, description: 'web sources actually used' },
  },
}

// ---------------------------------------------------------------------------
phase('Explore')

const CODE_TASKS = [
  { key: 'dashboard-sse', prompt: `Explore how the fritZ dashboard delivers LIVE updates to the browser today. Read ${SRC}/dashboard/dashboard.ts and ${ROOT}/fritz-orchestrator/daemon/dashboard-ui.html (large single-file SPA — grep for "EventSource", "SSE", "addEventListener", the event names, and the render functions). Enumerate every SSE event type (agent-started, agent-update, agent-stopped, queue-update, issues-update, usage-update, heartbeat, event-log) and its payload shape, the REST endpoints (agent-log/:name, issue-trail/:issue, workflow, retro, etc.), and how the SPA renders agent cards + live logs. This is the rail a Workflow-run view would ride on.` },
  { key: 'progress-telemetry', prompt: `Explore where agent PROGRESS data comes from. Read ${SRC}/core/registry.ts (agent state, lastActivity, teammateCount), ${SRC}/core/event-log.ts (JSONL append-only event log, 500-cap, SSE push), ${SRC}/agents/log-archive.ts (per-agent summary.json + agent.log persistence), ${SRC}/agents/session-parser.ts (parses session JSONL for tokens/tools/subagentCount), and how ${SRC}/agents/agent-comms.ts turn events + report.sh -> /api/notify feed status. Map exactly how a single agent's live progress reaches the dashboard today, and what fields already exist (e.g. subagentCount) that hint at multi-agent.` },
  { key: 'remote-setup', prompt: `Explore the always-on REMOTE/cloud setup and how the operator gets visibility remotely. Read ${ROOT}/fritz-orchestrator/docker-compose.prod.yml, ${ROOT}/fritz-orchestrator/docs/DEPLOYMENT.md, ${ROOT}/.claude/orchestrator/knowledge/DEPLOYMENT.md, any ${ROOT}/config/mtls/ nginx config, and the README deployment/monitoring sections. Describe: how fritZ runs detached on a server (your VPS provider), how the dashboard is exposed remotely (nginx-mTLS sidecar, ports, client certs), and the data-lifecycle (workspace cleanup vs log-archive retention) relevant to keeping workflow-run telemetry available after a run ends.` },
]

const WEB_TASKS = [
  { key: 'durable-workflow-uis', prompt: `Research how DURABLE WORKFLOW / ORCHESTRATION engines expose live run progress to a WEB UI. Use WebSearch (load it via ToolSearch "select:WebSearch,WebFetch" if needed) and WebFetch the best sources. Cover at least: Temporal Web UI, Prefect, Dagster, Airflow, Windmill, Inngest, Hatchet. For each: how the UI shows a run's DAG/timeline, how it gets live updates (polling vs SSE vs WebSocket vs gRPC stream), and how nested/child runs are represented. Return concrete approaches WITH source URLs; mark each web-verified vs training-knowledge.` },
  { key: 'llm-agent-observability', prompt: `Research LLM/AGENT OBSERVABILITY platforms and how they trace and visualize NESTED multi-agent runs in a web UI. Use WebSearch + WebFetch. Cover at least: LangSmith, Langfuse, Arize Phoenix, AgentOps, Helicone, OpenLLMetry / OpenTelemetry GenAI semantic conventions, AutoGen Studio, CrewAI. Focus on the trace/span data model for parent->child agent calls, how a fan-out (one orchestrator -> N subagents) is rendered (tree/waterfall), and live streaming vs post-hoc. Return approaches WITH source URLs and confidence.` },
  { key: 'headless-to-web-bridge', prompt: `Research the specific pattern of bridging a HEADLESS/CLI process's internal progress to a REMOTE WEB UI — the exact shape of fritZ's problem (a local TUI like Claude Code /workflows is unavailable in a server/container deployment). Use WebSearch + WebFetch. Cover: event-sourcing/tailing JSONL or log files to drive a UI, SSE vs WebSocket trade-offs for long-lived dashboards, "structured events to a file/socket the server tails", and how multi-agent CLIs (e.g. OpenAI Swarm, CrewAI, claude-flow / agent TUIs) surface run state to a server. Also note how a workflow run-journal (jsonl artifacts) can be tailed. Return approaches WITH source URLs and confidence. ${WF_TELEMETRY}` },
]

const [code, web] = await Promise.all([
  parallel(CODE_TASKS.map(t => () => agent(t.prompt, { label: `code:${t.key}`, phase: 'Explore', schema: CODE_SCHEMA }))),
  parallel(WEB_TASKS.map(t => () => agent(t.prompt, { label: `web:${t.key}`, phase: 'Explore', schema: WEB_SCHEMA }))),
])
const codeClean = code.filter(Boolean)
const webClean = web.filter(Boolean)
log(`Explored ${codeClean.length} code areas + ${webClean.length} web angles`)

const EXPLORE_CTX = JSON.stringify({ code: codeClean, web: webClean })

// ---------------------------------------------------------------------------
phase('Synthesize')

const design = await agent(
  `You are the architect. Design how an in-container Workflow RUN (the fritZ v2 workflow-program entrypoint — a stage that fans out N in-process subagents inside one Docker container) exposes its live progress to the fritZ WEB DASHBOARD, so the operator gets the same (or better) visibility they have today for a single agent. Use ultrathink-level reasoning. Ground the design in fritZ's EXISTING rails (the SSE event stream, event-log JSONL, log-archive, registry, the agent-log/issue-trail endpoints, nginx-mTLS remote access) — reuse them wherever possible; only invent what is genuinely missing (chiefly: a representation for a NESTED run tree vs a flat single agent, and capturing the workflow run-journal/jsonl from inside the container onto a mounted volume). Steal the best ideas from the external research (trace/span run-tree model, SSE streaming, event sourcing). Be concrete: name the telemetry source, the transport (container->daemon->browser), the data model (run -> phases -> subagents as spans/tree), the dashboard UI (a run-tree/waterfall view with live status, tokens, and drill-down to per-subagent logs), how it works over the remote always-on/mTLS setup, and the smallest MVP slice to see ONE workflow run live in the web UI. Cite the web sources you actually use.\n\n${WF_TELEMETRY}\n\n=== EXPLORATION (internal code + external web) ===\n${EXPLORE_CTX}`,
  { label: 'design-observability', phase: 'Synthesize', schema: DESIGN_SCHEMA }
)
log(`Design synthesized: ${design.name}`)
const designJson = JSON.stringify(design)

// ---------------------------------------------------------------------------
phase('Author')

const TITLE = 'Workflow-Run Observability — Surfacing In-Container Workflow Runs to the Web Dashboard'

const draft = await agent(
  `Draft the markdown design doc "${TITLE}" as ${BASE}/08-workflow-observability.md — part of the fritZ v2 evolution set. Audience: the owner + implementers. NO source code; ASCII diagrams + pseudo-structure encouraged. Must cover, in this spirit:\n- The problem: fritZ runs always-on and remote; today's dashboard (SSE + event-log + log-archive, behind nginx-mTLS) gives great single-agent visibility, but the v2 in-container Workflow runs fan out N subagents and the local /workflows TUI is NOT available in the headless/remote setup.\n- "How fritZ surfaces agent progress TODAY" — grounded in the real code (SSE event types, endpoints, registry/event-log/log-archive/session-parser, remote mTLS access). Cite files.\n- "How others solve it" — a compact comparison of durable-workflow UIs (Temporal/Prefect/Dagster/etc.) and LLM-agent observability (LangSmith/Langfuse/Phoenix/OTel GenAI/etc.), with the patterns worth stealing (trace/span run-tree, SSE streaming, event sourcing). Include source URLs.\n- The recommended design: telemetry source (capture the workflow run-journal/jsonl on a mounted volume), transport (reuse the existing SSE/event-log rail), data model (run -> phases -> subagent spans = a tree/waterfall), the dashboard UI (run-tree view + live status + tokens + drill-down to per-subagent logs), reuse-vs-new, remote/mTLS access, and the MVP slice.\n- Risks + open questions (incl. whether the Workflow run-journal is readable/tailable from inside the container, retention vs workspace cleanup, token/cost visibility).\nStart with "# ${TITLE}". Open with the same one-line v2 frame used by the sibling docs (one Docker substrate, two entrypoints; fan-out in-container; ultrareview deferred) so it sits consistently in the set.\n\n=== DESIGN ===\n${designJson}\n\n=== SUPPORTING EXPLORATION ===\n${EXPLORE_CTX}\n\nReturn only the markdown body.`,
  { label: 'draft:08', phase: 'Author' }
)

const critique = await agent(
  `Adversarially review this draft of "${TITLE}". Flag: claims about fritZ internals not grounded in the cited files; external-tool claims stated as fact without a source (these should be marked or sourced); overstatement of what the Claude Code Workflow run-journal exposes (it is an assumption to verify, not a certainty); missing required coverage; inconsistency with the established v2 framing (one Docker substrate/two entrypoints, fan-out in-container, ultrareview deferred); and over-engineering vs simply reusing the existing SSE/event-log rail. Return a concise numbered fix list.\n\n=== DRAFT ===\n${draft}`,
  { label: 'review:08', phase: 'Author' }
)

const result = await agent(
  `Finalize "${TITLE}". Apply valid fixes; ignore wrong ones. Keep it grounded, concrete, no source code, ASCII diagrams ok, external claims sourced or marked training-knowledge. Preserve the v2 framing. WRITE the final markdown to ${BASE}/08-workflow-observability.md with the Write tool (start with "# ${TITLE}"), then return the result.\n\n=== FIXES ===\n${critique}\n\n=== DESIGN (authority) ===\n${designJson}\n\n=== CURRENT DRAFT ===\n${draft}`,
  { label: 'finalize:08', phase: 'Author', schema: { type: 'object', additionalProperties: false, required: ['file', 'summary', 'wordCount', 'citations'], properties: { file: { type: 'string' }, summary: { type: 'string' }, wordCount: { type: 'number' }, citations: { type: 'array', items: { type: 'string' } } } } }
)
log(`Authored doc 08: ${result.wordCount} words`)

return { design, doc: result, code: codeClean, web: webClean }
