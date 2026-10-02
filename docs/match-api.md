# The Match API

The reference for `@ezpug/match-api`, the one contract between the platform and the iron
(`docs/decisions.md` 3). Written for the platform loop: read this instead of this repo's
code. Every schema here is a Zod schema in `packages/match-api/src`; a test checks that
every route in the table has a section below.

The base URL is the orchestrator: `https://gs.ezpug.com` in production, `http://localhost:3430`
on a dev box, the in-process fake in tests. Every route lives under `/v1/`. Every request
carries `Authorization: Bearer <api key>`. Bodies and responses are JSON.

The gamemode manifest — what a mode is, what each field means, how to render one — is
`docs/gamemodes.md`; this file carries its wire shape and its routes only.

## Authentication and scopes

An API key holds one or more **scopes**:

| Scope     | Lets a key                                                                  |
| --------- | --------------------------------------------------------------------------- |
| `matches` | create, read, command and cancel matches; mint player tokens; read the catalog and capacity |
| `fleet`   | read the ledger, providers, nodes, budget and GSLT pool; release, drain, undrain; console and RCON |
| `admin`   | mint, list and revoke keys; edit their scopes, set budgets and webhook secrets. Implies `matches`, `fleet` and `simulation` |
| `simulation` | send a match request that carries `simulation` — a match played by **puppets** (PRD-03 T4). Not a route scope: `POST /v1/matches` still needs `matches`, and this one is checked against the body |

Every route declares the scope it needs (`scope` in the route table). A key without it
gets `forbidden`. One command, `rcon`, needs `admin` on top of the `matches` route it
travels on; one body field, `simulation`, needs the `simulation` scope on top of it, and a
request that carries it on a key without the scope is `forbidden` with `details.scope:
"simulation"` — judged before anything about the body, because an unauthorised request is
not owed a diagnosis.

**Production's platform key holds `simulation`** (owner call, 2026-09-21). This page used
to say it never would; the admin console's "test match with puppets" is the point of the
fleet door, and it answered `forbidden`. What keeps a real match from becoming a simulated
one is narrower, and was always the guard that mattered: the block is never implied, so a
request is a rehearsal only by carrying `simulation` explicitly, and every fact of such a
match says `source.simulated`. Which scopes a live key holds is moved by
`PATCH /v1/keys/:keyId/scopes`, never by a hand-written `UPDATE`.

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
| `map_not_allowed`     | 422    | a planned map is outside the gamemode's `maps` allow-list            |
| `no_capable_server`   | 503    | no provider can host the request now; every `csgo` request this round |
| `budget_exceeded`     | 402    | the key's concurrent, lifetime or monthly ceiling would be crossed   |
| `rate_limited`        | 429    | back off                                                             |
| `provider_unavailable`| 503    | the provider or node behind this server is not answering             |
| `internal`            | 500    | the orchestrator's own fault; retry                                  |

A client retries `5xx` and `429`. It never retries `402`: money is a decision, not a
transient.

## Vocabulary

**Gameserver events** began as the platform's `gameserver.ts` on 2026-09-05, verbatim —
22 types — and are **28** since 0.12.0: `server_ready`, `heartbeat`, `player_connected`,
`player_disconnected`, `player_ready`, `player_unready`, `team_ready`, `all_ready`,
`knife_start`, `knife_end`, `going_live`, `round_start`, `round_end`, `side_swap`,
`map_end`, `series_end`, `match_paused`, `match_unpaused`, `player_death`,
`bomb_planted`, `bomb_defused`, `bomb_exploded`, `position_tick`, `backup_written`,
`demo_available`, `chat_command`, `chat_message`, `plugin_event`.
`GAMESERVER_EVENT_CONTRACT_VERSION = 1`, `position_tick` ephemeral. `source.provider` on
an event is the provider badge (`sim`, `dathost`, a node's provider id); `source.simulated`
is present, and `true`, on every event of a match played by puppets (`MatchRequest.simulation`,
PRD-03 T4) and absent on a real one. The platform
re-exports these from the package; its fixtures parse unchanged (a test in this package
proves it against the platform's own recorded files).

**A player's `team` is the roster's word.** `team_a` and `team_b` belong to the players the
request named — a puppet is one — wherever they stand; a body the request never named is
`unrostered` while it plays on a side (an open-join guest, a plain bot) and `spec` while it
is on none (since 0.16.0, PRD-03 T7). An `unrostered` player belongs to neither team: draw
it in a guest list and attribute nothing by team to it.

**A mode with nothing to win has a length, and the facts say so** (since 0.17.0, PRD-03
T9). A manifest's `length` (`docs/gamemodes.md`, "Length") names a duration, a frag limit
and an idle timeout, the SDK on the server enforces it, and three optional fields carry it:
`going_live.length` is `{ durationSeconds?, fragLimit? }` **in force** — count
`durationSeconds` down from that event's arrival (it is already on your clock: a simulated
match's time scale is taken out of it) and a leader's kills up to `fragLimit` from the
`player_death`s you already have — and `map_end.reason` / `series_end.reason` is
`time_limit`, `frag_limit` or `idle` when the length ended the match, absent when the game
did. An `idle` end may come from `ready`, with no `going_live` and no `map_end` before it:
nobody came. Either way the match ends `completed` and the server is released. **A
one-team mode (`slots.teams: 1`) names no winner**: `winner` is `null` on both facts,
whatever the engine's two side scores said.

**A tower round says who owned the tower** (since 0.28.0, PRD-06; decision 33). On
`rush_001` a round is won by whoever owns the room's tower when it ends, and the match walks
a line of seven rooms. Sides are fixed for the whole map and there is no `side_swap`.

| Field | Values |
| ----- | ------ |
| `round_end.reason` | `tower_held`: the side that held the tower as the round began still owns it, alive or not. `tower_captured`: the winner did not hold it. `elimination`: the holders kept it and every attacker died, or both sides did |
| `round_end.tower` | `{ room, roomId?, heldBy }`. `room` is 1–7 in side order: 1 is the T castle (`401`), 4 the start room, 7 the CT castle (`301`). `heldBy` is the side that held it as the round began, `null` only for a room a draw left empty. The winner is always the owner at the end |
| `map_end.tower` | `{ room, roomId?, ending }`. `ending` is `castle` (a win inside the enemy castle) or `rounds` (8 clinched, or 8–7 after Convoy at 7–7) |

A draw replays the room and has no `round_end`. **`roomId` is sometimes missing.** A real
server names only `401`, `301` and `convoy`, because no engine event says which arena the
map drew for the other rooms. The simulator names every room (`ralph/OPEN-POINTS.md` §11), so
draw the line from `room` and use `roomId` only as a label.

**The ready gate is the server's arithmetic, never the client's.** `player_ready`,
`player_unready` and `team_ready` each carry a `tally`: `ready` is the ready player count
per team, in team order, and `expected` is how many the server is waiting for across both
teams. `all_ready` means both teams passed the gate, with `countdown: true` when the
server is counting down rather than starting at once; `going_live` still follows, after
the knife round where there is one. A client draws these and does not recompute them —
whether a team has passed is a judgement the match plugin makes from its own rules, and a
client that reimplemented it is what made the 2026-09-18 stall invisible to every test we
had.

**Each of those facts is said once.** A player who is already ready says nothing more
until they unready, a team already through the gate says nothing more until one of its
players does, and an `all_ready` repeating counts already said is not repeated — the
counts as they move are `player_ready`'s, which carries the whole tally on every single
one. An unready puts its own team and the room back in play, and going live spends the
gate, so a map that runs a ready phase of its own starts from nothing. (The server side of
this is arithmetic a match plugin does not do for itself: MatchZy-Enhanced re-checks the
gate after every ready and re-announces every team still through it, from one player ready
upwards — 44 `team_ready` for two teams in the recorded puppet pug, which is why a
`team_ready` only travels once its side has reached the floor that match's own config set:
`minPlayersToReady` per team, or the whole roster where the request asked for no gate at
all.)

**A map is named the way your plan named it** (since 0.23.0, PRD-05 T1, #3; decision 32).
`going_live.map`, and `map_end.map` where it is present, is the plan's own string for that
map number, `maps[mapNumber - 1].map`: `de_mirage`, or `workshop/3084291314/aim_map` for a
workshop map. You can match it to your plan without knowing anything about the engine. A
server hosts a workshop map by its published-file id (`host_workshop_map`, and a bare id
in MatchZy's `maplist`), and the engine then calls the map by a name of its own, which you
never sent. That engine name is what `server_ready.map` reports, because that event says
what the server loaded. For an official map the two are the same string. Every flow says
it this way: a `matchzy` flow's translator names the map from the plan, and the SDK's
generic flow does the same. A workshop map needs a provider that claims
`capabilities.workshopMaps`: Dathost, a node and the simulator all do.

`knife_start` and `knife_end` bracket a knifed map; `knife_end.winner` is who picks
the side, `null` when the server could not attribute it, and the pick itself arrives as
`side_swap` when they swap and as nothing at all when they stay.

Also in the vocabulary: `steamId64Schema` (a 17-digit string, never a number), `game`
(`cs2 | csgo`), `locale` (`de | en`, German default), `mapRadar` (overview geometry, the
platform's `map-pools.ts` shape, with its transforms `worldToRadar`, `radarToWorld`,
`radarLayerFor`, `radarLayerNamed` and `radarHeading` verbatim, so a live page and the
simulator engine draw a `position_tick` with the same arithmetic), the map identifier
grammar (`de_mirage` or `workshop/<id>/<name>`, the platform's `map-pools.ts` regex, with
`parseMapIdentifier`).

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
| `maps`         | `{ map, sides: ct \| t \| knife }[]`, ≥1               | `sides` is where **team A** starts; every `map` inside the gamemode's `maps` |
| `rules?`       | `{ format, regulationRounds, overtime, warmup, cvars }` | absent = the gamemode's defaults. `format` is `competitive \| wingman`, defaulting to `competitive`. `warmup` is `{ minPlayersToReady, minSpectatorsToReady, autoReady }`, the last defaulting to `true` |
| `requirements` | `{ region?, lan?, preferLan?, simulated?, provider? }` | every field narrows except `preferLan`, which only ranks; default `{}`. `lan` and `preferLan` together are `validation_failed` |
| `callbacks`    | `{ webhookUrl, webhookSecretId, demoUploadUrl?, demoUploadUrls?, streamAllowedOrigins? }` | `webhookSecretId` names a secret registered on the key; `demoUploadUrl` is a presigned PUT, `demoUploadUrls` is one per map (`{ mapNumber, url }[]`, ≤16) |
| `warmupLines?` | string[] ≤20                                           | printed in warmup, one every eight seconds, in order and cycling; rendered by the client (one line everybody reads cannot be four languages), relayed unbranded, sanitized to one chat line |
| `branding?`    | `{ hostname?, eventName?, tagline?, banner?, hud }`    | how the server presents itself (decisions 22, 34). `tagline` ≤140 and `banner` (a key) are for the welcome; `hud` is the client's switch for the HUD, `false` unless said. See [The HUD, from a client's side](#the-hud-from-a-clients-side) |
| `sim?`         | `{ scenario?, seed?, mode?, timeScale?, chaos?, knifePerk? }` | honoured on the `sim` provider only. `knifePerk: { round, killer? }` deals a knife kill and the killer's `get ezpug` (see below) |
| `simulation?`  | `{ scenario?, timeScale? }`                            | **puppets**: every rostered player is played by a simulated one. Needs the `simulation` scope (else `forbidden`) and `capabilities.simulation` on the mode (else `validation_failed` on `simulation`); `scenario` is a name from `GET /v1/sim/scenarios`, `timeScale` the engine's `host_timescale`, 0.1…10. Absent is a real match |
| `ttlMinutes`   | int, 1…1440                                            | the reaper's deadline; never above the key's ceiling |

**`sim.knifePerk` deals the platform's knife perk** (ezpug/ezpug-iron#6). From round
`round` of map 1 on, the simulator turns one of the kills its story already deals into a
`player_death` with `weapon: "knife"` by a rostered player on `killer`'s team (either team
when unsaid). Before that round's `round_end`, so always before the next `round_start`,
the same player says `get ezpug` as a `chat_message` with scope `all`. The round is the
first one from `round` on in which that team kills anybody, so in a 1v1 it skips every
round the team loses. A mode with a length plays a single round, and there only `round: 1`
deals it. The knob has its own seeded stream, so the rest of the story is the one the seed
plays without it: only that kill's `weapon` (and `headshot`, now `false`) changes, and one
line is added. Both are ordinary events of the union.

**`rules.format` is which game the engine plays**, and there are two (PRD-03 T3b, owner
decision 2026-09-19).

- `competitive` — CS2's `game_mode 1`, the five-a-side game, **played at whatever size the
  roster holds**. A **1v1 is this**: one player a side, short rules, and the ready gate the
  roster derives. There is no `1v1` format and there does not need to be one.
- `wingman` — CS2's `game_mode 2`, the two-a-side game. MatchZy switches the engine mode
  from the match file and execs its `live_wingman.cfg` (MR8, a smaller overtime) instead
  of `live.cfg`, so **the map is loaded again** when the server was not already in that
  mode: a wingman match costs one map change before warmup. Your `rules` still win over
  that cfg — they are re-applied after it — so send the rounds you mean.

**The engine says which game it played** (since 0.27.0, PRD-05 T2d, #4). `going_live`
carries `engine: { gameType, gameMode }`, the `game_type` / `game_mode` the server read
when that map loaded, and `format`, which game that is: `0`/`1` is `competitive`, `0`/`2`
is `wingman` (`formatOfEngineGame`, MatchZy's own `IsWingmanMode` test), and anything else
(deathmatch is `1`/`2`) has no `format`. It is the engine's word, not your request echoed,
so comparing `going_live.format` with the `rules.format` you sent proves the format on
every match, with no RCON read (a node's RCON answers a convar read with nothing). They are
read at map load because that is when the engine applies them: a value set later decides
the next map, which is why MatchZy loads the map again for wingman. `server_ready.engine`
says the same per load, so a wingman match's first `server_ready` is the map before that
reload and its second is the one played; assert on `going_live`. A MatchZy flow's
`going_live` comes over MatchZy's own log, which knows no convar, so the orchestrator copies
the engine game from that server's last `server_ready`, and reads it back from the log
after a restart. Both fields are optional: a source that never read them leaves them off.

**`simulation` is a match played by puppets** (PRD-03 T4, decision 25): a body on the
server for every roster entry — or for the entries `simulation.puppets` names (PRD-04 T2) —
carrying that entry's SteamID and name, that connects, readies up through the match
plugin's own ready system, plays and leaves by the paths a human takes — so a client sees
exactly the facts a real match sends about exactly the players it rostered, with nobody at
a keyboard. It is not the `sim` block: `sim` steers
the simulator *provider*, where no server exists at all; `simulation` asks a real server —
rented, LAN or the simulator alike — to play without people, and **costs what a real
server costs**: the ledger row, the budget check and the reaper are exactly a real match's.
Four things a consumer needs to know:

- **Every fact says so.** `Match.simulated` is `true` and every gameserver event of the
  match carries `source.simulated: true`, stamped by the orchestrator whatever the server
  said — so a stats pipe, a board or a drop reads one field and never a request. A real
  match carries neither; nor does a match on the `sim` provider that did not ask for it,
  whose players are the simulator's own inventions and whose `source.provider` has
  always said so.
- **Who the puppets are is `simulation.puppets`** (PRD-04 T2, for the platform's PRD-11
  T23). Unsaid, every roster entry is a puppet — what every request written before the
  field asked for. A list of SteamID64s names the entries that are, and **the rest of the
  roster are people**, expected through the mode's ordinary door: a drop-in mode goes live
  on its own clock and they join it live like anybody else, and when they connect they are
  announced as the rostered players they are. **A `pug` waits for them at its ready gate**
  (PRD-04 T2b): the bots ready up, and the warmup holds until every person is on their
  side and ready (auto-ready does it for them when `rules.warmup.autoReady` is on). Nothing
  starts it without them, so a client that gives up on a person does what it does for any
  no-show: its join deadline, or `cancel`. A bot that turns up while such a seat is
  empty is never cast into it. A list that names everybody is the same request as no list.
  Three refusals, all `validation_failed`: a name the roster does not hold, on
  `simulation.puppets`; a partial list to a mode without `capabilities.mixedRoster`, on
  `simulation.puppets` (every bundled mode that seats puppets claims it since 0.22.0, so
  this refusal is for a mode that cannot); and a roster with nobody on it, on `teams` — a
  puppet is a roster entry made flesh. An empty
  list is not a way to ask for a real match and does not parse. The match is simulated
  however many of its players are people: `Match.simulated` and `source.simulated` say so on
  every fact, the human's included. On the `sim` provider the person's seat simply stays
  empty — the simulator has no door for a human and invents none — so a mixed `pug` on the
  simulator waits at the gate for the join deadline and a mixed drop-in mode is played by
  the puppets that came.
- **One scenario language.** `simulation.scenario` takes a name from `GET /v1/sim/scenarios`,
  the same catalog `sim.scenario` reads — what the puppets do beyond playing the match
  out. On the simulator it *is* the scenario played (and `simulation.timeScale` the
  story's speed where `sim.timeScale` says nothing); on a real server it is what the
  puppets are scripted to do, knob by knob. **A knob a real server cannot execute is
  refused, never silently ignored** (PRD-03 T11): a forced overtime, a scripted comeback,
  a box that dies on cue and a player who never readies are all `validation_failed` on
  `simulation.scenario`, and so is a knob the *mode's* match software cannot do — under a
  `matchzy` flow the bodies are MatchZy-Enhanced's and it seats and readies every
  configured entry itself. What a puppet does do: `absentPlayers` (a roster entry with no
  body, which the join deadline then gives up on) and `idle` (nobody is seated, and the
  mode's `length` or the join deadline ends it). `docs/sdk.md` has the table, knob by knob,
  and it is the table the refusal is read from. Naming a story in both
  blocks is fine when they agree and `validation_failed` on `simulation.scenario` when they
  do not; a name nobody defined is refused on whichever field named it. `sim.scenario` is
  never judged this way — that block steers the simulator, where every knob is executable.
- **Who may ask** is the `simulation` scope, above. The mode has to be able to: only a
  manifest with `capabilities.simulation` seats a puppet, and a request to any
  other is `validation_failed` on `simulation` at the door rather than a server waiting in
  warmup for players who are never coming.
- **Who seats them** depends on the mode and is nothing a client has to know: under `pug`
  it is MatchZy's simulation mode, under every other mode the SDK (PRD-03 T7, T10). Either
  way a puppet is the roster entry on the wire — its SteamID64, its
  name, its team — and in an SDK mode it is announced (`player_connected`, `player.joined`
  with `rostered: true`, the `presence` frame), reachable by `kick` and by a player token
  minted for the rostered id, and announced again when its seat is refilled. A plain bot
  is never announced and is `unrostered`. **All four bundled modes claim the capability**
  since T10, `retakes` last: what seats a puppet there is the engine's own `bot_add` and
  not the community plugin's queue, which keeps bots out of it. **The three the SDK seats
  claim `mixedRoster` too** (PRD-04 T2), and `pug` since 0.22.0 (PRD-04 T2b): the image
  runs our own fork of MatchZy-Enhanced, whose simulation mode spawns no bot for a seat the
  match file leaves to a person and waits for that person at the ordinary gate (decisions
  19 and 28).

**Wingman seats two a side, and the map is yours to name.** A roster with a third player
on a side is refused `validation_failed` on `teams.<side>.players`, because the engine's
wingman layouts hold two spawns for a team. This API keeps **no separate wingman map
catalog and never substitutes a map**: `maps[].map` is loaded as asked under `game_mode
2`. A Valve map that ships a wingman layout plays it (the short half, one bomb site); one
that ships none loads whole — legal and playable, but not the game a wingman player
expects, so name a wingman map (`de_lake`, `de_shortdust`, …) when that is what you mean.

Only a gamemode whose manifest says `flow: "matchzy"`, on `cs2`, can play wingman: the
switch travels in MatchZy's own match file, and a mode that runs its own flow has nowhere
to put it. Asking anyway is `validation_failed` on `rules.format` — never a match quietly
played as the other game.

**The ready gate counts the match, not a team.** `rules.warmup.minPlayersToReady` is how
many players **across both teams** must be ready before the match goes live, and
`minSpectatorsToReady` how many casters. A client computes both from the roster it already
holds — the platform's `gamemodeReadyGate` sends `min(players, seats, preset)` — and never
has to know which match plugin runs the server: MatchZy counts *per team*
(`GetTeamMinReady`), and the orchestrator's config builder halves the wire's number,
rounding up, on the way in.

**A gate below the roster is a real gate, not a formality.** Ask for eight on a 5v5 and
each side goes through at four ready with its fifth still silent — MatchZy-Enhanced reads
the per-team number as the gate itself, where stock only read it for `.forceready` — and
`team_ready` for that side travels at four, because that is when the server judged it
through. It is **not** a way to start a match short-handed: the side still needs its full
`players_per_team` bodies connected before any of this is read, so a player who never
arrives never brings the gate down to the rest (see the join deadline below). Ask for `0`
and every connected player must ready, which is the strictest the server offers.

The same builder sizes `players_per_team` from the **roster**, not from the gamemode's
`teamSize`: MatchZy passes a team only at `playerCount >= players_per_team`
(`ReadySystem.cs`), so a 1v1 sent with a five-a-side mode's number could never go live
however often the two typed `!ready` — which is exactly what happened on 2026-09-18. The
number is the *smaller* roster's length, because one number has to let both teams through
and a 2v1's single player is refused by anything larger; `playerCount == readyCount` is
what still makes everybody who is on the server say so. A match the request rosters nobody
for (bots, an open room) keeps the mode's own house.

**Nobody has to type `.ready`.** `rules.warmup.autoReady` defaults to **on** (PRD-03 T3a,
owner decision 2026-09-19): the match plugin readies each player a couple of seconds after
they pick a side and counts down out loud once the gate is passed, so a pug starts by
itself. It loosens nothing — **auto-ready decides only who has said yes, never whether the
match may start.** MatchZy-Enhanced still waits for every rostered SteamID to be connected
*and on its configured side*, and for the same `minPlayersToReady`
(`CheckAndAutoReadyPlayers` simulates the command; `IsLiveRequirementSatisfied` is what
decides). So a rostered player who never connects holds the match in warmup for ever, and
**the client's own join deadline is the only thing that gives up on them** — not the
server, not `.forceready`, which a loaded match ignores for a missing body. Set it to
`false` for a LAN where a captain wants the room to say so out loud; `.ready` and
`.unready` work either way, and a player who types `.unready` is left alone until they
type `.ready` again.

**A knife round nobody answers ends by itself**, and that one is not a request's to
choose. The server runs a sixty-second side-pick timer and picks at random when it
expires, because no match a client can build may hold a box until a human notices. For the
same reason `.gg` (a surrender vote) and forfeit-on-disconnect are off on every server of
ours: the Match API has no result that says either, and a server must not end a match in a
way its client cannot record.

**`lan` or `preferLan`.** `lan: true` is "the venue's own hardware or nothing" and refuses
the match `no_capable_server` when no node is enrolled; `preferLan: true` is "the venue's
first, a rented box otherwise" — the only field here that ranks candidates instead of
filtering them. A LAN night held before a node is enrolled wants the second.

**One demo upload URL, or one per map.** A presigned URL's signature covers the object key
it was drawn for, so there is no `{mapNumber}` template to fill in: a series that keeps
every map's demo draws one URL per map and sends them as `demoUploadUrls`. The entry whose
`mapNumber` matches the map being uploaded wins; `demoUploadUrl` is the fallback for every
map without one, which is exactly what a Bo1 always did. With only the single URL a series
uploads map 1 and leaves the rest on the server (a second PUT would overwrite map 1's
bytes), and the plugin says so in its log.

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
| `simulated`     | boolean | the players are puppets — the request carried `simulation` — and every gameserver event of the match carries `source.simulated: true`. The badge an admin page shows; `false` for a real match, and for a `Match` read from an orchestrator older than the field |

#### A server that never gets ready

A match stays `configuring` for at most `SERVER_READY_DEADLINE_MS` (three minutes, from
the moment it entered `configuring`) waiting for its server's `server_ready`. After that
it fails `provider_error` (`match.failed`), the server is released and leaves the fleet,
and `reason.detail` says why in words a person can act on: the plan's first map as you
sent it, then what the orchestrator last saw of the server. That is the provider's view
(for a node, the node and its container's state, and docker's error if there is one), then
the link's: whether the server ever said hello, and if it did, the state and map it last
reported, the last detail it gave (`plugins loaded`), and whether it is still connected.

```text
no server_ready on workshop/3084291314/aim_map within 180 s; nodes reports the server running (node devbox: container running); the link last said assigned on de_dust2 (plugins loaded), still connected
```

`detail` is for humans and logs. Branch on `kind`, never parse the words. The deadline is
exported so a client can keep its own provisioning timeout longer than it. The platform
gives up five minutes after its request, so the orchestrator's failure, with its reason,
arrives first. Three minutes also allows for a first-time workshop download: AIM Map
(112 MB) downloaded cold on the dev node in about 9 s. The fake's deadline is its own knob,
`readyTimeoutMs` (default 120 s), and its detail has the same shape.

### MatchCommand and MatchCommandResult

A discriminated union on `type`, every variant with a `correlationId` (the client's own
id; a retried command with the same id is not applied twice):

| Type            | Fields | Notes |
| --------------- | ------ | ----- |
| `pause`         | `kind?: tactical \| technical \| admin` | `applied` only once the server's own gamerules say the match stands; `invalid_state` when the match software refused it, the reason word first in `message` ([A pause that says no](#a-pause-that-says-no)) |
| `unpause`       | | the same answer, the other way round: `applied` once the match is running again |
| `restart_round` | | |
| `force_end`     | `reason?` | the match ends `force_ended` |
| `kick`          | `steamId64, reason?` | |
| `announce`      | `text` ≤512 | the plugin prints it, as the client wrote it and behind no prefix of ours; a sim echoes it as a `plugin_event`. Sanitized into one chat line first — control characters, `;`, `"` and `\` out, 127 code points — and `validation_failed` when nothing is left |
| `moment`        | `kind, steamId64?, tier, art?, text, inMs` | this happened to this player; the server decides how and when to show it. **A server without a HUD prints the line**, behind its own chat prefix. See [The HUD, from a client's side](#the-hud-from-a-clients-side) |
| `rcon`          | `command` | needs `admin`; `command_unsupported` on a sim |
| `restore`       | `roundNumber?` | **`live`**: the match is rewound on its own server to the start of that round of the map being played, the latest backup's round when unsaid — `applied` once the round has started again, `invalid_state` with the reason word first when the match software refused ([A restore on a live match](#a-restore-on-a-live-match)). **`recovering`**: the backup the replacement resumes from. `no_backup` when there is none; `invalid_state` in any other state |
| `reroll`        | | the match over on the same server, rosters kept |
| `reprovision`   | | the same match on **another box**: before `live` the server is released and the walk runs again for the same `clientMatchId`; from `live` it is the recovery a lost server starts by itself, started by hand (`match.recovering` → a replacement handed the newest backup → `match.recovered`). `no_backup` from `live` with nothing to resume from, `invalid_state` while `recovering` |
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

**`applied` is the server's word, not the relay's.** It means the match software did the
thing, not that the command reached a box and ran. A server that needs a moment to find
out holds the call while it looks (the orchestrator waits fifteen seconds for an answer,
which is longer than any of them take) and answers `rejected` when nothing happened. So a
client may read `applied` as the new truth and needs no confirming fact to believe it.
The fact is always there too — the server emits it before it answers — but it travels the
link, the durable log and the replay route while the answer comes straight back down the
call, so it lands on the stream moments after, not before.

#### The HUD, from a client's side

A server can draw on a player's screen: a welcome when they join, a toast and a card when
something happens to somebody (decision 34, `docs/hud.md`). A client never has to know
whether a given server can. It says three things, and every server takes all three.

**The switch** is `branding.hud` on the request, `false` by default. A server that was
started with the client addon's id hands the addon to the players of a match that says
`true` and draws for them. Every other server, and every match that leaves it off, says
the same things in chat. No `Match`, webhook or command result tells the two apart, and a
request with `hud: true` is accepted by an orchestrator none of whose servers can draw.

**The welcome** reads `branding.eventName`, `branding.tagline` and `branding.banner`.

**A `moment`** says what happened, and never how it should look:

| Field        | Type | Notes |
| ------------ | ---- | ----- |
| `kind`       | kebab name ≤32 | `drop`, `perk` and `raffle` are the ones a server dresses (`MOMENT_KINDS`). The set is open: a kind a server does not know is shown plainly, never refused |
| `steamId64?` | SteamID64 | the person it is about, when there is one. They need not be on the server or on the roster: everybody else still reads the line, and nothing waits for anybody |
| `tier`       | `common \| uncommon \| rare \| legendary` | how much it matters (`MOMENT_TIERS`, the platform's drop rarities). `common` when unsaid. A tier changes how a moment looks, never whether or when it is shown |
| `art?`       | key | the picture, by key |
| `text`       | `{ de: { everyone, you? }, en: { everyone, you? } }` | both languages, always; each line ≤512 and sanitized into one chat line like an `announce`. `everyone` is what the server reads, `you` what the person reads in its place. A player reads the language of their roster entry |
| `inMs`       | int, 0…60000 | how long after the server receives the command the moment is due. `0` when unsaid. **Relative on purpose**: the server's clock is not the client's, so a client that reveals the same win elsewhere at a time of its own says how far off that time is |

The answer does not wait for `inMs`. `applied` means the server holds the moment; a server
released before it is due shows nothing. `validation_failed` when nothing of a line
survives the chat sanitizer. `invalid_state` when the match has no server.

**A server without a HUD prints the line** when the moment is due, to each player in their
language and to the person in their own words. Unlike an `announce`, the line is the
server's to say: it goes out behind the match's chat prefix (`[EZPug]`, or the event's
name), so the words should carry no brand of their own, and prefix and line together are
cut to one chat line of 127 code points. A server with a HUD says the same line and draws
on top of it. A client
therefore sends a `moment` wherever it would have sent that `announce`, and falls back to
the `announce` only when the command itself is refused. One such case is worth knowing: a
server whose plugin predates `moment` cannot read the frame and does not answer, so the
call resolves `rejected` with `provider_unavailable` after fifteen seconds.

**Keys.** A picture in a HUD was compiled into the addon before the match, so a client
names one by key. `HUD_BANNER_KEYS` and `HUD_ART_KEYS` are every key the addon ships,
generated from the addon's own folders (`pnpm hud:keys`), for a picker. They are not what
the schema accepts: a key is any kebab-case name ≤64, and one the addon does not hold
shows the default picture (`HUD_DEFAULT_BANNER_KEY`, the house banner;
`HUD_DEFAULT_ART_KEY`, the empty card sleeve), never a refusal. `hudBannerKey(key)` and
`hudArtKey(key)` are that rule as functions. The art keys are the platform's house drop
pictures under their own names, the four `category-*` among them, so an item with a
picture of its own shows it and any other shows its category's.

#### A pause that says no

MatchZy-Enhanced refuses `pause` during halftime, after the last round and while a
timeout is running, and says so only in the server's chat. The plugin therefore watches
the gamerules for a beat after relaying the command and answers from what they did:
`applied` when the match stands, `invalid_state` when it does not, with the reason as the
first word of `message`, followed by `: ` and a sentence for a human. The words are a
closed set:

| Word | What it says |
| ---- | ------------ |
| `halftime` | the break between the halves; the match software refuses a pause there |
| `post_game` | the match is over and the scoreboard is up |
| `timeout_active` | a tactical or technical timeout is holding the match |
| `already_paused` | a `pause` for a match that is already standing |
| `not_paused` | an `unpause` for a match that is running |
| `not_live` | the match has not started; there is nothing to pause |
| `released` | the match ended while the server was being watched for the answer |
| `no_gamerules` | no map is loaded, so nothing could be asked |
| `round_over` | `restore` only: a round has ended and the next has not started — the one gap a restore cannot land in ([A restore on a live match](#a-restore-on-a-live-match)) |
| `unknown` | nothing paused and the gamerules name no reason |

A client that matches on the word matches on the word alone; the sentence after it is for
a human and may change. `unknown` is the one to retry: everything else is a state the
caller can see coming (the match's own `match_paused` / `match_unpaused` facts and its
state say it). On the `sim` provider a pause is the story's own and never refused.

#### A restore on a live match

`restore` on a `live` match takes it back to the start of a round on the server that is
playing it — the LAN case, a round somebody's machine crashed in, played again. The point
is a round of **the map being played** (the newest backup's map), `roundNumber` or the
latest backup when unsaid; the orchestrator resolves it from the backups the server itself
sent, so `no_backup` is answered before anything reaches the server. On a `matchzy` flow
the server loads MatchZy's own file for that round with MatchZy's own restore
(`matchzy_loadbackup`): its sides, scores, money and timeouts are the round's again.

**The answer is the server's, as for a pause.** MatchZy refuses a restore at halftime,
after the last round and while a tactical timeout runs, and says so only in chat, so the
plugin watches the engine after asking and answers:

- **`applied`** once a round has started since the ask with the rounds played the backup
  was written at. The call is held while the engine restarts the round — 268 ms end to
  end on the dev node, and never past the fifteen-second command deadline — and there is
  no `accepted` step to wait through; `applied` is the new truth.
- **`invalid_state`** when nothing was restored, with the same closed words as a refused
  pause in front of the message: `round_over`, `halftime`, `post_game`, `timeout_active`,
  `not_live`, `released`, `no_gamerules`, `unknown`. Three of them are said without asking
  the match software at all, because asking would do harm: **`round_over`** — the round has
  ended and the next has not started, and a backup loaded there leaves the engine waiting
  for a round restart that never comes (measured on the dev node: seven minutes, an
  `unpause`, nothing); `halftime` and `post_game` in that same gap; and `not_live` in warmup,
  where MatchZy would hold the file and apply it at the next match start instead.
  `round_over` and `halftime` pass — asking again once the next round is under way is the
  whole remedy, a few seconds later.
- **`command_unsupported`** where no match software keeps round backups (a mode whose flow
  is the SDK's) and on a simulated server.

**What follows on the stream**, moments after the answer:

- **`round_start`** with the restored `roundNumber` and the score that round started at the
  first time — a second `round_start` for a round number the log already holds — and from
  there on the match as it is played again: every `round_end` counts on from the rewound
  round.
- `plugin_event` **`backup_restored`** `{ mapNumber, roundNumber, filename }` — the same
  word a replacement server says when a recovery resumes, here on the same server. It
  comes over the server's link while `round_start` comes from the match software's own
  report, so **the two are not ordered**: on the dev node the `round_start` landed first.
  Read the rewind off the round numbers, and `backup_restored` as its label.
- `match_paused` — MatchZy holds a restored round until somebody lifts it
  (`matchzy_pause_after_restore`, its default): both teams' `.unpause`, or the Match API's
  `unpause`, which is the only one a room of puppets has.

The round the restore interrupted is not ended on the stream: the engine closes it with no
winning side, and that report is dropped.

The rounds after the point never happened now. The durable log keeps what it said about
them — it is a log — but the orchestrator forgets their backups, and so does the server:
a box lost later resumes the match being played, never the one that was rewound away. A
client drawing a timeline cuts it where a `round_start` names a round it has already seen.

### PlayerToken

`POST` body `{ steamId64, ttlSeconds (default 900, max 3600) }`; response `{ token,
matchId, steamId64, expiresAt }`. The token is what a gamemode widget opens its own socket
with (decision 17, [The widget socket](#the-widget-socket)) and what a browser subscribes
to the stream with. Minted for a rostered player, a player the server has seen join, or —
on an open-join mode — anyone; refused `player_not_in_match` otherwise and
`invalid_state` once the match is over. Shown once; the orchestrator keeps only its hash.

### Gamemode (the manifest)

The whole manifest, as `gamemodes/<id>/manifest.json` in the iron repo and as the catalog
serves it. `docs/gamemodes.md` explains every field; the wire shape is:

```
{ id, game, tier: config | plugin | sdk, title: {de, en}, description: {de, en},
  slots: { teamSize, teams, openJoin }, flow: matchzy | plugin | none,
  records: demo | events | none, ranked: false,
  maps: 'any' | { catalog: mapName[], workshop: workshopId[] },
  plugins: string[], cfg: string[], cvars: { [name]: string },
  capabilities: { positions, chat, playerCommands, widget, backups, scoreboardRating, simulation },
  commands: [{ name, title: {de, en}, description?: {de, en}, cooldownMs, charges: { count,
    per: life | round | map | match } | null, args?: <JSON Schema, type object> }],
  widget?: { entry, needs: (tokens | locale | playerToken)[], url? },
  version, sdkVersion }
```

`widget.url` is the orchestrator's addition to the manifest it serves (0.6.0): the absolute,
immutable, content-hashed address of the document the platform mounts
(`docs/gamemodes.md` "The widget host"). An authored manifest never carries it, the fake's
catalog never does (it serves no bundle), and an orchestrator without the mode's bundle
leaves it out — a host that finds none mounts nothing.

`GamemodeSummary` is the first line of it (`id … version`), for a client that only renders
a card. `ranked` is `false` by construction. The tier constrains the rest (a config mode
has no plugins, only an sdk mode has commands or a widget, capabilities agree with the
blocks that exist); a manifest that parses is one the loader can act on.

### WidgetHostMessage

The `postMessage` handshake between the platform's host frame and a gamemode's widget
(`docs/gamemodes.md` "The widget host"): `ezpug.widget.ready` and `ezpug.widget.size` and
`ezpug.widget.error` from the widget, `ezpug.widget.init` and `ezpug.widget.tokens` from
the host. `init` carries `{ protocol: 1, orchestratorUrl, matchId, locale, tokens:
{ '--css-property': value }, playerToken | null }`.

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

**`name` is at most 64 characters, and the mint enforces it** — not only the route.
`ApiKey.name` caps there, so a longer name written to the database is a key `GET /v1/keys`
can never list again: the response stops parsing and **every** caller of that database
gets `internal`, not just whoever minted it. The orchestrator's key service therefore
reads the create request against this schema at the write, wherever the caller came from,
and answers `validation_failed` with `details.issues` naming the field — the same for an
unknown scope and a budget outside its bounds. `@ezpug/match-api/fake`'s `mintKey` does
the same, so a dev world finds it at the mint rather than on the box.

## Routes

Paged lists take `?cursor=&limit=` (limit ≤200, default 50) and answer `{ items,
nextCursor }`; pass `nextCursor` back verbatim, it is opaque.

### `GET /v1/gamemodes`

Scope `matches`. `{ gamemodes: GamemodeManifest[] }` — the catalog the orchestrator ships,
whole manifests, `pug` first. Cache it; it changes with a release. The package exports the
same four as `SHIPPED_GAMEMODES`, which is what the fake serves.

### `GET /v1/gamemodes/:gamemodeId`

Scope `matches`. One `GamemodeManifest`; `not_found` for an id the orchestrator does not
ship.

### `GET /v1/capacity`

Scope `matches`. `Capacity`.

### `GET /v1/sim/scenarios`

Scope `matches`. `{ scenarios: SimScenario[], default }` — the scripted shapes this build's
simulator can play, and the one a `sim` block without a `scenario` gets. A `SimScenario` is
`{ name, neverReady, absentPlayers, crashAfterRound, pauses, idle, overtimes, comeback,
towerEnding }`: the knobs spelled out, so a console renders facts rather than a hard-coded
list. `towerEnding` (0.30.0) is how a tower map ends, `castle`, `clinch` or `convoy`, or null
for the dice; `rush-castle`, `rush-clinch` and `rush-convoy` set it, and it is ignored on a
map without a tower. `idle`
is the story where **nobody ever connects**, and what happens then is the *mode's*: a
`matchzy` mode holds its warmup open for ever, so the join deadline is the only thing
that gives up on it, while a mode whose flow the server's own plugin tells (`plugin`,
`none`) ends its warmup on its own clock — `going_live` on an empty server, then
`map_end` and `series_end` on whichever of its `length`'s clocks runs out first
(`reason: "idle"`, or `"time_limit"` where the duration is the shorter). A mode that
names no `length` at all plays on until the join deadline or the TTL. The simulator and a
real server tell that story the same way, beat for beat. Served whether
or not the `sim` provider is registered — this is what the build knows how to play, and
`GET /v1/capacity` is what says whether it could. `MatchRequest.sim.scenario` takes a
`name` from here, and so does `MatchRequest.simulation.scenario` — one scenario language,
whether the simulator plays it or puppets on a real server do; one that is not is
`validation_failed` on the match, on whichever field named it.

### `POST /v1/matches`

Scope `matches`. Body `MatchRequest`, answers `201 Match`. Idempotent on `clientMatchId`:
the same body again answers `200` with the same match; a different body under a used id
is `conflict`. Refused at the door with `unknown_gamemode`, `game_unsupported`,
`map_not_allowed`, `no_capable_server` or `budget_exceeded`.

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

Scope `matches`. Body `{ steamId64, ttlSeconds? }`, answers `201 PlayerToken`. The client
mints it because the client knows who is looking at the page; the widget never does.

### `GET /v1/matches/:matchId/events`

Scope `matches`. The webhook replay: query `cursor?` (default `"0"`) and `limit?`, answers
`{ items: WebhookEnvelope[], nextCursor }` in `seq` order. This is the one paged route whose
cursor is not opaque: it is **the `seq` to resume after**, as a decimal string, so
`Match.seq`, the stream's `hello.seq` and the last envelope you stored all plug in.
`nextCursor` is the last `seq` on the page; it is `null` only when the page reached the end
*and* the match is terminal. A live match never answers `null`. See [Webhooks](#webhooks).

### `GET /v1/matches/:matchId/stream`

Scope `matches`. A WebSocket upgrade, not a request: every message the socket sends is a
`StreamFrame`, the first one a `hello` — always, even when the match is publishing at the
moment you connect: the subscription is taken before the greeting is built, and anything
published in between waits behind it. **No `event` frame ever carries a `seq` at or below
`hello.seq`**, however late it arrives: the greeting's cursor is what you replay from, so a
frame it already covers would be the same fact twice. Authenticated by the bearer header, or by a player
token minted for this match in `?token=` for a browser. The typed client has no call for
it; `subscribeStream(matchId)` opens it. See [The stream](#the-stream).

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

Scope `fleet`. Query `state?`, `provider?`, `matchId?`, `since?` plus paging. Every row,
open and closed, newest first. `since` is **what tonight cost**: every row that was open at
or after that instant — still open now, or released at or after it — which is the window a
bill is asked over rather than the window a row was born in. A server allocated before
midnight and still running is part of tonight's; `GET /v1/fleet/budget` is this same read
with the first of the month.

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

### `POST /v1/keys/:keyId/rotate`

Scope `admin`. Draws the key a new secret and kills the old one on the spot — the answer
is `{ key, secret }`, the secret shown once, like a mint. Same id, scopes, budget and
webhook secrets; `invalid_state` for a revoked key. What an operator does when a key
leaked: rotate, then hand the new secret over, rather than mint a second key and leave
the first alive.

### `PATCH /v1/keys/:keyId/scopes`

Scope `admin`. Body `{ add?: Scope[], remove?: Scope[] }`, at least one of them non-empty;
the answer is the key. What an operator does when a key needs a capability it was not
minted with — before this route existed it was a hand-written `UPDATE` against production
(2026-09-21, the platform key and `simulation`).

Additive on purpose: the scopes that are not named do not change, so granting one on a
Saturday cannot take another away by accident. Both halves are idempotent — adding a scope
the key already holds, or removing one it never had, answers the key as it was. A scope on
**both** lists is `validation_failed`, and the published client refuses that body before it
reaches the wire. A removal that would leave the key no scopes at all is
`validation_failed` too: a key with none is a revoke under another name, and
`DELETE /v1/keys/:keyId` is the door for that. `invalid_state` for a revoked key, as with
`rotate`.

Nothing caches a key, so a scope granted here is in force on that key's very next request.

### `PATCH /v1/keys/:keyId/budget`

Scope `admin`. Body is the ceilings to move — any of `maxConcurrentServers`,
`maxServerLifetimeMinutes`, `monthlyCents`, at least one — and the answer is the key.
The ceilings that are not named do not change. A ceiling that moved is a new crossing:
the `fleet.budget_threshold` warnings for that key start over.

### `PUT /v1/keys/:keyId/webhook-secrets`

Scope `admin`. Body `{ secrets: [{ id, secret }] }` replaces the set. Answers the key.

### `PUT /v1/keys/:keyId/fleet-webhook`

Scope `admin`. Body `{ fleetWebhook: { url, secretId } | null }` — where the key's `fleet.*`
facts are POSTed, or `null` to send them with each match's own. `secretId` names one of the
key's registered webhook secrets; another one is `validation_failed`. Answers the key.

## Webhooks

Every durable thing the orchestrator has to say about a match is one **envelope**, POSTed
to the request's `callbacks.webhookUrl` as `application/json`:

```json
{
  "deliveryId": "0d3c1e2f-4a5b-4c6d-8e9f-000000000012",
  "matchId": "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b",
  "clientMatchId": "platform-match-4c1a2c7e",
  "seq": 12,
  "occurredAt": "2026-09-05T18:30:00.000Z",
  "payload": { "type": "round_end", "...": "..." }
}
```

| Field           | Meaning |
| --------------- | ------- |
| `deliveryId`    | names the envelope; a retry carries the same one |
| `matchId`, `clientMatchId` | the match, both ways |
| `seq`           | the match's own sequence: 1-based, gap-free, the order the orchestrator learned things. `Match.seq` is the last delivered |
| `occurredAt`    | the orchestrator's clock when it learned the fact, never a server's |
| `payload`       | a gameserver event or an orchestration fact, one discriminator (`payload.type`) |

**Idempotency**: `(matchId, seq)` names the fact. A consumer that has seen it already has
the fact whatever the `deliveryId`. Deliveries go out in `seq` order, but one stuck in
retries does not hold later ones back, so `seq` 12 may arrive before 11; a gap is closed
by replaying from the events route. A fact is never delivered under two sequence numbers.

### Payloads

**Gameserver events**: every type of the vocabulary except `position_tick`, which is
ephemeral and travels on the stream only. Same JSON as the vocabulary.

**Orchestration facts**, `domain.event` names (a dot, so they can never collide with an
event type):

| Type                         | Fields | When |
| ---------------------------- | ------ | ---- |
| `match.allocated`            | `provider, serverId, fleetServerId, region` | a server was obtained; the ledger row is open |
| `match.server_ready`         | `connect { host, port, password? }, tv, restored?, round?` | players may connect; `Match.state` is `ready`. Said again on a replacement server while `recovering`, then with `restored: true` and `round`, the round play resumes from |
| `match.recovering`           | `reason, backupRound` | the server was lost mid-match; a restore is being attempted. `backupRound` null means `match.failed` follows |
| `match.recovered`            | `serverId, fleetServerId, resumedFromRound` | `live` again, possibly on a new server (a new `match.allocated` and `match.server_ready` came first) |
| `match.failed`               | `state: failed, reason { kind, detail? }` | `kind ∈ server_lost, allocation_failed, provider_error` |
| `match.ended`                | `state: ended \| cancelled, reason { kind, detail? }, demo { uploaded, skipped? }` | `kind ∈ completed, force_ended, cancelled, ttl_expired`; the last envelope of a match that did not fail. `demo.uploaded` counts the maps whose demo reached the client's storage and `demo.skipped ∈ no_upload_url, not_recorded, no_demo, upload_failed` says why there were not more |
| `demo.uploaded`              | `mapNumber, key?, size, sha256, contentType` | the map's demo landed through `demoUploadUrl`; `sha256` lowercase hex |
| `player.joined`              | `player { steamId64, name, team? }, rostered` | a person is on the server; `rostered: false` in an open-join mode is the cue for a `profile` command |
| `player.left`                | `player` | |
| `fleet.provider_unreachable` | `provider, since, lastError` | the provider behind this match's server stopped answering probes |
| `fleet.node_disconnected`    | `node, lastSeenAt` | the node hosting this match's server dropped its link |
| `fleet.orphan_found`         | `provider, serverId, fleetServerId, released` | the reaper found a server still running for a closed row or an ended match |
| `fleet.budget_threshold`     | `limit, fraction, usage, limits` | the key crossed 80 % or 95 % of a ceiling (`maxConcurrentServers`, `maxServerLifetimeMinutes`, `monthlyCents`) |

The fleet facts are about a key's capacity, not one match, and still travel as envelopes:
the orchestrator fans each one out to every open match of the key it touches (the matches
on the provider or node, the match the orphan was obtained for, every open match for a
budget threshold), each in that match's own sequence. A key with no open match hears
nothing and reads the fleet routes instead.

**Where a fleet fact is POSTed.** A key that registered a fleet webhook
(`PUT /v1/keys/:keyId/fleet-webhook`) hears its four `fleet.*` facts there, signed with the
secret that registration named — one endpoint for the whole fleet, instead of a
subscription to every match's callback. The envelope is the same envelope, matchId, `seq`
and all, and the events route still replays it on the match. A key without one hears them
on each match's own `callbacks.webhookUrl`, exactly as before.

`going_live` is a gameserver event and is what moves `Match.state` to `live`; no fact
repeats it.

### Signature

```
X-EZPug-Signature: t=1767225600,kid=whsec-2026-09,v1=<hex hmac-sha256>
X-EZPug-Delivery: 0d3c1e2f-4a5b-4c6d-8e9f-000000000012
X-EZPug-Attempt: 1
```

- `v1` is HMAC-SHA256 over `t + "." + body`, `body` being the exact bytes received, keyed
  with the secret registered on the API key under `kid` (`PUT /v1/keys/:keyId/webhook-secrets`;
  the request's `callbacks.webhookSecretId`). Lowercase hex.
- `t` is unix seconds on the orchestrator's clock. Refuse a `t` more than **five minutes**
  from your own clock, either way, before computing anything. A retry is re-signed with a
  fresh `t`.
- A header may carry more than one `v1=` (an orchestrator-side rotation in flight); any one
  that verifies is enough. Unknown elements (`v2=`) are ignored.
- Rotation: register a new id, switch new match requests to it, keep verifying with both
  until the last match that named the old one has ended, then drop it.

`@ezpug/match-api/webhooks` ships `signWebhook` and `verifyWebhookSignature` (Web Crypto,
injected clock), so a consumer test can round-trip against the orchestrator's own signer.
A refused signature is answered `401` and never retried by the consumer.

### Retries

Any `2xx` within 10 seconds is delivered; the answer body is ignored. Anything else
(timeout, connection error, `5xx`, `429`, a `4xx`) is retried with the same `deliveryId`:

| Retry | 1  | 2   | 3    | 4     | 5     | 6   | 7   | 8   | 9   |
| ----- | -- | --- | ---- | ----- | ----- | --- | --- | --- | --- |
| after | 5 s | 30 s | 2 min | 10 min | 30 min | 1 h | 2 h | 4 h | 8 h |

Ten attempts in all, about sixteen hours; then the delivery is given up on. It is still in
the events route — nothing is lost, only late. **`410 Gone`** stops retries early and
stops every later delivery for the match: the endpoint said it no longer wants them. The
events route and the stream keep working. The constants are `WEBHOOK_RETRY_DELAYS_MS`,
`WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_ATTEMPT_TIMEOUT_MS`, `WEBHOOK_STOP_STATUS`.

### Handling one

`@ezpug/match-api/webhooks` is the consumer's whole half. A handler is four lines and two
rules:

```ts
import { createDeliveryDeduper, verifyWebhook } from '@ezpug/match-api/webhooks'

const deduper = createDeliveryDeduper(store) // your Redis, your table, a Map in a test

app.post('/hooks/ezpug', async request => {
  const body = await request.text() // the bytes, before anything parses them
  const result = await verifyWebhook({ headers: request.headers, body, secrets, clock })
  if (!result.ok) return new Response(null, { status: result.status }) // 401 or 400
  if ((await deduper.check(result.envelope)) === null) await handle(result.envelope)
  return new Response(null, { status: 200 })
})
```

- **Verify the bytes that arrived**, never a re-serialisation of the parsed JSON: the HMAC
  is over the body as sent, and a JSON round trip does not preserve key order. Read the
  body as text once, verify, then parse — the order `verifyWebhook` itself uses.
- **Answer fast.** A `2xx` inside ten seconds ends the delivery; anything slower is
  retried and your handler runs again. Do the work after the answer, keyed by
  `(matchId, seq)`.

`verifyWebhook({ headers, body, secrets, clock })` takes headers as a `Headers`, Node's
`req.headers` or a plain record, and answers `{ ok: true, envelope, secretId, deliveryId,
attempt, timestamp }` or `{ ok: false, reason, status, message }` — `reason` being
`missing_header | malformed_header | stale_timestamp | unknown_secret | signature_mismatch`
(`401`) or `invalid_body` (`400`). Refusing is not a retry request: the orchestrator
retries a refused delivery on the schedule above anyway, so a consumer whose secret was
wrong for a minute loses nothing. `parseEnvelope(raw)` is the parse alone, for a replay
from your own store or from the events route.

`createDeliveryDeduper(store)` records **two** keys per envelope — `delivery:<deliveryId>`
and `fact:<matchId>:<seq>` — and answers `null` (new, handle it), `'duplicate_delivery'`
(a retry) or `'duplicate_fact'` (the same fact through another path). Two keys because the
webhook, the stream's `event` frame and the events route all carry the same envelope: one
deduper in front of all three is what makes taking all three safe. The store is yours
(`{ has, add }`, sync or async); keep entries longer than the retry schedule's sixteen
hours. `createMemoryDeliveryStore()` is the `Map` version for tests.

## Demos

The orchestrator never sees a byte of a demo (decision 10). The request carries a
presigned PUT — one in `callbacks.demoUploadUrl`, or one per map in
`callbacks.demoUploadUrls` — the **server** puts the file there, and the orchestrator
relays a fact about what landed:

1. The server finishes recording (MatchZy for a `matchzy` flow, the SDK for any other),
   waits for the file to stop growing, PUTs it at the URL for **that map** — its entry in
   `demoUploadUrls`, else the single `demoUploadUrl` — and says `demo_available` with
   `filename`, `sizeBytes`, `sha256` and `contentType`.
2. The orchestrator relays `demo.uploaded` with those numbers and the object `key` it
   reads out of the URL's path. A `demo_available` **without** `sha256` is honest news
   that a demo exists on a server and nowhere else — no `demo.uploaded` follows it.
3. `match.ended` carries `demo`: `uploaded`, how many maps' demos landed, and `skipped`,
   why there were not more (`no_upload_url`, `not_recorded`, `no_demo`, `upload_failed`).

**Only a `records: demo` gamemode ever says `demo_available`.** A `powerup-dm` or a
`flying-scoutsman` server keeps its durable events and writes no file, so nothing is
announced, no match holds its server open waiting for one, and `match.ended` says
`skipped: "not_recorded"`. That is true of real hardware, of the `sim` provider and of the
fake alike — a mode's `records` is what decides, never the provider.

**A series without a URL per map keeps only its first map's demo.** A presigned URL
addresses one object, so a second PUT at the same one would overwrite what is already
there; the plugin refuses to and says so in its log, and `match.ended` counts the demo it
did hand over. Draw one URL per map (`demoUploadUrls`) and every map's demo travels.

**A match that records a demo stays `live` past its own `series_end`** until the demo is
announced or the orchestrator's demo window (six minutes) runs out. GOTV records the
*delayed* broadcast, so a `.dem` is only complete a `tv_delay` after the last round —
and `match.ended` releases the server the file is still being written on. A client that
watches `Match.state` sees `live` for a couple of minutes after `series_end` reaches its
webhook; the series is over, the demo is not.

Name neither URL and none of this happens: no upload, no `demo.uploaded`, and
`match.ended` says `demo: { uploaded: 0, skipped: 'no_upload_url' }`.

## The stream

`GET /v1/matches/:matchId/stream`, a WebSocket upgrade, one socket per match per
subscriber, the orchestrator speaking, the subscriber silent. It carries what a webhook
cannot (position ticks, never stored) and mirrors what a webhook also carries, so a live
page needs one socket and no polling. It is **best effort**: a missed frame is gone from
the stream and is fetched from the events route instead; the stream never replays.

Every message is one JSON frame with a `type`:

| Frame            | Fields | Meaning |
| ---------------- | ------ | ------- |
| `hello`          | `matchId, seq, state` | the first frame: the match's current `seq` (compare with the last you hold and replay the gap) and its state |
| `event`          | `envelope: WebhookEnvelope` | every durable fact, as the webhook carries it, `seq` and `deliveryId` included — one deduper serves both paths |
| `tick`           | `ticks: position_tick[]` (1…64) | the ephemeral tier, batched |
| `command_result` | `result: MatchCommandResult` | the late answer to a command acknowledged `accepted`, same `correlationId` |
| `presence`       | `players: [{ steamId64, name, team? }]` | who is on the server, whole, every time it changes; spectators included |

**The utility layer rides on the tick** (since 0.26.0, ezpug/ezpug-iron#5). Beside
`positions`, a `position_tick` may carry:

- `grenades: [{ id, kind, x, y, z, state, radius?, steamId64? }]`, every grenade flying or
  active at that instant. `kind` is `he | flash | smoke | molotov | incendiary | decoy`,
  the same six names as a replay's. `state` is `flying` in the air, and `active` while it
  occupies space: a smoke from its bloom until it clears, a fire while it burns (at the
  centre of its flames). A flash, an HE and a decoy are `active` in exactly one tick, where
  they went off. After that a grenade is simply absent. `radius` is how far an active smoke
  or fire reaches, in world units. `id` is stable for the grenade's life, so follow it from
  tick to tick.
- `bomb: { state, x, y, z, steamId64?, site? }`: `carried` (and by whom), `dropped` or
  `planted` (and on which site).

A source that samples utility sends `grenades` on **every** tick, empty when nothing is in
the air, so a missing `grenades` means "not sampled": draw no utility layer then. With
`grenades` present, a missing `bomb` means no bomb is in play (a mode without one, before
the round hands it out, and after `bomb_exploded` or `bomb_defused`). The core plugin
samples both on every node and on Dathost. The simulator throws a smoke or two a side per
round, sometimes a flash, an HE or a fire, and carries the bomb on a T; at its default
5-second tick a grenade's flight is usually between two ticks, so a simulated smoke mostly
shows up already standing. Like every tick, none of it is ever stored.

**Authentication**: the API key as `Authorization: Bearer` from a server; a browser cannot
set headers on a socket and passes a player token minted for this match as `?token=`. The
origin of a browser socket must be in the request's `callbacks.streamAllowedOrigins`.

**Close codes** (`STREAM_CLOSE_CODES`): `4000` the match ended (the `event` frame with
`match.ended` or `match.failed` came first), `4001` unauthorized, `4003` forbidden (scope,
token for another match, origin), `4004` no such match, `4008` slow consumer (frames were
dropped; reconnect and replay). Reconnect on a network close (`1006`), never on these.

### `GET /v1/widget`

A WebSocket upgrade, not a request, and not one the typed client opens: a gamemode's widget
opens it with the player token the host injected, in its first frame. Declared under the
`matches` scope because that is what the token's minting key needed; no API key is
presented on the socket. See [The widget socket](#the-widget-socket).

## The widget socket

Decision 17: a gamemode's widget opens **its own socket** to the orchestrator, `GET
/v1/widget`, with the player token the platform's host injected (`docs/gamemodes.md` "The
widget host"); taps become player-scoped commands relayed to the plugin; gameplay traffic
never touches the platform. Unlike the stream, this socket goes both ways. Every message is
one JSON frame with a `type`; `WidgetClientFrame` up, `WidgetServerFrame` down.

Up, from the widget:

| Frame     | Fields | Meaning |
| --------- | ------ | ------- |
| `hello`   | `protocol: 1, token` | the first frame, and the only place the token ever appears — never in the URL, so it is never in a request log or a browser history |
| `command` | `correlationId, command, args?` | a tap: a verb the manifest's `commands` declares, `args` validated against the verb's schema before sending (`validatePlayerCommandArgs`, the same check the plugin runs) |

Down, from the orchestrator:

| Frame            | Fields | Meaning |
| ---------------- | ------ | ------- |
| `hello`          | `protocol: 1, matchId, steamId64, gamemode, state, locale?, commands` | the answer to the widget's: who the token is for, where the match is, the player's locale when the roster knows it, and every declared verb as `WidgetCommandState` — the manifest's spec plus `chargesLeft` (`null` for a verb without charges) and `readyInMs` as last learned from the plugin; a hint for the button, never the truth |
| `event`          | `envelope: WebhookEnvelope` | every durable fact of the match from then on, as the webhook carries it, so a widget follows a death or a round without a second socket. The position-tick firehose never crosses it |
| `command_result` | `correlationId, command, status, code?, message?, cooldownMs?, chargesLeft?` | the answer to a tap: `applied`, or `rejected` with a code from `WIDGET_COMMAND_REFUSALS` and a `message` in the player's language the widget may show as it is |
| `push`           | `name, data` | **a moment the gamemode gave this one phone** (0.7.0): mode-defined, addressed to the SteamID64 the token was minted for, relayed from the server's link without being read, and gone — never logged, never in `match_events`, never replayed to a widget that reconnects. `name` is the mode's own snake_case word, `data` its own shape, up to `WIDGET_PUSH_DATA_MAX` (16 KiB) of JSON; a widget that does not know a `name` ignores the frame. `powerup-dm`'s `radar_peek` is how five seconds of enemy positions reach a phone without a position ever being stored |

**Refusals.** `cooldown` (with `cooldownMs`), `no_charges`, `unknown_command`,
`invalid_args`, `not_in_match`, `not_alive`, `refused` are the plugin's — the SDK enforces
the manifest's cooldowns and charges before the mode sees the tap (`docs/sdk.md` "Player
commands"), and the mode may still say no. `rate_limited` (with `cooldownMs`), `not_live`
and `unavailable` are the orchestrator's, refused at the door: a token has a bucket of
`WIDGET_COMMAND_RATE_LIMIT` (ten taps, two more a second), a tap before the match is `live`
or after it ended has no server to reach, and a server that does not answer inside the
relay deadline is `unavailable` — try again.

**A tap that was applied leaves a `plugin_event` in the durable log**: the mode's own
(`powerup-dm` emits `powerup_claimed`), and on a simulated server the stand-in mode's
`player_command` with `data: { command, steamId64, name?, args? }`. That is how the
platform proves a tap without a socket and how a widget sees its own tap land: the same
envelope arrives as an `event` frame and as a webhook.

**A push is not an event.** A durable fact is an `event` and survives in the log; a push is
a picture with a shelf life, delivered to whoever is looking and dropped when nobody is. A
mode's plugin sends one with the SDK's `PushWidget` (`docs/sdk.md`), a widget reads it with
`link.onPush` (`@ezpug/gamemode-kit`), and the fake's `widgetPush(matchId, steamId64, push)`
is the door a test opens — the simulated server has no mode of its own to decide when a
push is due.

**Close codes** (`WIDGET_CLOSE_CODES`): `4000` the match ended (the `event` frame with
`match.ended` or `match.failed` came first), `4001` no token, one that does not verify,
expired, or whose match was over before the `hello`, `4002` a protocol this orchestrator
does not speak, `4003` a frame that does not parse or a first frame that is not `hello`,
`4005` an origin not in the request's `callbacks.streamAllowedOrigins`, `4008` slow
consumer, `4009` no `hello` within `WIDGET_HELLO_TIMEOUT_MS` (ten seconds). Reconnect on a
network close (`1006`), never on these. A token dies with the match: every socket it opened
is closed `4000`, and it opens nothing afterwards.

## The client

`@ezpug/match-api/client` is generated from the same route table the orchestrator serves,
so a call cannot disagree with it about a path, a method or a shape:

```ts
import { createMatchApiClient } from '@ezpug/match-api/client'

const client = createMatchApiClient({ baseUrl: 'https://gs.ezpug.com', apiKey, clock })
const match = await client.matches.create({ body: request })
```

Every non-2xx is thrown as an `ApiError` with the envelope's `code`, `message`, `details`
and the HTTP status. A request that produced no answer at all after its attempts is a
`TransportError` with the last `cause` — the one error that is not the orchestrator's
verdict about anything.

**Idempotency.** An unsafe call whose body names its own key sends it as
`Idempotency-Key: <route key>:<body key>` — `matches.create:platform-match-1`,
`matches.command:<correlationId>`. The orchestrator answers a repeat of a key with the
first answer instead of doing the thing twice. A mint (`player-tokens`, `keys`) names
none: it makes a new secret every time, and repeating one is the caller's decision.
The header mirrors the body, so this round nothing has to read it: the fake (and the
orchestrator PRD-02 grows) keys a create on `clientMatchId` and a command on
`correlationId` and answers a repeat with the first answer. What the header adds is a
retry key that survives a body the orchestrator never got to parse.

**Retries** happen on the injected clock, never on a wall clock:

| Retry | 1     | 2     | 3     | 4      |
| ----- | ----- | ----- | ----- | ------ |
| after | 200 ms | 800 ms | 3.2 s | 12.8 s |

Five attempts, about seventeen seconds (`CLIENT_RETRY_DELAYS_MS`, `CLIENT_MAX_ATTEMPTS`).
A `Retry-After` on the answer wins over the schedule, capped at
`CLIENT_RETRY_AFTER_MAX_MS` (60 s). Two rules decide whether an attempt is repeated at
all:

- **The request must be safe or idempotent**: a `GET`, or one carrying an
  `Idempotency-Key`.
- **The answer must be weather**: no answer at all, a `429`, or any `5xx`
  (`isRetryableStatus`). Everything else is a verdict and stands — a `402 budget_exceeded`
  is money, and repeating it only wastes the ceiling it just refused.

`retry: false` attempts everything once; `retry: { delaysMs, retryAfterMaxMs, onRetry }`
tunes it. `createRetryingFetch({ clock, ... })` is the same behaviour as a plain `fetch`
wrapper.

**The stream** is an upgrade, so it is not a call on the client but
`client.subscribeStream({ matchId, onFrame })`, which returns `{ url, closed, close() }` —
`closed` resolving with the close code (`STREAM_CLOSE_CODES`). It does not reconnect and
does not buffer: a frame that never arrived is fetched from the events route, and only the
caller knows whether it still cares. On Node, pass `WebSocket` from `ws` so the API key can
travel as a header; a browser gets a player token and subscribes with `?token=`.

## The fake

`@ezpug/match-api/fake` is the orchestrator without a network: every route of the table,
in-process and over HTTP, matches played by the simulator engine on an injected clock,
webhooks signed with the scheme above and retried on the schedule above, the stream as a
subscription and as a WebSocket upgrade, a ledger and budgets that refuse. The platform's
tests and its history seed run on it; the conformance suite runs on it first and on the
real orchestrator second, and where the two disagree the recorded fixture decides.

```ts
import { createFakeClock } from '@ezpug/core'          // or any { now, date, after, at, sleep }
import { createFakeOrchestrator } from '@ezpug/match-api/fake'

const clock = createFakeClock()
const fake = createFakeOrchestrator({ clock, webhooks: { deliver: request => 200 } })
const { secret } = fake.mintKey({
  name: 'platform', scopes: ['matches'],
  budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
  webhookSecrets: [{ id: 'whsec-test', secret: 'a-test-secret-of-at-least-thirty-two-chars' }],
})
const client = fake.client(secret)                     // the same surface as the HTTP client
const match = await client.matches.create({ body: request })
await fake.playOut()                                   // the whole Bo1, its webhooks, their retries
```

**Doors.** `fake.client(apiKey)` is the typed in-process client (`ApiClient<typeof
matchApiRoutes>`, interchangeable with `createMatchApiClient`). `fake.handler` is a Hono app
with every route, for `handler.request()` in a test or mounting anywhere. `fake.listen()`
serves it over Node HTTP on a free port and performs the stream upgrade with `ws`; close it
before the test ends. `fake.stream({ matchId, apiKey | token }, onFrame, onClose)` is the
stream in-process; `fake.widget(token, onFrame, onClose)` is the widget socket in-process
(the `hello` arrives at once, `command(frame)` answers with a `command_result`, `close()`
hangs up). `fake.admin` is a root `admin` key minted at creation; `fake.mintKey()`
mints without the route. Every refusal is an `ApiError` with the code and status from the
error table.

**Options.** `clock` (required) and `prng` (seeded `ezpug-fake` by default) decide
everything: ids, tokens, passwords, timings. `gamemodes` overrides the catalog (default:
the four shipped manifests). `providers.sim` shapes the one provider: `capacity` (8),
`region` (`sim`), `hourlyCents` (0, so a monthly ceiling can be reached when set),
`allocateDelayMs` (1 s), `bootDelayMs` (4 s), `heartbeatIntervalMs` (10 s),
`positionTickIntervalMs` (5 s), `readyTimeoutMs` (120 s), `heartbeatTimeoutMs` (30 s),
`recoveryTimeoutMs` (5 min), `autoRecover` (true), `tvDelaySeconds` (90). `webhooks.deliver`
receives every POST (`{ url, headers, body, envelope, attempt }`) and answers a status;
without it the fake POSTs with `fetch` (injectable, also used for the demo `PUT`).
`gsltTotal` fills `GET /v1/fleet/gslt`. `onError` hears what went wrong off the request path.

**How a match plays.** Create writes the ledger row and answers `allocating`; after
`allocateDelayMs` the provider answers (`match.allocated`, `serverId` `sim-N`, host
`sim-N.sim.invalid`, ports 27015 and 27020) and the engine is assigned; after `bootDelayMs`
`server_ready` arrives and the match is `ready` (`match.server_ready` with a `fake-join-…`
password); `going_live` makes it `live`; every durable event is an envelope, every
`player_connected` is followed by `player.joined` (`rostered: false` for a player the fake
invented to fill an open-join roster), a `demo_available` on a `records: demo` mode is
followed by the `PUT` to `demoUploadUrl` and `demo.uploaded` with the recording's real size
and SHA-256; `series_end` ends the match `completed`, the row is released and
`match.ended` is the last envelope. `ttlMinutes` ends it `ttl_expired` regardless. A server
that says nothing for `heartbeatTimeoutMs` is lost: `match.recovering` with the newest
backup's round, a new row and server, `match.allocated`, `match.server_ready`, then
`match.recovered` on its `going_live` — or `match.failed` `server_lost` when there is no
backup. With `autoRecover: false` the match waits in `recovering` for a `restore` command.

Everything of one match runs in order on one queue, so the envelope order does not depend
on how the clock is advanced; `fake.playOut()` (fake clock only) runs timers and in-flight
work until the world is quiet, `fake.settle()` waits for in-flight work alone. Same clock,
seed and options: same envelopes, same deliveries — the recorded fixtures rely on it.

**Commands on a simulated server.** `announce` is echoed as a `plugin_event`
`chat_announced` — as are the request's `warmupLines`, one every eight seconds between
`server_ready` and `going_live`, which is what a real plugin prints in the same window;
`moment` is held for its `inMs` on the fake's clock (not divided by the time scale) and
then said as a `plugin_event` `moment_shown` with `{ kind, tier, steamId64?, art?, text }`,
the lines sanitized, so a test can prove a moment landed where it was meant to; `pause` parks the story (and the loss detector) and emits `match_paused`,
`unpause` resumes with `match_unpaused`; `force_end` ends `force_ended`; `kick` removes a
present player (`player_disconnected`, `player.left`); `profile` teaches the server a
player; `restore` works while `recovering`, and on a `live` match resolves its point
(`no_backup` before the first backup) and is then `command_unsupported`, as are
`restart_round`, `reroll` and `rcon` (a scripted story cannot restart or rewind, a sim has
no RCON); the `sim.*`
family drives the engine and answers with its `sim` status (`sim.step` also `stepped`).
Every result is also a `command_result` frame. A `correlationId` seen before returns the
first result.

**Fault knobs** (`providers.faults` at creation, `fake.setFaults()` later): `allocationRefused`
(every create is `no_capable_server`, no row), `bootNeverEnds` (the ready deadline fails the
match `provider_error`), `crash: { afterRound, backup }` (the server dies after that round's
`round_end`; with `backup: false` the match fails `server_lost`), `webhookDuplicates` (every
delivery POSTed twice, same `deliveryId`), `webhookOutOfOrder` (even `seq`s wait a second so
odd ones overtake them), `webhookFailures: N` (the next N attempts fail with a synthetic 503
before reaching the endpoint), `providerDown` (creates are `provider_unavailable`, capacity
unhealthy, every open match hears `fleet.provider_unreachable`; `fake.providerDownFor(ms)`
clears it on the clock). `fake.deliveries(matchId?)` lists every attempt with its status
and outcome.

**The widget door.** `fake.playerCommand({ token, command, args? })` takes a player token
and a command the gamemode's manifest declares and answers with the `plugin_event` the
simulated server's stand-in mode emits: `name: "player_command"`, `data: { command,
steamId64, name?, args? }`. The stand-in mode is the SDK's command table in TypeScript
(`@ezpug/sim`): cooldowns and charges **are** enforced, per period (`life` refills when the
player's death is dealt, `round` on `round_start`, `map` on `going_live`), args are
validated against the verb's schema, a SteamID64 off the roster is `not_in_match` unless
the mode is open join, and only an applied tap spends a charge. A refusal is an `ApiError`:
`command_unsupported` for an undeclared verb, `validation_failed` for bad args,
`player_not_in_match`, `rate_limited`, `invalid_state` for a cooldown, no charges or a
match that is not live — `details.code` carries the socket's own refusal code. What the
table cannot check is `not_alive`: a simulated player has no health. `fake.widget()` and
`fake.listen()`'s `/v1/widget` upgrade speak the socket's frames over the same door.

What is refused at the door, in order: idempotent replay or `conflict` on `clientMatchId`;
`validation_failed` for a `webhookSecretId` not registered on the key or an unknown
`sim.scenario`; `unknown_gamemode`; `no_capable_server` for `csgo`; `game_unsupported`;
`map_not_allowed`; `budget_exceeded` (concurrent, then lifetime, then monthly when the
provider has a price); `no_capable_server` for `lan`, another `provider`, another `region`,
a drained provider, `allocationRefused` or exhausted capacity; `provider_unavailable` while
down.

## The conformance suite

`@ezpug/match-api/fixtures` carries the flows every implementation of this document must
survive, the runner that drives them, and the recorded exchanges they produced. It is the
seam test: it runs against the fake here, against the real orchestrator in PRD-02, and
against whatever fake the platform pins. If the three disagree, the recorded fixture
decides.

```ts
import { createFakeConformanceTarget } from '@ezpug/match-api/fake'
import { assertConformance, runMatchApiConformance } from '@ezpug/match-api/fixtures'

// A fresh implementation per flow — the crash flows arm fault knobs.
assertConformance(await runMatchApiConformance({ target: () => createFakeConformanceTarget() }))
```

**The target** is what the suite drives. Three things are required: `client` (the typed
client of the route table, however it was built), `webhooks(handler)` (every delivery the
implementation made *for this key*, verified, returning the unsubscribe) and `callbacks`
(the `webhookUrl` and the registered `webhookSecretId` every flow puts in its request, and
an optional `demoUploadUrl`). Everything else narrows what can be asked of it: `clock`,
`advance(ms)` (let the implementation's time pass — a fake clock advances, a real one
sleeps), `settle()`, `faults()`, `playerCommand()`, `stream()`, `budget` (a second key with
a lower lifetime ceiling), `simulation` (a key holding the `simulation` scope beside
`matches`, while `client` must not), `pollIntervalMs`, `maxWaitMs`, `close()`. A flow that needs a
capability the target does not offer is **skipped with a reason**, never failed — a
production orchestrator has no crash knob.

**The flows**, in order: `happy-bo1` (a Bo1 on `pug`: idempotent create, ready with connect
facts, live, an announce replayed by its `correlationId`, a pause and an unpause, the demo,
`match.ended`), `config-only` (`flying-scoutsman`: a `config`-tier mode plays and uploads no
demo), `open-join` (`retakes` with empty rosters: `player.joined` with `rostered: false`),
`player-command` (`powerup-dm`: a player token, a widget's tap, the `plugin_event` back),
`cancel-allocating`, `crash-restore`, `crash-lost`, `csgo-refused`, `mode-owned-rules` (`rush`
refuses a request with `rules`, `validation_failed` on `rules`), `wingman-format`,
`simulation-switch` (a puppets request is `forbidden` by scope name on the suite's own key,
`validation_failed` on a mode the catalog says cannot seat them and on a scenario nobody defined, and
on the scoped key plays a Bo1 whose `Match.simulated` and every `source.simulated` are
`true`), `budget-refused`, `moment` (a request with `branding.hud`, a tagline and a banner
key nobody drew goes live like any other; a moment about a player and one with an unknown
kind, an unknown picture and a time of its own are both taken; a simulated server says
each once, as told), `webhook-replay` (the cursor walked to the end equals the tail)
and `stream-hello` (the `hello.seq` agrees with the events route, and every `event` frame is
an envelope the route also has).

**The report** is data, not a test framework: `{ ok, results, passed, failed, skipped }`
with a named check list per flow. `formatConformanceReport` prints it, `assertConformance`
throws it. `@ezpug/match-api/fixtures/vitest` (this repo only, not published — it is the
one file that imports Vitest) turns it into one `it()` per flow.

**The recorded fixtures** live at `fixtures/recorded/<flow>.json` in the package (published,
importable as `@ezpug/match-api/fixtures/recorded/happy-bo1.json`): every call with its
input and its answer, every envelope in `seq` order, the arrival order of the deliveries,
and the stream frames. They are what the fake produces under its fixed clock and seed, and
a test asserts it still produces them byte for byte — the goldens PRD-02's generated C#
types round-trip and the platform's translator is proven against. Secrets are redacted by
field name (`password`, `token`, `secret`, `apiKey` → `"<redacted>"`) and a test greps the
files for the fake's known prefixes. Re-record with `pnpm --filter @ezpug/match-api record`,
read the diff, and ship it with the change that caused it.

## Versioning and releases

The package is the contract, so a change to a schema is a **release with a changelog
line**, never a silent edit (decision 24). `packages/match-api/CHANGELOG.md` is that line's
home; `## Unreleased` collects them until someone cuts a version.

Semver, read against a *consumer of the API*:

| Change                                                                     | Bump  |
| -------------------------------------------------------------------------- | ----- |
| A new optional field, a new route, a new event or fact, a new error code    | minor |
| A new published file — a conformance flow, a hardware recording             | minor |
| A field becoming required, a removed or renamed field, a narrowed enum      | major |
| A doc comment, a re-recorded fixture, the fake's behaviour under an unchanged contract | patch |

While the version is `0.x`, a minor is the breaking bump — pin exactly.

The two fixture rows are one distinction and it is worth spelling out: **re-recording** a
file that already shipped is a patch (0.10.1), because a consumer's `import` resolves to
the same path and only its bytes moved; **adding** one is a minor (0.10.0, 0.11.0), because
a file that was not there is something a consumer can now import. Neither ever touches a
schema, which is why both say so in their changelog entry.

`GAMESERVER_EVENT_CONTRACT_VERSION` is a *separate* number and moves only when the
gameserver event union itself changes shape; it is the platform's and the plugin's
compatibility check, not npm's.

Cutting one:

```sh
node scripts/release.mjs version 0.2.0   # bump + roll the CHANGELOG, print the tag
pnpm verify:extended                     # the conformance suite is the gate
git commit -am 'chore(match-api): 0.2.0'
git tag match-api@0.2.0 && git push origin match-api@0.2.0
```

The tag fires `.github/workflows/release.yml`, which re-runs `pnpm verify:extended`, packs
with pnpm (so `catalog:` versions and `publishConfig.exports` resolve — `npm pack` does
neither, and its tarball would be broken on install), audits the tarball, and publishes it
with `npm publish --access public --provenance`. `node scripts/release.mjs publish` is the
same path locally for an owner who is `npm login`ed; `node scripts/release.mjs check` is
the audit alone and runs in `pnpm verify:extended` on every box. `publish` and `smoke`
take `--registry <url>` (or read `npm_config_registry`) for a registry that is not npmjs —
the box's own Verdaccio is where this repo's dev world reads the package from.

The audit refuses: an unresolved `catalog:`/`workspace:` range, a `@ezpug/*` dependency
escaping to a consumer (`core`, `gamemodes` and `sim` are bundled into `dist`), a file
outside the `files` whitelist, `src/` in the tarball, an entry point whose target is not
packed, a version with no CHANGELOG section, and anything `publint --strict` or
`arethetypeswrong` (`node16` + `bundler`; `esm-only`, the package ships no CJS on purpose)
objects to.

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
- `PlayerToken`, `Capacity`, the whole fleet family, `ApiKey` and webhook secret
  registration, the scopes, the error code set and its status table.
- The gamemode manifest, whole (decision 14 named the fields; the platform had none):
  `tier`, `flow`, `records`, `slots`, `maps` and its `map_not_allowed`, `plugins`, `cfg`,
  `cvars` and the protected list, `capabilities`, `commands` (cooldown, charges per
  life/round/map/match, JSON-Schema args), `widget.needs`, `version`, `sdkVersion`; the
  four shipped manifests; the widget host handshake (`WidgetHostMessage`, protocol 1).
  The map identifier grammar (`maps.ts`) is the platform's, verbatim.
- The webhook envelope and its identities (`deliveryId`, `(matchId, seq)`, `occurredAt`);
  the thirteen orchestration facts; the fan-out rule for fleet facts; the signature
  scheme (`t`, `kid`, `v1`), the five-minute window, the retry schedule and the `410`
  rule; the events route's transparent cursor. The platform's ingestion vocabulary
  (`accepted | duplicate | ephemeral`, `applied`) stays on the plugin↔orchestrator side.
- The stream frames (`hello`, `event`, `tick`, `command_result`, `presence`), `?token=`
  for browsers and the close codes. The platform's own realtime channels are unrelated.
- The client's half: the `Idempotency-Key` header and the `<route key>:<body key>` format,
  the retry policy (`CLIENT_RETRY_DELAYS_MS`, `CLIENT_RETRY_AFTER_MAX_MS`, the safe-or-keyed
  rule), `TransportError`, `subscribeStream`. The consumer's half: `verifyWebhook`'s result
  and its `reason` set, and the deduper's two keys (`delivery:`, `fact:`). The platform
  retries nothing today and dedupes on its own ingestion table.
- The fake (`@ezpug/match-api/fake`), whole: its options and fault knobs, the `sim`
  provider's facts (`sim-N`, `sim-N.sim.invalid`, region `sim`), the invented open-join
  roster rule, the `player_command` plugin event and `playerCommand`, the `fake-key-`,
  `fake-player-token-`, `fake-node-token-` and `fake-join-` secret prefixes
  (`FAKE_SECRET_PREFIXES`, what a fixture scrub greps for). The platform's simulator
  provider had `step`/`mode`/`speed`/`chaos`/`kill` handles; here they are the `sim.*`
  commands of the Match API.
- The conformance suite, whole: the target's shape and its capability set, the eleven flow
  ids, the report and check shapes, the recording shape and its redaction rule, and the
  recorded golden files. The platform has no conformance seam today — it will run this one
  against the fake it pins.
