import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  cpSync,
  chmodSync,
  copyFileSync,
} from 'fs';
import { resolve } from 'path';
import { randomBytes } from 'crypto';
import { execSync, spawn, type SpawnOptions } from 'child_process';
import { config } from '../config.js';
import * as registry from '../core/registry.js';
import * as github from '../github/github.js';
import {
  type AgentRole,
  type BootOptions,
  type InvocationMode,
  type BootContext,
  type CommentSummary,
  type LinkedPr,
} from '../types.js';
import { getRoleTtl, getRoleModel, getDefaultChatTtl } from './fritz-config.js';

/**
 * Async wrapper around child_process.spawn.
 * Runs a command without blocking the event loop.
 */
export function execAsync(
  cmd: string,
  args: string[],
  options?: SpawnOptions & { timeout?: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (options?.timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, options.timeout);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Timeout after ${options?.timeout}ms`));
      } else if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Exit ${code}: ${stderr.trim()}`));
      }
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

const VALID_ROLES: AgentRole[] = [
  'implement',
  'review',
  'validate',
  'define',
  'architect',
  'ux',
  'budget',
  'retro',
  'security-review',
  'pentest',
];

export function isValidRole(role: string): role is AgentRole {
  return VALID_ROLES.includes(role as AgentRole);
}

/**
 * Expand a retro sub-command into descriptive instructions for the agent.
 */
function parseRetroSubCommand(command: string): string {
  const parts = command.split(/\s+/);
  const subCmd = parts[0];

  switch (subCmd) {
    case 'scan': {
      const sinceMatch = command.match(/--since=(\S+)/);
      const since = sinceMatch ? sinceMatch[1] : 'all available archives';
      return `Run a **log scan** of the agent archive.\n- Analyze archived agent logs since: ${since}\n- Propose improvements via separate PRs (skills, knowledge, process)\n- This requires the archive API to be available`;
    }
    case 'report':
      return `Run a **full retrospective report**.\n- Combine log archive analysis with GitHub issue/PR data\n- Generate full metrics report\n- Propose improvements via separate PRs`;
    case 'analyze':
      return `Run **analysis only** (no PRs).\n- Analyze both log archives and GitHub data\n- Report findings but do not create improvement PRs`;
    case 'metrics':
      return `Show the **metrics dashboard** only.\n- Read existing METRICS.md\n- Compute current metrics from GitHub data\n- Report summary — no PRs, no deep analysis`;
    case 'investigate': {
      const issueNum = parts[1];
      if (!issueNum || !/^\d+$/.test(issueNum)) {
        return `Unknown sub-command: investigate requires an issue number (e.g. investigate 357). Proceed with full analysis.`;
      }
      return `Run a **focused investigation** on issue #${issueNum}.\n- Fetch ALL archived agent runs for issue #${issueNum} via archive API (\`?issue=${issueNum}\`)\n- Deep-dive logs for every agent run (not just anomalous ones)\n- Analyze: rework causes, review feedback patterns, token usage, failure modes\n- Produce a focused investigation report as a GitHub issue comment on issue #${issueNum}\n- No PRs needed — this is analysis-only`;
    }
    case 'experiment': {
      const expName = parts.slice(1).join(' ') || 'unnamed';
      return `Start a **new experiment**: ${expName}\n- Document the experiment hypothesis and measurement plan\n- Update METRICS.md with the new experiment entry`;
    }
    default:
      return `Unknown sub-command: ${subCmd}. Proceed with full analysis.`;
  }
}

/**
 * Fetch pre-loaded context for an issue (comments, linked PRs).
 * This is used to populate assignment.md with context the agent can reference.
 * Returns a BootContext with type 'issue' if successful, or type 'none' on failure.
 *
 * Note on repo usage:
 * - Issues are always fetched from `config.githubRepo` (the orchestrator repo, e.g. your-org/fritZ)
 *   because all fritZ issues live in the central orchestrator repo regardless of target codebase.
 * - PRs are fetched from the `repo` parameter because the actual code/PRs may live in an
 *   external repository specified via the `fritz.repo:` label on the issue.
 *
 * Non-blocking: uses execAsync (spawn + Promise) instead of execSync to avoid
 * blocking the event loop during GitHub API calls. Issue and PR fetches run in
 * parallel via Promise.all since they have no data dependency.
 */
async function fetchBootContext(issue: number, repo: string): Promise<BootContext> {
  if (!config.ghToken) {
    console.log(`   No GH_TOKEN, skipping context fetch`);
    return { type: 'none' };
  }

  const orchestratorRepo = config.githubRepo;
  if (!orchestratorRepo) {
    return { type: 'none' };
  }

  const ghEnv = { ...process.env, GH_TOKEN: config.ghToken };

  try {
    // Fetch issue and PRs in parallel — no data dependency between them
    const [issueJson, prsJson] = await Promise.all([
      execAsync(
        'gh',
        ['issue', 'view', String(issue), '--repo', orchestratorRepo, '--json', 'title,body,labels,comments'],
        { env: ghEnv, timeout: 10000 }
      ),
      execAsync(
        'gh',
        ['pr', 'list', '--search', String(issue), '--repo', repo, '--json', 'number,title,state', '--limit', '5'],
        { env: ghEnv, timeout: 5000 }
      ).catch(() => '[]'), // PR fetch is non-critical
    ]);

    const issueData = JSON.parse(issueJson) as {
      title?: string;
      body?: string;
      labels?: Array<{ name: string }>;
      comments?: Array<{ author?: { login?: string }; createdAt?: string; body?: string }>;
    };

    // Parse comments (limit to last 10, truncate long bodies)
    const MAX_COMMENTS = 10;
    const MAX_COMMENT_LENGTH = 500;
    const allComments = issueData.comments || [];
    const recentComments = allComments.slice(-MAX_COMMENTS);
    const comments: CommentSummary[] = recentComments.map((c) => ({
      author: c.author?.login || 'unknown',
      createdAt: c.createdAt || '',
      body: c.body && c.body.length > MAX_COMMENT_LENGTH
        ? c.body.slice(0, MAX_COMMENT_LENGTH) + '...'
        : c.body || '',
    }));

    // Parse linked PRs
    let linkedPrs: LinkedPr[] = [];
    try {
      const prsData = JSON.parse(prsJson || '[]') as Array<{ number: number; title?: string; state?: string }>;
      linkedPrs = prsData.map((pr) => ({
        number: pr.number,
        title: pr.title || '',
        state: pr.state?.toLowerCase() === 'merged' ? 'merged' as const
          : pr.state?.toLowerCase() === 'closed' ? 'closed' as const
          : 'open' as const,
      }));
    } catch {
      console.log(`   Could not parse linked PRs (non-critical)`);
    }

    const moreComments = allComments.length > MAX_COMMENTS
      ? allComments.length - MAX_COMMENTS
      : 0;

    console.log(`   ✓ Fetched context: ${comments.length} comments${moreComments ? ` (+${moreComments} more)` : ''}, ${linkedPrs.length} PRs`);

    return {
      type: 'issue',
      issue: {
        number: issue,
        title: issueData.title || 'Unknown',
        body: issueData.body || '',
        labels: (issueData.labels || []).map((l: { name: string }) => l.name),
        comments,
        linkedPrs,
      },
    };
  } catch (e: unknown) {
    console.log(`   Warning: Could not fetch boot context: ${e instanceof Error ? e.message : e}`);
    return { type: 'none' };
  }
}

export interface BootResult {
  name: string;
  workspace: string;
  role: AgentRole;
  issue?: number;
  repo?: string;
  branch?: string;
  ttl: number;
  model: string;
  invocationMode: InvocationMode;
  bootContext?: BootContext;
  apiToken: string;
}

export async function bootAgent(options: BootOptions): Promise<BootResult> {
  const { role, issue, mode = 'auto', retroCommand } = options;
  // Chat-mode agents get an extended TTL by default so interactive sessions
  // aren't killed mid-conversation. Explicit options.ttl always wins.
  let ttl = options.ttl ?? (mode === 'chat' ? getDefaultChatTtl() : getRoleTtl(role));
  const model = getRoleModel(role);
  const apiToken = randomBytes(16).toString('hex');

  // Determine invocation mode: explicit option > detected from labels > default 'orchestrated'
  // Sub-skills (architect, ux, budget) check for fritz.skill:define label to detect orchestration
  let invocationMode: InvocationMode = options.invocationMode || 'orchestrated';
  const subSkills: AgentRole[] = ['architect', 'ux', 'budget'];
  if (!options.invocationMode && subSkills.includes(role) && issue) {
    // Check if a define agent is currently active (orchestrated mode)
    const labels = github.getIssueLabels(issue);
    const hasDefineAgent = labels.includes('fritz.skill:define');
    invocationMode = hasDefineAgent ? 'orchestrated' : 'standalone';
    console.log(`   Invocation mode: ${invocationMode} (${hasDefineAgent ? 'define agent active' : 'no define agent'})`);
  }

  // Determine target repo and branch (explicit params > label > config default)
  let repo = options.repo;
  let branch = options.branch;
  let repoFromLabel = false;

  if (issue && !options.repo) {
    // No explicit repo—check for fritz.repo: label on the issue
    const targetInfo = github.getTargetRepoInfo(issue);
    if (targetInfo) {
      repo = targetInfo.repo;
      branch = targetInfo.branch ?? branch;
      repoFromLabel = true;
      console.log(`   Label lookup: fritz.repo:${repo}${targetInfo.branch ? `:${targetInfo.branch}` : ''}`);
    }
  }
  repo = repo ?? config.githubRepo;
  // Generate unique name: role-issue-suffix, role-subcommand-suffix, or role-suffix
  // Timestamp suffix ensures unique names across rework cycles and manual retries
  const timestampSuffix = Date.now().toString(16).slice(-4); // Last 4 hex chars of timestamp
  const descriptor = issue ? String(issue) : (retroCommand?.split(/\s+/)[0] || undefined);
  const name = options.name || (descriptor
    ? `${role}-${descriptor}-${timestampSuffix}`
    : `${role}-${timestampSuffix}`);
  const workspace = resolve(config.workspacesDir, name);

  // Validate role
  if (!isValidRole(role)) {
    throw new Error(`Invalid role: ${role}. Valid roles: ${VALID_ROLES.join(', ')}`);
  }

  // Check skill file exists
  const skillFile = resolve(config.fritzRoot, '.claude/skills', role, 'SKILL.md');
  if (!existsSync(skillFile)) {
    throw new Error(`Skill file not found: ${skillFile}`);
  }

  console.log(`🚀 Booting agent: ${name}`);
  console.log(`   Role: ${role}`);
  console.log(`   Model: ${model}`);
  if (issue) console.log(`   Issue: #${issue}`);
  if (repo) console.log(`   Repo: ${repo}`);
  if (branch) console.log(`   Branch: ${branch}`);

  // Create workspace directories
  mkdirSync(resolve(workspace, '.fritz'), { recursive: true });
  mkdirSync(resolve(workspace, 'project'), { recursive: true });
  console.log(`   Created workspace with UID: ${process.getuid?.()}, GID: ${process.getgid?.()}`);

  // Create agent's isolated .claude directory
  const agentClaude = resolve(workspace, '.claude');
  mkdirSync(agentClaude, { recursive: true });

  if (config.claudeOauthToken) {
    // Token-based auth: no credential files needed
    console.log(`   ✓ Using CLAUDE_CODE_OAUTH_TOKEN (skipping credential file copy)`);
  } else {
    // CRITICAL: Copy credential files from host .claude to agent .claude
    // This allows agents to authenticate with Claude Code subscription
    const hostClaude = config.claudeHome;
    const credentialFiles = [
      '.credentials.json',       // Production credentials (REQUIRED)
      'subscription_token.json', // Alternative auth method
    ];

    for (const credFile of credentialFiles) {
      const hostCred = resolve(hostClaude, credFile);
      const agentCred = resolve(agentClaude, credFile);

      if (existsSync(hostCred)) {
        try {
          copyFileSync(hostCred, agentCred);
          console.log(`   ✓ Copied ${credFile} to agent .claude`);

          // Set read-only permissions to prevent accidental modification
          try {
            chmodSync(agentCred, 0o444);
          } catch {
            console.log(`   ⚠ Could not set read-only permissions on ${credFile}`);
          }
        } catch (err: unknown) {
          console.log(`   ⚠ Warning: Could not copy ${credFile}: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        console.log(`   ⚠ Warning: ${credFile} not found at ${hostCred}`);
      }
    }
  }

  // 1. Identity
  const skillContent = readFileSync(skillFile, 'utf-8');
  const identityContent = `# Your Identity

You are a **${role}** agent at fritZ, a boutique AI agency.

## Your Role
${skillContent}

## Agency Values
- Quality over speed
- Clear communication
- Learn and improve
- Help the team succeed

## How You Work
1. Understand the assignment fully before starting
2. Work in the \`./project/\` directory
3. Report progress via \`.fritz/report.sh\`
4. Ask questions when blocked (don't guess)
5. Create clean, tested, documented work
`;
  writeFileSync(resolve(workspace, '.fritz/identity.md'), identityContent);

  // 2. Assignment
  let assignmentContent: string;
  let bootContext: BootContext = { type: 'none' };

  if (role === 'retro' && retroCommand && !issue) {
    // Retro agent with sub-command but no issue — issue-less boot path
    assignmentContent = `# Your Assignment

## Retro Agent — ${retroCommand}

**Repository:** ${repo || 'Not specified'}
**Labels:** fritz.skill:retro
**Trigger:** \`fritz retro ${retroCommand}\`

## Your Task

Run the retro process as described in your skill file (\`.fritz/identity.md\`).

**Mode:** \`${retroCommand}\`

### Sub-command Details
${parseRetroSubCommand(retroCommand)}

### Key Rules
- Read your skill file carefully — it defines your scope, process, and deliverables
- Post progress updates regularly: \`.fritz/report.sh progress "message"\`
- If blocked, report it: \`.fritz/report.sh blocked "reason"\`
- \`report.sh complete\` is terminal — your container stops after this
`;
  } else if (issue && repo) {
    // Fetch enhanced context with comments and linked PRs (non-blocking)
    bootContext = await fetchBootContext(issue, repo);

    // Extract issue details from context or fall back to basic fetch
    let issueTitle = 'Unknown';
    let issueBody = 'No description';
    let issueLabels = '';

    if (bootContext.type === 'issue' && bootContext.issue) {
      issueTitle = bootContext.issue.title;
      issueBody = bootContext.issue.body;
      issueLabels = bootContext.issue.labels.join(', ');
    } else if (config.ghToken) {
      try {
        // Fallback: fetch basic issue info if context fetch failed
        const issueJson = execSync(
          `gh issue view ${issue} --repo ${config.githubRepo} --json title,body,labels`,
          {
            encoding: 'utf-8',
            env: { ...process.env, GH_TOKEN: config.ghToken },
          }
        );
        const issueData = JSON.parse(issueJson);
        issueTitle = issueData.title || issueTitle;
        issueBody = issueData.body || issueBody;
        issueLabels = (issueData.labels || [])
          .map((l: { name: string }) => l.name)
          .join(', ');
      } catch {
        console.log(`   Warning: Could not fetch issue details`);
      }
    }

    // Detect fritz.long-running label and disable TTL
    const issueLabelsArray = bootContext.type === 'issue' && bootContext.issue
      ? bootContext.issue.labels
      : issueLabels.split(', ').filter(l => l.length > 0);
    const isLongRunning = issueLabelsArray.includes('fritz.long-running');
    if (isLongRunning) {
      ttl = 0;
      console.log(`   ⏳ Long-running mode: TTL disabled`);
    }

    // Build git workflow section based on whether a target branch is specified
    const gitWorkflowSection = branch
      ? `## Git Workflow

You are working on branch \`${branch}\`.

1. Create your feature branch:
   \`\`\`bash
   git checkout -b feature/${issue}-description
   \`\`\`

2. Do your work and commit

3. Push and create PR **targeting the base branch**:
   \`\`\`bash
   git push -u origin HEAD
   gh pr create --base ${branch} --title "[Issue #${issue}] Title" --body "Closes your-org/fritZ#${issue}"
   \`\`\`

**IMPORTANT:** Your PR must target \`${branch}\`, not \`main\`.
`
      : `## Git Workflow

1. Create your feature branch from the default branch
2. Do your work and commit
3. Push and create PR:
   \`\`\`bash
   git push -u origin HEAD
   gh pr create --title "[Issue #${issue}] Title" --body "Closes your-org/fritZ#${issue}"
   \`\`\`
`;

    if (mode === 'chat') {
      // Build pre-loaded context section if available
      let contextSection = '';
      if (bootContext.type === 'issue' && bootContext.issue) {
        const ctx = bootContext.issue;
        const commentCount = ctx.comments.length;
        const prCount = ctx.linkedPrs.length;

        if (commentCount > 0 || prCount > 0) {
          contextSection = `## Context Loaded
The following context has been pre-loaded for you:

`;
          if (commentCount > 0) {
            contextSection += `### Comments (${commentCount} shown)\n`;
            for (const comment of ctx.comments) {
              const date = comment.createdAt
                ? new Date(comment.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                : '';
              contextSection += `---\n**@${comment.author}** (${date}):\n${comment.body}\n\n`;
            }
          }

          if (prCount > 0) {
            contextSection += `### Related PRs\n`;
            for (const pr of ctx.linkedPrs) {
              const stateEmoji = pr.state === 'merged' ? '🟣' : pr.state === 'closed' ? '🔴' : '🟢';
              contextSection += `- ${stateEmoji} #${pr.number}: ${pr.title} (${pr.state})\n`;
            }
            contextSection += '\n';
          }
        }
      }

      // Chat mode: wait for user instructions instead of auto-executing
      assignmentContent = `# Your Assignment (Chat Mode)

## Issue #${issue}: ${issueTitle}

**Repository:** ${repo}
**Target Branch:** ${branch || '(default)'}
**Labels:** ${issueLabels}
**Issue:** https://github.com/${config.githubRepo}/issues/${issue}
**Mode:** Chat (interactive)

## Description
${issueBody}

${contextSection}${gitWorkflowSection}
## Chat Mode Instructions

You are in **chat mode**. This means:

1. **DO NOT** automatically start working on the issue
2. **WAIT** for the user to send you instructions via Telegram
3. When ready to start, the user will tell you what to do

## What You Can Do While Waiting

- Read your identity and skill file: \`.fritz/identity.md\`
- Explore the codebase in \`./project/\`
- Familiarize yourself with the project structure${bootContext.type !== 'issue' ? `\n- Review the issue context: \`gh issue view ${issue} --comments\`` : ''}

## Communication Tools

When the user gives you instructions, use these tools:
- Progress updates: \`.fritz/report.sh progress "message"\`
- If blocked: \`.fritz/report.sh blocked "reason"\`
- Ask questions: \`.fritz/report.sh ask "Your question?" '["Option A","Option B"]'\`
- When done: \`.fritz/report.sh complete "summary"\` (terminal — container stops)

---
*Waiting for user instructions...*
`;
    } else {
      // Auto mode (default): execute task automatically
      assignmentContent = `# Your Assignment

## Issue #${issue}: ${issueTitle}

**Repository:** ${repo}
**Target Branch:** ${branch || '(default)'}
**Labels:** ${issueLabels}
**Issue:** https://github.com/${config.githubRepo}/issues/${issue}

## Description
${issueBody}

${gitWorkflowSection}
## Your Task - Step by Step

Based on your role as **${role}**, follow these steps:

### 1. Post Start Update
\`\`\`bash
.fritz/report.sh progress "Started working on issue #${issue}. Reading requirements and planning approach."
\`\`\`

### 2. Load Context
- Read the issue description and ALL comments: \`gh issue view ${issue} --comments\`
- Check for linked PRs and existing work
- Continue from previous progress if any exists — do NOT restart

### 3. Do Your Work
Follow the detailed process in your skill file (\`.fritz/identity.md\`).
Your skill defines exactly what artifacts to produce and how to deliver them.

### 4. Report Completion
\`\`\`bash
.fritz/report.sh complete "Your completion summary here"
\`\`\`

## Key Rules
- Read your skill file carefully — it defines your scope, process, and deliverables
- Post progress updates regularly: \`.fritz/report.sh progress "message"\`
- If blocked, report it: \`.fritz/report.sh blocked "reason"\`
- Ask questions: \`.fritz/report.sh ask "Your question?" '["Option A","Option B"]'\`
- \`report.sh complete\` is terminal — your container stops after this
`;

    // Inject long-running instructions when fritz.long-running label is present
    if (isLongRunning) {
      assignmentContent += `
## Long-Running Mode

This issue is marked as **long-running**. Your TTL is disabled — you can work for hours.

### Important: Ask Questions FIRST

Before starting any implementation work:
1. Read the full issue, all comments, and linked specs/PRs
2. Analyze the scope and identify ALL ambiguities, unknowns, or decisions needed
3. Use \`.fritz/report.sh ask "question?" '["Option A","Option B"]'\` for EACH question
4. Wait for answers before proceeding
5. Post your plan via \`.fritz/report.sh progress "Plan: 1) ... 2) ... 3) ..."\`

### Then Execute Autonomously

Once all questions are answered:
- Work through the plan systematically
- Post progress updates every ~30 minutes: \`.fritz/report.sh progress "Completed X, working on Y"\`
- Do NOT ask questions mid-execution unless you hit a genuine blocker
- Commit frequently (every logical unit of work)
`;
    }
    }
  } else {
    // No issue assigned - standby mode (same for auto and chat)
    assignmentContent = `# Your Assignment${mode === 'chat' ? ' (Chat Mode)' : ''}

No specific issue assigned. You are on standby.

**Repository:** ${repo || 'Not specified'}
**Mode:** ${mode === 'chat' ? 'Chat (interactive)' : 'Standby'}

## Awaiting Instructions
${mode === 'chat'
  ? `You are in **chat mode**. Wait for the user to send you instructions via Telegram.

When the user gives you a task, use these tools:
- Progress updates: \`.fritz/report.sh progress "message"\`
- If blocked: \`.fritz/report.sh blocked "reason"\`
- Ask questions: \`.fritz/report.sh ask "Your question?" '["Option A","Option B"]'\`
- When done: \`.fritz/report.sh complete "summary"\` (terminal — container stops)`
  : `Check back with fritZ orchestrator or wait for an assignment.`}

You can explore the codebase and familiarize yourself with the project.
`;
  }
  writeFileSync(resolve(workspace, '.fritz/assignment.md'), assignmentContent);

  // 3. Report script — agents ONLY call the daemon API.
  //    The daemon handles Telegram + GitHub posting.
  //    "complete" also triggers container stop + label transition.
  const reportScript = `#!/bin/bash
# Report status back to fritZ via daemon API
# NOTE: "complete" will stop this container after responding — use as final action.
# Usage:
#   report.sh progress "message"
#   report.sh blocked "message"
#   report.sh complete "message"
#   report.sh complete --outcome=rejected "message"
#   report.sh ask "question" '["Option A","Option B"]'
FRITZ_API="\${FRITZ_DAEMON_URL}/api"
AGENT_NAME="${name}"
FRITZ_TOKEN="\${FRITZ_API_TOKEN}"

ACTION="\${1:-status}"
MESSAGE=""
OPTIONS=""
OUTCOME="approved"

# Parse arguments: ACTION is $1, then scan remaining args for --outcome and positional params
shift
for arg in "\$@"; do
  case "\$arg" in
    --outcome=*) OUTCOME="\${arg#*=}" ;;
    *)
      if [ -z "\$MESSAGE" ]; then
        MESSAGE="\$arg"
      elif [ -z "\$OPTIONS" ]; then
        OPTIONS="\$arg"
      fi
      ;;
  esac
done

case "\$ACTION" in
    progress|blocked|complete|summary)
        # Daemon handles Telegram + GitHub posting
        PAYLOAD=\$(jq -n --arg agent "\$AGENT_NAME" --arg type "\$ACTION" --arg msg "\$MESSAGE" \\
          --arg outcome "\$OUTCOME" \\
          '{agent: \$agent, type: \$type, message: \$msg, outcome: \$outcome}')
        RESPONSE=\$(curl -s -X POST "\$FRITZ_API/notify" \\
          -H "Content-Type: application/json" \\
          -H "Authorization: Bearer \$FRITZ_TOKEN" \\
          -d "\$PAYLOAD")
        if [ \$? -ne 0 ] || echo "\$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
          echo "[report.sh] Failed to notify daemon: \$RESPONSE" >&2
        fi
        ;;
    ask)
        # Blocking — waits for user answer (5 min timeout)
        PAYLOAD=\$(jq -n --arg agent "\$AGENT_NAME" --arg question "\$MESSAGE" --argjson options "\$OPTIONS" \\
          '{agent: \$agent, question: \$question, options: \$options}')
        RESPONSE=\$(curl -s --max-time 300 -X POST "\$FRITZ_API/ask" \\
          -H "Content-Type: application/json" \\
          -H "Authorization: Bearer \$FRITZ_TOKEN" \\
          -d "\$PAYLOAD")
        if [ \$? -ne 0 ]; then
          echo "[report.sh] Failed to ask daemon" >&2
        else
          echo "\$RESPONSE"
        fi
        ;;
    *)
        echo "[\$(date -Iseconds)] \$ACTION: \$MESSAGE"
        ;;
esac
`;
  writeFileSync(resolve(workspace, '.fritz/report.sh'), reportScript);
  chmodSync(resolve(workspace, '.fritz/report.sh'), '755');

  // 4. Knowledge — copy into workspace so agent containers can access it
  //    (symlinks break in Docker-in-Docker because the target path only
  //     exists inside the daemon container, not inside the agent container)
  const knowledgeDir = resolve(config.fritzRoot, 'fritz/knowledge');
  const knowledgeDest = resolve(workspace, '.fritz/knowledge');
  if (existsSync(knowledgeDir) && !existsSync(knowledgeDest)) {
    try {
      cpSync(knowledgeDir, knowledgeDest, { recursive: true });
      console.log(`   ✓ Copied knowledge to agent workspace`);
    } catch (err: unknown) {
      console.log(`   Warning: Could not copy knowledge directory: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 5. Clone target repo (non-blocking)
  if (repo) {
    const projectDir = resolve(workspace, 'project');
    if (!existsSync(resolve(projectDir, '.git'))) {
      try {
        const cloneArgs = ['repo', 'clone', repo, projectDir, '--', '--depth=50'];
        if (branch) cloneArgs.push('-b', branch);
        console.log(`📦 Cloning ${repo}${branch ? ` (branch: ${branch})` : ''}...`);
        await execAsync('gh', cloneArgs, {
          env: { ...process.env, GH_TOKEN: config.ghToken },
        });
        console.log(`   ✓ Cloned ${repo}${branch ? ` on branch ${branch}` : ''}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (repoFromLabel) {
          // Fail fast: user-specified repo via fritz.repo: label doesn't exist
          throw new Error(
            `Failed to clone repository "${repo}"${branch ? ` (branch: ${branch})` : ''}: ${msg}. ` +
            `Check that the fritz.repo: label on issue #${issue} points to a valid repository and branch.`
          );
        }
        console.log(`   Warning: Could not clone ${repo}${branch ? ` (branch: ${branch})` : ''}: ${msg}`);
      }
    }
  }

  // 6. CLAUDE.md
  const claudeMd = `# Welcome to fritZ

You are a fritZ agent waking up for a new assignment.

## First Steps
1. Read \`.fritz/identity.md\` to understand who you are
2. Read \`.fritz/assignment.md\` to understand your task (READ THIS!)
3. Detect your environment — run \`node --version\`, \`java --version\`, \`gradle --version\`, etc. to discover available tools
4. Check \`.fritz/knowledge/\` for team knowledge and patterns

## Workspace Structure
\`\`\`
./
├── .fritz/
│   ├── identity.md      # Your role and how you work
│   ├── assignment.md    # Your current task (READ THIS!)
│   ├── knowledge/       # Shared team knowledge
│   └── report.sh        # Post updates to GitHub
└── project/             # Target repository (work here)
\`\`\`

## Working Guidelines

### Git Workflow
- All code work happens in \`./project/\`
- Create feature branch: \`git checkout -b feature/ISSUE#-description\`
- Commit your changes with clear messages
- Push: \`git push -u origin HEAD\`
- Create PR: \`gh pr create --title "[Issue #N] Title" --body "Closes #N"\`

### Progress Communication

**IMPORTANT:** Use report.sh to communicate — it notifies both Telegram and GitHub automatically.

\`\`\`bash
# Status updates
.fritz/report.sh progress "Currently working on X"
.fritz/report.sh blocked "Stuck because Y, need help with Z"
.fritz/report.sh complete "Finished implementation, created PR"

# Ask a question (blocks until the user answers)
.fritz/report.sh ask "Which approach?" '["Option A","Option B"]'
\`\`\`

**WARNING:** \`report.sh complete\` is a **terminal action** — the daemon will stop your container after receiving it. Make sure all work is committed and pushed before calling complete.

### Key Milestones to Post About
1. **When you start**: \`.fritz/report.sh progress "Started working on this"\`
2. **Major progress**: \`.fritz/report.sh progress "Implemented X, now working on Y"\`
3. **When blocked**: \`.fritz/report.sh blocked "Stuck on Z, need guidance"\`
4. **When done**: \`.fritz/report.sh complete "Created PR: <url>"\` ← **last action, container stops after this**

## Your Assignment

Read \`.fritz/assignment.md\` for detailed step-by-step instructions with exact commands to run.

---
*Now read your identity and assignment, then begin work.*
`;
  writeFileSync(resolve(workspace, 'CLAUDE.md'), claudeMd);

  // 7. State
  const now = new Date().toISOString();
  const expires = ttl === 0 ? 'never' : new Date(Date.now() + ttl * 1000).toISOString();
  const state = {
    name,
    role,
    issue: issue || null,
    repo: repo || null,
    branch: branch || null,
    workspace,
    ttl,
    created: now,
    expires,
    status: 'ready',
  };
  writeFileSync(
    resolve(workspace, '.fritz/state.json'),
    JSON.stringify(state, null, 2)
  );

  // 8. Register
  registry.registerAgent(name, role, { issue, repo, branch, ttl, workspace, invocationMode, apiToken });

  console.log(`✅ Workspace ready: ${workspace}`);
  console.log(`   TTL: ${ttl === 0 ? '♾️ unlimited (long-running)' : `${ttl}s (${Math.round(ttl / 60)} minutes)`}`);

  return { name, workspace, role, issue, repo, branch, ttl, model, invocationMode, bootContext, apiToken };
}
