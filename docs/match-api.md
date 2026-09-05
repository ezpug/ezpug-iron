# The Match API

The reference for `@ezpug/match-api`, the one contract between the platform and the iron
(`docs/decisions.md` 3). Written for the platform loop: read this instead of this repo's
code. Every schema here is a Zod schema in `packages/match-api/src`; a test checks that
every route in the table has a section below.

The base URL is the orchestrator: `https://gs.ezpug.com` in production, `http://localhost:3430`
on a dev box, the in-process fake in tests. Every route lives under `/v1/`. Every request
carries `Authorization: Bearer <api key>`. Bodies and responses are JSON.

Webhooks, the events replay and the stream are added by PRD-01 T3; the gamemode manifest
by T4. This file grows with them.

## Authentication and scopes

An API key holds one or more **scopes**:

| Scope     | Lets a key                                                                  |
| --------- | --------------------------------------------------------------------------- |
| `matches` | create, read, command and cancel matches; mint player tokens; read the catalog and capacity |
| `fleet`   | read the ledger, providers, nodes, budget and GSLT pool; release, drain, undrain; console and RCON |
| `admin`   | mint, list and revoke keys; set webhook secrets. Implies `matches` and `fleet` |

Every route declares the scope it needs (`scope` in the route table). A key without it
gets `forbidden`. One command, `rcon`, needs `admin` on top of the `matches` route it
travels on.

## Errors

Every non-2xx response is

```json
{ "error": { "code": "budget_exceeded", "message": "Monthly ceiling reached.", "details": { "limit": "monthlyCents" } } }
```

`code` is from a closed set, and each code has one HTTP status:

| Code                  | Status | When                                                                 |
| --------------------- | ------ | -------------------------------------------------------------------- |
| `unauthorized`        | 401    | no key, unknown key, revoked key                                     |
| `forbidden`           | 403    | the key lacks the route's scope (or `admin` for `rcon`)              |
| `not_found`           | 404    | no such match, server, node or key for this key                      |
| `validation_failed`   | 400    | body, params or query did not parse; `details.issues` says why       |
| `conflict`            | 409    | `clientMatchId` reused with a different body; a key name taken       |
| `invalid_state`       | 409    | the command or transition is not legal in the match's state          |
| `command_unsupported` | 400    | `sim.*` on a real server, `rcon` on a sim, a verb the gamemode lacks |
| `no_backup`           | 409    | `restore` with nothing to restore from                               |
| `player_not_in_match` | 422    | `profile` or `kick` for an unrostered player on a closed-roster mode |
| `unknown_gamemode`    | 422    | no gamemode of that id in the catalog                                |
| `game_unsupported`    | 422    | the gamemode does not play the requested `game`                      |
| `no_capable_server`   | 503    | no provider can host the request now; every `csgo` request this round |
| `budget_exceeded`     | 402    | the key's concurrent, lifetime or monthly ceiling would be crossed   |
| `rate_limited`        | 429    | back off                                                             |
| `provider_unavailable`| 503    | the provider or node behind this server is not answering             |
| `internal`            | 500    | the orchestrator's own fault; retry                                  |

A client retries `5xx` and `429`. It never retries `402`: money is a decision, not a
transient.

## Vocabulary

**Gameserver events** are the platform's `gameserver.ts` on 2026-09-05, verbatim: 22
types (`server_ready`, `heartbeat`, `player_connected`, `player_disconnected`,
`going_live`, `round_start`, `round_end`, `side_swap`, `map_end`, `series_end`,
`match_paused`, `match_unpaused`, `player_death`, `bomb_planted`, `bomb_defused`,
`bomb_exploded`, `position_tick`, `backup_written`, `demo_available`, `chat_command`,
`chat_message`, `plugin_event`), `GAMESERVER_EVENT_CONTRACT_VERSION = 1`,
`position_tick` ephemeral. `source.provider` on an event is the provider badge (`sim`,
`dathost`, a node's provider id). The platform re-exports these from the package; its
fixtures parse unchanged (a test in this package proves it against the platform's own
recorded files).

Also in the vocabulary: `steamId64Schema` (a 17-digit string, never a number), `game`
(`cs2 | csgo`), `locale` (`de | en`, German default), `mapRadar` (overview geometry, the
platform's `map-pools.ts` shape).

## Resources

### MatchRequest

What `POST /v1/matches` takes. `maps` and `rules` are the platform's `mapPlanSchema` and
`matchRulesSchema` as they are.

| Field          | Type                                                   | Notes |
| -------------- | ------------------------------------------------------ | ----- |
| `clientMatchId`| string ≤128                                            | the idempotency key; the platform's match uuid |
| `game`         | `cs2 \| csgo`                                          | `csgo` is refused `no_capable_server` this round |
| `gamemode`     | kebab id                                               | from `GET /v1/gamemodes` |
| `teams`        | `{ teamA, teamB }`, each `{ name, players: RosterEntry[] }` | rosters may be empty for an open-join mode; a SteamID may appear once |
| `maps`         | `{ map, sides: ct \| t \| knife }[]`, ≥1               | `sides` is where **team A** starts |
| `rules?`       | `{ regulationRounds, overtime, warmup, cvars }`        | absent = the gamemode's defaults |
| `requirements` | `{ region?, lan?, simulated?, provider? }`             | every field narrows; default `{}` |
| `callbacks`    | `{ webhookUrl, webhookSecretId, demoUploadUrl?, streamAllowedOrigins? }` | `webhookSecretId` names a secret registered on the key; `demoUploadUrl` is a presigned PUT |
| `warmupLines?` | string[] ≤20                                           | printed in warmup, in order |
| `branding?`    | `{ hostname?, eventName? }`                            | decision 22 |
| `sim?`         | `{ scenario?, seed?, mode?, timeScale?, chaos? }`      | honoured on the `sim` provider only |
| `ttlMinutes`   | int, 1…1440                                            | the reaper's deadline; never above the key's ceiling |

**RosterEntry**: `{ steamId64, name, locale (default de), rating?, rankName?, loadout? }`.
The orchestrator relays these to the server and never stores a player.

**Loadout** mirrors cs2-WeaponPaints' tables so the fork's data layer is a mapping: per
side (`t`, `ct`) `{ weapons: WeaponSkin[], knife?, gloves?, agent?, music?, pin? }`;
`WeaponSkin = { defindex, paintId, wear, seed, nametag? (≤32), stattrak, stattrakCount,
stickers (≤5 of { id, schema, x, y, wear, scale, rotation }), keychain? { id, x, y, z, seed } }`.

### Match

| Field           | Type | Notes |
| --------------- | ---- | ----- |
| `id`            | uuid | minted by the orchestrator |
| `clientMatchId` | string | as requested |
| `state`         | `pending \| allocating \| configuring \| ready \| live \| recovering \| ended \| failed \| cancelled` | in that order; the last three are terminal |
| `game`, `gamemode` | | as requested |
| `provider`      | kebab \| null | a badge (`sim`, `dathost`, a node's) |
| `serverId`      | string \| null | the provider's handle; `source.serverId` on every event |
| `fleetServerId` | uuid \| null | the ledger row |
| `connect`       | `{ host, port, password? }` \| null | from `ready` on |
| `tv`            | `{ host, port, delaySeconds }` \| null | the GOTV relay, where there is one |
| `seq`           | int | the last durable sequence delivered; 0 before the first |
| `createdAt`, `updatedAt`, `readyAt`, `liveAt`, `endedAt`, `expiresAt` | ISO timestamps | nullable where not yet reached |
| `endedReason`   | `{ kind, detail? }` \| null | `kind ∈ completed, force_ended, cancelled, ttl_expired, server_lost, allocation_failed, provider_error` |
| `sim`           | SimStatus \| null | `{ scenario, seed, mode, timeScale, remainingBeats, finished, outcome, chaos }` on the `sim` provider only |

### MatchCommand and MatchCommandResult

A discriminated union on `type`, every variant with a `correlationId` (the client's own
id; a retried command with the same id is not applied twice):

| Type            | Fields | Notes |
| --------------- | ------ | ----- |
| `pause`         | `kind?: tactical \| technical \| admin` | |
| `unpause`       | | |
| `restart_round` | | |
| `force_end`     | `reason?` | the match ends `force_ended` |
| `kick`          | `steamId64, reason?` | |
| `announce`      | `text` ≤512 | the plugin prints it; a sim echoes it as a `plugin_event` |
| `rcon`          | `command` | needs `admin`; `command_unsupported` on a sim |
| `restore`       | `roundNumber?` | latest backup when unsaid; `no_backup` when none |
| `reroll`        | | the match over on the same server, rosters kept |
| `profile`       | `player: RosterEntry` | push or refresh one player's profile |
| `sim.step`      | | deal the next beat (step mode) |
| `sim.mode`      | `mode: auto \| step` | |
| `sim.speed`     | `timeScale` 0.25…600 | |
| `sim.chaos`     | `chaos: { delay?, duplicate?, delayMs? } \| null` | |
| `sim.kill`      | | the box dies; heartbeats stop |

Result: `{ correlationId, type, status: applied | accepted | rejected, code?, message?,
output?, sim?, stepped? }`. `accepted` means the answer comes later on the stream as a
`command_result` frame with the same `correlationId`. `rejected` is still HTTP 200: the
call worked, the command did not; `code` is from the error table.

### PlayerToken

`POST` body `{ steamId64, ttlSeconds (default 900, max 3600) }`; response `{ token,
matchId, steamId64, expiresAt }`. The token is what a gamemode widget opens its own socket
with (decision 17). Shown once.

### Gamemode (catalog read side)

`{ id, game, tier: config | plugin | sdk, title: {de, en}, description: {de, en}, slots:
{ teamSize, teams, openJoin }, flow: matchzy | plugin | none, records: demo | events |
none, ranked: false, version }`. The full manifest (plugins, cfg, cvars, capabilities,
player commands, widget) is PRD-01 T4's and extends this.

### Capacity

`{ providers: [{ id, healthy, drained, regions: [{ region, games, lan, available }] }],
asOf }`. `available` is null where a provider cannot count.

### Fleet

- **FleetServer** (a ledger row): `{ id, provider, serverId, node, matchId, keyId, state:
  allocated | configured | running | released | failed, game, region, lan, address:
  { host, port } | null, tv, cost: { currency: EUR, hourlyCents, accruedCents, asOf },
  allocatedAt, releasedAt, expiresAt }`. Never a password.
- **ProviderHealth**: `{ id, healthy, drained, lastCheckedAt, lastError, servers }`.
- **Node**: `{ id, labels, region, version, connected, lastSeenAt, drained, capacity:
  { total, inUse, warm }, currentMatches, enrolledAt }`. **NodeEnrolment**: `{ node,
  token }`, the token shown once.
- **Budget**: `{ keyId, limits: { maxConcurrentServers, maxServerLifetimeMinutes,
  monthlyCents }, usage: { concurrentServers, monthCents, monthStartedAt } }`.
- **GsltPool**: `{ total, inUse }`.
- Console and RCON: `{ lines: [{ at, line }] }` and `{ command } → { output }`.

### ApiKey

`{ id, name, prefix, scopes, budget, webhookSecretIds, createdAt, lastUsedAt, revokedAt }`.
Create takes `{ name, scopes, budget, webhookSecrets?: [{ id, secret }] }` and answers
`{ key, secret }`, the secret shown once. Webhook secrets are registered by id so a
match request can name one and a client can rotate without a gap.

## Routes

Paged lists take `?cursor=&limit=` (limit ≤200, default 50) and answer `{ items,
nextCursor }`; pass `nextCursor` back verbatim, it is opaque.

### `GET /v1/gamemodes`

Scope `matches`. `{ gamemodes: Gamemode[] }` — the catalog the orchestrator ships. Cache it;
it changes with a release.

### `GET /v1/capacity`

Scope `matches`. `Capacity`.

### `POST /v1/matches`

Scope `matches`. Body `MatchRequest`, answers `201 Match`. Idempotent on `clientMatchId`:
the same body again answers `200` with the same match; a different body under a used id
is `conflict`. Refused at the door with `unknown_gamemode`, `game_unsupported`,
`no_capable_server` or `budget_exceeded`.

### `GET /v1/matches`

Scope `matches`. Query `state?`, `clientMatchId?` plus paging. The key's own matches,
newest first.

### `GET /v1/matches/:matchId`

Scope `matches`. `Match`.

### `POST /v1/matches/:matchId/cancel`

Scope `matches`. Before `live`: the server is released, the match ends `cancelled`;
answers the `Match`. From `live` on: `invalid_state`, send a `force_end` command instead.

### `POST /v1/matches/:matchId/commands`

Scope `matches`. Body `MatchCommand`, answers `MatchCommandResult`. Idempotent on
`correlationId`.

### `POST /v1/matches/:matchId/player-tokens`

Scope `matches`. Body `{ steamId64, ttlSeconds? }`, answers `201 PlayerToken`.

### `GET /v1/fleet/servers`

Scope `fleet`. `{ servers: FleetServer[] }`: every open ledger row.

### `POST /v1/fleet/servers/:serverId/release`

Scope `fleet`. Body `{ reason? }`. Deallocates now whatever the match thinks; its match
ends `provider_error`. Answers the row.

### `GET /v1/fleet/servers/:serverId/console`

Scope `fleet`. `{ lines: [{ at, line }] }`, the last 500 at most, oldest first.

### `POST /v1/fleet/servers/:serverId/rcon`

Scope `fleet`. Body `{ command }`, answers `{ output }`. `command_unsupported` on a sim.

### `GET /v1/fleet/providers`

Scope `fleet`. `{ providers: ProviderHealth[] }`.

### `POST /v1/fleet/providers/:providerId/drain`

Scope `fleet`. Stops allocating on the provider; running servers finish. Answers the
provider.

### `POST /v1/fleet/providers/:providerId/undrain`

Scope `fleet`. The reverse.

### `GET /v1/fleet/nodes`

Scope `fleet`. `{ nodes: Node[] }`.

### `POST /v1/fleet/nodes`

Scope `fleet`. Body `{ id, region, labels? }`, answers `201 NodeEnrolment`. The token in
it is shown once.

### `DELETE /v1/fleet/nodes/:nodeId`

Scope `fleet`. Revokes the node's token; it is disconnected and forgotten. `{ ok: true }`.

### `POST /v1/fleet/nodes/:nodeId/drain`

Scope `fleet`. Answers the node.

### `POST /v1/fleet/nodes/:nodeId/undrain`

Scope `fleet`. Answers the node.

### `GET /v1/fleet/ledger`

Scope `fleet`. Query `state?`, `provider?`, `matchId?` plus paging. Every row, open and
closed, newest first.

### `GET /v1/fleet/budget`

Scope `fleet`. The calling key's `Budget`.

### `GET /v1/fleet/gslt`

Scope `fleet`. `GsltPool`.

### `POST /v1/keys`

Scope `admin`. Body `ApiKeyCreateRequest`, answers `201 { key, secret }`.

### `GET /v1/keys`

Scope `admin`. `{ keys: ApiKey[] }`.

### `DELETE /v1/keys/:keyId`

Scope `admin`. Revokes; answers the key with `revokedAt` set.

### `PUT /v1/keys/:keyId/webhook-secrets`

Scope `admin`. Body `{ secrets: [{ id, secret }] }` replaces the set. Answers the key.

## Invented here

Fields and shapes with no counterpart in the platform on 2026-09-05. The platform loop
reads this list first; everything not on it is a copy.

- `MatchRequest`: `clientMatchId`, `gamemode`, `teams.*.players[].{name, locale, rating,
  rankName, loadout}` (the platform's roster carries a user id and an elo instead),
  `requirements`, `callbacks`, `warmupLines`, `branding`, `sim`, `ttlMinutes`. Gone from
  the platform's request: `matchId` (minted here), `context`, `ranked`, `integrations`,
  `series` (all platform business).
- `Loadout` and everything under it.
- `Match` and its states (`pending … cancelled`; the platform's are `requested …
  aborted`), `endedReason.kind`, `seq`, `fleetServerId`, `expiresAt`, `sim`.
- `MatchCommand` (the non-sim verbs; the `sim.*` family is the platform's console command
  union with `correlationId` added), `MatchCommandResult`.
- `PlayerToken`, `Gamemode`, `Capacity`, the whole fleet family, `ApiKey` and webhook
  secret registration, the scopes, the error code set and its status table.
