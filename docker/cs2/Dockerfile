# syntax=docker/dockerfile:1.7
#
# **The CS2 server image** (PRD-02 T10) — `ghcr.io/ezpug/ezpug-iron/cs2`.
# One dedicated Counter-Strike 2 server with everything EZPug needs baked in:
# Metamod, CounterStrikeSharp, the vendored community plugins, `EZPug.Sdk` and
# `EZPug.Core`, and the gamemodes' cfg set. It dials the orchestrator itself
# (`EZPUG_IRON_URL` + `EZPUG_SERVER_TOKEN`, or `game/csgo/ezpug.json`) and needs
# no inbound anything but its own game port.
#
#   pnpm cs2:build                       # the local :dev tag
#   pnpm cs2:install                     # the game itself, once, into the volume
#   pnpm cs2:up                          # run it against the dev orchestrator
#
# Three destinations, one build (decision 16 — nothing is downloaded at boot):
# this image is what `pnpm cs2:up` runs on this box, what ghcr publishes for the
# nodes to start (T11/T34), and where T18 takes the plugin set it uploads to the
# Dathost template from. The **game files are not in the image**: app 730 is
# ~67 GB and lives in the `cs2-data` volume, installed once by
# `docker/cs2/install-game.sh`.
#
# Everything version-shaped here is an `ARG` with a checksum beside it, because
# `docs/pins.md` is the one place a version lives and `scripts/check-pins.mjs`
# reads these lines back (`pnpm lint` fails on a disagreement).

# ── The EZPug plugins ──────────────────────────────────────────────────────
# The same tree `plugins/publish.sh` writes for a hand install: the core plugin,
# the SDK gamemodes under `plugins/disabled/`, one copy of the SDK in
# CounterStrikeSharp's `shared/`, and nothing the runtime already ships. The .NET SDK tag is exactly `plugins/global.json`'s,
# so the image is built by the compiler the tests ran on.
FROM mcr.microsoft.com/dotnet/sdk:10.0.400 AS plugins
WORKDIR /src
# The csproj/props/sln first, so a code-only change re-uses the restore layer.
COPY plugins/global.json plugins/Directory.Build.props plugins/EZPug.sln ./
COPY plugins/EZPug.Sdk/EZPug.Sdk.csproj EZPug.Sdk/
COPY plugins/EZPug.Sdk.Testing/EZPug.Sdk.Testing.csproj EZPug.Sdk.Testing/
COPY plugins/EZPug.Sdk.Tests/EZPug.Sdk.Tests.csproj EZPug.Sdk.Tests/
COPY plugins/EZPug.Core/EZPug.Core.csproj EZPug.Core/
COPY plugins/EZPug.Core.Tests/EZPug.Core.Tests.csproj EZPug.Core.Tests/
COPY plugins/EZPug.PowerupDm/EZPug.PowerupDm.csproj EZPug.PowerupDm/
COPY plugins/EZPug.PowerupDm.Tests/EZPug.PowerupDm.Tests.csproj EZPug.PowerupDm.Tests/
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore EZPug.Core/EZPug.Core.csproj \
    && dotnet restore EZPug.PowerupDm/EZPug.PowerupDm.csproj
COPY plugins/ ./
# `.git` is not in the build context (`.dockerignore`), so the commit arrives
# as a build argument — `pnpm cs2:build` passes it and `build.json` records it.
ARG EZPUG_GIT_SHA=unknown
ENV EZPUG_GIT_SHA=${EZPUG_GIT_SHA}
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    ./publish.sh /out

# ── The vendored community plugins, from their own source ──────────────────
# cs2-retakes and the WeaponPaints fork are source under `plugins/vendor/`, at
# the commits `plugins/vendor/vendored.json` records (`plugins/vendor/README.md`):
# retakes stock, built by its own csproj with its own properties; the fork with
# its data layer patched to read loadouts from the core plugin over the link
# (decision 20, `plugins/vendor/WeaponPaints/PATCHES.md`) and built against our
# pins, which is why this stage follows the one that has EZPug.Sdk. Both land in
# `plugins/disabled/` exactly like MatchZy — installed, never enabled until a
# manifest names it (or, for the fork, until a roster entry carries a loadout).
FROM plugins AS vendorplugins
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    ./vendor/build.sh /vendor-out

# ── The community plugins, stock and pinned ────────────────────────────────
# Downloaded here rather than vendored: Metamod, CounterStrikeSharp, MatchZy and
# the retakes weapon allocator ship binary releases and this repo never patches
# them (the exceptions are cs2-retakes, whose spawn configs we need out of its
# tree, and the WeaponPaints fork, both source under `plugins/vendor/`). Each
# artifact is checked against the SHA-256 recorded in `docs/pins.md` — a URL
# that changed under us is a red build, not a surprise on a Saturday.
FROM debian:bookworm-slim AS vendor
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work

ARG METAMOD_VERSION=2.0.0-git1411
ARG METAMOD_SHA256=e3d4c3d457a1c86a5079e8bd8248a4a00361c7d0a3dce7c7e0c4c45458096649
ARG COUNTER_STRIKE_SHARP_VERSION=1.0.373
ARG COUNTER_STRIKE_SHARP_SHA256=2b9b64069c06c78bbb1ad92d59f165b32c107845c18eb7ca6e5c808a26fb6906
ARG MATCHZY_VERSION=0.8.15
ARG MATCHZY_SHA256=425955d7565df84915dd6002d0a7848546d3859d376cb493f2988ed182586b57
ARG RETAKES_ALLOCATOR_VERSION=3.2.5
ARG RETAKES_ALLOCATOR_SHA256=68e6e8ecfe999e7a09898b17bc33250efb0aa47ff35fb82e4040e9fa871ef24d

# `/out` is overlaid onto `game/csgo` at boot, so it is laid out exactly like it.
RUN mkdir -p /out/addons /out/cfg

# Metamod first: it owns `addons/metamod` and the loader vdf. Its own
# `addons/` is the shape we want, so it extracts straight in.
RUN curl -fsSL -o metamod.tar.gz \
      "https://mms.alliedmods.net/mmsdrop/2.0/mmsource-${METAMOD_VERSION}-linux.tar.gz" \
    && echo "${METAMOD_SHA256}  metamod.tar.gz" | sha256sum -c - \
    && tar -xzf metamod.tar.gz -C /out \
    && rm metamod.tar.gz

# CounterStrikeSharp "with runtime": the loader, its managed API *and* the .NET
# runtime it needs — the steamrt base has none and never will.
RUN curl -fsSL -o css.zip \
      "https://github.com/roflmuffin/CounterStrikeSharp/releases/download/v${COUNTER_STRIKE_SHARP_VERSION}/counterstrikesharp-with-runtime-linux-${COUNTER_STRIKE_SHARP_VERSION}.zip" \
    && echo "${COUNTER_STRIKE_SHARP_SHA256}  css.zip" | sha256sum -c - \
    && unzip -q -o css.zip -d /out \
    && rm css.zip \
    # **`FollowCS2ServerGuidelines: false`** (PRD-02 T27). CounterStrikeSharp
    # refuses to read or write a handful of controller fields while that flag
    # is on, `m_iCompetitiveRanking` and `m_iCompetitiveRankType` among them —
    # the two EZ Rating is drawn with (decision 21), measured on the dev node
    # as `Cannot set or get 'CCSPlayerController::m_iCompetitiveRanking'`. The
    # flag exists because Valve's guidelines ask a server not to alter what a
    # client shows about a player's *Valve* rank; ours draws EZPug's own number
    # on a private league's servers, on a scoreboard nobody mistakes for
    # matchmaking, and writes nothing back to Steam. **The risk is Valve's to
    # take**: a server that flouts the guidelines can be refused a GSLT, which
    # would cost the Dathost half of the fleet its public listing. Turned off
    # here rather than in a hand-written config so every other key stays
    # exactly what the pinned release ships; the `grep` makes an upstream
    # rename a failed build instead of a silent no-op.
    && sed 's/"FollowCS2ServerGuidelines": true/"FollowCS2ServerGuidelines": false/' \
         /out/addons/counterstrikesharp/configs/core.example.json \
         > /out/addons/counterstrikesharp/configs/core.json \
    && grep -q '"FollowCS2ServerGuidelines": false' /out/addons/counterstrikesharp/configs/core.json

# MatchZy, into `plugins/disabled/` — CounterStrikeSharp auto-loads every folder
# directly under `plugins/` and skips `disabled/`, which is exactly the door the
# core plugin's loader opens for the gamemode that names it (decision 16). Its
# `cfg/MatchZy/` set rides along; the plugin ships its own dependencies and they
# stay where upstream put them, because a stock vendor is a stock vendor.
RUN curl -fsSL -o matchzy.zip \
      "https://github.com/shobhit-pathak/MatchZy/releases/download/${MATCHZY_VERSION}/MatchZy-${MATCHZY_VERSION}.zip" \
    && echo "${MATCHZY_SHA256}  matchzy.zip" | sha256sum -c - \
    && unzip -q -o matchzy.zip -d matchzy \
    && mkdir -p /out/addons/counterstrikesharp/plugins/disabled \
    && mv matchzy/addons/counterstrikesharp/plugins/MatchZy \
          /out/addons/counterstrikesharp/plugins/disabled/MatchZy \
    && cp -a matchzy/cfg/. /out/cfg/ \
    && rm -rf matchzy matchzy.zip

# The retakes weapon allocator (`docs/pins.md` says why this fork): a release
# zip laid out exactly like the tree it extracts into, plus the gamedata file
# PanoramaManager reads its signatures from. `RetakesPluginShared.dll` is
# dropped from its folder because the retakes build below puts the one copy in
# `shared/`, and the contract the two find each other through
# (`RetakesPluginEventSenderCapability`) has to be one assembly — the same rule
# `plugins/publish.sh` states for `EZPug.Sdk`.
RUN curl -fsSL -o allocator.zip \
      "https://github.com/Ravid-A/cs2-retakes-weapon-allocator/releases/download/v${RETAKES_ALLOCATOR_VERSION}/RetakesAllocator-v${RETAKES_ALLOCATOR_VERSION}.zip" \
    && echo "${RETAKES_ALLOCATOR_SHA256}  allocator.zip" | sha256sum -c - \
    && unzip -q -o allocator.zip -d allocator \
    && mv allocator/addons/counterstrikesharp/plugins/RetakesAllocator \
          /out/addons/counterstrikesharp/plugins/disabled/RetakesAllocator \
    && rm -f /out/addons/counterstrikesharp/plugins/disabled/RetakesAllocator/RetakesPluginShared.dll \
    && mkdir -p /out/addons/counterstrikesharp/gamedata \
    && cp -a allocator/addons/counterstrikesharp/gamedata/. /out/addons/counterstrikesharp/gamedata/ \
    && rm -rf allocator allocator.zip

# cs2-retakes with its shared contract, and the WeaponPaints fork with its
# `gamedata/weaponpaints.json`, built from the vendored source by the
# `vendorplugins` stage. No MySQL anywhere in here: the fork's loadouts come
# over the link (T28). A plugin folder that is not there is still handled — the
# core plugin's loader warns and skips, and an assignment naming a plugin the
# server does not have is refused by the orchestrator before it is ever sent (T6).
COPY --from=vendorplugins /vendor-out/addons/ /out/addons/

# The EZPug tree last, so it wins over anything a vendor put in `shared/`.
COPY --from=plugins /out/addons/ /out/addons/

# ── The server ─────────────────────────────────────────────────────────────
# The Steam Linux Runtime 3.0 "sniper" platform is the environment Valve builds
# the CS2 dedicated server against; pinned by digest, because
# `latest-container-runtime-depot` is a moving tag and a game server that ran
# yesterday has to run today.
FROM registry.gitlab.steamos.cloud/steamrt/sniper/platform:latest-container-runtime-depot@sha256:8cd1bdfc418afd8b019a69d6f5a9305865a5f3bb5554102006fdb8f6853d5f67 AS cs2

ENV EZPUG_CS2_HOME=/serverdata \
    EZPUG_CS2_ROOT=/serverdata/serverfiles \
    EZPUG_CS2_STEAMCMD=/opt/steamcmd \
    EZPUG_CS2_IMAGE_DIR=/opt/ezpug \
    HOME=/serverdata \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

# steamcmd is 32-bit and the game's own libraries come from the volume, so both
# multilib and the runtime's loader path are needed. `procps` is there so an
# operator can see what is running inside the container at all.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl locales procps lib32gcc-s1 lib32stdc++6 lib32z1 \
    && echo 'en_US.UTF-8 UTF-8' > /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

# Never root — the game runs as `steam` (uid 1000). The directories are created
# here and owned here, which is also what gives a *fresh* named volume the right
# ownership: docker seeds an empty volume from the image's directory.
RUN useradd --create-home --home-dir "${EZPUG_CS2_HOME}" --shell /bin/bash --uid 1000 steam \
    && mkdir -p "${EZPUG_CS2_ROOT}" "${EZPUG_CS2_STEAMCMD}" "${EZPUG_CS2_HOME}/.steam/sdk64" \
    && chown -R steam:steam "${EZPUG_CS2_HOME}" "${EZPUG_CS2_STEAMCMD}"

# steamcmd updates itself on every run, so there is no version to pin: what the
# image carries is the bootstrap Valve publishes at one unversioned URL.
#
# The first run is done here, as `steam`, for two reasons. steamcmd self-updates
# on its first run, and that run is what writes `linux64/steamclient.so` — the
# Steam client library a dedicated server dlopens from `~/.steam/sdk64` and
# **exits 0 right after loading its plugins without**, which reads as a clean
# shutdown and, under a restart policy, as a silent boot loop. Doing it at build
# time means the image carries it and a boot still downloads nothing
# (decision 16). As `root` it fails outright ("Failed to load steamconsole.so"),
# so it runs as the user that will run the server.
RUN curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz \
      | tar -xz -C "${EZPUG_CS2_STEAMCMD}" \
    && chown -R steam:steam "${EZPUG_CS2_STEAMCMD}" \
    && su -s /bin/bash steam -c "${EZPUG_CS2_STEAMCMD}/steamcmd.sh +quit" \
    && test -f "${EZPUG_CS2_STEAMCMD}/linux64/steamclient.so"

# What the server is: the addons overlay and the cfg set, both copied onto the
# volume at every boot so the image is the truth and a hand-edit on the volume
# never survives a restart unnoticed.
COPY --from=vendor --chown=steam:steam /out/ ${EZPUG_CS2_IMAGE_DIR}/
COPY --chown=steam:steam gamemodes/ ${EZPUG_CS2_IMAGE_DIR}/gamemodes/
COPY --chown=steam:steam docker/cs2/entrypoint.sh docker/cs2/install-game.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/install-game.sh

ARG EZPUG_GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$EZPUG_GIT_SHA \
      org.opencontainers.image.source=https://github.com/ezpug/ezpug-iron \
      org.opencontainers.image.title=ezpug-iron-cs2 \
      org.opencontainers.image.description="A CS2 dedicated server with Metamod, CounterStrikeSharp, the vendored plugins and EZPug.Core baked in."

USER steam
WORKDIR ${EZPUG_CS2_ROOT}
# The game port (UDP, and TCP for `-usercon`) and GOTV's. Nothing else listens;
# the link to the orchestrator is outbound (decision 5).
EXPOSE 27415/udp 27415/tcp 27420/udp
# "Is the game up": the one process this container exists to run. The start
# period is generous because the first map load off a cold volume is slow.
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=3 \
    CMD pgrep -x cs2 > /dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
