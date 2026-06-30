#!/bin/bash
set -e

# Fix permissions on mounted volumes (must run as root)
echo "🔧 Fixing volume permissions..."
mkdir -p /app/.workspaces
chown -R node:node /app/.workspaces
chown -R node:node /app/.claude 2>/dev/null || true

# Ensure Claude credentials file is readable+writable by node user.
# The file is on a bind mount owned by the host's fritz user — add node to
# fritz's group so both can read/write without changing ownership.
CLAUDE_CRED="${HOME}/.claude/.credentials.json"
if [ -f "$CLAUDE_CRED" ]; then
  CRED_GID=$(stat -c '%g' "$CLAUDE_CRED")
  if ! getent group "$CRED_GID" > /dev/null 2>&1; then
    groupadd -g "$CRED_GID" credfile
  fi
  usermod -aG "$CRED_GID" node
  chmod g+rw "$CLAUDE_CRED"
  echo "  ✅ Fixed credentials file permissions (added node to group $CRED_GID)"
fi

echo "🔄 Syncing skills and knowledge from GitHub..."

# Extract repo info
REPO="${GITHUB_REPO:-your-org/fritZ}"

# Download skills directory using GitHub API tarball
if [ -n "$GH_TOKEN" ]; then
  # Use gh CLI if token is available
  echo "  Using GitHub CLI to download skills..."
  gh api repos/$REPO/tarball/main > /tmp/repo.tar.gz

  # Extract just the .claude/skills directory
  cd /tmp
  tar -xzf repo.tar.gz
  EXTRACTED_DIR=$(tar -tzf repo.tar.gz | head -1 | cut -f1 -d"/")

  # Copy skills to the right location (/app/.claude/skills)
  if [ -d "$EXTRACTED_DIR/.claude/skills" ]; then
    rm -rf /app/.claude/skills/*
    mkdir -p /app/.claude/skills
    cp -r "$EXTRACTED_DIR/.claude/skills/"* /app/.claude/skills/
    chmod -R 755 /app/.claude/skills
    echo "  ✅ Skills synced to /app/.claude/skills"
  else
    echo "  ⚠️  Skills directory not found in repo"
  fi

  # Copy knowledge to the right location (/app/fritz/knowledge)
  if [ -d "$EXTRACTED_DIR/fritz/knowledge" ]; then
    rm -rf /app/fritz/knowledge/*
    mkdir -p /app/fritz/knowledge
    cp -r "$EXTRACTED_DIR/fritz/knowledge/"* /app/fritz/knowledge/
    chmod -R 755 /app/fritz/knowledge
    echo "  ✅ Knowledge synced to /app/fritz/knowledge"
  else
    echo "  ⚠️  Knowledge directory not found in repo"
  fi

  # Cleanup
  rm -rf /tmp/repo.tar.gz /tmp/$EXTRACTED_DIR
else
  echo "  ⚠️  No GH_TOKEN set, using existing skills"
fi

# Fix ownership of synced skills/knowledge
chown -R node:node /app/.claude/skills 2>/dev/null || true
chown -R node:node /app/fritz/knowledge 2>/dev/null || true

# Add node user to docker group for Docker socket access
if [ -S /var/run/docker.sock ]; then
  echo "🐳 Configuring Docker socket access..."
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)

  # Check if docker group exists, if not create it
  if ! getent group docker > /dev/null 2>&1; then
    groupadd -g $DOCKER_GID docker
  else
    # Modify existing docker group to match socket GID
    groupmod -g $DOCKER_GID docker
  fi

  # Add node user to docker group
  usermod -aG docker node
  echo "  ✅ Added node user to docker group (GID: $DOCKER_GID)"
else
  echo "  ⚠️  Docker socket not found, skipping docker group setup"
fi

# Start the daemon as node user
echo "👤 Starting daemon as node user (UID 1000)..."
cd /app
exec su -s /bin/sh node -c "exec node dist/index.js $*"
