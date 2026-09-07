# Pins

Every version this repo is fixed to, in one place, with the file that actually holds it.
A pin is a number *and* a home: the number here is a copy for people, the home is what a
build reads. Bumping means editing the home, then this table, in one commit — a check in
`pnpm lint` (`scripts/check-pins.mjs`) refuses a disagreement.

Read this before upgrading anything on a server: CounterStrikeSharp, Metamod and the game
move together, and a community plugin built for an older API surface is the usual reason a
server boots with half its plugins missing.

## The toolchain

| What | Pin | Home |
| ---- | --- | ---- |
| Node | `>=22.19 <23` | `package.json` `engines` |
| pnpm | `10.33.2` | `package.json` `packageManager` (`corepack enable` reads it) |
| .NET SDK | `10.0.400` | `plugins/global.json` (`rollForward: latestFeature`) |
| TypeScript | `~5.9.3` | `pnpm-workspace.yaml` catalog |
| Vitest | `^4.1.11` | `pnpm-workspace.yaml` catalog |
| zod | `^4.4.3` | `pnpm-workspace.yaml` catalog |
| tsdown | `^0.22.14` | `pnpm-workspace.yaml` catalog |
| Hono | `^4.13.3` | `pnpm-workspace.yaml` catalog |
| drizzle-orm | `^0.45.2` | `pnpm-workspace.yaml` catalog (drizzle-kit `^0.31.10` beside it) |
| postgres (postgres.js) | `^3.4.9` | `pnpm-workspace.yaml` catalog |
| ioredis | `^5.9.0` | `pnpm-workspace.yaml` catalog |
| dockerode | `^4.0.12` | `pnpm-workspace.yaml` catalog (`@types/dockerode` `^4.0.1` beside it) — the node agent's docker client (PRD-02 T11); 4.x because 5.x adds a BuildKit client and the gRPC stack behind it for nothing the agent does |
| Node (the image) | `22.19.0-bookworm-slim` | `docker/orchestrator/Dockerfile` and `docker/node/Dockerfile` (`FROM node:…`) — the runtime the orchestrator and node images ship, the version this repo's `engines` allows |
| Postgres | `17` | `compose.yaml` (`postgres:17-alpine`); production's own instance is PRD-02 T35's |
| Redis | `8` | `compose.yaml` (`redis:8-alpine`) |

The catalog mirrors the platform's on 2026-09-05 on purpose: `@ezpug/match-api` must
resolve against the same zod the platform installs (`docs/decisions.md` 24), and the
orchestrator's rails (Drizzle, postgres.js, ioredis) are the versions the platform's
`packages/db` and `apps/api` run, so an idiom ported from there behaves the same here.

## The server side

| What | Pin | Home | Why this one |
| ---- | --- | ---- | ------------ |
| CounterStrikeSharp.API | `1.0.373` | `plugins/Directory.Build.props`, `<CounterStrikeSharpApiVersion>` | the runtime `EZPug.Sdk` and the core plugin load into. `EZPug.Sdk.Tests` asserts the restored assembly carries this number, so a silent NuGet drift fails `pnpm verify` |
| Target framework | `net10.0` | `plugins/Directory.Build.props` | CounterStrikeSharp moved to .NET 10 (LTS) on 2026-05-30; every API package from **1.0.369** on targets `net10.0` only (1.0.368 is the last `net8.0`). Decided in PRD-01 T1 |
| Metamod:Source | `2.0.0-git1411` | `docker/cs2/Dockerfile`, `METAMOD_VERSION` (+ `METAMOD_SHA256`) | the loader CounterStrikeSharp itself needs. The image pins the exact build *and* its checksum, so a rebuild is the same rebuild and a changed artifact is a red build |
| CounterStrikeSharp (the release) | `1.0.373`, `counterstrikesharp-with-runtime-linux` | `docker/cs2/Dockerfile`, `COUNTER_STRIKE_SHARP_VERSION` (+ `COUNTER_STRIKE_SHARP_SHA256`) | the same number as the NuGet row above — `check-pins` holds the two against each other, because a plugin compiled against one API and loaded by another is the failure mode this table exists to prevent. "with runtime" because the steamrt base ships no .NET |
| steamrt sniper (the base image) | `latest-container-runtime-depot@sha256:8cd1bdfc` (truncated; the Dockerfile carries the whole digest) | `docker/cs2/Dockerfile` (`FROM registry.gitlab.steamos.cloud/…`) | the runtime Valve builds the CS2 dedicated server against. Pinned **by digest**: the tag moves, and a server that ran yesterday has to run today |
| steamcmd | unversioned | `docker/cs2/Dockerfile` (the one Valve URL) | it updates itself on every run; there is no version to pin and pretending otherwise would be a lie in this table |

Everything above ships **in the image** (decision 16): one image with every plugin baked
in, the core plugin enabling exactly what a gamemode manifest names. Nothing is downloaded
at boot — the one exception is the game itself, app 730, which is ~67 GB and is installed
once into the `cs2-data` volume by `pnpm cs2:install` (`docker/cs2/install-game.sh`).

The three downloaded artifacts carry a SHA-256 beside their version in the Dockerfile.
Refreshing one after a bump is `curl -fsSL <url> | sha256sum`; a mismatch fails the build
rather than shipping something nobody looked at.

## The vendored community plugins

Pinned, never patched, except the WeaponPaints data layer (decision 20). PRD-02 vendors
them under `plugins/vendor/` and updates the "Vendored at" column with the commit it took.

| Plugin | Pin | Builds against | Vendored at |
| ------ | --- | -------------- | ----------- |
| [MatchZy](https://github.com/shobhit-pathak/MatchZy) | `0.8.15` | CounterStrikeSharp.API 1.0.342, `net8.0` | the release binary, not source: `docker/cs2/Dockerfile`, `MATCHZY_VERSION` (+ `MATCHZY_SHA256`), unzipped into `plugins/disabled/MatchZy/` with its `cfg/MatchZy/` set. The platform's read-only reference checkout is at `ef289d51` ("0.8.15: noclip command fix") |
| [cs2-retakes](https://github.com/B3none/cs2-retakes) | `3.1.0` | CounterStrikeSharp.API 1.0.369, `net10.0` | source, `plugins/vendor/cs2-retakes/` at tag `3.1.0` (commit `157d2bbd`), built by `plugins/vendor/build.sh` into `plugins/disabled/RetakesPlugin/` with its `map_config/` spawn set; `RetakesPluginShared` 2.0.0 goes to `shared/` |
| [cs2-retakes-weapon-allocator](https://github.com/Ravid-A/cs2-retakes-weapon-allocator) | `3.2.5` | CounterStrikeSharp.API 1.0.373, `net10.0`, RetakesPluginShared 2.0.0 | the release binary, not source: `docker/cs2/Dockerfile`, `RETAKES_ALLOCATOR_VERSION` (+ `RETAKES_ALLOCATOR_SHA256`), unzipped into `plugins/disabled/RetakesAllocator/` with the `gamedata/panoramamanager.json` PanoramaManager reads. The one allocator built against the API we actually ship — `plugins/vendor/README.md` says why this fork and not the original, and why its source is not in this repo |
| [cs2-WeaponPaints](https://github.com/Nereziel/cs2-WeaponPaints) | commit `fa8936f3` | CounterStrikeSharp.API 1.0.367, Dapper 2.1.72, MySqlConnector 2.5.0, `net8.0` | not yet — the commit is the platform's recorded one, whose `CREATE TABLE`s the `Loadout` schema mirrors field for field |

A `net8.0` plugin loads unchanged on the .NET 10 runtime CounterStrikeSharp ships, which is
why MatchZy and the WeaponPaints fork stay where upstream put them and only `EZPug.Sdk`
moved; cs2-retakes and its allocator had already moved themselves.

The four downloaded plugin artifacts each carry a SHA-256 beside their version; refreshing
one is `curl -fsSL <url> | sha256sum`.

A vendored *source* tree has a second home, `plugins/vendor/vendored.json` (repo, tag,
commit, and the line of source that carries the version) — that file is what
`scripts/check-pins.mjs` reads, and it checks the version against the source itself, not
against a copy of it. A vendor that publishes a release is pinned like MatchZy instead: a
version and a checksum in the image, and nothing of theirs in our tree.

The WeaponPaints fork is the one exception to "never patched": its data layer takes the
in-memory loadout the core plugin hands it instead of querying MySQL (decision 20). Its
schema stays byte-identical to the pinned commit's — `Loadout` in `@ezpug/match-api` is a
mapping of those tables, so a plugin bump means re-reading `Utility.cs` and, if a column
moved, a Match API release.

## Bumping one

1. Edit the **home** — `Directory.Build.props`, `global.json`, the catalog, the image
   script. Never this file alone.
2. Edit the row here in the same commit; `pnpm lint` fails otherwise.
3. `pnpm verify`. For a CounterStrikeSharp bump that is also `EZPug.Sdk.Tests` proving the
   restored assembly matches, and for a plugin bump it is the vendored source building
   against the pinned API.
4. A vendor bump that moves a wire shape (a MatchZy event field, a WeaponPaints column) is
   a `@ezpug/match-api` release with a changelog line, not a silent edit (decision 24).
