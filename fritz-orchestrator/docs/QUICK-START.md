# Quick Start Guide

Get fritZ up and running in minutes - either locally for development or on a production server.

## Prerequisites

- Node.js 18+
- GitHub CLI (gh) authenticated
- Claude Code CLI authenticated
- Telegram Bot Token
- GitHub Personal Access Token

## Local Development (5 minutes)

### 1. Install Dependencies

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

### 4. Configure Telegram Bot

Create a bot with @BotFather on Telegram:

```
/newbot
# Follow prompts
# Save the token: 123456:ABC-DEF...
```

Get your Chat ID from @userinfobot.

### 5. Create .env File

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

### 6. Start the Daemon

```bash
# Development (runs TypeScript directly, no build step needed)
npm run dev

# Or for production-like setup:
npm run build && npm start
```

That's it! Now send a message to your Telegram bot:

```
fritz hallo
```

You should get a response from Claude Code!

The dashboard is available at `http://localhost:3456/dashboard` (enabled by default).

---

## Production Deployment

Production runs as Docker containers, deployed via GitHub Actions. See [DEPLOYMENT.md](DEPLOYMENT.md) for the full server provisioning guide.

### Quick Summary

1. **Provision server**: Install Docker, create `fritz` service user
2. **Install Claude Code**: `su - fritz && claude setup-token`
3. **Create `.env`**: Add secrets to `/opt/fritz/.env`
4. **Configure GitHub Secrets**: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`
5. **Deploy**: Push a version tag or trigger deploy workflow

```bash
# Deploy via tag
git tag v1.0.0 && git push origin v1.0.0
# Then trigger deploy-scaleway.yml from GitHub Actions UI
```

### Verify Deployment

```bash
# Check container status
ssh fritz@<server> 'cd /opt/fritz && docker compose ps'

# View logs
ssh fritz@<server> 'cd /opt/fritz && docker compose logs --tail=50'

# Test via Telegram
# Send: fritz status
```

---

## Common Commands

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

### Local Development (PM2)

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

### Telegram Commands

```
fritz <anything>          - Talk to Claude Code
fritz status              - Show running agents
fritz boot impl 42        - Start implement agent for issue #42
fritz stop <name>         - Stop an agent
fritz logs <name>         - View agent logs
/cleanup [hours]          - Remove old workspaces
```

---

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

---

## What's Next?

After getting fritZ running:

1. **Create a test issue** on GitHub
2. **Send to fritZ**: `fritz boot implement <issue-number>`
3. **Watch the agent work** via Telegram updates
4. **Review the PR** when complete
5. **Deploy to production** (see DEPLOYMENT.md)

---

## Documentation

| Guide | Purpose |
|-------|---------|
| **[DEPLOYMENT.md](DEPLOYMENT.md)** | Production server provisioning guide |
| **[DOCKER.md](../DOCKER.md)** | Container architecture, volumes, credential isolation |
| **[SECURITY.md](SECURITY.md)** | Security best practices |
| **[CI-CD.md](CI-CD.md)** | GitHub Actions CI/CD pipeline |
| **[README.md](../README.md)** | Full fritZ documentation |

---

## Server Requirements

### Development
- Any machine with Node.js 18+
- 2 GB RAM minimum
- Internet connection

### Production
- 4 vCPUs, 8 GB RAM (recommended)
- Ubuntu 22.04 LTS or similar
- Cost: ~€25/month (Scaleway PRO2-S or similar)

---

## Cost Breakdown

**Free:**
- Claude Code (subscription via claude.com)
- GitHub (public repos)
- Telegram Bot

**Paid:**
- Production server: €8-25/month (depending on specs)
- Claude Code subscription: See claude.com/pricing

**Total for production**: ~€30-50/month

---

## Quick Reference

### File Locations

```
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

### Environment Variables

| Variable | Required | Example |
|----------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | `123456:ABC-DEF...` |
| `TELEGRAM_CHAT_ID` | Yes | `-100...` or your user ID |
| `GH_TOKEN` | Yes | `ghp_xxxxx` |
| `GITHUB_REPO` | No | `owner/repo` |
| `HOST_WORKSPACES_DIR` | Production | `/opt/fritz/.workspaces` |
| `HOST_CLAUDE_HOME` | Production | `/home/fritz/.claude` |
| `ANTHROPIC_API_KEY` | No* | Fallback for API key billing |

\* Not needed if Claude Code is authenticated (recommended)

---

Happy orchestrating!
