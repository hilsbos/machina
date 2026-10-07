# machina Quick Start Guide

Get machina up and running in minutes - either locally for development or on a production server. For the full picture, see the [machina orchestrator README](../README.md).

## Contents

- [Prerequisites](#prerequisites)
- [Local development (5 minutes)](#local-development-5-minutes)
- [Production deployment](#production-deployment)
- [Common commands](#common-commands)
- [Troubleshooting](#troubleshooting)
- [What's next?](#whats-next)
- [Documentation](#documentation)
- [Server requirements](#server-requirements)
- [Cost breakdown](#cost-breakdown)
- [Quick reference](#quick-reference)

## Prerequisites

- Node.js 18+
- GitHub CLI (`gh`) authenticated
- Claude Code CLI authenticated
- Telegram Bot Token
- GitHub Personal Access Token

## Local development (5 minutes)

### 1. Install dependencies

```bash
# Navigate to daemon directory
cd fritz-orchestrator/daemon

# Install Node.js dependencies
npm install
```

### 2. Authenticate Claude Code

```bash
# One-time setup
claude setup-token
# Follow prompts to authenticate via browser
```

### 3. Authenticate GitHub CLI

```bash
gh auth login
# Follow prompts
```

### 4. Configure Telegram bot

Create a bot with `@BotFather` on Telegram:

```text
/newbot
# Follow prompts
# Save the token: 123456:ABC-DEF...
```

Get your Chat ID from `@userinfobot`.

### 5. Create .env file

```bash
# Create .env in fritz-orchestrator/daemon/
cat > .env << 'EOF'
# Authentication: Automatic via ~/.claude directory
# Only needed if Claude Code CLI is not authenticated:
# ANTHROPIC_API_KEY=sk-ant-api03-...

TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=-100...
GH_TOKEN=ghp_xxxxx
GITHUB_REPO=owner/repo

# Optional - only needed if you see "Claude home not found" errors in Docker:
# HOST_CLAUDE_HOME=${HOME}/.claude
EOF

# Secure it
chmod 600 .env
```

### 6. Start the daemon

```bash
# Development
npm run dev

# Or for production-like setup:
npm run build && npm start
```

> [!TIP]
> `npm run dev` runs the TypeScript daemon directly with no build step - the fastest loop for local development.

That's it! Now send a message to your Telegram bot:

```text
fritz hallo
```

You should get a response from Claude Code. The dashboard is available at `http://localhost:3456/dashboard` (enabled by default).

## Production deployment

Production runs as Docker containers, deployed via GitHub Actions. See the [deployment guide](DEPLOYMENT.md) for the full server provisioning walkthrough.

### Quick summary

1. **Provision server**: Install Docker, create `fritz` service user
2. **Install Claude Code**: `su - fritz && claude setup-token`
3. **Create `.env`**: Add secrets to `/opt/fritz/.env`
4. **Configure GitHub Secrets**: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`
5. **Deploy**: Push a version tag or trigger the deploy workflow

```bash
# Deploy via tag
git tag v1.0.0 && git push origin v1.0.0
# Then trigger deploy.yml from GitHub Actions UI
```

### Verify deployment

```bash
# Check container status
ssh fritz@<server> 'cd /opt/fritz && docker compose ps'

# View logs
ssh fritz@<server> 'cd /opt/fritz && docker compose logs --tail=50'

# Test via Telegram
# Send: fritz status
```

## Common commands

### Development

```bash
# Start daemon (development, no build needed)
npm run dev

# Watch mode (auto-restart on changes)
npm run watch

# Type check
npx tsc --noEmit
```

### Production (Docker)

```bash
# Status
docker compose ps
docker ps --filter "name=fritz-"

# Logs
docker compose logs -f
docker logs fritz-agent-<name>

# Restart
docker compose restart

# Stop
docker compose down
```

### Local development (PM2)

```bash
# Status
npm run pm2:status

# Logs
npm run pm2:logs

# Restart
npm run pm2:restart

# Stop
npm run pm2:stop
```

### Telegram commands

```text
fritz <anything>          - Talk to Claude Code
fritz status              - Show running agents
fritz boot impl 42        - Start implement agent for issue #42
fritz stop <name>         - Stop an agent
fritz logs <name>         - View agent logs
/cleanup [hours]          - Remove old workspaces
```

## Troubleshooting

### Daemon won't start

```bash
# Check config
cat .env

# Check Telegram bot token
curl https://api.telegram.org/bot<TOKEN>/getMe

# Check Claude Code authentication
claude --version
ls -la ~/.claude/

# Check Node.js version
node --version  # Should be 18+
```

### Bot not responding

```bash
# Check daemon logs (Docker)
docker compose logs fritz-daemon

# Or if running locally
npm start  # Check stdout/stderr

# Verify Telegram configuration
echo $TELEGRAM_BOT_TOKEN
echo $TELEGRAM_CHAT_ID

# Restart daemon (Docker)
docker compose restart

# Restart daemon (local PM2)
npm run pm2:restart
```

### Agents not starting

```bash
# Check Claude Code is authenticated
claude --version

# Check gh is authenticated
gh auth status

# View agent logs
fritz logs <agent-name>

# Check running containers
docker ps --filter "name=fritz-"

# Check daemon logs for errors
docker compose logs fritz-daemon
```

## What's next?

After getting machina running:

1. **Create a test issue** on GitHub
2. **Send to machina**: `fritz boot implement <issue-number>`
3. **Watch the agent work** via Telegram updates
4. **Review the PR** when complete
5. **Deploy to production** (see the [deployment guide](DEPLOYMENT.md))

> [!IMPORTANT]
> The pipeline has two human approval gates - approve the spec, then approve the merge. The `fritz.auto-pipeline` label removes those two gates only; CI is still checked before any merge.

## Documentation

| Guide | Purpose |
|-------|---------|
| [Deployment guide](DEPLOYMENT.md) | Production server provisioning guide |
| [Docker architecture](../DOCKER.md) | Container architecture, volumes, credential isolation |
| [Security guide](SECURITY.md) | Security best practices |
| [CI/CD pipeline](CI-CD.md) | GitHub Actions CI/CD pipeline |
| [Orchestrator README](../README.md) | Full machina documentation |

## Server requirements

### Development

- Any machine with Node.js 18+
- 2 GB RAM minimum
- Internet connection

### Production

- 4 vCPUs, 8 GB RAM (recommended)
- Ubuntu 22.04 LTS or similar
- Cost: ~€25/month (a standard cloud VPS)

## Cost breakdown

### Free

- Claude Code (subscription via claude.com)
- GitHub (public repos)
- Telegram Bot

### Paid

- Production server: €8-25/month (depending on specs)
- Claude Code subscription: see claude.com/pricing

**Total for production**: ~€30-50/month

## Quick reference

### File locations

```text
fritz-orchestrator/
├── daemon/
│   ├── src/                    # Daemon source code
│   ├── .env                    # Configuration (create this)
│   └── package.json            # Dependencies
├── docs/                       # Documentation
├── docker-compose.yml          # Dev: Docker Compose
├── docker-compose.prod.yml     # Production: pre-built images
├── Dockerfile                  # Daemon container image
├── Dockerfile.agent            # Agent container image
├── DOCKER.md                   # Container architecture
└── README.md                   # Full documentation
```

### Environment variables

| Variable | Required | Example |
|----------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | `123456:ABC-DEF...` |
| `TELEGRAM_CHAT_ID` | Yes | `-100...` or your user ID |
| `GH_TOKEN` | Yes | `ghp_xxxxx` |
| `GITHUB_REPO` | No | `owner/repo` |
| `HOST_WORKSPACES_DIR` | Production | `/opt/fritz/.workspaces` |
| `HOST_CLAUDE_HOME` | Production | `/home/fritz/.claude` |
| `ANTHROPIC_API_KEY` | No* | Fallback for API key billing |

\* Not needed if Claude Code is authenticated (recommended).

Happy orchestrating!
