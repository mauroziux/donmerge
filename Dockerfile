FROM docker.io/cloudflare/sandbox:0.7.17

# Install OpenCode CLI
ENV PATH="/root/.opencode/bin:${PATH}"
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

    # Install GitHub CLI
    RUN (type -p wget >/dev/null || (apt-get update && apt-get install wget -y)) \
        && mkdir -p -m 755 /etc/apt/keyrings \
        && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        && cat $out | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
        && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
        && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
        && apt-get update \
        && apt-get install gh -y \
        && rm -rf /var/lib/apt/lists/*

# --- Add your own setup here ---
# For example: install additional tools, clone your repo,
# pre-install dependencies, etc.
# RUN npm install -g pnpm
# RUN git clone https://github.com/your-org/your-repo.git /home/user/repo

WORKDIR /home/user
EXPOSE 48765
