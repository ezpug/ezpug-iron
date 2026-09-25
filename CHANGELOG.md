# Changelog

What this repository has released, in the order it went out. Five things carry a version
here and each is a git tag (`docs/operations.md`, "Releasing: CI and the tags"):

| Tag | Artifact | Its own changelog |
| --- | -------- | ----------------- |
| `match-api@x.y.z` | `@ezpug/match-api` on npm | **`packages/match-api/CHANGELOG.md`** — the contract's line-by-line history, which is the one this repo owes the platform |
| `orchestrator@x.y.z` | `ghcr.io/ezpug/ezpug-iron/orchestrator` | here |
| `node@x.y.z` | `ghcr.io/ezpug/ezpug-iron/node` | here |
| `cs2@x.y.z` | `ghcr.io/ezpug/ezpug-iron/cs2` | here |
| `plugins@x.y.z` | `ezpug-plugins-x.y.z.zip` on the tag's GitHub release | here |

The package's history is not repeated below: a schema change is a release with a line in
`packages/match-api/CHANGELOG.md` (`docs/decisions.md` 24), and that file is what a client
reads before it moves its pin. This one is about the services, the images and the plugins —
what an operator gets when they pull a tag.

Versions are the pins in `docs/pins.md`; what is deployed on `gs.ezpug.com` is the table
there, not this file.

## Unreleased

**Workshop maps go live** (`ralph/PRD-05-workshop.md`, #3, #4, #5, #6; decision 32). The
dev node runs this work from a local build of the CS2 image. It is not deployed to
`gs.ezpug.com` yet, and no tag has been cut. The contract went out as `@ezpug/match-api`
**0.23.0** through **0.27.0**, and the package's own changelog has every line.

- **The orchestrator**:
  - A workshop plan goes into MatchZy's `maplist` as its bare id (T1). The Dathost
    provider allocates every server with `cs2_settings.disable_workshop_command_filtering`.
  - A restart between `series_end` and `demo_available` still ends the match (T1a).
    `resume()` rebuilds the demo wait from the durable log, and the deadline counts from
    the logged `series_end`, not from the restart.
  - A server that never sends `server_ready` fails the match after
    `SERVER_READY_DEADLINE_MS`, three minutes, where it used to wait five (T2). The
    `provider_error` detail names the map, the provider's view of the server and the
    link's last word, and the server leaves the fleet.
  - The `sim` provider deals the knife perk on request (T2b). Its story throws utility
    onto the tick and carries the bomb (T2c).
  - A MatchZy `going_live` carries the engine's game type and mode, copied from the
    server's last `server_ready` (T2d).
- **The plugins**:
  - The loader hosts a `workshop/<id>/<name>` plan with `host_workshop_map <id>` (T1;
    `MapIdentifier` in the SDK is the one parser). Before `matchzy_loadmatch`, it puts
    the engine's name for the map that is up into `maplist[0]`. The SDK's generic flow
    names `going_live.map` and `map_end.map` from the plan. The hostname names a
    workshop map by its plan's `<name>`.
  - The position tick carries grenades and the bomb (T2c), fed by the game's events
    through `UtilityBook`, because `OnEntitySpawned` never fired for the plugin on
    CounterStrikeSharp 1.0.373.
  - `server_ready` and `going_live` carry the engine's `game_type` and `game_mode`, read
    at map start (T2d).
  - `bomb_planted`, `bomb_defused` and `bomb_exploded` name their site on a real server
    (T2e). The event's `site` is the trigger's entity index, so the plugin reads
    `planted_c4`'s `m_nBombSite` instead.
- **The CS2 image**: CS2 starts with `-disable_workshop_command_filtering`. Without it,
  a workshop map drops MatchZy's `live.cfg` and `tv_enable`.

**Mixed rosters** (`ralph/PRD-04-mixed-rosters.md`). This work is deployed on `gs.ezpug.com`
from local builds, and the Dathost template carries its plugins. No `orchestrator@`,
`node@`, `cs2@` or `plugins@` tag has been cut for it yet. The contract went out as
`@ezpug/match-api` **0.19.0**, **0.20.0**, **0.21.0** and **0.22.0**, and the package's own
changelog has every line.

- **The orchestrator**:
  - `simulation.puppets` names the roster entries that are puppets. A partial list to a
    mode without `capabilities.mixedRoster` and a name the roster does not hold are
    refused at the door. On the `sim` provider a person's chair stays empty
    (decision 28).
  - `pug` claims `capabilities.mixedRoster` (PRD-04 T2b). The MatchZy match file marks a
    seat left to a person `{ "name", "simulated": false }`.
  - `PATCH /v1/keys/:keyId/scopes` (admin, audited): a live key's scopes move by a route.
  - `restore` on a `live` match rewinds it on its own server to a round of the map being
    played. The point is resolved from the server's own backups, and the backups after
    it are forgotten once the restore is applied.
  - MatchZy-Enhanced's `backup_loaded` makes the door forget the map's last round start,
    so the rewound round's start is not dropped as a go-live repeat.
- **The CS2 image and the Dathost template** run our own fork of MatchZy-Enhanced,
  `ezpug/MatchZy-Enhanced` `1.4.32-ezpug.1`: upstream `v1.4.32` plus a patch series that
  lets a simulated match leave a seat to a person (decision 19 as amended).
- **The plugins** (and the CS2 image and the Dathost template, which carry them):
  - The SDK's puppeteer seats only the entries a request names, and never casts a later
    bot as a person. `retakes`, `powerup-dm` and `flying-scoutsman` claim
    `capabilities.mixedRoster`.
  - `pause` and `unpause` are answered by the engine: `applied` once the gamerules turned
    over, `invalid_state` with a reason word when MatchZy refused (decision 29).
  - `restore` loads MatchZy's own backup and answers the same way, and refuses the gap
    after a round up front (`round_over`).
  - `GameThreadClock.Every` keeps its grid, and a stalled frame skips beats instead of
    firing a burst (decision 30). The position stream is ten ticks a second.
  - A demo is recorded on CS2 builds newer than 1.41.7.8 too (PRD-04 T11, issue #2).
    Dathost's build resolves `tv_record` under the engine's write path,
    `csgo/addons/metamod`, and never creates a folder there. So MatchZy's
    `tv_record MatchZy/…` wrote nothing on Dathost, and every puppeted `pug` there ended
    `no_demo`. The core plugin now makes
    the recording folder under both roots when a match that records is assigned, and
    looks for the demo under both.
- **The terminal**: `ezpug-iron keys scopes <id> --add/--remove`.
- **The box**:
  - The CS2 lane lock queues its waiters: whoever asked first goes first (decision 31,
    issue #1).
  - The lane's `pause`, `radar`, `retakes`, `mixed` and `restore` rows assert what those
    changes promise.
  - The lane's full `pug` row reads the stored demo's first bytes back and asserts the
    CS2 magic (`PBDEMS2\0`).
  - The dev node's game install is on the build Dathost runs, 1.41.8.2 (PRD-04 T11a).
    When Steam refuses the manifests of a build no branch carries any more, the CS2
    image's `install-game.sh` forgets those depots and validates against the new
    build, where it used to fail with `state is 0x6`. `pnpm cs2:status` names the
    installed build.

**Puppets** (`ralph/PRD-03-puppets.md`). This work is deployed on `gs.ezpug.com` from local
builds, but no `orchestrator@`, `node@`, `cs2@` or `plugins@` tag has been cut for it
yet. The contract went out as `@ezpug/match-api` **0.11.1** to **0.18.5**, and the
package's own changelog has every line.

- **The CS2 image** runs **MatchZy-Enhanced** `1.4.32` in place of stock MatchZy 0.8.15.
  It is upstream's release binary, pinned by sha-256 (decision 19 as amended). The build
  checks the appended `cfg/MatchZy/ezpug.cfg`: every path that opens a socket by itself
  is off, the side-pick timer is on, and `.gg` and forfeit-on-disconnect are off.
- **The orchestrator**:
  - `players_per_team` comes from the roster: a 1v1 pug can ready up.
  - Simulation is behind the `simulation` key scope, and every fact carries
    `source.simulated`.
  - MatchZy-Enhanced's ready, knife and demo-upload events are translated into the
    vocabulary.
  - The `1v1` and `wingman` formats.
  - `keys.mint` refuses anything the contract cannot list.
  - The fleet console route asks the plugin for a fresh tail on every read.
- **The plugins**:
  - `EZPug.Sdk` seats puppets for the modes MatchZy does not run. It casts the fork's bots
    to their roster entries under `pug`.
  - Plugin modes get a length: a duration, a frag limit and an idle end.
  - A one-team mode names no winner.
  - `retakes` is one team of ten.
- **The terminal**: `ezpug-iron matches create --simulate [--scenario] [--timescale]`.
- **The box**:
  - `scripts/deploy.sh` and `cs2-env.sh build` prune dangling images and age-bound the
    build cache.
  - Every compose service caps its json log.
  - The dev CS2 lane runs under the lock both repos share, `/tmp/ezpug-cs2-lane.lock`.

## 2026-09-08

**The iron** (`ralph/PRD-02-iron.md`), released: `orchestrator@0.1.0`, `node@0.1.0`,
`cs2@0.1.0` and `plugins@0.1.0` — the first tags any of them has ever carried — beside
`@ezpug/match-api` **0.10.0** — with **0.10.1** and **0.11.0** following the same evening,
both fixtures only — whose own changelog has every version the round cut.
Each image tag publishes `0.1.0`, the moving `0.1` and `latest` over per-platform digests,
with the commit in `org.opencontainers.image.revision` and signed build provenance against
the manifest list; the plugin zip is on the tag's GitHub release with its sha-256 in the
notes. `docs/pins.md` is what a deployment pins and the only place that says what runs
where; the package went to the box's Verdaccio and goes to npmjs the day the owner logs in
(`docs/decisions.md` 3, as amended).

- **The orchestrator** (`apps/orchestrator`, `ghcr.io/ezpug/ezpug-iron/orchestrator`) —
  Hono over Postgres and Redis serving every route in `@ezpug/match-api`: the match
  machine (`pending → allocating → configuring → ready → live → ended | failed |
  cancelled`, `recovering` from `live`), the provisioning walk over ranked candidates, the
  ledger and its reaper, per-key budgets, the webhook worker with signatures and retries,
  the match stream, the widget socket, the server link and the node link. Three providers
  behind one interface: **Dathost**, **nodes**, and the **simulator** for a box with
  neither. `/healthz` asks each rail live; the conformance suite in
  `@ezpug/match-api/fixtures` passes against it and against the fake on every extended
  verify.
- **The node agent** (`apps/node`, `ghcr.io/ezpug/ezpug-iron/node`) — `ezpug-node`, which
  turns a docker host at a venue into one LAN-capable provider: enrol once with a token
  shown once, dial out, start and stop CS2 containers on command, drain, report. It
  listens on nothing. `docs/nodes.md` installs one in five commands.
- **The CS2 server image** (`docker/cs2`, `ghcr.io/ezpug/ezpug-iron/cs2`) — steamrt
  `sniper` with Metamod, CounterStrikeSharp, MatchZy, cs2-retakes and its allocator, the
  WeaponPaints fork and the EZPug plugins baked in, every artifact pinned by version *and*
  checksum in `docs/pins.md`. The game itself is the one thing not in the image: app 730
  installs once into a volume.
- **The plugins** (`plugins/`, the `ezpug-plugins-x.y.z.zip`) — **`EZPug.Sdk`**, the
  product: the link, the event model, timers, per-player state, player commands, i18n, the
  `IGameWorld` seam and a test harness that plays a gamemode with no CS2 anywhere near it.
  **`EZPug.Core`** is the thin host on it — one outbound WebSocket, the vocabulary emitted
  natively, the gamemode loader, backups, demos, branding, EZ Rating on the scoreboard,
  skins over the link. **`EZPug.PowerupDm`** is a gamemode written on the SDK, with a phone
  widget built by `gamemode-kit`.
- **The gamemodes** (`gamemodes/`, bundled into `@ezpug/match-api`) — `pug` and
  `flying-scoutsman` on MatchZy, `retakes` on the community plugin, `powerup-dm` on the
  SDK; manifests as data, read by the orchestrator and the plugin alike.
- **The terminal** (`apps/cli`) — `ezpug-iron`: keys, gamemodes, matches, servers, nodes,
  providers, capacity, budget and the Dathost image, every verb one call on the same Match
  API the platform speaks, `--json` on all of them. The `providers` group (`list`, `drain`
  `--undrain`, `gslt`) and `capacity` are the first two moves of an outage, which were
  `curl` in the runbook until T38b.
- **The deploy** (`scripts/deploy.sh`, `compose.prod.yaml`) — preflight, build, backup,
  migrate, up, routes, smoke; `rollback` and `backup` beside it. `ralph/DEPLOY.md` is the
  runbook.

## 2026-09-05

**The spine** (`ralph/PRD-01-spine.md`): `@ezpug/match-api` **0.1.0**, tagged
`match-api@0.1.0` — the vocabulary, the Match API, the webhooks, the stream, the manifests,
a typed client, a webhook verifier, an in-process fake orchestrator that plays real matches
on the simulator engine, and a conformance suite with recorded golden files. The package's
own changelog carries every version since.
