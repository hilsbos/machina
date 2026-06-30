import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import type { Config } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Try loading .env file for local development.
// In Docker, there is no .env file inside the container — docker-compose
// reads the host's .env and injects variables into the container environment.
const envPath = resolve(__dirname, '../../.env');
if (existsSync(envPath)) {
  console.log(`Loading .env from: ${envPath}`);
  loadEnv({ path: envPath });
} else if (existsSync('/.dockerenv')) {
  console.log('Running in Docker — env variables provided by docker-compose from host .env');
} else {
  console.log(`No .env file found at ${envPath}, using shell environment variables`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string = ''): string {
  return process.env[name] || defaultValue;
}

function optionalInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  return value ? parseInt(value, 10) : defaultValue;
}

export function loadConfig(): Config {
  // In Docker, workspaces are mounted at /app/.workspaces
  // In local dev, they're at fritz-orchestrator/../../.workspaces
  const isDocker = existsSync('/.dockerenv') || existsSync('/proc/1/cgroup');
  const fritzRoot = isDocker ? '/app' : resolve(__dirname, '../../..');

  // For Docker-in-Docker: daemon needs host path to mount in agent containers
  // HOST_WORKSPACES_DIR should be set to the actual host path (e.g., /opt/fritz/fritz-orchestrator/.workspaces)
  const hostWorkspacesDir = optional('HOST_WORKSPACES_DIR');

  // Claude home directory for subscription tokens
  // Priority: HOST_CLAUDE_HOME > CLAUDE_HOME > ${HOME}/.claude
  // HOST_CLAUDE_HOME should be set in .env to the actual host path
  const hostClaudeHome = optional('HOST_CLAUDE_HOME');
  const homeDir = process.env.HOME || '/root';
  const claudeHome = hostClaudeHome || optional('CLAUDE_HOME', `${homeDir}/.claude`);

  // Authentication: optional (can use mounted ~/.claude directory)
  const apiKey = optional('ANTHROPIC_API_KEY');
  const oauthToken = optional('CLAUDE_CODE_OAUTH_TOKEN');
  const claudeAccountName = optional('CLAUDE_ACCOUNT_NAME');

  // API server port (resolved once, used in config and daemonUrl)
  const apiPort = optionalInt('FRITZ_API_PORT', 3456);

  // Debug: Show auth mode without exposing secret values
  if (oauthToken) {
    console.log(`CLAUDE_CODE_OAUTH_TOKEN loaded: ${oauthToken.substring(0, 7)}***`);
    console.log('Auth mode: token-based (no credential file copying needed)');
  } else if (apiKey) {
    console.log(`ANTHROPIC_API_KEY loaded: ${apiKey.substring(0, 5)}***`);
    console.log('Auth mode: API key');
  } else {
    console.log('Auth mode: file-based (mounted ~/.claude credentials)');
  }

  return {
    // Authentication (all optional — oauth token preferred, file-based as fallback)
    claudeOauthToken: oauthToken || undefined,
    claudeAccountName: claudeAccountName || undefined,
    anthropicApiKey: apiKey || undefined,

    // Required
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    telegramChatId: required('TELEGRAM_CHAT_ID'),

    // Optional API keys
    ghToken: optional('GH_TOKEN'),

    // GitHub
    githubRepo: optional('GITHUB_REPO'),

    // Paths
    fritzRoot,
    workspacesDir: resolve(fritzRoot, '.workspaces'),
    hostWorkspacesDir: hostWorkspacesDir || undefined,
    claudeHome,

    // Docker (used in Docker runtime mode)
    dockerImage: optional('DOCKER_IMAGE', 'fritz-agent'),
    ghcrRegistry: optional('GHCR_REGISTRY', 'ghcr.io/your-org'),

    // API server
    apiPort,
    daemonUrl: optional('FRITZ_DAEMON_URL') ||
      (isDocker
        ? `http://fritz-daemon:${apiPort}`
        : `http://host.docker.internal:${apiPort}`),

    // Telegram tagging
    telegramTagHandle: optional('TELEGRAM_TAG_HANDLE') || undefined,

    // OpenTelemetry
    otelExporterEndpoint: optional('OTEL_EXPORTER_OTLP_ENDPOINT') || undefined,
  };
}

export const config = loadConfig();
