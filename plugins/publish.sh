#!/usr/bin/env bash
# Build the EZPug plugins and lay them out the way a CounterStrikeSharp server installs
# them (plugins/README.md). The server image (PRD-02 T10) and the Dathost template script
# (T18) both take this tree, so there is one build and two destinations.
#
#   plugins/publish.sh [out-dir]      default: plugins/dist
#
# What lands where, and why only these files:
#   addons/counterstrikesharp/shared/EZPug.Sdk/EZPug.Sdk.dll   the one copy of the SDK —
#       the contract the core and every gamemode plugin resolve through the host's shared
#       folder, so the host capability (EZPug.Sdk.Hosting) sees one type on both sides
#   addons/counterstrikesharp/plugins/EZPug.Core/               the core plugin's dll,
#       deps.json and pdb — nothing else: CounterStrikeSharp.API and its
#       Microsoft.Extensions.* come from the runtime the server already runs, and a copy
#       beside a plugin would shadow the host's
set -euo pipefail
cd "$(dirname "$0")"

out="${1:-dist}"
css="$out/addons/counterstrikesharp"
rm -rf "$out"
mkdir -p "$css/plugins/EZPug.Core" "$css/shared/EZPug.Sdk" "$css/plugins/disabled"

dotnet build EZPug.Core/EZPug.Core.csproj -c Release --nologo -v quiet
bin="EZPug.Core/bin/Release/net10.0"

cp "$bin/EZPug.Core.dll" "$bin/EZPug.Core.deps.json" "$bin/EZPug.Core.pdb" "$css/plugins/EZPug.Core/"
cp "$bin/EZPug.Sdk.dll" "$bin/EZPug.Sdk.pdb" "$css/shared/EZPug.Sdk/"

# A marker so an operator (and T18's --check) can read what was built without a dll.
sdk_version=$(grep -o '<Version>[^<]*' EZPug.Sdk/EZPug.Sdk.csproj | sed 's/<Version>//')
core_version=$(grep -o '<Version>[^<]*' EZPug.Core/EZPug.Core.csproj | sed 's/<Version>//')
css_version=$(grep -o '<CounterStrikeSharpApiVersion>[^<]*' Directory.Build.props | sed 's/<CounterStrikeSharpApiVersion>//')
printf '{"sdk":"%s","core":"%s","counterStrikeSharp":"%s","commit":"%s"}\n' \
  "$sdk_version" "$core_version" "$css_version" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" \
  > "$css/plugins/EZPug.Core/build.json"

echo "published to $out:"
(cd "$out" && find . -type f | sort)
