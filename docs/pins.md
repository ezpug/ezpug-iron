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
| Node (the image) | `22.19.0-bookworm-slim` | `docker/orchestrator/Dockerfile` (`FROM node:…`) — the runtime the orchestrator image ships, the version this repo's `engines` allows |
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
| Metamod:Source | `2.0`, build `git1411` | not vendored yet — PRD-02's image script | the loader CounterStrikeSharp itself needs. The image pins the exact build so a rebuild is reproducible |

Everything above ships **in the image** (decision 16): one image with every plugin baked
in, the core plugin enabling exactly what a gamemode manifest names. Nothing is downloaded
at boot.

## The vendored community plugins

Pinned, never patched, except the WeaponPaints data layer (decision 20). PRD-02 vendors
them under `plugins/vendor/` and updates the "Vendored at" column with the commit it took.

| Plugin | Pin | Builds against | Vendored at |
| ------ | --- | -------------- | ----------- |
| [MatchZy](https://github.com/shobhit-pathak/MatchZy) | `0.8.15` | CounterStrikeSharp.API 1.0.342, `net8.0` | not yet — the platform's read-only reference checkout is at `ef289d51` ("0.8.15: noclip command fix") |
| [cs2-retakes](https://github.com/B3none/cs2-retakes) | `3.1.0` | `net8.0` | not yet |
| [cs2-WeaponPaints](https://github.com/Nereziel/cs2-WeaponPaints) | commit `fa8936f3` | CounterStrikeSharp.API 1.0.367, Dapper 2.1.72, MySqlConnector 2.5.0, `net8.0` | not yet — the commit is the platform's recorded one, whose `CREATE TABLE`s the `Loadout` schema mirrors field for field |

A `net8.0` plugin loads unchanged on the .NET 10 runtime CounterStrikeSharp ships, which is
why these three stay where upstream put them and only `EZPug.Sdk` moved.

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
