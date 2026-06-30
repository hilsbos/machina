// Agent roles
export type AgentRole =
  | 'implement'
  | 'review'
  | 'validate'
  | 'define'
  | 'architect'
  | 'ux'
  | 'budget'
  | 'retro'
  | 'security-review'
  | 'pentest';

// Agent image variants for language-specific environments
// 'base' is the default Node.js agent; others add language-specific toolchains
export const AGENT_IMAGE_VARIANTS = ['base', 'java', 'cpp', 'kali', 'rust'] as const;
export type AgentImageVariant = (typeof AGENT_IMAGE_VARIANTS)[number];

// Agent boot modes
export type AgentMode = 'auto' | 'chat';

// Invocation mode - determines how sub-skills (architect, ux, budget) terminate
// 'standalone': Directly booted via /boot - transitions to 'defined' on completion
// 'orchestrated': Spawned by /define - transitions to 'for-define' for synthesis
export type InvocationMode = 'standalone' | 'orchestrated';

// Boot options
export interface BootOptions {
  role: AgentRole;
  issue?: number;
  repo?: string;
  branch?: string;  // Target branch to checkout and base PR on
  name?: string;
  ttl?: number;
  imageVariant?: AgentImageVariant;
  mode?: AgentMode;  // 'auto' (default) = auto-execute, 'chat' = wait for user input
  invocationMode?: InvocationMode;  // 'standalone' (via /boot) or 'orchestrated' (via /define)
  retroCommand?: string;  // Sub-command for retro agent: scan, report, analyze, metrics, experiment
  force?: boolean;  // Bypass maxParallelAgents limit (manual boots only)
}

// Config
export interface Config {
  // Authentication
  claudeOauthToken?: string;     // CLAUDE_CODE_OAUTH_TOKEN (preferred for production)
  claudeAccountName?: string;    // CLAUDE_ACCOUNT_NAME (display name for dashboard/Telegram)
  anthropicApiKey?: string;      // API key (per-token billing fallback)

  // Other API Keys
  ghToken?: string;
  telegramBotToken: string;
  telegramChatId: string;

  // Paths
  workspacesDir: string;
  fritzRoot: string;
  hostWorkspacesDir?: string;  // Host path for Docker-in-Docker agent mounts
  claudeHome: string;          // Host path to ~/.claude directory for subscription tokens

  // GitHub
  githubRepo?: string;

  // Docker (used in Docker runtime mode)
  dockerImage: string;
  ghcrRegistry: string;  // GHCR registry for auto-pulling agent images

  // API server
  apiPort: number;
  daemonUrl: string;

  // Telegram tagging
  telegramTagHandle?: string;  // Telegram handle to tag when input is needed (e.g., "@your-org")

  // OpenTelemetry
  otelExporterEndpoint?: string;  // OTLP collector endpoint (enables telemetry when set)
}

// Role emoji mapping
export const ROLE_EMOJI: Record<AgentRole | 'fritz', string> = {
  implement: '🔨',
  review: '👀',
  validate: '✅',
  define: '📋',
  architect: '🏗️',
  ux: '🎨',
  budget: '💰',
  retro: '🔄',
  'security-review': '🔒',
  pentest: '🎯',
  fritz: '🤖',
};

// Boot context - pre-loaded issue context for agents
export interface CommentSummary {
  author: string;
  createdAt: string;
  body: string;  // truncated to ~500 chars
}

export interface LinkedPr {
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
}

export interface BootContext {
  type: 'issue' | 'none';

  // For issues
  issue?: {
    number: number;
    title: string;
    body: string;
    labels: string[];
    comments: CommentSummary[];
    linkedPrs: LinkedPr[];
  };
}
