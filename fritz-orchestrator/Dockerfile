FROM node:20-slim

# Install Docker CLI and GitHub CLI
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    git \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY daemon/package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy TypeScript source
COPY daemon/src ./src
COPY daemon/tsconfig.json ./

# Build TypeScript
RUN npm install typescript && npm run build && npm uninstall typescript

# Copy agent configuration
COPY config/ /app/config/

# Copy dashboard SPA
COPY dashboard-ui.html /app/dashboard-ui.html

# Bake build version (git short hash) into the image
ARG FRITZ_BUILD_VERSION=dev
RUN echo "$FRITZ_BUILD_VERSION" > /app/.build-version

# Copy agent Dockerfile for building agent image
COPY Dockerfile.agent /app/Dockerfile.agent

# Copy entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create directories (skills and knowledge will be pulled at runtime from GitHub)
RUN mkdir -p /app/.claude/skills /app/fritz/knowledge && chmod -R 755 /app/.claude /app/fritz

# Create workspace directory
RUN mkdir -p /app/.workspaces

# Use existing node user from base image (UID 1000)
# Set ownership at build time
RUN chown -R node:node /app/.claude /app/fritz /app/.workspaces /app/config

# Don't set USER here - entrypoint needs to run as root to fix volume permissions
# USER will be switched in entrypoint.sh after fixing permissions

# Use entrypoint script to sync skills before starting daemon
ENTRYPOINT ["/app/entrypoint.sh"]
