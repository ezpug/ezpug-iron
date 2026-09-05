# syntax=docker/dockerfile:1.7
#
# **The orchestrator image** (PRD-02 T4) — `ghcr.io/ezpug/ezpug-iron/orchestrator`.
# One service, one process, no game server: Hono over Postgres and Redis, the
# providers `EZPUG_IRON_PROVIDERS` names, and the links every server and node
# dials.
#
#   pnpm image:build                          # a local :dev tag, before any publish
#   docker build -f docker/orchestrator/Dockerfile -t ezpug-iron/orchestrator:dev .
#
# It is built from the repo root (the build context is the whole workspace,
# minus `.dockerignore`). Offline-first is a *development* rule: nothing here
# is needed for `pnpm dev` — this file exists for the boxes that run the thing,
# and for another project's dev world that pulls it beside its own services
# (docs/operations.md, "Running it inside another project's dev world").

# ── Base ───────────────────────────────────────────────────────────────────
# Node pinned to the version the repo pins (`package.json` engines,
# docs/pins.md) — a deploy on a different runtime than the tests ran on is not
# a deploy of what was tested. bookworm-slim rather than alpine, like the
# platform's image: the toolchain has native optional dependencies and glibc is
# where they are tested.
FROM node:22.19.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable
WORKDIR /app

# ── Build ──────────────────────────────────────────────────────────────────
# The whole workspace, installed once and built once. The pnpm store rides a
# BuildKit cache mount, so a rebuild after a code change re-links rather than
# re-downloads.
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store --global \
    && pnpm install --frozen-lockfile

# `@ezpug/protocol`'s build regenerates the C# wire types beside the JSON
# Schema; `--filter=@ezpug/orchestrator...` builds it and everything else the
# service depends on, in dependency order, and nothing else in the workspace.
RUN pnpm --filter=@ezpug/orchestrator... build

# ── Runtime tree ───────────────────────────────────────────────────────────
# `pnpm deploy` resolves one package's production dependencies into a
# self-contained directory: the bundles plus the npm packages they did not
# inline, and none of the build tooling. `--legacy` is required because this
# workspace does not inject workspace packages — they are already bundled into
# `dist/`, so there is nothing to inject.
FROM build AS deploy
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm deploy --legacy --filter=@ezpug/orchestrator --prod /out

# ── orchestrator ───────────────────────────────────────────────────────────
FROM base AS orchestrator
ENV NODE_ENV=production \
    # The container binds every interface and lets the compose file decide
    # what is published; the dev default (127.0.0.1) would be unreachable.
    EZPUG_IRON_HOST=0.0.0.0 \
    EZPUG_IRON_PORT=3430 \
    # The SQL is not code and cannot ride a bundle — the image says where it
    # put it, and applies what is pending before the port opens. Idempotent
    # and advisory-locked, so two replicas starting together is not a race.
    EZPUG_IRON_MIGRATIONS_DIR=/app/drizzle \
    EZPUG_IRON_MIGRATE_ON_BOOT=true
COPY --from=deploy --chown=node:node /out /app
# `drizzle/` holds the migration SQL and its journal; `db/migrate.ts` reads it
# through EZPUG_IRON_MIGRATIONS_DIR above.
COPY --from=build --chown=node:node /app/apps/orchestrator/drizzle /app/drizzle
# Which commit this image was built from — what a rollback has to be able to
# ask of `:previous` (T35).
ARG EZPUG_GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$EZPUG_GIT_SHA \
      org.opencontainers.image.source=https://github.com/ezpug/ezpug-iron \
      org.opencontainers.image.title=ezpug-iron-orchestrator \
      org.opencontainers.image.description="The EZPug Iron orchestrator: the Match API over Dathost, self-hosted nodes and a simulator."
# Never root: the image runs as node (uid 1000), which is also why nothing in
# it is writable by the process except /tmp.
USER node
EXPOSE 3430
# The service's own answer to "are you healthy": the rails and every
# registered provider, and 503 while draining (`/healthz`, docs/operations.md).
# Node's fetch rather than curl, because the image has no curl and does not
# need one.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.EZPUG_IRON_PORT ?? 3430}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.mjs"]
