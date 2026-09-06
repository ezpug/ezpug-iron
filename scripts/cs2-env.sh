#!/usr/bin/env bash
# The dev CS2 server (PRD-02 T10) — the opt-in lane beside the offline dev
# world. `scripts/dev-env.sh` is Postgres and Redis, which every clone needs;
# this is the game, which only the boxes that run matches do.
#
#   ./scripts/cs2-env.sh build      build the image (docker/cs2/Dockerfile)
#   ./scripts/cs2-env.sh install    install/update app 730 into the volume (~67 GB, once)
#   ./scripts/cs2-env.sh up         start the server
#   ./scripts/cs2-env.sh down       stop it (the game install is kept)
#   ./scripts/cs2-env.sh status     is it up, and what is it running
#   ./scripts/cs2-env.sh logs       follow its log
#   ./scripts/cs2-env.sh console    attach to the server console (detach: Ctrl-P Ctrl-Q)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose -f compose.cs2.yaml)
CONTAINER=ezpug-iron-cs2
# The compose project's `name:`; how an install container is found again after
# the shell that started it is gone.
PROJECT=ezpug-iron-cs2

log() { printf '\033[36m[cs2]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[cs2] error:\033[0m %s\n' "$*" >&2; exit 1; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die 'docker is not installed'
  docker compose version >/dev/null 2>&1 || die 'docker compose v2 is required'
}

ensure_env_file() {
  [[ -f .env ]] || { cp .env.example .env; log 'created .env from .env.example'; }
}

# The name of an install container already running against this volume, if any.
# A `docker compose run` container outlives the shell that started it, so the
# usual way to end up with two is entirely undramatic: an install takes an hour,
# a terminal is closed, somebody starts it again. Two steamcmd processes writing
# one install directory corrupt each other's chunks, and the damage only shows
# up much later as a server that will not boot.
# `|| true`: no match is the normal answer, and `grep` says that with a 1 that
# `set -o pipefail` would otherwise take for a failure.
running_install() {
  docker ps --filter "label=com.docker.compose.project=${PROJECT}" \
    --format '{{.Names}}\t{{.Command}}' 2>/dev/null \
    | grep -F 'install-game.sh' | cut -f1 | head -1 || true
}

get_env() {
  node --env-file-if-exists=.env -e "process.stdout.write(process.env['$1'] ?? '$2')"
}

# The image records the commit it was built from; without a checkout it is
# "unknown", which is honest and which is what a CI build overrides.
git_sha() { git rev-parse --short HEAD 2>/dev/null || echo unknown; }

image_name() { node --env-file-if-exists=.env -e \
  "process.stdout.write(process.env.EZPUG_IRON_CS2_IMAGE ?? 'ghcr.io/ezpug/ezpug-iron/cs2:dev')"; }

require_image() {
  docker image inspect "$(image_name)" >/dev/null 2>&1 \
    || die "the image $(image_name) does not exist yet — run \`pnpm cs2:build\`"
}

installed() {
  # The volume holds the game; ask the volume, not the container, so this
  # answers the same whether the server is running or not.
  "${COMPOSE[@]}" run --rm --no-deps --entrypoint /bin/bash cs2 \
    -c 'test -x "${EZPUG_CS2_ROOT}/game/bin/linuxsteamrt64/cs2"' >/dev/null 2>&1
}

cmd_build() {
  require_docker
  ensure_env_file
  log 'building the CS2 image (the plugins are compiled inside it)…'
  EZPUG_GIT_SHA="$(git_sha)" "${COMPOSE[@]}" build
  log 'built. Next: `pnpm cs2:install` if the game is not in the volume yet.'
}

cmd_install() {
  require_docker
  ensure_env_file
  require_image
  local already
  already="$(running_install)"
  [[ -z "$already" ]] || die "an install is already running in ${already}.
       Two steamcmd processes on one volume corrupt each other's download.
       Follow it:  docker logs -f ${already}
       Stop it:    docker rm -f ${already}
       If that one was interrupted, re-run with --validate afterwards."
  local confirm=1 forward=()
  for argument in "$@"; do
    case "$argument" in
      --yes) confirm=0 ;;
      *) forward+=("$argument") ;;
    esac
  done
  log 'about to download Counter-Strike 2 (app 730) into the cs2-data volume.'
  log 'That is roughly 67 GB installed (~71 GB downloaded) and can take hours on a'
  log 'slow line. It happens once; nothing else in this repo downloads anything'
  log 'at runtime.'
  printf '  free on this filesystem: %s\n' "$(df -h "$ROOT" | awk 'NR==2 {print $4}')"
  if [[ "$confirm" == 1 && "${EZPUG_CS2_INSTALL_YES:-}" != '1' ]]; then
    read -r -p '[cs2] download it now? [y/N] ' answer
    [[ "${answer:-}" =~ ^[Yy]$ ]] || die 'install cancelled'
  fi
  # `run` and not `exec`: the install has to work before there is a server to
  # exec into, which is the whole point of it being its own entrypoint.
  "${COMPOSE[@]}" run --rm --no-deps --entrypoint install-game.sh cs2 "${forward[@]}"
}

cmd_up() {
  require_docker
  ensure_env_file
  require_image
  installed || die 'the game is not in the volume yet — run `pnpm cs2:install` first'
  log 'starting the CS2 server…'
  EZPUG_GIT_SHA="$(git_sha)" "${COMPOSE[@]}" up -d
  log "up. Ports $(get_env EZPUG_IRON_CS2_GAME_PORT 27415) (game) and $(get_env EZPUG_IRON_CS2_GOTV_PORT 27420) (GOTV) on this host."
  log 'follow the boot with `pnpm cs2:logs`; the console is `pnpm cs2:console`.'
}

cmd_status() {
  require_docker
  "${COMPOSE[@]}" ps
  echo
  if docker image inspect "$(image_name)" >/dev/null 2>&1; then
    printf '  \033[32mok\033[0m    image %s built\n' "$(image_name)"
  else
    printf '  \033[33m--\033[0m    image %s not built (pnpm cs2:build)\n' "$(image_name)"
    return 0
  fi
  if installed; then
    printf '  \033[32mok\033[0m    game installed in the cs2-data volume\n'
  else
    printf '  \033[33m--\033[0m    game not installed (pnpm cs2:install)\n'
  fi
  if docker ps --filter "name=^${CONTAINER}$" --filter 'status=running' --format '{{.Names}}' | grep -q .; then
    printf '  \033[32mok\033[0m    %s running\n' "$CONTAINER"
    # What the plugin thinks, straight from the horse's mouth. It prints no
    # secret (plugins/README.md), so it is safe in a terminal and in a log.
    docker logs --tail 40 "$CONTAINER" 2>&1 | grep -E '^\[ezpug-cs2\]|EZPug' | sed 's/^/  /' || true
  else
    printf '  \033[33m--\033[0m    %s not running (pnpm cs2:up)\n' "$CONTAINER"
  fi
}

case "${1:-up}" in
  build) cmd_build ;;
  install) shift; cmd_install "$@" ;;
  up) cmd_up ;;
  down) require_docker && "${COMPOSE[@]}" down ;;
  status) cmd_status ;;
  logs) require_docker && "${COMPOSE[@]}" logs -f ;;
  # `attach` and not `exec`: the game reads its console from the process's own
  # stdin, and that is PID 1's, not a new shell's.
  console)
    require_docker
    log 'attaching to the CS2 console — detach with Ctrl-P Ctrl-Q (Ctrl-C stops the server)'
    docker attach "$CONTAINER"
    ;;
  *) die "unknown command '$1' (build | install | up | down | status | logs | console)" ;;
esac
