FROM mcr.microsoft.com/devcontainers/typescript-node:22-bookworm

ARG WRANGLER_VERSION=4
ARG UV_VERSION=0.5.11

# ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        locales \
        pandoc \
        sqlite3 \
        python3 \
        python3-venv \
        python3-pip \
        jq \
        ripgrep \
        zsh \
        wget \
        vim \
        less \
        htop \
        # Playwright Chromium runtime deps — enable headless-browser
        # inspection of UI prototypes via the @playwright/mcp MCP server.
        libnspr4 libnss3 libatk1.0-0 libdbus-1-3 \
        libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libxkbcommon0 libasound2 libatspi2.0-0 \
        libcups2 libdrm2 libpango-1.0-0 libcairo2 \
    && sed -i -e 's/# bg_BG.UTF-8 UTF-8/bg_BG.UTF-8 UTF-8/' /etc/locale.gen \
    && sed -i -e 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

# Install act (run GitHub Actions locally) — use -b to install directly into /usr/local/bin
# instead of the installer's default ./bin (which would otherwise need cleanup and is risky
# at this point in the build because WORKDIR is still /).
RUN curl -fsSL https://raw.githubusercontent.com/nektos/act/master/install.sh \
    | bash -s -- -b /usr/local/bin

# Make zsh node's default login shell
RUN usermod -s /usr/bin/zsh node

RUN su node -c "curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh"

RUN corepack enable \
    && printf 'export PNPM_HOME=/home/node/.local/share/pnpm\nexport PATH=$PNPM_HOME:$PATH\n' \
       > /etc/profile.d/pnpm-home.sh

USER node
WORKDIR /workspaces/sigma-prototype

ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=/home/node/.local/bin:${PNPM_HOME}:${PATH}

RUN corepack prepare pnpm@latest --activate \
    && pnpm config set store-dir /home/node/.pnpm-store

RUN pnpm add -g wrangler@${WRANGLER_VERSION}

# AI coding agents
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN pnpm add -g @openai/codex

# Playwright MCP server + pre-fetched Chromium so the agent can inspect UI in a
# real headless browser. System libs are installed above (apt section).
RUN pnpm add -g @playwright/mcp playwright \
    && npx playwright install chromium

# Headline theme — oh-my-zsh is pre-installed in the typescript-node base image,
# so we only drop the theme in and switch ZSH_THEME.
RUN curl -fsSL https://raw.githubusercontent.com/moarram/headline/main/headline.zsh-theme \
        -o /home/node/.oh-my-zsh/themes/headline.zsh-theme \
    && sed -i "s/'echo \$USER'/'whoami'/g" /home/node/.oh-my-zsh/themes/headline.zsh-theme \
    && sed -i 's/^ZSH_THEME=.*/ZSH_THEME="headline"/' /home/node/.zshrc

# act default: use the catthehacker image (closer to the real GitHub runner than the slim default)
RUN echo '-P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-latest' > /home/node/.actrc
