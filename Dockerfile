# syntax=docker/dockerfile:1.4

# =============================================================================
# OPTIMIZED DOCKERFILE - Layer Caching Efficiency
# =============================================================================
# Layer ordering principle: Most stable → Most volatile
# This ensures small changes don't invalidate the entire build cache
# =============================================================================

FROM docker.io/cloudflare/sandbox:0.7.17

# -----------------------------------------------------------------------------
# LAYER 1: Environment Variables (rarely change)
# Put PATH modifications early so they apply to all subsequent layers
# -----------------------------------------------------------------------------
ENV PATH="/root/.opencode/bin:${PATH}" \
    # Reduce apt interactivity during builds
    DEBIAN_FRONTEND=noninteractive

# -----------------------------------------------------------------------------
# LAYER 2: System Package Repository Setup (rarely change)
# Separating this allows cache reuse even if package versions change
# Using BuildKit cache mount for faster repeated builds
# -----------------------------------------------------------------------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    set -eux; \
    # Install wget if not present (needed for GPG key download)
    if ! command -v wget &> /dev/null; then \
        apt-get update; \
        apt-get install -y --no-install-recommends wget; \
    fi; \
    # Setup GitHub CLI repository
    mkdir -p -m 755 /etc/apt/keyrings; \
    wget -nv -O /etc/apt/keyrings/githubcli-archive-keyring.gpg \
        https://cli.github.com/packages/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] \
        https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list

# -----------------------------------------------------------------------------
# LAYER 3: Install System Packages (rarely change)
# Combined apt-get update + install for cache efficiency
# Cleanup in same layer to reduce image size
# -----------------------------------------------------------------------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    # Verify installation
    gh --version; \
    # Cleanup apt cache (doesn't affect BuildKit cache mounts)
    rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# LAYER 4: Install OpenCode CLI (changes occasionally)
# Download, install, and cleanup in single layer
# Note: This is separate from system packages as it may update independently
# -----------------------------------------------------------------------------
RUN set -eux; \
    curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh; \
    bash /tmp/install-opencode.sh; \
    rm -f /tmp/install-opencode.sh; \
    # Verify installation
    opencode --version

# -----------------------------------------------------------------------------
# LAYER 5: Project-Specific Setup (changes frequently)
# Add your custom setup here - this layer will rebuild most often
# -----------------------------------------------------------------------------
# --- Add your own setup here ---
# For example: install additional tools, clone your repo,
# pre-install dependencies, etc.
# RUN npm install -g pnpm
# RUN git clone https://github.com/your-org/your-repo.git /home/user/repo

# -----------------------------------------------------------------------------
# METADATA (final layer, minimal impact)
# -----------------------------------------------------------------------------
WORKDIR /home/user
EXPOSE 48765
