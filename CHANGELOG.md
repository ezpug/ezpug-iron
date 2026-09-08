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

_Nothing yet._

## 2026-09-08

**The iron** (`ralph/PRD-02-iron.md`), released: `orchestrator@0.1.0`, `node@0.1.0`,
`cs2@0.1.0` and `plugins@0.1.0` — the first tags any of them has ever carried — beside
`@ezpug/match-api` **0.10.0**, whose own changelog has the nine versions the round cut.
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
