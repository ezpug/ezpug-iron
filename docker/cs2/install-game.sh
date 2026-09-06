#!/bin/bash
# Install (or update, or validate) the CS2 dedicated server — app 730 — into the
# volume the container runs from (PRD-02 T10). This is the one download in the
# whole repo and it happens **once**, by hand:
#
#   pnpm cs2:install                 # first time, or to update
#   pnpm cs2:install --validate      # re-check every file (slow, use after a crash)
#
# It is a separate entrypoint on purpose. A server that installs its own game at
# boot is a server that downloads 67 GB on a Saturday because a volume was
# pruned; the entrypoint refuses to start instead, and says this command.
set -euo pipefail

ROOT="${EZPUG_CS2_ROOT:-/serverdata/serverfiles}"
STEAMCMD="${EZPUG_CS2_STEAMCMD:-/opt/steamcmd}"
APP_ID=730

log() { printf '\033[36m[ezpug-cs2]\033[0m %s\n' "$*"; }

validate=''
for argument in "$@"; do
  case "$argument" in
    --validate) validate='validate' ;;
    *) printf '[ezpug-cs2] error: unknown argument %s (--validate)\n' "$argument" >&2; exit 1 ;;
  esac
done

log "installing Counter-Strike 2 (app ${APP_ID}) into ${ROOT}"
log 'this is roughly 67 GB installed (~71 GB downloaded) and takes a while on a'
log 'first run; it is the only thing EZPug ever downloads at runtime, and it'
log 'lands in the cs2-data volume, never in the repository.'
if [[ -d "$ROOT/game/csgo" ]]; then
  log "an install is already there ($(du -sh "$ROOT" 2>/dev/null | cut -f1)); steamcmd will update it in place"
fi

# `+@sSteamCmdForcePlatformType linux` because the sniper runtime reports itself
# in ways steamcmd occasionally reads as something else; anonymous login is what
# a dedicated server uses for CS2.
"$STEAMCMD/steamcmd.sh" \
  +@sSteamCmdForcePlatformType linux \
  +force_install_dir "$ROOT" \
  +login anonymous \
  +app_update "$APP_ID" ${validate} \
  +quit

[[ -x "$ROOT/game/bin/linuxsteamrt64/cs2" ]] || {
  printf '\033[31m[ezpug-cs2] error:\033[0m steamcmd finished but %s/game/bin/linuxsteamrt64/cs2 is missing\n' "$ROOT" >&2
  exit 1
}

log "done: $(du -sh "$ROOT" 2>/dev/null | cut -f1) in ${ROOT}"
log 'the addons and the cfg set are installed by the entrypoint at every boot —'
log 'run `pnpm cs2:up` next.'
