#!/bin/bash
# The CS2 container's boot (PRD-02 T10). Three jobs, in order: put the image's
# addons and cfg set onto the volume that holds the game, say where home is,
# and hand the process over to `cs2` so signals and the console reach the game
# and not a shell.
#
# The image is the truth (decision 16): every plugin and every cfg file is
# copied over the volume's copy on each boot, so a server never runs a mix of
# what was baked and what somebody edited in place last week. Nothing is
# downloaded here.
set -euo pipefail

ROOT="${EZPUG_CS2_ROOT:-/serverdata/serverfiles}"
IMAGE_DIR="${EZPUG_CS2_IMAGE_DIR:-/opt/ezpug}"
CSGO="$ROOT/game/csgo"
BINARY="$ROOT/game/bin/linuxsteamrt64/cs2"

GAME_PORT="${EZPUG_IRON_CS2_GAME_PORT:-27415}"
GOTV_PORT="${EZPUG_IRON_CS2_GOTV_PORT:-27420}"
START_MAP="${EZPUG_IRON_CS2_START_MAP:-de_dust2}"

log() { printf '\033[36m[ezpug-cs2]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[ezpug-cs2] error:\033[0m %s\n' "$*" >&2; exit 1; }

# ── The game itself ────────────────────────────────────────────────────────
# It is not in the image: app 730 is ~67 GB and lives in the `cs2-data` volume.
if [[ ! -x "$BINARY" ]]; then
  die "no CS2 install at $ROOT (looked for game/bin/linuxsteamrt64/cs2).
       Install it once into the volume:  pnpm cs2:install
       On a node or a plain docker host:  docker run --rm -v <volume>:/serverdata/serverfiles \\
         --entrypoint install-game.sh <image>"
fi

# ── The addons overlay ─────────────────────────────────────────────────────
log 'installing the addons from the image…'
rm -rf "$CSGO/addons/metamod" "$CSGO/addons/counterstrikesharp" "$CSGO/addons/multiaddonmanager"
mkdir -p "$CSGO/addons"
cp -a "$IMAGE_DIR/addons/." "$CSGO/addons/"

# Metamod loads because gameinfo.gi says so, and a game update rewrites
# gameinfo.gi — so this is checked every boot, not once at install.
gameinfo="$CSGO/gameinfo.gi"
metamod_line='			Game	csgo/addons/metamod'
if [[ -f "$gameinfo" ]] && ! grep -qF 'csgo/addons/metamod' "$gameinfo"; then
  log 'adding the Metamod loader to gameinfo.gi'
  line_number="$(awk '/Game_LowViolence/{print NR; exit}' "$gameinfo")"
  [[ -n "$line_number" ]] || die 'gameinfo.gi has no Game_LowViolence line to anchor Metamod to'
  sed -i "${line_number}a\\$metamod_line" "$gameinfo"
fi

# ── The HUD's addon (PRD-07 T2, docs/hud.md) ───────────────────────────────
# MultiAddonManager is in the overlay asleep: its loader file waits in the
# image, and Metamod loads only what is in `addons/metamod/`, which the copy
# above has just replaced. So a server without `EZPUG_HUD_ADDON` never loads
# it, and says nothing about it here. A server with one loads it at boot, with
# the empty client list of `cfg/multiaddonmanager/multiaddonmanager.cfg`. The id
# reaches a client only when a match asks for the HUD.
hud_addon="${EZPUG_HUD_ADDON:-}"
hud_addon="${hud_addon//[[:space:]]/}"
if [[ -n "$hud_addon" ]]; then
  if [[ "$hud_addon" =~ ^[1-9][0-9]{0,19}$ ]]; then
    cp "$IMAGE_DIR/asleep/metamod/multiaddonmanager.vdf" "$CSGO/addons/metamod/"
    log "hud: addon $hud_addon; MultiAddonManager loads with an empty client list"
  else
    log 'hud: EZPUG_HUD_ADDON is not a Workshop id (digits only); the HUD stays off'
  fi
fi

# ── The cfg set ────────────────────────────────────────────────────────────
# `gamemodes/<id>/cfg/**` is copied by name into `game/csgo/cfg/`, which is what
# a manifest's `cfg: ["ezpug/pug.cfg"]` is relative to. A bind mount of the
# repo's `gamemodes/` wins over the baked copy, so editing a cfg on this box is
# a container restart and not a rebuild.
gamemodes_dir="$IMAGE_DIR/gamemodes"
mkdir -p "$CSGO/cfg"
cp -a "$IMAGE_DIR/cfg/." "$CSGO/cfg/"
modes=()
for manifest in "$gamemodes_dir"/*/manifest.json; do
  [[ -e "$manifest" ]] || continue
  mode="$(basename "$(dirname "$manifest")")"
  modes+=("$mode")
  # A mode with no cfg of its own is normal (a manifest may be cvars only).
  if [[ -d "$(dirname "$manifest")/cfg" ]]; then
    cp -a "$(dirname "$manifest")/cfg/." "$CSGO/cfg/"
  fi
done
log "cfg installed for: ${modes[*]:-none}"

plugins_dir="$CSGO/addons/counterstrikesharp/plugins"
installed=()
for folder in "$plugins_dir"/*/ "$plugins_dir"/disabled/*/; do
  [[ -d "$folder" ]] || continue
  name="$(basename "$folder")"
  [[ "$name" == 'disabled' ]] && continue
  installed+=("$name")
done
log "plugins installed: ${installed[*]:-none}"

# ── Steam's own client libraries ───────────────────────────────────────────
# The server loads them from ~/.steam/sdk64; steamcmd is where they come from.
if [[ -d "${EZPUG_CS2_STEAMCMD:-/opt/steamcmd}/linux64" ]]; then
  mkdir -p "$HOME/.steam/sdk64"
  cp -a "${EZPUG_CS2_STEAMCMD:-/opt/steamcmd}/linux64/." "$HOME/.steam/sdk64/"
fi

# ── Where home is ──────────────────────────────────────────────────────────
# The plugin reads the sidecar itself (`EZPUG_IRON_URL` + `EZPUG_SERVER_TOKEN`
# in the environment, else `game/csgo/ezpug.json`, plugins/README.md); this only
# says which of the two it will find, so a silent unlinked server is impossible
# to miss in the log. The token is never printed — not here, not anywhere.
if [[ -n "${EZPUG_IRON_URL:-}" && -n "${EZPUG_SERVER_TOKEN:-}" ]]; then
  log "link: ${EZPUG_IRON_URL%%\?*} (from the environment)"
elif [[ -f "$CSGO/ezpug.json" ]]; then
  log "link: $(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"?]*\).*/\1/p' "$CSGO/ezpug.json" | head -1) (from game/csgo/ezpug.json)"
else
  log 'link: unlinked — no EZPUG_IRON_URL/EZPUG_SERVER_TOKEN and no ezpug.json.'
  log '      The server runs and the plugin loads; every event is dropped.'
fi

# `-usercon` needs a password or RCON is open to whoever reaches the port. One
# is minted when nobody chose one, and it is not logged (CLAUDE.md, "Secrets
# stay in the process"): set EZPUG_IRON_CS2_RCON_PASSWORD to use RCON by hand.
#
# It goes into a cfg the server execs, **never onto the command line**. The
# engine does strip `+rcon_password` from the line it prints, but
# CounterStrikeSharp echoes the raw command line at boot ("Initializing with
# command line: …"), so a password passed that way lands in `docker logs` and
# `pnpm cs2:logs` in clear whatever this script does — and in `/proc/*/cmdline`
# for anything in the container. A cfg is read once and printed nowhere.
rcon_password="${EZPUG_IRON_CS2_RCON_PASSWORD:-}"
if [[ -z "$rcon_password" ]]; then
  rcon_password="$(head -c 24 /dev/urandom | base64 | tr -d '=+/' )"
  log 'rcon: a password was generated for this boot and not logged (set EZPUG_IRON_CS2_RCON_PASSWORD to choose one)'
fi
# After the cfg set is installed above, so the copy cannot overwrite it.
mkdir -p "$CSGO/cfg/ezpug"
rcon_cfg="$CSGO/cfg/ezpug/rcon.cfg"
install -m 600 /dev/null "$rcon_cfg"
printf 'rcon_password "%s"\n' "$rcon_password" > "$rcon_cfg"

# ── The server ─────────────────────────────────────────────────────────────
# No GSLT: a token is one per running server and the orchestrator leases them
# for Dathost only (T17). Without one CS2 takes LAN connections, which is all
# this box and a venue node ever need.
log "starting CS2 on ${GAME_PORT} (GOTV ${GOTV_PORT}), map ${START_MAP}"
cd "$ROOT"
export LD_LIBRARY_PATH="$ROOT/game/bin/linuxsteamrt64:$ROOT/bin:${LD_LIBRARY_PATH:-}"
# `-disable_workshop_command_filtering` (PRD-05 T1): on a workshop map CS2
# refuses every console command and convar outside a short list, whoever sends
# it ("DISALLOWED WORKSHOP CONVAR: mp_overtime_enable"). On the dev node that
# took MatchZy's live.cfg (overtime, halftime, timeouts, `mp_backup_round_auto`)
# and `tv_enable` on AIM Map. The match went live on the wrong rules, with no
# round backup to restore and no GOTV. Dathost has the same switch
# (`cs2_settings.disable_workshop_command_filtering`) and the provider sets it.
# shellcheck disable=SC2086 -- EZPUG_IRON_CS2_EXTRA_ARGS is deliberately split.
exec "$BINARY" \
  -dedicated \
  -usercon \
  -disable_workshop_command_filtering \
  -ip 0.0.0.0 \
  -port "$GAME_PORT" \
  +exec ezpug/rcon \
  +tv_enable 1 \
  +tv_port "$GOTV_PORT" \
  +sv_hibernate_when_empty 0 \
  +game_type "${EZPUG_IRON_CS2_GAME_TYPE:-0}" \
  +game_mode "${EZPUG_IRON_CS2_GAME_MODE:-1}" \
  +map "$START_MAP" \
  ${EZPUG_IRON_CS2_EXTRA_ARGS:-}
