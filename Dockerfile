FROM oven/bun:1 AS base
WORKDIR /app
ENV CI=1
ENV BUN_INSTALL=/usr/local/bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

# Copy workspace config and lockfile (layer cache key — only rebuilds when deps change)
COPY package.json pnpm-lock.yaml ./
COPY tsconfig.json ./
COPY packages/protocol/package.json packages/protocol/
COPY server/package.json server/

# Scope workspace to only the packages present in Docker (server + protocol).
# bun reads workspaces from package.json, not pnpm-workspace.yaml, so we
# inject the field and write a matching workspace yaml.
RUN bun -e " \
  const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8')); \
  pkg.workspaces = ['packages/*','server']; \
  require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2)); \
" && printf 'packages:\n  - packages/*\n  - server\n' > pnpm-workspace.yaml

# bun install resolves deps directly — no pnpm needed, much faster on
# Docker BuildKit's overlay fs, and no symlink-heavy node_modules.
RUN bun install

# Copy source files
COPY packages/protocol/ packages/protocol/
COPY server/ server/
COPY client/resources/admin-dist/ client/resources/admin-dist/

# Build protocol so the runtime image has a real dist entrypoint.
RUN cd packages/protocol && bun run build

# Production image
FROM oven/bun:1-slim
WORKDIR /app

ARG ARKESTRATOR_APT_PACKAGES=""
ARG ARKESTRATOR_BUN_GLOBAL_PACKAGES=""
ARG ARKESTRATOR_PIP_PACKAGES=""
ARG ARKESTRATOR_INSTALL_COMMANDS=""
ARG ARKESTRATOR_INSTALL_COMMANDS_TIMEOUT_SECONDS=""
ENV BUN_INSTALL=/usr/local/bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

COPY docker/install.d/ /opt/arkestrator/install.d/
RUN set -eux; \
  export ARKESTRATOR_APT_PACKAGES="${ARKESTRATOR_APT_PACKAGES}"; \
  export ARKESTRATOR_BUN_GLOBAL_PACKAGES="${ARKESTRATOR_BUN_GLOBAL_PACKAGES}"; \
  export ARKESTRATOR_PIP_PACKAGES="${ARKESTRATOR_PIP_PACKAGES}"; \
  export ARKESTRATOR_INSTALL_COMMANDS="${ARKESTRATOR_INSTALL_COMMANDS}"; \
  export ARKESTRATOR_INSTALL_COMMANDS_TIMEOUT_SECONDS="${ARKESTRATOR_INSTALL_COMMANDS_TIMEOUT_SECONDS}"; \
  for script in /opt/arkestrator/install.d/*.sh; do \
    [ -e "$script" ] || continue; \
    chmod +x "$script"; \
    echo "Running install hook: $script"; \
    /bin/sh "$script"; \
  done

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/server ./server
COPY --from=base /app/client/resources/admin-dist ./client/resources/admin-dist
COPY --from=base /app/package.json ./
COPY --from=base /app/pnpm-workspace.yaml ./

# Ensure Bun can resolve the workspace protocol package at runtime.
RUN mkdir -p /app/node_modules/@arkestrator && \
    ln -sfn ../../packages/protocol /app/node_modules/@arkestrator/protocol && \
    mkdir -p /app/server/node_modules/@arkestrator && \
    ln -sfn ../../../packages/protocol /app/server/node_modules/@arkestrator/protocol

VOLUME /data
ENV DB_PATH=/data/arkestrator.db
ENV PORT=7800
ENV NODE_ENV=production
ENV COORDINATOR_SCRIPTS_DIR=/data/coordinator-scripts
ENV COORDINATOR_PLAYBOOKS_DIR=/data/coordinator-playbooks

RUN mkdir -p /data "${BUN_INSTALL}" && chown -R bun:bun /app /data "${BUN_INSTALL}"
USER bun

EXPOSE 7800

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT ?? 7800) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "server/src/index.ts"]
