# syntax=docker/dockerfile:1.7
#
# **The node agent image** (PRD-02 T11) — `ghcr.io/ezpug/ezpug-iron/node`.
# One process and no game server: `ezpug-node` dials the orchestrator on the
# node link and starts CS2 server containers from the *server* image
# (`docker/cs2/Dockerfile`) on the host it runs on. It needs the host's
# docker socket and nothing else of the host; `docs/nodes.md` is the runbook.
#
#   pnpm node:build                           # a local :dev tag, before any publish
#   docker build -f docker/node/Dockerfile -t ezpug-iron/node:dev .
#
# Built from the repo root like the orchestrator's image (the same base, the
# same install, the same `pnpm deploy` of one package's production tree) so
# the two stay one recipe.

# ── Base ───────────────────────────────────────────────────────────────────
FROM node:22.19.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable
WORKDIR /app

# ── Build ──────────────────────────────────────────────────────────────────
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store --global \
    && pnpm install --frozen-lockfile
# `@ezpug/protocol`'s build (a dependency) regenerates the C# wire types
# beside the JSON Schema; the node's own build is one bundle, `dist/main.mjs`.
# Through Turbo rather than `pnpm -r`, for the orchestrator image's reason
# (PRD-02 T25): `@ezpug/node...` reaches the manifests through `@ezpug/match-api`,
# and the kit that builds their widgets is a devDependency of the manifests and
# a *peer* of the published package — an edge pnpm counts as a cycle and refuses
# to order, so `pnpm -r` starts the widget build before the kit exists and the
# image cannot be built at all (found by T37's rehearsal, which needed one).
RUN pnpm exec turbo run build --filter=@ezpug/node...

# ── Runtime tree ───────────────────────────────────────────────────────────
FROM build AS deploy
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm deploy --legacy --filter=@ezpug/node --prod /out

# ── node ───────────────────────────────────────────────────────────────────
FROM base AS node
ENV NODE_ENV=production \
    # The identity (`node.json`, the node token, 0600) and `health.json`
    # live on a volume, so a re-created container is still the same node.
    EZPUG_NODE_STATE_DIR=/var/lib/ezpug-node
COPY --from=deploy --chown=node:node /out /app
RUN mkdir -p /var/lib/ezpug-node && chown node:node /var/lib/ezpug-node
VOLUME /var/lib/ezpug-node
ARG EZPUG_GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$EZPUG_GIT_SHA \
      org.opencontainers.image.source=https://github.com/ezpug/ezpug-iron \
      org.opencontainers.image.title=ezpug-iron-node \
      org.opencontainers.image.description="ezpug-node: the EZPug Iron agent that turns a docker host into self-hosted CS2 capacity."
# Never root. The docker socket is the host's and is owned by the host's
# `docker` group: run with `--group-add "$(stat -c %g /var/run/docker.sock)"`
# so uid 1000 may open it (docs/nodes.md), rather than running the agent as
# root for one file descriptor.
USER node
# `health` reads health.json: exit 0 iff the link was up within three
# heartbeat intervals. No port is opened, so nothing else could be asked.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "dist/main.mjs", "health"]
ENTRYPOINT ["node", "dist/main.mjs"]
CMD ["run"]
