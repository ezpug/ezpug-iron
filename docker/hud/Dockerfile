# syntax=docker/dockerfile:1.7
#
# **The HUD's build image** (PRD-07 T1) — `ezpug-iron/hud-build:dev`, local only.
# Valve's resource compiler is a Windows program, and this box gains no packages
# for it: Wine, Xvfb and SteamCMD live here, and `scripts/hud.mjs` is the only
# thing that runs this image.
#
#   pnpm hud:build        compile hud/ into hud/dist/ (builds this image first)
#
# Nothing of the game is in the image. Three volumes are mounted at run time:
#
# - `ezpug-iron-hud-steam` at `/serverdata/Steam`: the Steam session, logged in
#   by hand once. The same path the CS2 image's steamcmd uses, so one session
#   serves both, and the account's name arrives as an environment value.
# - `ezpug-iron-hud-build` at `/build`: the Windows build of CS2 (depot 2347771)
#   and the Workshop Tools (depot 2347779), about 10 GB, plus the assembled
#   tree the compiler runs in. `docs/hud.md` says how to delete it.
# - `ezpug-iron-cs2_cs2-data` at `/cs2` **read-only**: the dev node's install,
#   whose common content (depot 2347770) the compiler reads instead of a second
#   65 GB copy.
#
# Debian trixie for Wine 10.0, pinned by digest like every base in this repo.
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

ENV HOME=/serverdata \
    EZPUG_HUD_STEAMCMD=/opt/steamcmd \
    WINEPREFIX=/opt/wineprefix \
    WINEARCH=win64 \
    WINEDEBUG=-all \
    WINEDLLOVERRIDES="mscoree,mshtml=" \
    LANG=C.UTF-8

# `wine64` alone is enough for a 64-bit compiler, so the image needs no i386
# architecture; steamcmd is 32-bit and takes the multilib runtime instead.
# `xauth` because `xvfb-run` needs it to hand the display to its child.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl wine wine64 xvfb xauth lib32gcc-s1 lib32stdc++6 procps util-linux \
    && rm -rf /var/lib/apt/lists/*

# uid 1000, home `/serverdata`, exactly the CS2 image's `steam`: the session
# volume was written by that user and is read back by this one.
RUN useradd --create-home --home-dir "${HOME}" --shell /bin/bash --uid 1000 steam \
    && mkdir -p "${EZPUG_HUD_STEAMCMD}" "${WINEPREFIX}" /build /out \
    && chown -R steam:steam "${HOME}" "${EZPUG_HUD_STEAMCMD}" "${WINEPREFIX}" /build /out

# Valve's one unversioned bootstrap, as in `docker/cs2/Dockerfile`; it updates
# itself on its first run, which happens here so a build downloads only depots.
RUN curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz \
      | tar -xz -C "${EZPUG_HUD_STEAMCMD}" \
    && chown -R steam:steam "${EZPUG_HUD_STEAMCMD}" \
    && su -s /bin/bash steam -c "${EZPUG_HUD_STEAMCMD}/steamcmd.sh +quit" >/dev/null

# The Wine prefix is made once, in the image: `wineboot` takes a minute and
# writes nothing a build needs to keep.
USER steam
RUN xvfb-run -a wineboot --init && wineserver -w && test -f "${WINEPREFIX}/system.reg"

# The entrypoint starts as root for one reason, the overlay mount
# (`hud-build.sh`), and runs steamcmd and the compiler as `steam`.
USER root
COPY docker/hud/hud-build.sh /usr/local/bin/hud-build.sh
WORKDIR /build
ENTRYPOINT ["/usr/local/bin/hud-build.sh"]
