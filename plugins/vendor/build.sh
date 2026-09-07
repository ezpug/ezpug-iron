#!/usr/bin/env bash
# Build the **vendored community plugins that ship as source** and lay them out
# the way a CounterStrikeSharp server installs them (PRD-02 T23; the
# WeaponPaints fork joins them in T28).
#
#   plugins/vendor/build.sh [out-dir]      default: plugins/vendor/dist
#
# Today that is cs2-retakes and only cs2-retakes: a vendor that publishes a
# release binary is downloaded and checksummed in `docker/cs2/Dockerfile`
# instead (MatchZy, the retakes weapon allocator), which is both less to build
# and less of somebody else's tree to carry.
#
# It lands under `plugins/disabled/`, not `plugins/`: CounterStrikeSharp
# auto-loads every folder directly under `plugins/` and skips `disabled/`,
# which is the door the core plugin's loader opens for the gamemode that names
# it (decision 16). Nothing here is enabled until an assignment asks.
#
# **Stock, pinned, never patched** (docs/pins.md, `plugins/vendor/vendored.json`):
# the source is upstream's tree verbatim and it builds with upstream's own
# properties — `plugins/vendor/Directory.Build.props` is the empty file that
# keeps ours off it. What this script decides is *packaging*, and only once:
# `map_config/` rides along with the plugin. The csproj copies `lang/` to the
# output and not the spawn configs, because upstream ships those from the
# release zip rather than from a build, and a retakes server without them has
# no spawns and no map it can play.
set -euo pipefail
cd "$(dirname "$0")"

out="${1:-dist}"
css="$out/addons/counterstrikesharp"
rm -rf "$out"
mkdir -p "$css/plugins/disabled" "$css/shared"

# Builds RetakesPluginShared with it; both land where their csproj's OutputPath
# says, in an `addons/counterstrikesharp` tree of upstream's own shape. The
# shared contract goes to `shared/` — one assembly, which is how the plugin and
# the allocator find each other through `RetakesPluginEventSenderCapability`.
dotnet build cs2-retakes/RetakesPlugin/RetakesPlugin.csproj -c Release --nologo -v quiet
retakes_out="cs2-retakes/build-output/addons/counterstrikesharp"
cp -a "$retakes_out/plugins/RetakesPlugin" "$css/plugins/disabled/"
cp -a "$retakes_out/shared/RetakesPluginShared" "$css/shared/"
cp -a cs2-retakes/RetakesPlugin/map_config "$css/plugins/disabled/RetakesPlugin/"

echo "vendored plugins published to $out:"
(cd "$out" && find . -type f | sort)
