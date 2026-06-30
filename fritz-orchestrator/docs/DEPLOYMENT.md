# fritZ Deployment Guide

## Overview

fritZ is deployed as a Docker-based system via GitHub Actions CI/CD:

- **Daemon + agents** run as Docker containers
- **CI/CD**: `build-daemon.yml` + `build-agent-images.yml` build and push images to GHCR; `deploy-hetzner.yml` deploys via SSH; `build-and-deploy-hetzner.yml` combines build + deploy in one workflow
- **No manual git clone on server** -- the deploy workflow copies `docker-compose.prod.yml` and pulls pre-built images

```
Developer publishes release or triggers manually
        |
        v
build-daemon.yml / build-agent-images.yml
  - Builds fritz-daemon and fritz-agent Docker images (separate workflows)
  - Pushes to ghcr.io/your-org/fritz-daemon, ghcr.io/your-org/fritz-agent
        |
        v
deploy-hetzner.yml (manual trigger or called by build-and-deploy)
  - SSHs into server as fritz
  - Copies docker-compose.prod.yml -> /opt/fritz/docker-compose.yml
  - Copies .env.example -> /opt/fritz/.env.example
  - Checks .env exists (must be created manually once)
  - docker login to ghcr.io
  - docker pull both images
  - docker tag as fritz-daemon:latest, fritz-agent:latest
  - docker compose up -d
```

## Server Requirements

### Recommended Specs

**For Development/Testing:**
- 2 vCPUs
- 4 GB RAM
- 20 GB storage
- Cost: ~EUR 8-10/month (Hetzner CX22 or similar)

**For Production:**
- 4 vCPUs
- 8 GB RAM
- 40 GB storage
- Cost: ~EUR 25/month (Hetzner CX32 or similar)

**Why these specs?**
- Good CPU performance for running multiple Claude Code agents
- Sufficient RAM for daemon container + concurrent agent containers
- Fast storage for agent workspaces
- Stable network for Telegram/GitHub/Anthropic APIs

### Supported Platforms
- Ubuntu 22.04 LTS (recommended)
- Debian 11+
- Any Linux distribution with Docker support

---

## Provisioning a New Server

### 1. Initial Server Setup

```bash
# SSH as root
ssh root@<your-server-ip>

# Update system
apt-get update && apt-get upgrade -y

# Install essential tools
apt-get install -y git curl
```

### 2. Install Docker and Docker Compose

```bash
# Install Docker (official method)
curl -fsSL https://get.docker.com | sh

# Verify
docker --version
docker compose version
```

### 3. Install GitHub CLI

```bash
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
apt-get update && apt-get install -y gh
```

### 4. Create the fritz Service User

```bash
# Create dedicated service user with home directory
sudo useradd -r -m -s /bin/bash -d /home/fritz fritz

# Add to docker group (so fritz can run Docker commands)
sudo usermod -aG docker fritz

# Create deployment directory
sudo mkdir -p /opt/fritz
sudo chown fritz:fritz /opt/fritz
```

### 5. Install Claude Code (as fritz)

```bash
# Switch to fritz user
su - fritz

# Install Claude Code
curl -fsSL https://claude.ai/install.sh | bash

# Authenticate (creates ~/.claude/ with subscription credentials)
claude setup-token

# Verify installation
claude --version
ls -la ~/.claude/
# Should contain: .credentials.json, subscription_token.json

# Protect credentials
chmod 700 ~/.claude

# Return to root
exit
```

Note: Credentials are account-bound and cannot be transferred between machines. You must run `claude setup-token` on each server.

### 6. Set Up SSH Key for GitHub Actions Deployment

```bash
# Option A: Add the deploy key's public key to fritz's authorized_keys
# (The private key goes into GitHub Secrets as SSH_PRIVATE_KEY)
mkdir -p /home/fritz/.ssh
# Add your deploy public key:
echo "ssh-ed25519 AAAA... github-actions-fritz" >> /home/fritz/.ssh/authorized_keys
chmod 700 /home/fritz/.ssh
chmod 600 /home/fritz/.ssh/authorized_keys
chown -R fritz:fritz /home/fritz/.ssh

# Option B: Set SSH_USER in GitHub secrets to a different user that can sudo
```

### 7. Create .env

Create the environment file manually on the server (this is done once; the deploy workflow does not overwrite it):

```bash
cat > /opt/fritz/.env << 'EOF'
# Telegram Configuration
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=-100...

# GitHub Configuration
GH_TOKEN=ghp_xxxxx
GITHUB_REPO=owner/repo

# Docker-in-Docker path mapping (required for production)
HOST_WORKSPACES_DIR=/opt/fritz/.workspaces
HOST_CLAUDE_HOME=/home/fritz/.claude
HOME=/home/fritz

# Model configuration: see config/fritz.yaml

# Optional: Telegram Topics — configure in config/fritz.yaml (telegram.topics section)
EOF

# Secure it
chmod 600 /opt/fritz/.env
chown fritz:fritz /opt/fritz/.env
```

See `.env.example` for all available variables.

### 8. Configure GitHub Secrets

In your repository settings (Settings > Secrets and variables > Actions), add:

| Secret | Value |
|--------|-------|
| `SSH_HOST` | Server IP address |
| `SSH_USER` | `fritz` |
| `SSH_PRIVATE_KEY` | Private key for SSH deployment |

`GITHUB_TOKEN` is automatic and does not need to be set.

### 9. Deploy

```bash
# Option A: Push a version tag (triggers build + you manually trigger deploy)
git tag v1.0.0 && git push origin v1.0.0

# Option B: Trigger workflows manually from GitHub Actions UI
# 1. Run build-daemon.yml (and/or build-agent-images.yml)
# 2. Run deploy-hetzner.yml

# Verify deployment
ssh fritz@<server-ip> 'cd /opt/fritz && docker compose ps'
```

---

## Deployment via GitHub Actions

### build-daemon.yml

**Triggers:** Manual dispatch, called by `build-and-deploy-hetzner.yml`

**What it does:**
1. Builds the `fritz-daemon` Docker image
2. Pushes to `ghcr.io/your-org/fritz-daemon`
3. Tags with git SHA and `latest`

### build-agent-images.yml

**Triggers:** Manual dispatch

**What it does:**
1. Builds `fritz-agent` Docker images (base, Java, C++ variants)
2. Pushes to `ghcr.io/your-org/fritz-agent`, `ghcr.io/your-org/fritz-agent-java`, `ghcr.io/your-org/fritz-agent-cpp`

### deploy-hetzner.yml

**Triggers:** Manual dispatch (with environment and optional `image_tag` input), called by `build-and-deploy-hetzner.yml`

**What it does:**
1. SSHs into the production server as `$SSH_USER`
2. Copies `docker-compose.prod.yml` to `/opt/fritz/docker-compose.yml`
3. Copies `.env.example` to `/opt/fritz/.env.example`
4. Verifies `.env` exists (must be created manually once)
5. Logs into GHCR, pulls both images
6. Tags images as `fritz-daemon:latest` and `fritz-agent:latest`
7. Runs `docker compose up -d`
8. Verifies containers are running
9. Cleans up old Docker images

### build-and-deploy-hetzner.yml

**Triggers:** Release published, manual dispatch

**What it does:**
1. Calls `build-daemon.yml` to build and push the daemon image
2. Calls `deploy-hetzner.yml` to deploy to the server

### How to Deploy

1. **Create a release** on GitHub (or push a release tag)
2. `build-and-deploy-hetzner.yml` triggers automatically on release publish — builds the daemon image and deploys
3. Or trigger `build-daemon.yml` and `deploy-hetzner.yml` manually from the Actions tab

---

## Dashboard Remote Access (Optional)

To access the dashboard remotely via mTLS:

1. Add to `/opt/fritz/.env`:
   ```bash
   FRITZ_DOMAIN=your-server.example.com
   FRITZ_DASHBOARD_PORT=8443
   FRITZ_CLIENT_CERT_PASS=your-secure-password
   ```

2. Allow the dashboard port in your firewall:
   ```bash
   sudo ufw allow 8443/tcp
   ```

3. Restart the stack — `mtls-init` generates certs on first boot:
   ```bash
   cd /opt/fritz && docker compose up -d
   ```

4. Download `client.p12` and import into your browser:
   ```bash
   scp fritz@<server>:/opt/fritz/mtls/certs/client.p12 ~/Downloads/
   ```

See [DASHBOARD.md](DASHBOARD.md) for full details.

---

## Server Directory Structure

After deployment, the server looks like:

```
/opt/fritz/
├── docker-compose.yml    # Copied from docker-compose.prod.yml by deploy workflow
├── .env                  # Created manually once on server
├── .env.example          # Copied by deploy workflow
├── nginx/                # nginx config template (copied by deploy workflow)
│   └── nginx.conf
├── mtls/                 # Auto-generated on first boot (if FRITZ_DOMAIN set)
│   └── certs/
│       ├── ca.crt/key
│       ├── server.crt/key
│       ├── client.crt/key
│       └── client.p12
└── .workspaces/          # Created at runtime by daemon
    ├── fritz/             # Orchestrator workspace
    ├── implement-18/      # Agent workspaces...
    └── review-20/

/home/fritz/
└── .claude/              # Claude Code subscription credentials
    ├── .credentials.json
    └── subscription_token.json
```

---

## Monitoring and Maintenance

### Check Status

```bash
# Container status
ssh fritz@<server> 'cd /opt/fritz && docker compose ps'

# All fritZ containers (including agents)
ssh fritz@<server> 'docker ps --filter "name=fritz-"'

# From Telegram
fritz status
```

### View Logs

```bash
# Daemon logs
docker compose -f /opt/fritz/docker-compose.yml logs -f

# Specific agent logs
docker logs fritz-agent-<name>

# Follow all fritZ container logs
docker logs -f fritz-daemon
```

### Workspace Cleanup

Workspaces are cleaned up automatically by the watchdog. Old directories (older than `daemon.workspaceMaxAgeHours` in `fritz.yaml`, default 24h) that are not associated with a running agent are removed each check cycle.

You can also trigger cleanup manually via Telegram:

```
/cleanup        — remove workspaces older than the configured default
/cleanup 48     — remove workspaces older than 48 hours
/cleanup 0      — remove all non-active workspaces regardless of age
```

To disable automatic cleanup, set `daemon.workspaceMaxAgeHours: 0` in `fritz.yaml`.

**Manual fallback** (if the daemon is not running):

```bash
# List workspaces
ls -la /opt/fritz/.workspaces/

# Remove old agent workspaces (older than 7 days)
find /opt/fritz/.workspaces/ -maxdepth 1 -type d -mtime +7 \
  -not -name '.workspaces' -not -name 'fritz' -exec rm -rf {} +
```

### Update Deployment

Trigger the deploy workflow -- images are rebuilt automatically:

1. Create a release on GitHub (or trigger workflows manually)
2. `build-and-deploy-hetzner.yml` builds the daemon image and deploys
3. For agent images, run `build-agent-images.yml` separately when needed

No manual `git pull` or `npm install` needed on the server.

---

## Troubleshooting

### Container Not Starting

```bash
# Check compose logs
cd /opt/fritz && docker compose logs

# Check daemon container specifically
docker logs fritz-daemon

# Verify images exist
docker images | grep fritz
```

### Agent Credential Issues

```bash
# Check credentials were copied into agent workspace
ls -la /opt/fritz/.workspaces/<agent-name>/.claude/

# Verify permissions (should be 0444 read-only)
stat /opt/fritz/.workspaces/<agent-name>/.claude/.credentials.json

# Check daemon logs for credential copy messages
docker logs fritz-daemon 2>&1 | grep -i "credential\|claude home"
```

### Claude Auth Not Working

```bash
# SSH as fritz user and verify Claude Code
ssh fritz@<server>
claude --version
ls -la ~/.claude/

# Re-authenticate if needed
claude setup-token

# Restart containers
cd /opt/fritz && docker compose restart
```

### Docker Socket Issues

```bash
# Verify fritz is in docker group
groups fritz

# Check socket permissions
ls -la /var/run/docker.sock

# If needed, re-add to group (requires re-login)
sudo usermod -aG docker fritz
```

### Agent Not Spawning

```bash
# Check if agent image exists
docker images | grep fritz-agent

# Check daemon logs for spawn errors
docker logs fritz-daemon 2>&1 | grep -i "spawn\|agent\|error"

# Verify Docker socket is mounted
docker inspect fritz-daemon | grep -A5 docker.sock
```

---

## Configuration

- See `.env.example` for all environment variables and their descriptions
- See [DOCKER.md](../DOCKER.md) for container architecture, volume mounts, and credential isolation
- See [SECURITY.md](SECURITY.md) for security hardening and secret management
- See [CI-CD.md](CI-CD.md) for the full CI/CD pipeline documentation
