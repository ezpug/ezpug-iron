# @ezpug/match-api

A change to a schema is a release with a line here (decisions 3, 24).

## Unreleased

_Nothing yet._

## 0.28.0 — 2026-09-27

**Rush, and the vocabulary of a tower round** (PRD-06 T1, for the platform's PRD-13 T19).
Additive: a fifth manifest in the catalog, two values of `RoundWinCondition`, one optional
field on `round_end` and one on `map_end`, and the schemas they are made of. Every event a
0.27.0 client parsed still parses.

- **The `rush` manifest.** Valve's Rush (2026-09-22), 3v3 on `rush_001`: tier `config`, flow
  `none`, records `events`, `slots { teamSize: 3, teams: 2, openJoin: false }`, unranked,
  `maps: { catalog: ["rush_001"] }` (an engine name, so `mapIdentifierSchema` already admits
  it), `cfg ["ezpug/rush.cfg"]`, which execs the game's own `gamemode_rush.cfg`, and the
  cvars `bot_quota 0`, `mp_maxrounds 15`, `sv_cheats 0`. It claims `simulation` and
  `mixedRoster`. The engine game is `game_type 0` / `game_mode 6`, read off the node's own
  `gamemodes.txt`, so a Rush `going_live.engine` says `0`/`6` and carries no `format`. **Send
  a Rush request without `rules`.** `regulationRounds` is even by schema and would override
  the mode's 15.
- **`RoundWinCondition` gains `tower_held` and `tower_captured`.** In a tower round the owner
  of the tower wins. `tower_held`: the side that held it as the round began still owns it
  when the clock runs out. `tower_captured`: the winner took it during the round.
  `elimination`: the holders kept it and every attacker died. A client with an exhaustive
  switch over the enum has two cases to add.
- **`round_end.tower`** (`roundTowerSchema`): `{ room, roomId?, heldBy }`. `room` is where on
  the line of seven the round was played, 1-based in side order: `1` is the T castle (`401`),
  `4` the start room, `7` the CT castle (`301`). `roomId` is the arena, one of
  `RUSH_ROOM_IDS` (`101`–`104`, `201`–`212`, `301`, `401`, `convoy`). `heldBy` is the side
  that held the tower as the round began, `null` for a room nobody owns. The owner at the
  end is always the round's `winner`.
- **`map_end.tower`** (`mapTowerSchema`): `{ room, roomId?, ending }`. This is the last room
  played. `ending` is `castle` when a win inside the enemy castle ended the match, `rounds`
  when the rounds ran out (15, or 8 clinched).
- **Fixtures.** `TOWER_EVENT_FIXTURES` in `@ezpug/match-api/fixtures`: a Rush `going_live`,
  a round of each of the three conditions, walked along the line as the map walks it, and
  a `map_end` for each ending.
- **Producers.** Nothing speaks these yet. The simulator learns Rush in PRD-06 T2 and the
  SDK's generic flow on the dev node in T3; both follow the walk and the deaths rather
  than read the map script's state. The generated C# (`RoundTower`, `MapTower`,
  `RushRoomId`, `TowerMapEnding`) is already in `EZPug.Sdk`.

## 0.27.0 — 2026-09-25

**The format on the record** (PRD-05 T2d, ezpug/ezpug-iron#4, for the platform's `wingman`
lane row, PRD-12 T6). Additive: two optional fields on `going_live`, one on `server_ready`,
one new schema and one function. The issue's option 2: a fact on every match rather than
an RCON probe, which a node answers with nothing.

- **`going_live.engine`** (`engineGameSchema`): `{ gameType, gameMode }`, the engine's
  `game_type` and `game_mode` as the server read them when the map loaded. That is when
  the engine applies them, so they are the game the map is being played under. A value
  set later decides the next map, which is why MatchZy loads the map again for wingman.
- **`going_live.format`** (`formatOfEngineGame`): `competitive` for `0`/`1`, `wingman` for
  `0`/`2`, absent for any other game (deathmatch is `1`/`2`). The engine's word, so a
  client compares it with the `rules.format` it sent.
- **`server_ready.engine`**, the same per map load. A wingman match under MatchZy says
  `server_ready` twice, and only the second, after the reload, says `gameMode: 2`, so
  assert on `going_live`.
- **Producers.** The core plugin reads both convars at map start, before anything of its
  own is exec'd, on every node and on Dathost. The SDK's generic flow puts them on its own
  `going_live`. MatchZy's `going_live` comes over its HTTP log, so the orchestrator copies
  the engine game from that server's last `server_ready`, and reads it back from the
  durable log after a restart. The simulator and the fake say `0`/`2` for a wingman
  request and `0`/`1` otherwise, and draw no dice for it.
- **Proved on the dev node.** The lane's `wingman` row (iron match
  `376afd8f-0066-40ac-814f-6a39eb8bbb51`) said `server_ready` at `0`/`1`, then at `0`/`2`
  after MatchZy's reload, and `going_live` at `0`/`2`, `format: "wingman"`. The `pug-1v1`
  row (`0d848c51-aca5-45a9-b535-44ada46e498c`) went live at `0`/`1`, `competitive`. Both
  rows assert it from now on, and the conformance suite checks it in `happy-bo1` and
  `wingman-format`, which now plays its match out.

## 0.26.0 — 2026-09-25

**Smokes and the bomb on the live tier** (PRD-05 T2c, ezpug/ezpug-iron#5, for the
platform's live radar, PRD-12 T8b). Additive: two optional fields on the ephemeral
`position_tick`, three new schemas. The tick stays ephemeral and `isEphemeralGameserverEvent`
is unchanged.

- **`position_tick.grenades`** (`liveGrenadeSchema`, `grenadeKindSchema`): `{ id, kind, x,
  y, z, state, radius?, steamId64? }` for every grenade flying or active at that instant,
  exactly as the issue shaped it. `kind` is the replay artifact's six names. A smoke is
  `flying` until it blooms, then `active` with its radius until it clears. A molotov or
  incendiary flies, then burns as `active` at the centre of its flames under the same id.
  A flash, an HE and a decoy are `active` in exactly one tick, where they went off.
- **`position_tick.bomb`** (`liveBombSchema`): `{ state: carried | dropped | planted, x, y,
  z, steamId64?, site? }`. The tick did not carry the bomb before; the PRD asked for it
  beside the grenades in the same additive shape.
- **Absence means something.** A source that samples utility sends `grenades` on every
  tick, empty when nothing is in the air, so a missing `grenades` means "not sampled" and a
  client draws no utility layer. With `grenades` present, a missing `bomb` means none is in
  play.
- **Producers.** The core plugin samples both on every node, and on Dathost, which runs the
  same plugin. It keys on the game's events (`smokegrenade_detonate`, `inferno_startburn`,
  the detonates, `bomb_pickup` / `_dropped` / `_planted`) and reads an entity only for a
  grenade in flight or a fire's spread: the entity listeners never fired for it on the dev
  node. Proved there by the lane's `grenades` row (iron match
  `934a78c8-8c3d-4f9f-9e43-e9b1a0db46e0`): 12 smokes flew, stood with their radius and
  cleared, and the bomb was carried, dropped and planted on both sites. The simulator throws a smoke or two a side per round (sometimes a flash, an
  HE or a fire) and carries the bomb on a T. Its dice come from a fork per round, so a seed
  plays the same match it did before. The fake does the same, through the same engine.

## 0.25.0 — 2026-09-25

**The simulator deals the knife perk** (PRD-05 T2b, ezpug/ezpug-iron#6, for the platform's
PRD-12 T16a: its golden path walks a knife kill and `get ezpug` against the real
orchestrator). Additive: one optional field on the request, two new constants.

- **`MatchRequest.sim.knifePerk: { round, killer? }`** (`simKnifePerkSchema`). From round
  `round` of map 1 on, one kill the story already deals becomes a `player_death` with
  `weapon: "knife"` (`SIM_KNIFE_WEAPON`) by a rostered player on `killer`'s team (either
  team when unsaid). Before that round's `round_end` the same player says `get ezpug`
  (`SIM_KNIFE_PERK_LINE`) as a `chat_message` with scope `all`. The round is the first
  from `round` on in which that team kills anybody, so in a 1v1 it skips every round the
  team loses. A mode with a length plays a single round, and there only `round: 1` deals
  it. Honoured on the `sim` provider, the real orchestrator's and the fake's.
- **Why a knob and not `sim.say` / `sim.kill` commands** (the issue's option 2). A kill
  dealt by command has to be invented outside the story. Every `round_end` after it would
  then have to be recounted, and where it lands depends on when the command arrives, which
  at 20× speed is any round at all. The knob rewrites a kill the story already has, so the
  scoreboard stays true (the kill is no longer a headshot, and the count says so). It draws
  from its own `prng.fork('knife-perk')`, so a seed plays the same rounds, kills and winner
  with it on or off, and the same seed always puts the knife in the same place.

## 0.24.0 — 2026-09-25

**A node that never gets ready says why** (PRD-05 T2, the follow-up to the platform's
PRD-12 T6a, whose workshop row sat silent until the platform's own five-minute cancel). No
schema moved. There is one new export.

- **`SERVER_READY_DEADLINE_MS`** (3 min): how long a match stays `configuring` waiting for
  `server_ready` before it fails `provider_error`. It used to be five minutes, the same as
  the platform's provisioning timeout, so the platform always gave up first and learnt
  nothing. Three minutes fits inside that timeout with allocation in front of it. It is
  also plenty for a first-time workshop download: AIM Map (112 MB) took about 9 s on the
  dev node.
- **`match.failed.reason.detail` says why**: the plan's first map as you sent it, then the
  provider's view of the server (a node's container state and docker's error) and the
  link's (never said hello, or the last state, map and detail it reported, and whether it
  is still connected). For example: `no server_ready on workshop/3084291314/aim_map within
  180 s; nodes reports the server starting (node devbox: container starting); the server
  never said hello over the link`. The server leaves the fleet as before. `detail` is
  still for humans. Branch on `kind` (`docs/match-api.md`, "A server that never gets
  ready").
- **The fake** says the same shape at its own `readyTimeoutMs`:
  `no server_ready on <map> within 120 s; the fake's server never booted`.

## 0.23.0 — 2026-09-24

**Workshop maps go live** (PRD-05 T1, ezpug/ezpug-iron#3, for the platform's PRD-12 T6a:
AIM Map as a room preset). No schema moved. A `workshop/<id>/<name>` plan used to reach
the engine verbatim, as `changelevel workshop/…` from the core plugin's loader and as that
string in MatchZy's `maplist`. Neither ever hosts a map, so a node never loaded one and the
match sat at `allocated` until the client cancelled it. Now every workshop plan is hosted
by its id, on every flow.

- **`going_live.map` is the plan's string** for that map number: `workshop/<id>/<name>`
  for a workshop map, exactly as you sent it, and `map_end.map` too where it is present.
  A `matchzy` flow already named it that way. The SDK's generic flow (`flow: none`) used
  to say the engine's name and now says the plan's too. `server_ready.map` is still the
  engine's name for what it loaded, which for a workshop map is the map's own name
  (`docs/match-api.md`, "A map is named the way your plan named it"). The schema comments
  say so.
- **What a server does with it.** The loader hosts the first map with
  `host_workshop_map <id>`. MatchZy's `maplist` carries the bare id, the one spelling it
  hosts a later map of a series by. Before `matchzy_loadmatch`, the loader puts the
  engine's name for the map that is already up into `maplist[0]`. Without that, MatchZy
  hosts the map a second time, and in simulation mode it waits for a map named by a number
  that never comes, so no puppet ever joins. CS2 also filters console commands on a
  workshop map, which took MatchZy's `live.cfg` and `tv_enable`. So the CS2 image starts
  with `-disable_workshop_command_filtering`, and the Dathost provider sets
  `cs2_settings.disable_workshop_command_filtering` on every server it allocates.
- **Proven on the dev node** (iron match `859085d0-2cb8-43cb-90a5-6f1f0e92763b`, lane row
  `workshop`). A puppeted 1v1 `pug` on `workshop/3084291314/aim_map` was allocated, and 10 s
  later `server_ready` named `aim_map`. `going_live` and `map_end` named
  `workshop/3084291314/aim_map`, and the match ended `completed` with its demo uploaded.
  AIM Map's first download (112 MB) took about 9 s. The run is recorded as
  `fixtures/recorded/real-workshop-pug-bo1.json`.
- **Conformance.** A new flow, `workshop-map`, plays a Bo1 on
  `workshop/3084291314/aim_map` against the fake and the real orchestrator. It checks that
  `going_live.map` (and `map_end.map` when present) is the plan's string.

## 0.22.0 — 2026-09-23

**`pug` seats a mixed roster** (PRD-04 T2b, for the platform's PRD-11 T23 — the owner as
the tenth player on the 5v5 queue). No schema moved. The `pug` manifest now claims
**`capabilities.mixedRoster: true`**, so the door takes a `simulation.puppets` that names
only some of a `pug`'s roster, where 0.19.0 refused it `validation_failed`.

- **What a real server does with it.** The CS2 image runs our own fork of MatchZy-Enhanced
  (`ezpug/MatchZy-Enhanced` `1.4.32-ezpug.1`). The orchestrator writes a seat left to a
  person into the match file as `{ "name", "simulated": false }`. The fork spawns no bot
  for that seat. It readies the bots, and then holds the warmup until the person is on
  their side and ready, through the ordinary gate (auto-ready when the request's
  `rules.warmup.autoReady` is on). The warmup watchdog never starts such a match. A client
  that gives up on the person does what it does for any no-show: its join deadline, or
  `cancel`. The hold is measured on the dev node. A person taking the seat is upstream's
  ordinary path for a human and has not been seen yet, because no bot can stand in for one
  at MatchZy's gate. The platform's PRD-11 T23 is the first such run.
- **On the `sim` provider and the fake** nothing changed: a person's chair stays empty and
  a `matchzy` match is held at the gate until the client calls it off.
- **Conformance.** `simulation-switch` no longer finds a mode that seats every seat or
  none, so that refusal is not exercised against the catalog (the rule is unchanged and
  unit-tested). It gains a `pug` of nine puppets and one person's seat, which must reach
  `ready`, announce every puppet and never the person, never go live, and be cancelled.

## 0.21.0 — 2026-09-22

**`restore` rewinds a live match** (PRD-04 T8, for the platform's PRD-11 T3 — `restore` in
the admin's hand with a round picker built from the match's timeline). No schema moved:
the command, its `roundNumber?` and its error codes are the ones 0.10.0 published. What
changed is where it is answered — it used to be `invalid_state` everywhere but
`recovering`.

- **`restore` on a `live` match** takes it back to the start of a round on the server that
  is playing it: `roundNumber` on the map being played, or the latest backup's round when
  unsaid; `no_backup` when there is none. The answer is the server's, as for a pause:
  `applied` once the round has started again, `invalid_state` with the reason word first
  when the match software refused (`halftime`, `post_game`, `timeout_active`, `not_live`,
  …), `command_unsupported` where no round backups are kept. One word is new to the closed
  set: **`round_over`**, a restore asked between two rounds — the engine loads a backup
  there and never restarts the round, so the server refuses the gap without asking and the
  client asks again once the next round is under way. The stream then carries the
  plugin's `backup_restored`, MatchZy's pause after a restore, and the round's
  `round_start` at the score it started at the first time. `restore` in any state other
  than `live` or `recovering` is still `invalid_state` ("restore only while live or
  recovering").
- **On the `sim` provider and the fake** a live `restore` resolves its point (`no_backup`
  before the first backup) and is then `command_unsupported`: a scripted story cannot
  rewind, as it cannot `restart_round`.
- **The conformance suite's `happy-bo1`** asks for a live `restore` and holds the answer to
  those two.
- **What you may need to change**: a client that greyed `restore` out on a live match may
  offer it; one that retried it on `invalid_state` should read the word first — `halftime`
  passes, `post_game` does not.

## 0.20.0 — 2026-09-22

**A key's scopes are edited by a route** (PRD-04 T3). On 2026-09-21 production's platform
key was granted `simulation` by a hand-written `UPDATE`, because there was no door for it.
There is one now. Additive: nothing that existed changed shape.

- **`PATCH /v1/keys/:keyId/scopes`** (scope `admin`), body
  `{ add?: Scope[], remove?: Scope[] }` with at least one of them non-empty, answering the
  key. The scopes not named do not move, so granting one cannot take another away by
  accident; both halves are idempotent. A scope on both lists is `validation_failed` (the
  published client refuses that body before it is sent), a removal that would leave the key
  no scopes at all is `validation_failed` and points at `DELETE /v1/keys/:keyId`, and a
  revoked key is `invalid_state`, as with `rotate`.
- **`scopesPatchRequestSchema` / `ScopesPatchRequest`**, and **`applyScopesPatch(held,
  patch)`** — the one reading of a patch, so the fake, the orchestrator and any client
  agree on what it means. The answer is in `MATCH_API_SCOPES` order, whatever order the
  patch named, so two `GET /v1/keys` a month apart are diffable.
- **The conformance suite's `key-scopes` flow** and its `admin` capability: a target that
  hands over an `admin` client and the id of the key the suite itself calls with gets the
  round trip proven — the key is widened, the door answers the new scope on the very next
  request, and the key is put back the way it was found.
- **The truth about production's platform key.** `scopes.ts` and `docs/match-api.md` used
  to say a production platform key never holds `simulation`. It does (owner call,
  2026-09-21); what keeps a real match from becoming a rehearsal is that the block is never
  implied and every fact of one says `source.simulated`.
- **What you may need to change**: nothing.

## 0.19.0 — 2026-09-22

**Mixed rosters: `simulation.puppets` names who is a puppet** (PRD-04 T2, for the platform's
PRD-11 T23 — the owner as the tenth in a rehearsal queue). Additive: every request written
before the field asks for what it always did.

- **`simulation.puppets?: SteamID64[]`** on `matchSimulationSchema`. Unsaid, every roster
  entry is a puppet; a list names the entries that are, and the rest of the roster are
  people, expected through the mode's ordinary door and announced as the rostered players
  they are when they connect. A list naming everybody is the same request as no list. An
  empty list does not parse, nor does a SteamID named twice; at most 32 names.
- **`capabilities.mixedRoster`** on the gamemode manifest (default `false`, implies
  `simulation`): the mode's match software can seat some puppets and leave the other chairs
  to people. `retakes`, `powerup-dm` and `flying-scoutsman` claim it — the SDK's puppeteer
  seats exactly who is named. **`pug` does not**: MatchZy-Enhanced's simulation mode seats
  every configured entry or none, kicks a bot it did not map outside that mode and
  force-starts without anybody, so a partial list to it is refused at the door rather than
  played as a different match.
- **Two refusals on `simulation.puppets`**, both `validation_failed`, decided once in
  `matchSimulationProblem` for the fake and the orchestrator alike: a name the roster does
  not hold, and a partial list to a mode without `mixedRoster`.
- **`matchPuppets(request)` and `matchHumans(request)`**: the one reading of the field, in
  roster order.
- **On the `sim` provider and the fake** a person's seat stays empty — the simulator has no
  door for a human and invents none — so a mixed `pug` waits at the gate for the join
  deadline and a mixed drop-in mode is played by the puppets that came. The match is
  `simulated` however many of its players are people, and every fact says so.
- **The conformance suite's `simulation-switch` flow** now refuses a stranger and a partial
  list to `pug`, and plays a mixed `flying-scoutsman` on which the person is never announced.
- **What you may need to change**: nothing. A client that wants a human in the room sends
  `simulation.puppets` with everybody else's SteamID64 to a mode whose manifest says
  `mixedRoster`.

## 0.18.5 — 2026-09-20

**An empty server goes live where a real one of its modes would** (PRD-03 T11a, for the
platform's PRD-10 T6). No schema, route, event, error code or state moved; what changed is
the story the simulator — and the fake beside it — tells for a mode whose flow is not
MatchZy's.

- **The `idle` and `no-show` stories now depend on the manifest's `flow`.** They used to
  tell every mode MatchZy's version of it: an empty or short-handed server sits in warmup
  for ever, and the match ends with a `series_end` and nothing before it. That is right for
  `pug`, whose warmup is held open until two teams have readied up, and wrong for every
  mode the server's own plugin tells the story of (`flow: "plugin"`, `flow: "none"` — all
  three of `powerup-dm`, `retakes` and `flying-scoutsman`): such a server ends its warmup
  on its own clock twenty seconds after the map is up whether or not anybody came, which is
  the only thing a drop-in mode can sensibly do, since people join one of those *live*.
  Measured side by side on a dev CS2 server and the simulator: the real leg said
  `server_ready`, `going_live`, `round_start`, `map_end`, `series_end`, and the simulated
  one said `server_ready`, `series_end`. They now say the same list.
- **What you can draw off it**: a `powerup-dm` match on the `sim` provider goes live with a
  `going_live.length` to count down, ends on whichever of the mode's clocks runs out first
  — the idle timeout from `server_ready`, the duration from `going_live` — and carries that
  `reason` on `map_end` as well as `series_end`, naming no winner for a one-team mode. A
  short-handed `no-show` of such a mode is *played* by the bodies that came, so a console
  rehearsing against the simulator is rehearsing against a match that can happen.
- **`pug` is untouched**, and so is every round-based story of every mode: a `matchzy`
  match's empty server still waits for the join deadline, and a `length` is still never
  MatchZy's to enforce (a real server drops it for that flow).
- **What you may need to change**: nothing, unless a test of yours pinned the old shape of
  a simulated `powerup-dm`, `retakes` or `flying-scoutsman` match that nobody joined.

## 0.18.4 — 2026-09-20

**A scenario a real server cannot play is refused, never silently ignored** (PRD-03 T11,
for the platform's PRD-10 T8 and T9). No schema, route, event, error code or state moved;
what changed is what the fake — and the orchestrator beside it — does with
`simulation.scenario`, and the conformance suite says so.

- **`simulation.scenario` is now judged by what it asks for.** One scenario language has
  always meant that a puppets request names a story from the same catalog
  `GET /v1/sim/scenarios` lists; what was missing is that a knob no room of bots can
  execute did nothing at all when the match landed on a real server. It is now
  `validation_failed` on `simulation.scenario`, with the knob named in the message.
  **What a real server's puppets can do**: `absentPlayers` (a roster entry with no body,
  which the join deadline then gives up on) and `idle` (nobody is seated at all, and the
  mode's `length` or the join deadline ends it). **What is refused**: `overtimes` (two
  even sides of bots cannot be made to draw), `comeback` (nothing scripts a bot's aim),
  `pauses` (a pause is the Match API's own admin verb — use `POST
  /v1/matches/:id/commands`), `crashAfterRound` and `neverReady` (a request cannot ask a
  box to die, or not to boot). **What is refused for a `matchzy` mode whatever the knob**:
  its bodies are MatchZy-Enhanced's, which seats one bot per configured player and
  force-readies them, so `no-show` and `idle` are a `powerup-dm`, `retakes` or
  `flying-scoutsman` request's. `docs/sdk.md` tabulates all seven, knob by knob, and the
  refusal reads its sentence from that same table.
- **`sim.scenario` is untouched**: that block steers the simulator, where every knob is
  executable by definition, so `sim: { scenario: 'overtime' }` still plays an overtime.
  Only `simulation`, the block that asks a *real* server to play without people, is
  judged this way.
- **What you may need to change**: nothing, unless you were sending a scenario to a
  puppets match and reading nothing back from it. A console offering the catalog as a
  dropdown for a simulated match should now offer `happy-path`, `no-show` and `idle` for
  the modes the SDK seats, and `happy-path` alone for `pug`.

## 0.18.3 — 2026-09-20

**`retakes` is one team of ten, and every bundled mode seats puppets** (PRD-03 T10, for
the platform's PRD-10 T5). Catalog only: no schema, route, event, error code or state
moved, and a client that never renders a room card sees nothing at all.

- **The shipped `retakes` manifest is `0.4.0`, and `slots` is now
  `{ teamSize: 10, teams: 1, openJoin: true }`** where it was `5 × 2`. The old numbers
  were copied from `pug` and were wrong about the mode: cs2-retakes builds an attacking
  and a defending side out of one pool every round by its own ratio, so a team of yours
  never survives a round. **What changes for you**: a retakes room is one group of up to
  ten rather than two fives, and `map_end.winner` / `series_end.winner` are `null` for
  every retakes match — until now the win panel's leading *side* was reported as the
  winner of a map nobody had won, which the `open-join` recorded fixture shows going from
  `"team_a"` to `null`. The match's own shape on the wire is unchanged: a request still
  carries `teamA` and `teamB`, and an open-join mode still lets anybody in.
- **`capabilities.simulation` is `true` for `retakes`**, the last of the four to claim it,
  so `simulation` on a key with the scope now plays on every mode this package ships. The
  claim waited for a run on real hardware because the doubt was real: cs2-retakes keeps
  bots out of its *queue* (`QueueManager.AddConnectingPlayer` returns at `IsBot`). Nothing
  seats a puppet through that door — the SDK's puppeteer asks the engine and the plugin's
  team hook, which has no bot filter, takes the body into its active players like anybody
  else. Three puppets played a retakes match out on the dev node and ended it on its
  rounds. **If your conformance run asserted that some mode refuses puppets, there is no
  longer one**; the suite's `simulation-switch` flow already treats that as a fact about
  the catalog rather than a failure.
- **The `sim` provider fills an empty retakes roster with ten invented players** rather
  than six: it seats `ceil(teamSize / teams)` a side, capped at five, and the manifest's
  ten now means the mode's full house. `open-join`'s golden carries the new story.

## 0.18.2 — 2026-09-20

**A mode that records events announces no demo** (PRD-03 T9c, for the platform's PRD-10 T6
and T11). No schema moved; the fake and the `sim` provider stop saying one thing a real
server of that mode never says.

- **`demo_available` is a `records: "demo"` mode's fact and nobody else's.** The simulator
  told every mode the same story, so a `powerup-dm`, `flying-scoutsman` or `retakes` match
  on the fake or on the `sim` provider announced a demo per map. The orchestrator gated
  the *upload* on the manifest all along, so `demo.uploaded` never followed and
  `match.ended` said `skipped: "not_recorded"` — but the announcement travelled, and a
  consumer that opens a demo pipeline on one (the platform's does: it registers the
  expected upload and waits out its secured timeout before calling the demo missing) waited
  for a file no server of that mode was ever going to write.
- **What changes for you.** Three of the four bundled manifests record `events`, so a
  dev-world deathmatch, retakes or flying-scoutsman match is now one envelope shorter and
  its `series_end` follows `map_end` by two seconds rather than eight — there is no GOTV to
  wait out where there is no demo. `pug` is untouched, announcement, `PUT` and
  `demo.uploaded` alike. The recorded fixtures `config-only`, `open-join` and
  `player-command` carry the new shape; `demo-per-map` is byte for byte what it was.
- **The conformance suite says it out loud**: the `config-only` flow now checks that a mode
  which records events announces no demo as well as uploading none.

## 0.18.1 — 2026-09-20

**The fake reads a minted key against the contract** (PRD-03 T9b). No schema moved; the
fake refuses one thing it used to accept, and refuses it because the orchestrator does.

- **`fake.mintKey` is the fake's one door that is not the dispatch**, so it was the one
  door where a caller held `ApiKeyCreateRequest`'s TypeScript type and none of its bounds
  — a `name` of 65 characters, an unknown scope, a negative `monthlyCents`. It now parses
  the request the way a route would and throws `validation_failed`. This matters because
  of what the same gap did to the real orchestrator on 2026-09-20: names of up to 71
  characters were minted in-process, written, and `GET /v1/keys` then answered `internal`
  for **every** caller of that database, because `ApiKey.name` caps at 64 and the response
  no longer parsed. The orchestrator's service refuses the same three now.
- **Nothing to change** unless your seed or your tests mint keys the contract could never
  have carried; if they do, the fake tells you at the mint instead of the real
  orchestrator telling you on the box.

## 0.18.0 — 2026-09-20

**The simulator plays a length** (PRD-03 T9a, for the platform's PRD-10 T6). Additive: one
boolean on a response object you already parse, and one more name in a catalog you already
read by name.

- **`SimScenario.idle`** — `GET /v1/sim/scenarios` spells out one more knob, and the
  catalog carries one more scenario, `idle`: **nobody ever connects**. What that does is
  the *mode's* to say, exactly as on real hardware. A mode whose manifest names a
  `length.idleTimeoutSeconds` ends itself on it — a `series_end` with `reason: "idle"`,
  no `going_live` and no `map_end` anywhere before it, while the match is still `ready` —
  and a mode that names none waits for ever, leaving your join deadline the only thing
  that gives up. `MatchRequest.sim.scenario` and `.simulation.scenario` both take the
  name, as with every other.
- **What 0.17.0 said it did not do yet, the `sim` provider now does.** A match on the
  simulator whose mode declares a `length` is played as a mode with a length rather than
  as rounds: `going_live` carries the `length` in force, one `round_start` opens a round
  that never ends, bodies kill each other and respawn until the duration runs out or
  somebody reaches the frag limit, and `map_end`/`series_end` carry `time_limit` or
  `frag_limit`. **So the countdown of PRD-10 T6 is drawable off your dev world**, not only
  off the dev node, and it is the same number either way: `durationSeconds` is in seconds
  of your own clock, so a `sim.timeScale: 20` says `30` for a manifest's `600`.
- **A one-team mode names no winner on the simulator too.** `map_end.winner` and
  `series_end.winner` are `null` for `slots.teams: 1`, whichever story the mode plays —
  the rule 0.17.0 wrote for the server, now true of the fake and the `sim` provider as
  well. No shape changed; a `sim` `powerup-dm` simply stops naming a side that never won
  anything.

## 0.17.0 — 2026-09-20

**A length for a mode with nothing to win** (PRD-03 T9, for the platform's PRD-10 T6; it
closes `OPEN-POINTS` §1). Additive: three optional fields and one optional manifest block,
no enum you already parse grew a value, and a client that ignores them needs no change.

- **`GamemodeManifest.length`** (also on the summary), `{ durationSeconds?, fragLimit?,
  idleTimeoutSeconds? }`, at least one. What ends a match of the mode besides the game
  itself, enforced by the SDK on the server for `plugin` and `none` flows; a `matchzy`
  manifest that declares one does not parse. **This is what the room screen says before
  anybody joins**: "10 minutes", "first to 30", or — when the block is absent or names only
  the idle timeout — "plays the rounds the room sets". `powerup-dm` is `600` s with a
  `300` s idle end at manifest `0.4.0`; `retakes` (`0.3.0`) and `flying-scoutsman`
  (`0.4.0`) keep ending on the rules' rounds and gain the same idle end, so an open-join
  server nobody is on stops billing by itself.
- **`going_live.length`**, `{ durationSeconds?, fragLimit? }` — **the field you turn into a
  countdown** (PRD-10 T6). `durationSeconds` is the length *in force*, in seconds of your
  own clock, counted from the arrival of that `going_live` (a simulated match at
  `timeScale: 2` says `300` for a manifest's `600`; no server timestamp travels, as ever).
  `fragLimit` is what you count the leader's kills up to, from `player_death`. Absent for
  a mode with neither.
- **`map_end.reason` and `series_end.reason`**: `time_limit`, `frag_limit` or `idle` when
  the mode's length ended the match, absent when the game did (the win panel). An `idle`
  end can arrive while the match is still `ready` — nobody ever came — as a `series_end`
  with no `going_live` and no `map_end` before it. The match then ends `completed` like
  any finished series, the server is released, and `match.ended`'s `detail` repeats the
  reason for whoever reads the match rather than its events.
- **A one-team mode names no winner.** `winner` is `null` on `map_end` and `series_end`
  for `slots.teams: 1`, whoever ended the match. It used to be whichever side of the
  engine's free-for-all happened to lead, which no client could draw. Already legal in the
  schema (a drawn map), so nothing to parse differently — stop expecting a team there.
- Not in this release: the simulator still plays every mode as a round-based story and
  says none of the three fields. Until it does (PRD-03 T9a), a `powerup-dm` match on the
  `sim` provider has no countdown to draw; the real server and the manifest do.

## 0.16.0 — 2026-09-20

**A body the request never named, and puppets outside MatchZy** (PRD-03 T7, for the
platform's PRD-10 T4 and T8; it closes the platform's half of `OPEN-POINTS` §2 too).

- **`team: "unrostered"`** — a fourth value of `ServerSlot`, the `team` of every
  `GameserverPlayer` (`player_connected`, `player_death`, chat, bombs, the `presence`
  frame). The rule is now one sentence: **`team_a` and `team_b` are the roster's word and
  nobody else's; a body the request never named is `unrostered` while it plays on a side and
  `spec` while it is on none.** An open-join guest in `powerup-dm` or `retakes` and a plain
  bot filling a seat are `unrostered` — they used to be given whichever team owned the side
  they happened to spawn on, which put strangers on a team's sheet. A rostered player is
  their team wherever they stand. **This is a new value in an enum you parse strictly**: a
  client on ≤ 0.15.0 refuses a delivery that carries it, so **move the pin before the
  orchestrator you talk to is deployed with this round** (PRD-03 T16 deploys; nothing in
  production sends it before then). What to draw: an `unrostered` player belongs in a guest
  list, never in a team column, and never in a stat that is attributed by team.
- The `spec` production showed on 2026-09-09 (a bot that scored fourteen kills as a
  spectator) was **not** this rule but a server bug, fixed in the same round: a kicked
  bot's slot kept its player, and the next body in that slot played under the dead one's
  name with no side to read. Nothing to change on your side; it stops.
- **`capabilities.simulation` may be claimed by any flow.** `powerup-dm` and
  `flying-scoutsman` claim it at manifest `0.3.0`: the SDK seats the puppets there (a bot
  per roster entry, carrying that entry's SteamID64 and name, announced with
  `player_connected` like a person, reachable by `kick` and by a widget tap addressed to
  the rostered id, and announced again when it comes back). The manifest rule that refused
  the capability for `flow: none` is gone — the core plugin is on every server. `retakes`
  does not claim it yet. Offer the puppets switch (PRD-10 T8) wherever the catalog says so;
  a plain bot is still never announced and never rostered.
- The conformance flow `simulation-switch` picks the mode that must refuse puppets from the
  catalog instead of naming `flying-scoutsman`, and passes with a note when every mode
  seats them.

## 0.15.0 — 2026-09-20

**Puppets** (PRD-03 T4, for the platform's PRD-10 T7 and T8): a match request may ask to
be played by simulated players, and every fact of such a match says so. Additive — a
request written before this release parses unchanged and is a real match, a `Match` read
from an older orchestrator reads `simulated: false`, and a client that ignores a field it
does not know needs no change.

- **`MatchRequest.simulation`**, `{ scenario?, timeScale? }`. Every rostered player is
  played by a puppet: a body on the server carrying that entry's SteamID and name, that
  connects, readies up through the match plugin's own ready system, plays and leaves by
  the doors a human takes. All or nothing this round — there is no "these two are humans"
  field, because MatchZy-Enhanced fills every seat or none and a field a server cannot
  honour would be a lie. A roster with nobody on it is refused `validation_failed` on
  `teams`. `scenario` is a name from `GET /v1/sim/scenarios`, the same catalog `sim.scenario`
  reads (one scenario language; naming a different story in each is `validation_failed` on
  `simulation.scenario`); `timeScale` is the engine's `host_timescale`, `0.1…10`, `1` when
  unsaid. It is **not** the `sim` block: that steers the simulator provider, this asks a
  real server to play without people and **costs what a real server costs**.
- **The `simulation` scope.** A fourth key scope, the first that no route requires: `POST
  /v1/matches` still needs `matches`, and a body carrying `simulation` needs this one on
  top — refused `forbidden` with `details.scope: "simulation"` before anything else about
  the body is judged. `admin` implies it like the others. **Your production key does not
  hold it and should not**: that is how a real match can never be a simulated one by
  accident. Mint a second key with `["matches", "simulation"]` for the test door (PRD-10 T8)
  and the lane.
- **`GamemodeManifest.capabilities.simulation`**, a seventh capability, default `false`.
  A request with `simulation` to a mode without it is `validation_failed` on `simulation`
  at the door — never a server waiting in warmup for people who are not coming. `pug`
  claims it (manifest `0.3.0`); the SDK modes will when the SDK seats a puppet (PRD-03 T7).
  Offer the switch exactly where the catalog says it works.
- **`Match.simulated`** and **`source.simulated`** — the marker (PRD-10 T7). `Match.simulated`
  is `true` on the resource from creation; every gameserver event of the match carries
  `source.simulated: true`, stamped by the orchestrator whatever the server said. Read one
  field: a stats pipe, a board, a drop or a feed that skips on `source.simulated === true`
  (and an admin page that badges on `Match.simulated`) never has to know what a request
  looked like. A real match carries neither, and **so does a match on the `sim` provider
  that did not ask** — its players are the simulator's inventions and its
  `source.provider` has always said so; nothing about how you count those changes.
- The fake honours all of it: the scope, the capability, the scenario, the marker on the
  resource and on every event. A new conformance flow, `simulation-switch`, holds the four
  refusals and the played match against the fake and the real orchestrator; a target that
  offers a `simulation` key (one holding the scope beside `matches`) runs it, one that does
  not skips it with the reason.

## 0.14.0 — 2026-09-20

**Wingman, and every size in between** (PRD-03 T3b, for the platform's PRD-10 T2a):
`rules.format`, either `competitive` (the default) or `wingman`. Additive — a request
written before this field existed parses unchanged and is competitive, which is the only
thing it could ever have meant.

- **`competitive` is the five-a-side game at whatever size the roster holds.** A **1v1 is
  this**, not a format of its own: one player a side, short rules, and the ready gate the
  roster derives (0.11.1). There is no `1v1` value and there does not need to be one — a
  `1v1` *preset* is yours, and it sends the rounds and the gate, not a format.
- **`wingman` is CS2's two-a-side game** (`game_mode 2`). The server execs MatchZy's
  `live_wingman.cfg` (MR8, a smaller overtime) instead of `live.cfg` and **loads the map
  again** when it was not already in that mode, so a wingman match costs one map change
  before warmup. Your `rules` still win over that cfg — they are re-applied after it — so
  send the rounds you mean rather than relying on MR8.

Two refusals come with it, both `validation_failed` and both at the door, because a format
a server cannot play must never be quietly demoted to the other game:

- `rules.format` — only a gamemode whose manifest says `flow: "matchzy"`, on `cs2`, can
  play wingman. The switch rides in MatchZy's own match file; a mode that runs its own
  flow has nowhere to put it.
- `teams.<side>.players` — **wingman seats two a side.** The engine's wingman layouts hold
  two spawns for a team, so a third rostered player is refused rather than sent to a map
  with nowhere to put them.

**Maps stay yours to name.** This API keeps no separate wingman catalog and never
substitutes a map: `maps[].map` is loaded as asked under `game_mode 2`. A Valve map that
ships a wingman layout plays it (the short half, one bomb site); one that ships none loads
whole — legal and playable, but not the game a wingman player expects. Name a wingman map
(`de_lake`, `de_shortdust`, …) when that is what you mean, and say so on the screen where
somebody picks the format.

## 0.13.0 — 2026-09-20

**Nobody has to type `.ready`** (PRD-03 T3a, for the platform's PRD-10 T4):
`rules.warmup.autoReady`, a boolean that defaults to **`true`**. Additive — a request
written before this field existed parses unchanged and gets the default, which is the
owner's decision of 2026-09-19 that real matches auto-ready. The server readies each
player a couple of seconds after they pick a side and counts down out loud once the gate
is passed, so the match a lobby made starts by itself.

Two things a consumer needs to know about it:

- **It decides who has said yes, never whether the match may start.** Every gate is
  unchanged: the whole roster still has to be connected and on its configured side, and
  `minPlayersToReady` still has to be met. A rostered player who never connects still
  holds the match in warmup — **your join deadline is the only thing that gives up on
  them**, as it was before.
- **Read it off the request rather than guessing.** A ready board that says "type `.ready`
  in game" is wrong for an auto-ready match; what it should show is who is in and who is
  still missing, with the countdown starting when the last one arrives. `.ready` and
  `.unready` still work for anyone who types them, and `.unready` opts that player out
  until they type `.ready` again.

Not in this package, because no request may ask for them (PRD-03 T3a, decision 19 as
amended): a server of ours now runs a **side-pick timer**, so a knife round whose winner
never answers picks a side at random after sixty seconds instead of holding the box for
ever — and `.gg` and forfeit-on-disconnect stay **off** on every server, because this API
has no result that says a match was surrendered or walked over, and a server must not end
a match in a way its client cannot record.

## 0.12.0 — 2026-09-20

**Six new gameserver events, so a client can draw the ready gate and the knife** (PRD-03
T3, for the platform's PRD-10 T4): `player_ready`, `player_unready`, `team_ready`,
`all_ready`, `knife_start` and `knife_end`. Additive — the union goes from 22 types to 28,
`GAMESERVER_EVENT_CONTRACT_VERSION` stays 1, nothing that existed moved, and a client that
ignores an unknown `type` needs no change. They are all durable, so they arrive on the
webhook, on the stream and in `GET /v1/matches/:matchId/events` like every other fact.

- `player_ready` and `player_unready` carry the player and a `tally`: `tally.ready` is the
  ready count per team in team order, `tally.expected` is how many the server is waiting
  for across both teams.
- `team_ready` carries the team that passed the gate and the same tally.
- `all_ready` means both teams are through, with `countdown: true` when the server is
  counting down rather than starting at once. `going_live` still follows, after the knife
  round where there is one.
- `knife_start` and `knife_end` bracket a knifed map. `knife_end.winner` is who picks the
  side, `null` when the server could not attribute it; the pick itself arrives as
  `side_swap` when they swap and as nothing at all when they stay.

**Draw these, do not recompute them.** Whether a team has passed the ready gate is a
judgement the match plugin makes from its own rules — who is connected, who is on which
side, the configured minimum — and a client that reimplements it is exactly what let the
2026-09-18 stall (0.11.1) hide from every test we had. The tally is the server's
arithmetic; a lobby renders it.

Beside it, in the orchestrator rather than in this package (PRD-03 T3): the MatchZy door
now translates MatchZy-Enhanced's `round_started` into the `round_start` this package has
always had. Until now a `pug` produced no `round_start` at all — the core plugin emits it
only for its own gamemode flows, and MatchZy had no event for it before the fork. A
consumer that counted rounds off `round_end` is unaffected; one that wanted a round's
beginning now gets one.

## 0.11.1 — 2026-09-19

**`warmup.minPlayersToReady` gets one meaning, written down** (PRD-03 T1, for the
platform's PRD-10 T3): it is the number of ready players **across both teams**, never per
team. Nothing in the shape moved — two doc comments and a `.describe()` on each of the two
warmup fields — but until now neither this package nor `docs/match-api.md` said which, and
the two ends had picked different answers: the platform computes a total
(`gamemodeReadyGate`), MatchZy counts per team (`GetTeamMinReady`). The total is the wire's,
because a client can compute it from the roster it already holds without knowing which
match plugin will run the server; the orchestrator's config builder halves it for MatchZy
on the way in.

Beside it, in the orchestrator rather than in this package: `players_per_team` is sized
from the roster instead of from the gamemode's `teamSize`, which is what made a 1v1 pug
impossible to start on 2026-09-18 — MatchZy passes a team only at `playerCount >=
players_per_team`, so two people typing `!ready` at a five-a-side number waited for ever.
A client that was already sending the right `minPlayersToReady` needs no change; a 1v1 now
goes live.

## 0.11.0 — 2026-09-08

The **fifth hardware recording**, `fixtures/recorded/real-powerup-dm-bo1.json` (PRD-02
T40): a whole `powerup-dm` — the round's original SDK mode — played by eight bots on the
dev node on this box and driven, like every other one, through nothing but the Match API.
It is the recording the round's fourth gamemode never had: `pug`, `flying-scoutsman` and
`retakes` were recorded when they landed, and `powerup-dm` was proved on hardware three
times in T26 without any of those runs being written down.

It is the longest of the five and honestly so — a ten-minute deathmatch is 346 deaths, so
355 envelopes and 355 verified deliveries against `pug`'s 47 — and it is the only recording
whose match ends on `mp_timelimit` rather than on a round count. The 5 741 position ticks
its stream carried are **not** in the file and never were: ticks are ephemeral, stream
only, never stored (`docs/decisions.md` 6), which is exactly the rule a recording of a mode
this chatty is worth having as proof of.

No schema, no route and no default moved: `0.10.1`'s shapes are this release's. Like the
four beside it, the file is never regenerated from code, and every payload in it must still
parse against this package's schemas — the day one stops, the vocabulary moved under a
server that already spoke it.

**And one conformance flow gets the margin 0.10.1 gave its neighbour.** `prefer-lan` ends
by giving its box back with `cancel`, and a cancel is refused the moment the match is live;
at the twenty times real time an extended target plays at, `ready → live` is a second or
two, so the poll that saw the connect facts and the cancel that followed it were racing the
story — green against the fake and against a quiet orchestrator, and red on a loaded box
with `cannot cancel a live match; use force_end`. The flow now asks for `sim.timeScale: 2`
like `reprovision-before-live` does, which makes the window tens of seconds; a target with
no simulator ignores it, and the flow ends at the cancel, so nothing costs more.
`fixtures/recorded/prefer-lan.json` is re-recorded to match.

## 0.10.1 — 2026-09-08

Fixtures only: no schema, no route, no default. The `reprovision-before-live` conformance
flow is the one flow that has to catch a match **in the act** — every other flow waits for
a state a match keeps, and this one needs the window between the first box being allocated
and the first round starting, because that is the only time a match can be moved. On a
target that plays a real story on real timers that window is a second or two wide, and one
starved poll cycle falls straight through it: the flow then waits out its whole budget on a
match that is already playing, and reports it as a box that never came (PRD-02 T39b). Three
changes, all inside the flow:

- The request asks for the story at **`timeScale: 2`** instead of the target's own, which
  makes the window tens of seconds — a margin that holds rather than one that is lucky —
  and a `sim.speed` back to 20 once the replacement is standing keeps the play-out at the
  speed it always ran at. A target with no simulator ignores both, which is the right
  thing to do with either.
- The waits are for the **provider's own server id**, not for the transient `ready` state
  and not for the ledger row: a row is written before the walk asks anyone for a box, so a
  reprovision keyed on `fleetServerId` would cancel an allocation that had not happened
  yet.
- A match that is already `live` or `ended` when the flow looks fails **in one poll**,
  saying the poll missed the window, instead of after the wait's whole budget saying
  nothing.

`fixtures/recorded/reprovision-before-live.json` is re-recorded to match.

## 0.10.0 — 2026-09-08

The round's last additive change is not a schema: it is a **fourth hardware recording**,
`fixtures/recorded/dathost-pug-bo1.json` (PRD-02 T36). The three `real-*.json` beside it
are matches played on the dev node on this box; this one is a match on a box **rented in a
datacentre** (Dathost, Düsseldorf) driven through the deployed orchestrator at
`gs.ezpug.com` over the public internet — 117 calls, 48 webhook envelopes and their
verified deliveries, 53 stream frames, a real demo PUT into the platform's bucket. Same
shape as every other recording (`flow`, `calls`, `envelopes`, `deliveries`, `frames`),
same rule: it is never regenerated from code, and **every payload in it must still parse**
against this package's schemas. That is what makes a recording a contract test rather than
a souvenir — the day one stops parsing, the vocabulary moved under a server that already
spoke it.

No schema, no route and no default moved in this release; `0.9.0`'s shapes are `0.10.0`'s.

## 0.9.0 — 2026-09-08

Four contract gaps the platform's own console found and wrote down instead of editing a
schema (decision 24). Each entry names the note it answers in
`ezpug/ralph/PRD-09-iron-platform.md`. Additive throughout; a client that pinned `0.8.0`
sees every shape it knew unchanged, and every one of these is optional.

- **`MatchRequirements.preferLan`** (answers **T3's note**): "the venue's hardware first,
  a rented box otherwise". Every other field of `requirements` narrows — `lan: true` means
  a self-hosted node *or nothing*, so a LAN night held before a node is enrolled refused
  every match — and this one only **ranks**: nodes first, then cheapest, and nothing
  filtered out. `lan` and `preferLan` in the same request is `validation_failed`: they are
  two different sentences about the same wish.
- **`GET /v1/sim/scenarios`** (answers **T4's note**): `{ scenarios, default }`, the
  scripted shapes this build's simulator can play, each with its knobs spelled out
  (`neverReady`, `absentPlayers`, `crashAfterRound`, `pauses`, `overtimes`, `comeback`).
  A console offering a dropdown reads it here instead of keeping a second list that agrees
  with the orchestrator's by ancestry alone; an added scenario used to be discovered as a
  `validation_failed` on a match somebody meant to demo. Served whether or not the `sim`
  provider is registered — it is what the build knows how to play, and `GET /v1/capacity`
  is what says whether it could.
- **`MatchCallbacks.demoUploadUrls`** (answers **T5's note**): one presigned PUT per map,
  `{ mapNumber, url }[]`, so a Bo3 keeps every map's demo instead of overwriting map 1's
  bytes with map 2's. **Not** a `{mapNumber}` template: a presigned URL's signature covers
  the object key it was drawn for, so a template could not be signed — the list is the only
  honest shape. The entry whose `mapNumber` matches wins, `demoUploadUrl` is the fallback
  for every map without one (exactly what a Bo1 always did), and `demoUploadUrlFor()` is
  the rule as a function, which the orchestrator, the fake and the plugin all call. With
  only the single URL the plugin still refuses the second PUT and says so in its log.
- **The `reprovision` command** (answers **T14's note**): the same match, another box.
  Before the match is live the current server is released and the placement walk runs again
  for the same `clientMatchId` — the thing a second create could never do, because that id
  is the idempotency key and a repeat replays the match it already made. From `live` it is
  the recovery a lost server starts by itself, started by hand: `match.recovering`, a
  replacement handed the newest round backup, `match.recovered`. `no_backup` from `live`
  with nothing to resume from, `invalid_state` while a replacement is already on its way.
  The ledger and the events replay tell the whole story — two rows, two `match.allocated`.
  It is the first command the orchestrator answers **by itself and never relays**
  (`ORCHESTRATOR_COMMAND_TYPES`, beside `SIM_COMMAND_TYPES`).

Four conformance flows travel with them — `sim-scenarios`, `prefer-lan`,
`reprovision-before-live` and `demo-per-map` — and pass against the fake, the fake over
HTTP and the real orchestrator.

## 0.8.0 — 2026-09-07

Fleet facts and provider health (PRD-02 T31): a key can name one endpoint for everything
that is about its capacity rather than about a match, and the ledger can be asked what a
night cost. Additive; a client that pinned `0.7.1` sees every shape it knew unchanged.

- **`ledgerFilterSchema.since`** (`GET /v1/fleet/ledger?since=`): every row that was open
  at or after that instant — still open now, or released at or after it. It is the window
  a **bill** is asked over, not the window a row was born in, so a server allocated before
  midnight and still running is part of tonight's; `GET /v1/fleet/budget` is the same read
  with the first of the month. A request without it pages the whole ledger as before.
- **`fleetWebhookSchema`** (`{ url, secretId }`) and **`ApiKey.fleetWebhook`**: where the
  key's four `fleet.*` facts are POSTed. A console tile that watches the fleet is one
  endpoint now, instead of a subscription to every open match. The envelope does not
  change — same `matchId`, same `seq`, same signature scheme, same events route — only its
  destination; `secretId` names one of the key's registered webhook secrets, so the
  verifier on the other side is the one it already runs. A key with none hears its fleet
  facts on each match's own callback, exactly as before.
- **`PUT /v1/keys/:keyId/fleet-webhook`** (`admin`, body `{ fleetWebhook }`, `null` to
  clear) and **`ApiKeyCreateRequest.fleetWebhook`** to register one at the mint. A
  `secretId` the key never registered is `validation_failed`: an endpoint whose envelopes
  carry a `kid` nothing can verify fails silently at three in the morning, which is worse
  than not having one.

## 0.7.1 — 2026-09-07

The fake says what a server says while it waits. No schema moved: `warmupLines` has been
on the request since `0.1.0`, and this is the fake finally honouring it. Serves PRD-02 T30.

- **The fake's simulated server prints a request's `warmupLines`** one every eight seconds
  from `server_ready` until the map goes live, cycling in order — as a
  `plugin_event` named `chat_announced` with `{ line }`, the same event an `announce`
  already deals, and the same rule, pace and sanitizing the core plugin's own printer
  follows on a real server. A request without warmup lines plays exactly the match it
  played before, down to the seed.

## 0.7.0 — 2026-09-07

The push: a gamemode may put one moment on one player's phone (decision 17). Serves
PRD-02 T26, `powerup-dm`'s `radar_peek` — five seconds of the enemy positions on the
phone that asked for them, and nowhere else. Additive; a client that pinned `0.6.0` sees
every shape it knew unchanged. Only a **widget** parses the frames this adds, and a
widget is served by the orchestrator that sends them, so the two never disagree about the
union.

- **`WidgetPushFrame`** (`{ type: 'push', name, data }`), a fourth member of
  `WidgetServerFrame` and a fourth entry in `WIDGET_SERVER_FRAME_TYPES`: something the
  gamemode wants *this* phone to see now. `name` is the mode's own snake_case word for
  it, `data` its own shape — this contract does not read it, because the plugin that
  sends it and the widget that draws it ship together in `gamemodes/<id>/`. A widget that
  does not recognise a `name` ignores the frame.
- **`WIDGET_PUSH_DATA_MAX`** (16 KiB of serialized JSON): the ceiling the orchestrator
  enforces where a push enters it. A mode that wants to send more than that wants an event.
- **A push is ephemeral by contract**: relayed to the open widgets of the one SteamID64
  it names, never logged, never written to the match's event log, never replayed to a
  widget that reconnects. The position-tick firehose still never crosses the socket — a
  push is a picture a mode chose to give one player, not a feed.
- **`FakeOrchestrator.widgetPush(matchId, steamId64, push)`**: the door a test or a widget
  harness opens by hand, since the fake's simulated server runs a stand-in mode with no
  opinion about when a push is due. Returns how many phones got it.
- **The shipped `powerup-dm` manifest is `0.2.0`**: the `powerup` verb's `kind` enum is
  now `speed`, `armor`, `radar_peek` (was `haste`, `armor`, `heal`), and its description
  says so in both languages. The verb, its one charge per life and its cooldown are
  unchanged.

## 0.6.0 — 2026-09-07

The widget's address: the catalog names where a gamemode's widget is served (decision 17).
Serves PRD-02 T25, the `gamemode-kit` that builds a widget and the orchestrator route that
serves it. Additive; a client that pinned `0.5.0` sees every shape it knew unchanged and
strips the one new field.

- **`widget.url`** on the served manifest (`GamemodeWidget`, optional): the absolute,
  immutable, content-hashed URL of the HTML document the platform mounts in its sandboxed
  frame — `<orchestrator>/gamemodes/<id>/widget/<sha256[0..16]>/index.html`, whose
  script is `./widget.js` beside it. The orchestrator adds it to the manifests it serves
  when it has the mode's bundle; an authored `manifest.json` never carries it, and the
  fake's catalog never does (the fake serves no bundle — the platform's dev twin stands
  in). A `capabilities.widget` mode without a `url` is one this orchestrator cannot mount
  yet; a host mounts nothing rather than a blank frame.
- **`widget.entry`** of the shipped `powerup-dm` (manifest `0.1.1`) is now `dist/widget.js`,
  the path relative to the mode's directory that `ezpug-widget build` produces.

## 0.5.0 — 2026-09-07

The widget socket: a gamemode's widget opens its own socket to the orchestrator with a
player token and taps the mode's declared commands (decision 17). Serves PRD-02 T24, which
mints the tokens, relays the taps to the plugin's SDK and teaches the simulated server to
answer them so the platform can test its host without CS2. Additive; a client that pinned
`0.4.3` sees every shape it knew unchanged.

- **`GET /v1/widget`**, a second WebSocket upgrade beside the stream (`matchApiRoutes.widget`,
  `WIDGET_SOCKET_PATH`), and its frames in `widget/socket.ts`: up `hello { protocol: 1,
  token }` — the token travels in the first frame, never in the URL — and `command {
  correlationId, command, args? }`; down `hello { matchId, steamId64, gamemode, state,
  locale?, commands: WidgetCommandState[] }` (the manifest's specs plus `chargesLeft` and
  `readyInMs` as last learned), `event { envelope }` (every durable fact, the webhook's
  envelope) and `command_result { correlationId, command, status, code?, message?,
  cooldownMs?, chargesLeft? }`. `WIDGET_COMMAND_REFUSALS` is the SDK's seven plus
  `rate_limited`, `not_live`, `unavailable`; `WIDGET_CLOSE_CODES` mirrors the stream's
  (`4000` the match ended, `4001` unauthorized, `4002` protocol, `4003` malformed, `4005`
  origin, `4008` slow consumer, `4009` no hello); `WIDGET_COMMAND_RATE_LIMIT` (ten taps,
  two a second per token) and `WIDGET_HELLO_TIMEOUT_MS` (ten seconds) are published so a
  widget can say why it was refused. `WidgetClientFrame` and `WidgetServerFrame` join the
  schema registry.
- **`validatePlayerCommandArgs(schema, args)`**: the corner of JSON Schema a manifest's
  `commands[].args` uses, checked in TypeScript with the SDK's `ArgsValidator`'s sentences —
  one document, the same verdict on the phone, the simulated server and the plugin.
- **The fake enforces the manifest now.** `fake.playerCommand()` runs the tap through the
  simulated server's stand-in mode (`@ezpug/sim`'s command table): cooldowns and charges
  per period, args against the schema, `not_in_match` off the roster unless the mode is
  open join; a refusal is an `ApiError` (`command_unsupported`, `validation_failed`,
  `player_not_in_match`, `rate_limited`, `invalid_state`) whose `details.code` is the
  socket's refusal code. `fake.widget(token, onFrame, onClose)` is the socket in-process
  and `fake.listen()` performs the `/v1/widget` upgrade. The stand-in mode's
  `plugin_event` is dealt through the engine, so it carries the server's `seq` like every
  other event — the recorded `player-command` flow was re-recorded for the shifted `seq`s
  and nothing else.
- `POST /v1/matches/:matchId/player-tokens` is documented as the orchestrator serves it: a
  rostered player, a player the server has seen join, or anyone on an open-join mode;
  `invalid_state` once the match is over.

## 0.4.3 — 2026-09-07

Catalog only: `retakes` is a mode a server can actually play. Serves PRD-02 T23, which
vendored cs2-retakes 3.1.0 and a weapon allocator into the server image and taught the
loader to write a vendored plugin's own config file before it enables it.

- The `retakes` manifest the fake serves (and the orchestrator ships) is at `0.2.0`:
  `plugins` names the allocator beside the plugin (`RetakesPlugin`, `RetakesAllocator`,
  in load order — the allocator resolves the retakes capability a tenth of a second after
  its own load), `maps.catalog` gains `de_train` and is now exactly the maps the pinned
  release ships spawn configs for, and `cvars` carries the two the mode needs to land
  after cs2-retakes' own cfg (`bot_quota_mode`, `bot_join_after_player`). The description
  says who hands out the guns.
- No schema, route, event, error code or state changed. cs2-retakes' own settings —
  `MaxPlayers`, `ShouldAutoJoinGame` — are not in the manifest and are not cvars: the
  orchestrator derives them from `slots` into the plugin's config file, over the link.
  A client that pinned `0.4.2` sees the same shapes; a client rendering the catalog sees
  a corrected card and one more map.

## 0.4.2 — 2026-09-07

Catalog only: `flying-scoutsman` grew a story and says so. Serves PRD-02 T22, which gave
the SDK a generic flow emitter — `going_live`, `round_start`, `round_end`, `side_swap`,
`map_end`, `series_end` read off the engine — so a `flow: plugin | none` mode with no
match plugin anywhere still tells a complete match.

- The `flying-scoutsman` manifest the fake serves (and the orchestrator ships) is at
  `0.2.0`: `slots.openJoin` is `true` (a scout duel is open to whoever walks in), and the
  description no longer says the mode has no match flow, because it now has one. The two
  recorded flows that read the catalog — `config-only`, `happy-bo1` — carry the new text.
- No schema, route, event, error code or state changed. A client that pinned `0.4.1` sees
  the same shapes; a client rendering the catalog sees a corrected card.

## 0.4.1 — 2026-09-06

Fixtures only: a conformance flow that finds its match already over says **why**. Serves
PRD-02 T21c, where `happy-bo1` failed a whole `pnpm verify` on `the match failed before it
was ready` and the reason lived only in a row `afterAll` was about to sweep.

- The three flows that wait for a match to become ready or to go live now print the
  `endedReason` beside the state — `failed: provider_error — server lost before going
  live: sim no longer lists server sim-1` instead of `failed`. No schema, route, event or
  recorded fixture changed; a red run in somebody else's CI is now readable from its log
  alone.

## 0.4.0 — 2026-09-06

Additive: the demo pipe says what landed and what did not. Serves PRD-02 T21 (the core
plugin owns the upload, the orchestrator relays the fact) and the platform's demo
handling in `PRD-09`, which otherwise cannot tell "no demo yet" from "there was never
going to be one".

- `demo_available` gains `sha256` (lowercase hex) and `contentType`, present together and
  only once the server has already PUT the file where `callbacks.demoUploadUrl` said. That
  pair is what the orchestrator relays as `demo.uploaded`; a `demo_available` without them
  announces a demo that exists on the server and nowhere else.
- `match.ended` gains `demo`: `uploaded`, the number of maps whose demo reached the
  client's storage, and `skipped`, why there were not more — `no_upload_url`,
  `not_recorded`, `no_demo` or `upload_failed` (`DEMO_SKIP_REASONS`). `matchDemoOutcome()`
  is the one rule every producer answers it by, so the fake and a real orchestrator cannot
  drift. Absent only from a producer older than the field.
- No route, no state and no error code changed. A match that records a demo now stays
  `live` past its own `series_end` until the demo is announced or the orchestrator's demo
  window runs out: GOTV records the *delayed* broadcast, so a `.dem` is finished a
  `tv_delay` after the last round and the server it is on is released the moment the match
  ends. The conformance suite checks the ordering (`demo_available` before
  `demo.uploaded`, both before `match.ended`).

## 0.3.0 — 2026-09-06

Additive: the recovery flow's second `match.server_ready` says that it is one. Serves
PRD-02 T14 (a server that dies comes back) and the platform's `PRD-09` handling of
`match.recovering` / `match.recovered`, which otherwise cannot tell a replacement
server's connect facts from a first boot without consulting `Match.state`.

- `match.server_ready` gains two optional fields, present together and only on the
  replacement server's announcement while the match is `recovering`: `restored: true`
  and `round`, the round play resumes from (the same number `match.recovered` then
  carries as `resumedFromRound`). A first boot's fact is byte-for-byte what it was.
- The fake says both on its recovery path; the `crash-restore` recording carries them.

## 0.2.0 — 2026-09-05

Additive: two `admin` routes the operator half of decision 7 was missing. Serves the
platform's key administration (`PRD-09` T2's console) and PRD-02 T5's budget enforcement,
which is otherwise unreachable — a ceiling nobody can move is a ceiling nobody sets.

- `POST /v1/keys/:keyId/rotate` — draw the key a new secret, kill the old one on the
  spot, answer `{ key, secret }` like a mint. Same id, scopes, budget and webhook
  secrets; `invalid_state` for a revoked key.
- `PATCH /v1/keys/:keyId/budget` — move one or more of the three ceilings
  (`BudgetPatchRequest`, at least one named); the rest keep their values, and the key's
  `fleet.budget_threshold` warnings start over.
- The fake serves both; `GET /v1/fleet/budget`, the `budget_exceeded` refusals and the
  threshold facts are unchanged — this release only adds the door to them.

## 0.1.0 — 2026-09-05

The first release: the whole contract, exercised end to end by the fake orchestrator and
the conformance suite before it left the repo. ESM only, Node 22+, `zod` and `hono` as
peers, `@ezpug/core`, `@ezpug/gamemodes` and `@ezpug/sim` bundled into `dist` so a
consumer never sees them.

- The vocabulary: the platform's gameserver event union (22 types, contract version 1)
  copied verbatim, the SteamID64 grammar, `game`, `locale`, `mapRadar`.
- The Match API resources — `MatchRequest`, `Match`, `MatchCommand`,
  `MatchCommandResult`, `PlayerToken`, `Gamemode` (read side), `Capacity`, the fleet
  family, `ApiKey` — the `/v1` route table, the three scopes and the error vocabulary.
- Webhooks: the envelope `{ deliveryId, matchId, clientMatchId, seq, occurredAt, payload }`,
  thirteen orchestration facts beside the durable gameserver events under one
  discriminator, the `X-EZPug-Signature` scheme (`t`, `kid`, `v1`; five-minute window), the
  retry schedule and the `410` stop, `GET /v1/matches/:matchId/events` with a `seq` cursor.
- The stream: `GET /v1/matches/:matchId/stream` (an upgrade) and its frames `hello`,
  `event`, `tick`, `command_result`, `presence`; close codes.
- `@ezpug/match-api/client`: the table-driven typed client —
  `createMatchApiClient({ baseUrl, apiKey, fetch?, clock?, retry?, WebSocket? })` with the
  `Idempotency-Key` header on a create and a command, retries with backoff for `429`, `5xx`
  and a dead connection on the injected clock (`CLIENT_RETRY_DELAYS_MS`, `Retry-After`
  honoured and capped), `TransportError`, and `subscribeStream({ matchId, onFrame })` over
  `ws`/`WebSocket`.
- `@ezpug/match-api/webhooks`: `signWebhook`, `verifyWebhookSignature`, the envelope, the
  facts and the retry constants, plus the consumer's half —
  `verifyWebhook({ headers, body, secrets, clock })`, `parseEnvelope` and
  `createDeliveryDeduper(store)` keyed on `deliveryId` and `(matchId, seq)`.
- `@ezpug/match-api/fixtures`: one valid event per type, one valid fact per type,
  `envelopeFixture`, and the conformance suite — `runMatchApiConformance({ target, flows? })`
  over eleven flows (`happy-bo1`, `config-only`, `open-join`, `player-command`,
  `cancel-allocating`, `crash-restore`, `crash-lost`, `csgo-refused`, `budget-refused`,
  `webhook-replay`, `stream-hello`), `formatConformanceReport`, `assertConformance`, and the
  recorded golden exchanges at `@ezpug/match-api/fixtures/recorded/<flow>.json`.
- `@ezpug/match-api/fake`: `createFakeOrchestrator({ clock, prng?, gamemodes?, providers?,
  webhooks?, fetch? })` — every route in-process (`fake.client`) and as a Hono app
  (`fake.handler`, `fake.listen()` with the stream as a `ws` upgrade), matches played by the
  simulator engine, signed webhooks on the published retry schedule, the stream, ledger and
  budgets that refuse, `sim.*` commands, the fault knobs, `playerCommand` for the widget
  round trip, and `createFakeConformanceTarget()` — the fake wired as a conformance target.
  `hono` becomes a peer dependency; `ws` and `@hono/node-server` optional.
