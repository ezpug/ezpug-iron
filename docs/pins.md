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
| Vue | `^3.5.41` | `pnpm-workspace.yaml` catalog — the runtime inside every widget bundle (`gamemode-kit`, PRD-02 T25); the platform's `packages/ui` runs the same major, so the page and the frame agree on it (`vue-tsc` `^3.3.11` beside it) |
| Vite | `^8.2.2` | `pnpm-workspace.yaml` catalog — the kit's library build and its dev harness (`@vitejs/plugin-vue` `^6.0.8` beside it); the platform's version, on purpose |
| dockerode | `^4.0.12` | `pnpm-workspace.yaml` catalog (`@types/dockerode` `^4.0.1` beside it) — the node agent's docker client (PRD-02 T11); 4.x because 5.x adds a BuildKit client and the gRPC stack behind it for nothing the agent does |
| Node (the image) | `22.19.0-bookworm-slim` | `docker/orchestrator/Dockerfile` and `docker/node/Dockerfile` (`FROM node:…`) — the runtime the orchestrator and node images ship, the version this repo's `engines` allows |
| Postgres | `17` | `compose.yaml` and `compose.prod.yaml` (`postgres:17-alpine`) — the dev world's and production's own instance, on the same major so a dump moves between them |
| Redis | `8` | `compose.yaml` and `compose.prod.yaml` (`redis:8-alpine`) |

The catalog mirrors the platform's on 2026-09-05 on purpose: `@ezpug/match-api` must
resolve against the same zod the platform installs (`docs/decisions.md` 24), and the
orchestrator's rails (Drizzle, postgres.js, ioredis) are the versions the platform's
`packages/db` and `apps/api` run, so an idiom ported from there behaves the same here.

## The server side

| What | Pin | Home | Why this one |
| ---- | --- | ---- | ------------ |
| CounterStrikeSharp.API | `1.0.376` | `plugins/Directory.Build.props`, `<CounterStrikeSharpApiVersion>` | the runtime `EZPug.Sdk` and the core plugin load into. `EZPug.Sdk.Tests` asserts the restored assembly carries this number, so a silent NuGet drift fails `pnpm verify` |
| Target framework | `net10.0` | `plugins/Directory.Build.props` | CounterStrikeSharp moved to .NET 10 (LTS) on 2026-05-30; every API package from **1.0.369** on targets `net10.0` only (1.0.368 is the last `net8.0`). Decided in PRD-01 T1 |
| Metamod:Source | `2.0.0-git1469` | `docker/cs2/Dockerfile`, `METAMOD_VERSION` (+ `METAMOD_SHA256`) | the loader CounterStrikeSharp itself needs. CounterStrikeSharp 1.0.375 and 1.0.376 need Metamod plugin API 18, and git1411 has 17 ("Plugin requires newer Metamod version (18 > 17)", PRD-05 T2f), so the two move together. git1469 is commit `16d692c7`, one past the `fa6f80e4` (git1468) that both releases' `libraries/metamod-source` name, and it bumps KHook. git1468 hung in 6 of 9 boots on the dev node before CounterStrikeSharp printed a line: the main thread waited on a `pthread_rwlock_wrlock` while KHook's two worker threads slept. git1469 booted 12 of 12, in 4 to 8 s each. Boot a bump several times before you trust it. The image pins the exact build *and* its checksum, so a rebuild is the same rebuild and a changed artifact is a red build |
| CounterStrikeSharp (the release) | `1.0.376`, `counterstrikesharp-with-runtime-linux` | `docker/cs2/Dockerfile`, `COUNTER_STRIKE_SHARP_VERSION` (+ `COUNTER_STRIKE_SHARP_SHA256`) | the same number as the NuGet row above — `check-pins` holds the two against each other, because a plugin compiled against one API and loaded by another is the failure mode this table exists to prevent. "with runtime" because the steamrt base ships no .NET. **It follows the game.** CounterStrikeSharp calls into CS2 through offsets and signatures that a game update can move, and the game in the volume updates on its own. 1.0.375 is upstream's fix for CS2 1.41.8.2 (2026-09-23). Under 1.0.373, that update moved `CBaseEntity_Teleport`, and every retakes server segfaulted at its first round (PRD-05 T2f). 1.0.376 (2026-09-27) carries #1434, without which every `{s:…}` dialog variable of a custom HUD layout stays blank once a player has taken the slot (PRD-07 T2), and the schema for CS2 1.41.8.4. A console that says `Failed to find signature` at boot is the early warning |
| steamrt sniper (the base image) | `latest-container-runtime-depot@sha256:8cd1bdfc` (truncated; the Dockerfile carries the whole digest) | `docker/cs2/Dockerfile` (`FROM registry.gitlab.steamos.cloud/…`) | the runtime Valve builds the CS2 dedicated server against. Pinned **by digest**: the tag moves, and a server that ran yesterday has to run today |
| Debian `bullseye-security` (the base's apt suite) | snapshot `20260801T000000Z` | `docker/cs2/Dockerfile`, `DEBIAN_SECURITY_SNAPSHOT` | the pinned base is Debian 11 and still names `deb.debian.org/debian-security`, whose pool lost the packages its index lists (404 on `libc6-i386 2.31-13+deb11u14`, 2026-09-19) before `archive.debian.org` took the suite. `snapshot.debian.org` is the same signed archive frozen on a day index and pool agreed, with the exact `libc6-i386` the base's `libc6` demands |
| steamcmd | unversioned | `docker/cs2/Dockerfile` (the one Valve URL) | it updates itself on every run; there is no version to pin and pretending otherwise would be a lie in this table. The game it installs is not pinned either, but `rush` has a floor: `rush_001`, its script and `gamemode_rush.cfg` arrived with the Rush update (2026-09-22), measured on the dev node's CS2 1.41.8.2 under `game_type 0` / `game_mode 6` (PRD-06, decision 33) |

Everything above ships **in the image** (decision 16): one image with every plugin baked
in, the core plugin enabling exactly what a gamemode manifest names. Nothing is downloaded
at boot — the one exception is the game itself, app 730, which is ~67 GB and is installed
once into the `cs2-data` volume by `pnpm cs2:install` (`docker/cs2/install-game.sh`).

The three downloaded artifacts carry a SHA-256 beside their version in the Dockerfile.
Refreshing one after a bump is `curl -fsSL <url> | sha256sum`; a mismatch fails the build
rather than shipping something nobody looked at.

## The HUD's build (PRD-07)

What compiles the client addon (`hud/`, `docs/hud.md`). None of it is in a server image
and none of it runs on a server; it runs on this box, inside `ezpug-iron/hud-build:dev`.

| What | Pin | Home | Why this one |
| ---- | --- | ---- | ------------ |
| Debian trixie (the HUD build image) | `trixie-slim@sha256:a99cfc51` (truncated; the Dockerfile carries the whole digest) | `docker/hud/Dockerfile` (`FROM debian:…`) | the base whose own `wine` package is 10.0, which runs Valve's `resourcecompiler.exe` headless under Xvfb (measured 2026-10-01: a layout, a stylesheet and a texture). Wine is the base's package, so the digest is its pin too |
| Valve's resource compiler | unversioned; `hud/dist/manifest.json` records its sha-256 and the depot manifests | the build volume `ezpug-iron-hud-build`, fetched by `pnpm hud:build --tools` | depots 2347771 (the Windows binaries) and 2347779 (the Workshop Tools) of app 730, fetched with the logged-in session at whatever is public. Like steamcmd it moves with the game; the manifest of what built `hud/dist/` is the record |
| ValveResourceFormat CLI | `20.0` (`cli-linux-x64.zip`, sha-256 `3e8af47c…`) | `hud/src/readback.ts` (`VRF`) | the decoder `pnpm hud:build` reads every compiled file back with. The release and checksum the platform's asset scripts pin (`/root/ezpug/scripts/valve-tools.mjs`), so both repos read the game with one tool |

## The vendored community plugins

Pinned, never patched, with two exceptions: the WeaponPaints data layer (decision 20) and
MatchZy-Enhanced's simulation mode, which runs as our own fork's release (decision 19 as
amended by PRD-04 T2b). PRD-02 vendors them under `plugins/vendor/` and updates the
"Vendored at" column with the commit it took.

| Plugin | Pin | Builds against | Vendored at |
| ------ | --- | -------------- | ----------- |
| [MatchZy-Enhanced](https://github.com/Auto-Tournament/cs2-plugin) (MIT; a fork of [MatchZy](https://github.com/shobhit-pathak/MatchZy), which it replaced at `0.8.15` — decision 19 as amended, PRD-03 T2), **as our fork** [`ezpug/MatchZy-Enhanced`](https://github.com/ezpug/MatchZy-Enhanced) (PRD-04 T2b) | `1.4.32-ezpug.1` (tag `v1.4.32-ezpug.1`, commit `120e4c3`: upstream `v1.4.32` / `ef76a748` plus the four `ezpug:` commits `EZPUG.md` lists) | CounterStrikeSharp.API 1.0.342, `net8.0` — the same pair stock 0.8.15 built against | **our fork's release binary**, built from the tag by its `ezpug-release.yml` in upstream's zip layout: `docker/cs2/Dockerfile`, `MATCHZY_VERSION` (+ `MATCHZY_SHA256`, which the workflow also attaches beside the zip), unzipped out of its `MatchZy-<version>/` wrapper into `plugins/disabled/MatchZy/` with its `cfg/MatchZy/` set. The patch is the smallest that lets a simulated match leave a seat to a person — a per-player `simulated` flag in the match file's `players` map, the ordinary ready gate for that person, no watchdog start without them — kept as a rebaseable series on an upstream tag (`docs/operations.md`, "MatchZy-Enhanced, our fork"). Everything else is upstream's, and the sha is still the point. The one thing of ours outside the fork is the end of `cfg/MatchZy/config.cfg`: `docker/cs2/cfg/MatchZy/ezpug.cfg` is appended and decides two things — every path the fork opens a socket on by itself is off, and the player features a match must not be able to lose are pinned (the side-pick timer on, `.gg` and forfeit-on-disconnect off, auto-ready left to the request; PRD-03 T3a) — and the build runs `docker/cs2/matchzy-cfg-check.sh` over the result. Its own xUnit project (`tests/MatchZy.Tests`, 251 tests with the series') builds and passes on this repo's toolchain with the .NET 8 runtime installed and runs in the fork's release workflow, but is not part of `pnpm verify`: the source is a gitignored reference clone (`references/MatchZy-Enhanced`, whose `ezpug` branch is the fork's), the pin is a binary, and verify never needs the network |
| [cs2-retakes](https://github.com/B3none/cs2-retakes) | `3.1.0` | CounterStrikeSharp.API 1.0.369, `net10.0` | source, `plugins/vendor/cs2-retakes/` at tag `3.1.0` (commit `157d2bbd`), built by `plugins/vendor/build.sh` into `plugins/disabled/RetakesPlugin/` with its `map_config/` spawn set; `RetakesPluginShared` 2.0.0 goes to `shared/` |
| [cs2-retakes-weapon-allocator](https://github.com/Ravid-A/cs2-retakes-weapon-allocator) | `3.2.5` | CounterStrikeSharp.API 1.0.373, `net10.0`, RetakesPluginShared 2.0.0 | the release binary, not source: `docker/cs2/Dockerfile`, `RETAKES_ALLOCATOR_VERSION` (+ `RETAKES_ALLOCATOR_SHA256`), unzipped into `plugins/disabled/RetakesAllocator/` with the `gamedata/panoramamanager.json` PanoramaManager reads. The one allocator built against the API we actually ship — `plugins/vendor/README.md` says why this fork and not the original, and why its source is not in this repo |
| [cs2-WeaponPaints](https://github.com/Nereziel/cs2-WeaponPaints) | commit `fa8936f3` (tag `build-459`, `ModuleVersion` `3.3a`) | **the fork's:** CounterStrikeSharp.API 1.0.376 (the `Directory.Build.props` pin), `net10.0`, Newtonsoft.Json 13.0.5-beta1, `EZPug.Sdk` from `shared/`. Upstream built that commit for 1.0.367 / `net8.0` with Dapper 2.1.72 and MySqlConnector 2.5.0, both gone with the data layer | source, `plugins/vendor/WeaponPaints/` — the one patched vendor; `PATCHES.md` beside it is every patch, in words, to re-apply on a bump. Built by `plugins/vendor/build.sh` into `plugins/disabled/WeaponPaints/` (with its `lang/`, the English item catalogue under `data/` and its own `Newtonsoft.Json.dll`), `gamedata/weaponpaints.json` beside the plugins folder; `pnpm verify` builds and tests it as part of `EZPug.sln`. The commit is the platform's recorded one, whose `CREATE TABLE`s the `Loadout` schema mirrors field for field |

A `net8.0` plugin loads unchanged on the .NET 10 runtime CounterStrikeSharp ships, which is
why MatchZy stays where upstream put it. The WeaponPaints fork moved to `net10.0` with
`EZPug.Sdk`, because it references it (`ILoadoutSource`, decision 20) and a `net8.0`
assembly cannot; cs2-retakes and its allocator had already moved themselves.

The four downloaded plugin artifacts each carry a SHA-256 beside their version; refreshing
one is `curl -fsSL <url> | sha256sum`.

A vendored *source* tree has a second home, `plugins/vendor/vendored.json` (repo, tag,
commit, and the line of source that carries the version) — that file is what
`scripts/check-pins.mjs` reads, and it checks the version against the source itself, not
against a copy of it. A vendor that publishes a release is pinned like MatchZy instead: a
version and a checksum in the image, and nothing of theirs in our tree.

The WeaponPaints fork is one exception to "never patched": its data layer takes the
in-memory loadout the core plugin hands it instead of querying MySQL (decision 20), and
`plugins/vendor/WeaponPaints/PATCHES.md` lists every patch. The schema it mirrors is the
pinned commit's — `Loadout` in `@ezpug/match-api` is a mapping of those tables, so a plugin
bump means re-reading upstream's `Utility.cs` and, if a column moved, a Match API release.

## The images we publish

Three images, one GitHub Container Registry repository, one release tag each
(`.github/workflows/images.yml`, PRD-02 T34). The **tag is the version**: an image has no
manifest in the tree carrying a number, so there is nothing for a tag to disagree with —
what ties one to this repo is its `org.opencontainers.image.revision` label (the commit it
was built from) and the build provenance the workflow attests against the manifest list.
`scripts/release-image.mjs` is the table a release reads; `pnpm lint` fails if a name below
stops matching it.

| Image | Released by | Platforms | Built from | Latest tag, and what runs it |
| ----- | ----------- | --------- | ---------- | --------------------------- |
| `ghcr.io/ezpug/ezpug-iron/orchestrator` | tag `orchestrator@x.y.z` | `linux/amd64`, `linux/arm64` | `docker/orchestrator/Dockerfile` | `0.1.0` — the first release, cut 2026-09-08 (PRD-02 T39); production on this box and the platform's dev world both still run a local build (`EZPUG_IRON_IMAGE` unset, `…/orchestrator:dev`), and moving either to `:0.1.0` is a commit in that consumer |
| `ghcr.io/ezpug/ezpug-iron/node` | tag `node@x.y.z` | `linux/amd64`, `linux/arm64` | `docker/node/Dockerfile` | `0.1.0` — the first release, cut 2026-09-08; the dev node on this box runs `pnpm node:build`'s local `:dev` |
| `ghcr.io/ezpug/ezpug-iron/cs2` | tag `cs2@x.y.z` | `linux/amd64` | `docker/cs2/Dockerfile` | `0.1.0` — the first release, cut 2026-09-08; the dev CS2 container and the Dathost template are built from the checkout (`pnpm cs2:build`, `pnpm dathost:image`) |

A release publishes `x.y.z`, the moving `x.y`, and `latest`; a prerelease (`0.2.0-rc.1`)
publishes its exact version and nothing else, because `latest` is a promise about a
release. A version already in the registry is refused rather than overwritten.

**Multi-arch where it is cheap.** The orchestrator and the node agent are bundled
JavaScript on the Node base image, so a second architecture is a second *native* runner
(GitHub's `-arm` labels, free for public repositories) and a manifest list stitched from
the two digests — no emulation, no hour-long `pnpm install` under qemu. The CS2 image is
`linux/amd64` only: Valve ships the dedicated server and its steamrt base for that platform
alone, and an arm64 tag would be an image with no game in it.

**Who pins one.** The platform's compose pulls the orchestrator image and pins it in its
own `.env` (`EZPUG_IRON_IMAGE`, today `…/orchestrator:dev`); production here pins it with
the same variable in `.env.production`, which `compose.prod.yaml` reads (PRD-02 T35) —
unset, the deploy builds the checkout instead and `docs/operations.md` says what that
costs. A node at a venue pulls the node image and the CS2 image it starts servers from —
`docs/nodes.md` is that runbook. Bumping a pin is a commit in the consumer, not a moving
tag: that is why `x.y.z` exists beside `latest`.

The other two release tags are `match-api@x.y.z` (npm, with provenance —
`.github/workflows/release.yml`, decision 24) and `plugins@x.y.z` (the plugin zip attached
to a GitHub release, `.github/workflows/plugins.yml`, whose version has to be the one
`plugins/EZPug.Core/EZPug.Core.csproj` carries). Where those two stand today: the package
is **`0.30.0`** in this tree and on the box's Verdaccio (`http://172.17.0.1:4873/`, `latest`;
`0.20.0` and `0.21.0` each published from the commit that cut it, PRD-04 T9, `0.23.0`
from PRD-05 T1's, `0.24.0` from PRD-05 T2's, `0.25.0` from PRD-05 T2b's, `0.26.0` from PRD-05 T2c's, `0.27.0` from PRD-05 T2d's, `0.28.0` from PRD-06 T1's, and `0.30.0` from PRD-06 T2's; `0.29.0` was cut in PRD-06 T1a's commit but never published or tagged, because that run stopped first, and everything in it ships in `0.30.0`) — and waiting
on an `npm login` for npmjs, so its tag is cut and held rather than pushed — pushing it would
only run `release.yml` into a registry nobody here can write to; the plugin zip is
**`plugins@0.1.0`**, `EZPug.Core`'s own `<Version>`, on the tag's GitHub release with its
sha-256 in the notes.

**What the platform pins today** (PRD-06 T4, read off `/root/ezpug` on 2026-09-27):
`@ezpug/match-api` **`0.27.0`** in its `pnpm-workspace.yaml` catalog (its `93a40b46` of
2026-09-26), and `ghcr.io/ezpug/ezpug-iron/orchestrator:dev` — a local build — for the copy
its dev world runs in `sim` mode. The number is behind what this repo has released (0.28.0
and 0.30.0, both additive), and moving it is the platform's own commit to make — its
PRD-13 T19 (the Rush room row) waits for 0.30.0, the first release in which the fake plays
Rush and the door refuses `rules` for it. The history of how it got here, release by release (PRD-02
T40 read `0.9.0` on 2026-09-08): none of 0.10.0, 0.10.1, 0.11.0 or 0.11.1 moved a schema, a
route or a default — two added a hardware recording, one repaired a conformance flow, and
0.11.1 wrote down what `warmup.minPlayersToReady` counts (PRD-03 T1) — so nothing over
there breaks by standing still, and `packages/match-api/CHANGELOG.md` is what its author
reads before moving the number. 0.12.0, 0.13.0, 0.14.0 and 0.15.0 are all additive too —
six gameserver event types (PRD-03 T3), `rules.warmup.autoReady` (T3a), `rules.format`
(T3b) and the puppets switch (T4: `simulation` on the request, the `simulation` scope,
`capabilities.simulation`, `Match.simulated` and `source.simulated`) — and five platform
tasks want them: PRD-10 T4 for the ready board (which cannot draw the gate without the
first, nor say the right empty state without the second), PRD-10 T2a for the `wingman`
preset, whose wire meaning is the third, and PRD-10 T7 and T8, which cannot skip a
simulated match nor start one without the fourth. **0.16.0 is the first of the round a
consumer cannot stand still for** (PRD-03 T7): `team: "unrostered"` is a new value in an
enum the published verifier parses strictly, so a client on ≤ 0.15.0 refuses any delivery
that names an open-join guest or a plain bot. Nothing in production sends it until this
round deploys (T16), and the pin moves before that. The platform's PRD-10 T3 is the task
that moves this pin. **0.17.0** is additive again (PRD-03 T9): a manifest's `length`,
`going_live.length` and a `reason` on `map_end`/`series_end` — what the platform's PRD-10
T6 draws a countdown and an end reason from. **0.18.0** is additive too (PRD-03 T9a):
`SimScenario.idle`, one boolean on a response object and one more scenario name — and, on
the `sim` provider rather than in a schema, the length story itself, so the countdown
PRD-10 T6 draws is drawable off the platform's dev world and not only off the dev node. **0.18.1** moves no schema at all (PRD-03 T9b): the fake's `mintKey` now
reads its request the way a route would, so a key the contract cannot carry is refused at
the mint rather than written and found later — the orchestrator's own service refuses the
same three, and that half needs no pin to move. **0.18.2** and **0.18.3** are catalog and
`sim` only (PRD-03 T9c and T10): a mode that records `events` announces no demo, and
`retakes` is one group of ten that claims `capabilities.simulation` — which the platform's
PRD-10 T5 is waiting on, and which changes what a retakes room and a finished retakes map
look like over there. **0.18.4** moves no schema either (PRD-03 T11): a
`simulation.scenario` whose knobs no real server can execute is `validation_failed` at the
door instead of a knob that quietly did nothing, so a console offering the catalog as a
dropdown for a simulated match (PRD-10 T8) can now be told which entries a room of puppets
will actually play. **0.18.5** is the `sim` again (PRD-03 T11a): a simulated server nobody
joined now goes live and ends as a match wherever a real server of that mode would — the
manifest's `flow` reaches the story, so `powerup-dm`, `retakes` and `flying-scoutsman` are
told the SDK's version of an empty room rather than MatchZy's, which is what the platform's
PRD-10 T6 rehearses its countdown against in its dev world. **0.19.0** is mixed rosters
(PRD-04 T2, for the platform's PRD-11 T23): `simulation.puppets` names which roster entries
are puppets and the rest are people, `capabilities.mixedRoster` says which modes can seat
such a room — the three the SDK seats; `pug` refused a partial list at the door because
upstream's MatchZy-Enhanced seats every configured entry or none — and on the simulator a
person's chair stays empty. **0.20.0** is the scope route (PRD-04 T3): `PATCH /v1/keys/:keyId/scopes` and
`ezpug-iron keys scopes <id> --add/--remove` move what a live key may do, additively, so
the grant that reached production as a hand-written `UPDATE` on 2026-09-21 — the platform
key and `simulation` — has a door. Production's platform key holds `simulation`, and the
places that said it never would say what is true instead. **0.21.0** is `restore` on a live
match (PRD-04 T8, for the platform's PRD-11 T3): no schema moved, the command is answered
where it used to be refused — the match is rewound on its own server to a round of the map
being played, `applied` once the engine has started it again, a reason word when MatchZy
said no. **0.22.0** is `pug` claiming `capabilities.mixedRoster` (PRD-04 T2b, for the
platform's PRD-11 T23): no schema moved. The image runs our fork of MatchZy-Enhanced, which
leaves a seat to a person, so the door takes a partial `simulation.puppets` for the 5v5
queue. **0.23.0** hosts a workshop map by its id (PRD-05 T1, #3, for the platform's
PRD-12 T6a): no schema moved. `going_live.map` is the plan's `workshop/<id>/<name>` on
every flow, and a new conformance flow, `workshop-map`, holds it. **0.24.0** is a node that
never gets ready saying why (PRD-05 T2, the follow-up to the platform's PRD-12 T6a): no
schema moved. `SERVER_READY_DEADLINE_MS` (3 min) is exported, and `match.failed`'s
`provider_error` detail names the map and what was last seen of the server. **0.25.0** is
the simulator dealing the knife perk (PRD-05 T2b, #6, for the platform's PRD-12 T16a):
`MatchRequest.sim.knifePerk: { round, killer? }` turns one of the story's kills into a knife
kill and has its killer say `get ezpug` before the next round starts. **0.26.0** is smokes and
the bomb on the live tier (PRD-05 T2c, #5, for the platform's live radar, PRD-12 T8b): the
ephemeral `position_tick` gains optional `grenades[]` and `bomb`, produced by the core plugin
from the game's events and by the simulator. **0.27.0** is the format on the record
(PRD-05 T2d, #4, for the platform's `wingman` row, PRD-12 T6): `going_live` gains optional
`engine { gameType, gameMode }` and `format`, and `server_ready` gains `engine`, read by the
core plugin at map load. **0.28.0** is Rush (PRD-06 T1, for the platform's PRD-13 T19): the `rush`
manifest joins the catalog, `RoundWinCondition` gains `tower_held` and `tower_captured`, and
`round_end` and `map_end` gain an optional `tower`. **0.29.0** is a mode that owns its rounds (PRD-06 T1a):
the manifest's `rules` field (`request` | `mode`), with `rush` saying `mode`, so the door refuses
a Rush request that carries `rules` rather than play an even `regulationRounds` over the
map's 15. **0.30.0** is the fake playing Rush (PRD-06 T2): tower rounds
along the line on `rush_001`, and the scenario catalog's `towerEnding` with `rush-castle`,
`rush-clinch` and `rush-convoy`.

## Bumping one

1. Edit the **home** — `Directory.Build.props`, `global.json`, the catalog, the image
   script. Never this file alone.
2. Edit the row here in the same commit; `pnpm lint` fails otherwise.
3. `pnpm verify`. For a CounterStrikeSharp bump that is also `EZPug.Sdk.Tests` proving the
   restored assembly matches, and for a plugin bump it is the vendored source building
   against the pinned API.
4. A vendor bump that moves a wire shape (a MatchZy event field, a WeaponPaints column) is
   a `@ezpug/match-api` release with a changelog line, not a silent edit (decision 24).
