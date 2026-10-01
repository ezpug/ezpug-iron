#!/bin/bash
# Inside the HUD build image (PRD-07 T1). `hud/src/cli.ts` is the caller and
# the only one: it decides the mounts and stages the inputs, this runs the
# Windows and Steam programs and decides nothing.
#
#   hud-build.sh tools          fetch (or update) the two Windows depots into /build/depots
#   hud-build.sh compile        compile /src (an addon content folder) into /out
#   hud-build.sh publish        upload /work/item.vdf's item with the Steam session
#   hud-build.sh fetch <id>     download a Workshop item anonymously into /out
#
# Mounts: /serverdata/Steam the session (tools, publish), /build the build
# volume, /cs2 the dev node's install read-only (compile), /src, /out and /work
# from the checkout's .cache. Starts as root for the overlay mount alone;
# steamcmd and the compiler run as `steam`.
set -euo pipefail

STEAMCMD="${EZPUG_HUD_STEAMCMD:-/opt/steamcmd}"
WINDOWS_DEPOT=2347771
TOOLS_DEPOT=2347779
DEPOTS=/build/depots/app_730
ADDON=ezpug_hud
TREE=/build/tree
CONTENT="$TREE/content/csgo_addons/$ADDON"
GAME="$TREE/game/csgo_addons/$ADDON"

log() { printf '\033[36m[hud]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[hud] error:\033[0m %s\n' "$*" >&2; exit 1; }

as_steam() { setpriv --reuid=steam --regid=steam --init-groups env HOME=/serverdata "$@"; }

# What leaves the container belongs to whoever ran `pnpm hud:*`, not to root.
hand_back() { [[ -n "${EZPUG_HUD_OWNER:-}" ]] && chown -R "$EZPUG_HUD_OWNER" "$@" 2>/dev/null || true; }

# SteamCMD names the account in its output. Nothing that leaves this container
# carries the name or the SteamID; the unredacted transcript is deleted.
redact() { sed -e "s/${EZPUG_HUD_STEAM_USER:-<none>}/<account>/g" -e 's/\[U:1:[0-9]*\]/[U:<id>]/g'; }

require_session() {
  [[ -n "${EZPUG_HUD_STEAM_USER:-}" ]] || die 'EZPUG_HUD_STEAM_USER is not set (.env)'
  [[ -f /serverdata/Steam/config/config.vdf ]] \
    || die 'no Steam session in the ezpug-iron-hud-steam volume (docs/hud.md, "The Steam session")'
}

# A run that would have to type a password or a Steam Guard code is over: that
# is the owner's mailbox, never a loop's.
refuse_prompts() {
  if grep -qi 'Steam Guard\|Two-factor\|password:\|Cached credentials not found' "$1"; then
    rm -f "$1"
    die 'Steam wants a password or a Steam Guard code: the session has expired, and logging in again is a human step (docs/hud.md)'
  fi
}

# `download_depot` writes to steamcmd's own content directory whatever
# `force_install_dir` says, so that directory becomes the build volume.
tools() {
  require_session
  mkdir -p /build/depots && chown steam:steam /build/depots
  rm -rf "$STEAMCMD/linux32/steamapps/content"
  mkdir -p "$STEAMCMD/linux32/steamapps"
  ln -s /build/depots "$STEAMCMD/linux32/steamapps/content"
  log "fetching depots ${TOOLS_DEPOT} (Workshop Tools) and ${WINDOWS_DEPOT} (Windows binaries), about 10 GB on a first run"
  local transcript
  transcript="$(mktemp)"
  as_steam "$STEAMCMD/steamcmd.sh" \
    +@sSteamCmdForcePlatformType windows \
    +login "$EZPUG_HUD_STEAM_USER" \
    +download_depot 730 "$TOOLS_DEPOT" \
    +download_depot 730 "$WINDOWS_DEPOT" \
    +quit > "$transcript" 2>&1 || true
  refuse_prompts "$transcript"
  if ! grep -q "Depot download complete.*depot_${TOOLS_DEPOT}" "$transcript" \
    || ! grep -q "Depot download complete.*depot_${WINDOWS_DEPOT}" "$transcript"; then
    grep -i 'error\|failed\|denied' "$transcript" | redact | tail -10 >&2 || true
    rm -f "$transcript"
    die 'a depot did not finish downloading'
  fi
  grep -o 'depot_[0-9]*" (manifest [0-9]*)' "$transcript" | sed 's/" (manifest / /; s/)$//' > /build/depots/manifests.txt || true
  rm -f "$transcript"
  log "depots ready: $(du -sh "$DEPOTS" | cut -f1)"
}

# The tree the compiler runs in: an overlay, so nothing is copied and nothing
# of the node's is written. Top to bottom: the Workshop Tools, the Windows
# binaries, the node's install (read-only) for the 65 GB of common content.
# Writes land in /build/upper, emptied each run. Symlinks are not an option:
# the engine's file system refuses every one (a VPK is "invalid", a gameinfo.gi
# "can't be read") although Wine itself follows them, and hard links cannot
# cross into another volume. Mounting the overlay is why this container gets
# CAP_SYS_ADMIN, and only this container.
assemble() {
  [[ -f "$DEPOTS/depot_${TOOLS_DEPOT}/game/bin/win64/resourcecompiler.exe" ]] \
    || die 'no resourcecompiler.exe in the build volume: run `pnpm hud:build --tools` once'
  [[ -d "$DEPOTS/depot_${WINDOWS_DEPOT}/game/bin/win64" ]] \
    || die "depot ${WINDOWS_DEPOT} is missing from the build volume: run \`pnpm hud:build --tools\`"
  [[ -f /cs2/game/csgo/pak01_dir.vpk ]] || die 'the dev node install is not mounted at /cs2 (pnpm cs2:install)'
  umount "$TREE" 2>/dev/null || true
  rm -rf /build/upper /build/work "$TREE"
  mkdir -p /build/upper /build/work "$TREE"
  mount -t overlay overlay \
    -o "lowerdir=$DEPOTS/depot_${TOOLS_DEPOT}:$DEPOTS/depot_${WINDOWS_DEPOT}:/cs2,upperdir=/build/upper,workdir=/build/work" \
    "$TREE" || die 'could not mount the build tree (the container needs --cap-add SYS_ADMIN)'
  # The node's gameinfo.gi carries Metamod's loader line (docker/cs2/entrypoint.sh);
  # the compiler gets the game's own.
  grep -vF 'csgo/addons/metamod' "$TREE/game/csgo/gameinfo.gi" > /tmp/gameinfo.gi
  cp /tmp/gameinfo.gi "$TREE/game/csgo/gameinfo.gi"
  # **The signature list goes.** `vpk.signatures` comes with the common
  # content, so it is the node's, and the node's install trails the public
  # build whenever nobody has run `pnpm cs2:install` since an update. It then
  # vouches for none of the current Windows depot's `shaders_pc` VPKs, and the
  # compiler stops at "shaders_pc.vpk: Failed to load file (invalid)". The
  # compiler reads the common content only to resolve references; what it
  # writes is in its own format, the current one, which is what clients run.
  rm -f "$TREE/game/bin/win64/vpk.signatures"
  mkdir -p "$CONTENT" "$GAME"
  cp -r /src/. "$CONTENT/"
  cp /src/addoninfo.txt "$GAME/"
  chown -R steam:steam /build/upper /build/work
}

# Z: is Wine's view of /.
winpath() { printf 'Z:%s' "${1//\//\\}"; }

# The compiled name of a source: `.xml` → `.vxml_c`, `.css` → `.vcss_c`, `.vtex` → `.vtex_c`.
compiled_name() {
  case "$1" in
    *.xml) printf '%s.vxml_c' "${1%.xml}" ;;
    *.css) printf '%s.vcss_c' "${1%.css}" ;;
    *.vtex) printf '%s.vtex_c' "${1%.vtex}" ;;
  esac
}

# One source, one compiler run. Success is the compiler's own summary line
# *and* the file on disk. The compiler does not create the folders it writes
# into: without them it says "Failed to write" and still exits 0.
compile_one() {
  local file="$1" rel="${1#"$CONTENT"/}"
  local out log_file="/out/logs/${rel//\//_}.log"
  out="$GAME/$(compiled_name "$rel")"
  mkdir -p "$(dirname "$out")" && chown steam:steam "$(dirname "$out")"
  rm -f "$out"
  as_steam timeout 600 xvfb-run -a wine "$TREE/game/bin/win64/resourcecompiler.exe" -nop4 -f -i "$(winpath "$file")" \
    > "$log_file" 2>&1 || true
  if ! grep -q 'OK: 1 compiled, 0 failed' "$log_file" || [[ ! -s "$out" ]]; then
    grep -v '^X connection' "$log_file" | tail -20 >&2
    die "the compiler did not compile $rel"
  fi
}

compile() {
  assemble
  rm -rf /out/logs /out/panorama && mkdir -p /out/logs
  # Pictures, then styles, then layouts: each compiles against the one before.
  local file
  while IFS= read -r -d '' file; do
    log "compiling ${file#"$CONTENT"/}"
    compile_one "$file"
  done < <(
    find "$CONTENT/panorama/images" -name '*.vtex' -print0 2>/dev/null | sort -z
    find "$CONTENT/panorama/styles" -name '*.css' -print0 | sort -z
    find "$CONTENT/panorama/layout" -name '*.xml' -print0 | sort -z
  )
  as_steam wineserver -k 2>/dev/null || true
  cp -r "$GAME/panorama" /out/
  # What built it, for hud/dist/manifest.json: the compiler's own hash and the
  # depot manifests `tools` recorded.
  {
    printf 'resourcecompiler.exe %s\n' \
      "$(sha256sum "$DEPOTS/depot_${TOOLS_DEPOT}/game/bin/win64/resourcecompiler.exe" | cut -d' ' -f1)"
    cat /build/depots/manifests.txt 2>/dev/null || true
  } > /out/compiler.txt
  umount "$TREE"
  hand_back /out
}

# /work holds item.vdf, content/ and the preview; SteamCMD writes a new item's
# id back into item.vdf, which is how the caller learns it.
publish() {
  require_session
  chown -R steam:steam /work
  local transcript
  transcript="$(mktemp)"
  as_steam "$STEAMCMD/steamcmd.sh" +login "$EZPUG_HUD_STEAM_USER" +workshop_build_item /work/item.vdf +quit \
    > "$transcript" 2>&1 || true
  refuse_prompts "$transcript"
  redact < "$transcript" > /work/steamcmd.txt
  rm -f "$transcript"
  hand_back /work
}

# Anonymous, the way a server or a stranger's client would ask for it.
fetch() {
  local id="${1:?usage: hud-build.sh fetch <id>}"
  rm -rf /tmp/fetch && mkdir -p /tmp/fetch /out/fetch && chown steam:steam /tmp/fetch
  as_steam "$STEAMCMD/steamcmd.sh" +force_install_dir /tmp/fetch +login anonymous \
    +workshop_download_item 730 "$id" +quit > /out/fetch/steamcmd.txt 2>&1 || true
  local item
  for item in "/tmp/fetch/steamapps/workshop/content/730/$id" "$STEAMCMD/linux32/steamapps/workshop/content/730/$id" \
    "/serverdata/steamapps/workshop/content/730/$id"; do
    [[ -d "$item" ]] && cp -r "$item/." /out/fetch/ && break
  done
  hand_back /out
}

case "${1:-}" in
  tools) tools ;;
  compile) compile ;;
  publish) publish ;;
  fetch) shift && fetch "$@" ;;
  *) die 'usage: hud-build.sh tools|compile|publish|fetch <id>' ;;
esac
