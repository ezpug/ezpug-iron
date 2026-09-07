#!/usr/bin/env bash
# Build the **vendored community plugins that ship as source** and lay them out
# the way a CounterStrikeSharp server installs them (PRD-02 T23, T28).
#
#   plugins/vendor/build.sh [out-dir]      default: plugins/vendor/dist
#
# That is cs2-retakes and the WeaponPaints fork: a vendor that publishes a
# release binary is downloaded and checksummed in `docker/cs2/Dockerfile`
# instead (MatchZy, the retakes weapon allocator), which is both less to build
# and less of somebody else's tree to carry.
#
# It lands under `plugins/disabled/`, not `plugins/`: CounterStrikeSharp
# auto-loads every folder directly under `plugins/` and skips `disabled/`,
# which is the door the core plugin's loader opens for the gamemode that names
# it (decision 16). Nothing here is enabled until an assignment asks.
#
# **Stock, pinned, never patched** (docs/pins.md, `plugins/vendor/vendored.json`)
# for cs2-retakes: the source is upstream's tree verbatim and it builds with
# upstream's own properties — `plugins/vendor/Directory.Build.props` is the
# empty file that keeps ours off it. What this script decides is *packaging*,
# and only once: `map_config/` rides along with the plugin. The csproj copies
# `lang/` to the output and not the spawn configs, because upstream ships those
# from the release zip rather than from a build, and a retakes server without
# them has no spawns and no map it can play.
#
# **The one exception** is the WeaponPaints fork (decision 20): its data layer
# is patched to read loadouts from the core plugin over the link, every patch is
# listed in `WeaponPaints/PATCHES.md`, and its csproj imports our properties on
# purpose because it references EZPug.Sdk. `pnpm verify` builds and tests it as
# part of `EZPug.sln`; this script only lays it out.
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

# The WeaponPaints fork, laid out like MatchZy's release: the plugin's own files,
# its `lang/`, the English item catalogue under `data/` and Newtonsoft.Json —
# the one dependency CounterStrikeSharp's runtime does not ship (MatchZy carries
# its own copy for the same reason). `CounterStrikeSharp.API.dll` and the
# `Microsoft.Extensions.*` assemblies the build also emits are the runtime's and
# stay out, as `plugins/publish.sh` says; so does `EZPug.Sdk.dll`, which
# `Private=false` already keeps out of the build output — the one copy in
# `shared/` is the type the core plugin published the capability under. The
# gamedata file goes where the allocator's does, next to the plugins folder,
# because that is where the plugin looks for it.
dotnet build WeaponPaints/WeaponPaints.csproj -c Release --nologo -v quiet
wp_bin="WeaponPaints/bin/Release/net10.0"
wp_out="$css/plugins/disabled/WeaponPaints"
mkdir -p "$wp_out" "$css/gamedata"
cp "$wp_bin/WeaponPaints.dll" "$wp_bin/WeaponPaints.deps.json" "$wp_bin/WeaponPaints.pdb" "$wp_bin/Newtonsoft.Json.dll" "$wp_out/"
cp -a "$wp_bin/lang" "$wp_bin/data" "$wp_out/"
cp WeaponPaints/gamedata/weaponpaints.json "$css/gamedata/"
test ! -e "$wp_out/EZPug.Sdk.dll"

echo "vendored plugins published to $out:"
(cd "$out" && find . -type f | sort)
