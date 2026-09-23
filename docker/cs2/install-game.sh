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
update() {
  "$STEAMCMD/steamcmd.sh" \
    +@sSteamCmdForcePlatformType linux \
    +force_install_dir "$ROOT" \
    +login anonymous \
    +app_update "$APP_ID" "$@" \
    +quit
}

# **An install Steam no longer serves a delta from** (PRD-04 T11a). To update a
# depot, steamcmd first fetches the manifest of the build that is installed, to
# diff against. Steam hands an anonymous login the request code for a manifest
# only while a branch still carries it, and Valve prunes the versioned branches
# (`1.41.7.8` went in September 2026). So an install that fell a few releases
# behind gets "Failed to get manifest request code, 'Access Denied'" for its own
# manifests, the update ends `state is 0x6`, and `--validate` alone does not help,
# because it asks for the same old manifests. Forgetting those depots in the app
# manifest and validating makes steamcmd check the files on disk against the new
# manifest instead: the same download a delta would have been, give or take.
content_log="$HOME/Steam/logs/content_log.txt"
seen="$(wc -l < "$content_log" 2>/dev/null || echo 0)"
if ! update ${validate}; then
  refused="$(tail -n "+$((seen + 1))" "$content_log" 2>/dev/null \
    | sed -n "s/.*Depot: \([0-9]*\), Manifest: [0-9]*, branch: [^)]*): Failed to get manifest request code, 'Access Denied'.*/\1/p" \
    | sort -u | tr '\n' ' ')"
  acf="$ROOT/steamapps/appmanifest_${APP_ID}.acf"
  [[ -n "$refused" && -f "$acf" ]] || {
    printf '\033[31m[ezpug-cs2] error:\033[0m steamcmd failed; its log is %s\n' "$content_log" >&2
    exit 1
  }
  log "Steam refused the installed manifests of depots ${refused}(a build no branch carries any more)."
  log 'forgetting them in the app manifest and validating the files against the new build instead'
  cp "$acf" "$acf.before-revalidate"
  for depot in $refused; do
    # Only the entry under "InstalledDepots": `"<depot>" { "manifest" … "size" … }`.
    perl -0 -i -pe 's/("InstalledDepots"\n\t\{(?:(?!\n\t\}).)*?)\n\t\t"'"$depot"'"\n\t\t\{[^}]*\}/$1/s' "$acf"
  done
  update validate || {
    printf '\033[31m[ezpug-cs2] error:\033[0m steamcmd failed again; its log is %s\n' "$content_log" >&2
    printf '        the app manifest before the edit is %s\n' "$acf.before-revalidate" >&2
    exit 1
  }
  rm -f "$acf.before-revalidate"
fi

[[ -x "$ROOT/game/bin/linuxsteamrt64/cs2" ]] || {
  printf '\033[31m[ezpug-cs2] error:\033[0m steamcmd finished but %s/game/bin/linuxsteamrt64/cs2 is missing\n' "$ROOT" >&2
  exit 1
}

log "done: $(du -sh "$ROOT" 2>/dev/null | cut -f1) in ${ROOT}"
log 'the addons and the cfg set are installed by the entrypoint at every boot —'
log 'run `pnpm cs2:up` next.'
