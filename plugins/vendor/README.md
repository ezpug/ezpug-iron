# Vendored community plugins

Third-party CounterStrikeSharp plugins this repo ships **in the server image** and keeps
here **as source** at a pinned tag: today [cs2-retakes](https://github.com/B3none/cs2-retakes),
with the WeaponPaints fork to come (PRD-02 T28).

Source is the exception, not the rule. A vendor that publishes a release binary is
downloaded and checksummed in `docker/cs2/Dockerfile` and none of it is in this repo —
MatchZy and the retakes weapon allocator are pinned that way. cs2-retakes is here because
we need something out of its *tree* rather than out of its build: the per-map spawn
configs under `RetakesPlugin/map_config/`, which its csproj does not copy to the output.

The folder is upstream's tree **verbatim**, minus `.git`. It is stock, pinned and never
patched — the one exception in the whole repo is the WeaponPaints data layer (decision 20),
and it is not here yet. That is why a diff of it against its tag is empty, and why `plugins/vendor/Directory.Build.props` exists: MSBuild stops at
the first `Directory.Build.props` above a project, so that empty file keeps
`plugins/Directory.Build.props` — our target framework, our CounterStrikeSharp pin,
`TreatWarningsAsErrors` — away from somebody else's source.

None of it is in `plugins/EZPug.sln`, so `pnpm verify` never builds it.
`plugins/vendor/build.sh` does, and `docker/cs2/Dockerfile` is what calls that.

| Folder | Upstream | Pin | Licence |
| ------ | -------- | --- | ------- |
| `cs2-retakes/` | B3none/cs2-retakes | `3.1.0` | GPL-3.0 (`cs2-retakes/LICENSE`, kept verbatim) |

`vendored.json` beside this file is the machine-readable version of that table — repo,
tag, commit and the line in the source that carries the version — and
`scripts/check-pins.mjs` holds it against `docs/pins.md` on every `pnpm lint`.

## Why this allocator, and why it is not in here

cs2-retakes allocates weapons itself (`EnableFallbackAllocation`) and its README lists
three standalone allocators that do it better.
[Ravid's](https://github.com/Ravid-A/cs2-retakes-weapon-allocator) is picked because it is
the only one built against what we actually run: `net10.0` and CounterStrikeSharp.API
**1.0.373**, the exact number in `docs/pins.md`, against `RetakesPluginShared` 2.0.0, which
is the contract cs2-retakes 3.1.0 publishes. Yoni's — the original, which this one forks —
is at API 1.0.315 and `net8.0` and has not moved since mid-2025; fifty-eight API releases
of drift is the failure mode `docs/pins.md` exists to prevent.

Its **release zip** is what the image takes (`docker/cs2/Dockerfile`,
`RETAKES_ALLOCATOR_VERSION`), and its source is deliberately not vendored here: the
repository carries no licence file. Its ancestor is GPL-3.0, so the code almost certainly
is too, but "almost certainly" is not a licence to copy somebody's source into a public
repo — and the zip is upstream's own build of the same tree, laid out exactly like the
folder it extracts into, so there is nothing to gain by building it ourselves.

Two things about it are worth knowing before reading its log:

- **Its loadout menu needs a workshop addon we do not ship.** The menu is a Panorama
  layout, which lives on the *client*; upstream distributes it as a workshop item through
  MultiAddonManager. Without it the plugin says so at load and allocates weapons anyway,
  which is all EZPug asks of it — a player's choices are the platform's business, over a
  widget (decision 17), not a menu in the game.
- **It keeps weapon preferences in SQLite by default**, one file in its own plugin folder.
  Nothing in this repo runs a database for it and nothing configures MySQL for it
  ("no MySQL in the image").
- **It throws once per disconnect at load** (`Votes_OnPlayerDisconnect`, `player.UserId!.Value`
  on a controller that has none — seen twice on the dev node when the level change kicked
  the boot map's bots). CounterStrikeSharp catches it and the match is unaffected; it is
  upstream's to fix and this repo does not patch vendors.

## Re-vendoring one

```sh
rm -rf plugins/vendor/<dir>
git clone --depth 1 --branch <tag> <repo> plugins/vendor/<dir>
rm -rf plugins/vendor/<dir>/.git
```

Then `vendored.json`, then the row in `docs/pins.md`, in the same commit (`pnpm lint`
fails otherwise), then `pnpm cs2:build` and the mode's recorded lane — a vendor bump that
moves a wire shape is a `@ezpug/match-api` release, not a silent edit (decision 24).
Bumping one of the *binary* vendors is the same walk with the version and its checksum in
`docker/cs2/Dockerfile` as the home.
