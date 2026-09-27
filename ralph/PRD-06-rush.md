# PRD 06: Rush

Valve shipped **Rush** on 2026-09-22 ("Rush Hour"): a queued 3v3 where two teams fight
over a tower through a line of seven small rooms toward each other's castle. The owner
wants it on EZPug in custom rooms and as a queue of its own (`/root/ezpug/ralph/PRD-13-encore.md`
T19–T20, the constitution amended for it on 2026-09-27). Everything that touches a server
lives here, so this round ships the `rush` gamemode: its manifest, its cfg, the simulator
playing tower rounds so the platform can build and test against the fake, a real-server
row on the dev node, and a release of `@ezpug/match-api` the platform pins.

Runs in parallel with the platform's PRD-13. Its T19 waits for this round's release (the
`chore(deps): match-api x.y.z` bump), then its room row and queue row.

**Branch:** `main`. **Surface:** the whole repo. **Model:** `claude-opus-5-5`; effort as
tagged, `high` without a tag.

**Budgets:**
- **The dev CS2 lane** is the proving ground (`EZPUG_CS2_TESTS`, the dev node, the lane
  lock in `docs/operations.md`). The platform loop shares it.
- **Dathost:** none. Nothing in this round allocates a Dathost server.
- **Contract:** additive only; every change is a release to the box's Verdaccio with a
  changelog line naming the platform task it serves.

## Findings

Traced 2026-09-27 against the tree at match-api `0.27.0` and the dev node's volume.

- **The game already has the mode.** The CS2 install in the `ezpug-iron-cs2_cs2-data`
  volume updated itself to 1.41.8.2 on 2026-09-23 (PRD-05 T2f), and it carries
  `game/csgo/maps/rush_001.vpk`, `cfg/gamemode_rush.cfg`, `cfg/gamemode_rush_offline.cfg`
  and `panorama/videos/rush_001_preview.webm`. Nothing in this repo mentions Rush.
- **What Rush is** (Valve's notes of 22–24 September; `source2.wiki/Scripting/Counter-Strike 2/rush`,
  the most exact public description): 3v3; one map, `rush_001`, holding 19 arenas; a match
  is a line of 7 rooms (a start room `101`–`104` in the middle, four mid rooms from
  `201`–`212`, the castles `301` (CT end) and `401` (T end)); every room has a **tower** with
  a button, `+use` captures it for the presser's team; **the tower's owner wins the round**
  when the timer runs out, at once when every attacker is dead, and when both teams are
  dead; when every owner is dead the timer drops to at most 7 s (14 s in the end rooms and
  Convoy since 23 September) for the survivors to press; a round win moves play one room
  toward the loser's castle, a draw replays the room, a win inside the enemy castle ends
  the match; otherwise `mp_maxrounds 15`, 8 clinches, and at 7–7 the decider room
  **Convoy**; rounds are 40 s (60 s in the castles and Convoy); `mp_freezetime 13`,
  `mp_buytime 15`, `mp_startmoney 800`, `mp_maxmoney 10000`, `$2500` for a round win,
  `cash_team_loser_bonus 2100`, `mp_halftime 0`, `ammo_grenade_limit_total 1`,
  `mp_team_intro_type rush`, `bot_quota 2` with `bot_quota_mode fill`, a Rush bot tree
  `scripts/ai/rush/bt_default.kv3`. **The rules are a `cs_script` on the map**
  (`maps/scripts/rush_001.vjs`): every live round it sets `mp_ignore_round_win_conditions 1`
  and ends rounds itself with `FireWinCondition` (reasons 8/9 add to the score; elimination
  ends as `ELIMINATION_HOSTAGE_MAP_T/CT`, time as `WIN_BY_TIME_RUNNING_OUT_HOSTAGE`), adds
  money with `AddTeamMoney`, teleports the spawns and the tower into the next room, and
  ends the match early by setting `mp_maxrounds` to the rounds played. **So MatchZy cannot
  run it**: this is a `flow: none` mode (the SDK tells the story from the engine's events)
  or a `plugin` one if a thin plugin is needed for `going_live` and the roster gate.
- **How a mode is added** (`docs/gamemodes.md` → Authoring the next one; decisions 14–16):
  `gamemodes/rush/manifest.json` against the field table, the id in `SHIPPED_GAMEMODE_IDS`
  and the import in `packages/match-api/src/gamemodes/index.ts:1-27` (the test insists the
  folder list and the id list agree), the cfg at `gamemodes/rush/cfg/ezpug/rush.cfg` (the
  pattern: `gamemodes/flying-scoutsman/cfg/ezpug/flying-scoutsman.cfg`), `pnpm verify` puts
  it in the catalog the fake serves and in the JSON Schema the C# side generates from.
  The nearest sibling is `flying-scoutsman` (tier `config`, flow `none`, records `events`,
  `slots {5, 2, openJoin true}`, `maps: "any"`, no plugins, `capabilities.simulation`).
- **The schema's edges this mode touches** (`packages/match-api/src/resources/gamemode.ts`):
  `slots.teamSize ≤ 32, teams 1|2` (`:65-71`) takes `{teamSize: 3, teams: 2, openJoin: false}`;
  `maps` is `"any"` or `{catalog: [...], workshop: [...]}`: whether `rush_001` may be a
  `catalog` id is `vocabulary/maps.ts`'s (`mapIdentifierSchema`) and T1 decides; `formats`
  (`:390`) is `competitive|wingman` and Rush is **not a format** of `pug`, so nothing there
  changes; `length` (idle timeout) applies to a `none` flow.
- **How the server is told what to play.** `docker/cs2/entrypoint.sh:148-149` boots with
  `+game_type ${EZPUG_IRON_CS2_GAME_TYPE:-0} +game_mode ${EZPUG_IRON_CS2_GAME_MODE:-1}`;
  MatchZy sets `game_mode 2` for wingman (`match-config/matchzy.ts:59`); the loader
  (`plugins/EZPug.Core/Loader/GamemodeLoader.cs`) execs the manifest's cfg and changes the
  map after a cvar settle (`:154-165`). Rush's `game_type`/`game_mode` pair is not in this
  repo: the client's `gamemodes.txt` inside `pak01_dir.vpk` on the node has it (VRF is
  pinned in the platform's `scripts/valve-tools.mjs`, `pnpm skins:assets` reads the same
  install), and `gamemode_rush.cfg` is what the engine execs for it.
- **The sim plays a `none` flow already** (`packages/sim/src/story.ts:165-215`, the
  `SDK_TOLD_FLOWS` branch: the SDK ends warmup itself, `going_live`, rounds, `map_end` with
  a reason; `:414-428` records nothing for `records: events`; `playLength` `:1406`), with
  `assignment.ts` carrying `flow`, `records`, `length`, `slots`. What it does not know is a
  round that ends on a **tower** rather than on bodies, a room that moves, and a match that
  ends in a castle: `round_end` today is bomb or elimination shaped
  (`:623-676`, `:902`).
- **The platform's evidence and needs** (`/root/ezpug/ralph/PRD-13-encore.md`, Findings →
  Rush): it will show a `rush` match with no radar and no bomb, a round strip that says who
  owned the tower, 15 rounds, its own room preset and an unranked queue whose lobby has no
  map act. It reads the round-end **reason** off the wire as the package names it, so the
  vocabulary for a tower round is this round's to name (Match.md §5's union is ours:
  `packages/match-api/src/vocabulary/gameserver.ts`).
- **The lane** (`apps/orchestrator/src/cs2.extended.test.ts`): rows are shapes played on
  the dev node behind the lock; the test at `:1556` names every shape the lane covers, and
  T3's row joins that list. The platform's own rows (`/root/ezpug/scripts/cs2-lane-rows.mjs`)
  play its presets and the queue through the real orchestrator.

## Attitude

- **The mode owns its rounds; the SDK only listens.** Nothing here re-implements the
  tower: the script on the map decides, the engine's events say what happened, and the
  SDK tells the platform. A shape the events do not carry (who pressed the button) is a
  fixture question, never a plugin that reads the script's state.
- **A manifest may lead, the sim must not lie.** The fake plays tower rounds the way the
  real map ends them (owner wins on time, elimination, the short capture window, the walk
  along the line, the castle ending) so the platform's tests mean something before a real
  server has been seen; the real row on the dev node is what makes it true.
- **Additive, released, named.** Every wire change is a minor release with a changelog
  line that names PRD-13 T19/T20.

## Tasks

- [x] **T1: the `rush` manifest, its cfg, and the vocabulary of a tower round.**
  `gamemodes/rush/manifest.json`: `game cs2`, tier `config` (or `plugin` with the
  thinnest possible plugin if `going_live` and the roster gate need one; say why in the
  decision), `slots {teamSize 3, teams 2, openJoin false}`, `flow none`, `records events`
  (a demo of a `none` flow is a later question; note it), `ranked false`, the one map
  (decide how `rush_001` is named on the wire: a `catalog` id if `mapIdentifierSchema`
  admits an engine map that is neither `de_*` nor workshop, else the smallest additive
  change to the schema, released), `cfg ["ezpug/rush.cfg"]` execing the engine's own
  `gamemode_rush.cfg` after the right `game_type`/`game_mode` (found on the node, written
  into the decision), the mode's cvars the manifest should pin (`bot_quota 0` for a match
  with six people, `mp_maxrounds 15` restated, `sv_cheats 0`), `capabilities {positions
  true, chat true, playerCommands false, widget false, backups false, scoreboardRating
  false, simulation true, mixedRoster true}`, DE+EN title ("Rush 3v3") and a description in
  the platform's voice (plain, spoken, no hype). Add it to `SHIPPED_GAMEMODE_IDS`. Then the
  vocabulary: the normalized `round_end` gains what a tower round says, additively (a
  `reason` value for the owner winning on time and for a capture, the room index or id and
  which side owned it, both optional so every older fixture still parses), and `map_end`
  can say the match ended in a castle; a fixture in `packages/match-api` for each shape;
  the conformance suite green. Release **x.y.0** to Verdaccio with the changelog line
  "PRD-13 T19".
- [x] **T1a (effort: medium): a Rush request's `rules`.** Found in T1: a request's `rules`
  derive `mp_maxrounds` from `regulationRounds` **over** the manifest's cvars
  (`match-config/cvars.ts`), and `regulationRounds` is even by schema, so a Rush request that
  carries `rules` plays 14 or 16 rounds rather than the map's 15, and `overtime.enabled` would
  switch on an overtime the script does not know. 0.28.0's changelog tells the platform to
  send none. Decide whether the door refuses `rules` for such a mode (a manifest field, an
  additive release) or the assignment drops what it derives. Either way a test in the unit tier.
- [x] **T2: the sim plays Rush.** `packages/sim`: a `rush` story: the line of seven rooms
  drawn at random from the ids above, play from the start room (CT owns it, T attacks),
  the tower's owner per room, rounds of 40/60 s on the fake clock that end the four ways
  the script ends them (time, all attackers dead, both dead, the owners wiped and the short
  window with a capture or not), the walk along the line, the castle ending, the 15-round
  limit and 8 to clinch, Convoy at 7–7, $2500 a win; bodies that die and buy so the stats
  the platform reads stay plausible; `going_live` with the engine's game type and mode as
  0.27.0 says them; the recording nothing (`records: events`). Determinism under the
  seeded PRNG (`determinism.test.ts`), `story.test.ts` cases for each ending, and the
  scenario door (`scenario.ts`) knows `rush`. Patch release if the wire moved, else none.
- [x] **T3: Rush on the dev node.** A lane row (`cs2.extended.test.ts`, named at `:1556`):
  a `rush` match requested through the front door with six puppets (`mixedRoster`), the
  server assigned, `rush.cfg` exec'd, `rush_001` loaded, `server_ready`, `going_live`
  carrying the engine's type and mode, at least two `round_end`s with a tower reason and
  their room, `map_end`, the server released; the lane lock taken and given back as
  `docs/operations.md` says. Whatever the real events say that the fixtures did not is
  fixed in T1's shapes (an additive release) or filed in `ralph/OPEN-POINTS.md` with the
  captured lines. Note what the node's bots do when `bot_quota` is left to the engine's cfg,
  and pin what a match wants.
- [ ] **T4 (effort: medium): the docs, the decision, the release.** A decision in
  `docs/decisions.md` (Rush is a `none`/`plugin` flow because the map's script owns the
  rounds; the map's name on the wire; the round-end vocabulary; what a Rush match records),
  `docs/gamemodes.md` gets the mode in its table and the authoring note ("a mode whose
  rules are a map script"), `CHANGELOG.md`, the pins. Closing note: the release versions,
  the `game_type`/`game_mode` pair, what the platform needs to do (bump, then PRD-13
  T19/T20's rows), and the platform's list of manifest titles that jar in German (PRD-13
  T11 sends it here; rewrite them in this task if the list has arrived, else leave the
  request in the note).

## Working rules

- **Production is `./scripts/deploy.sh` and nothing else**: the box's `docker` shim
  refuses `-p ezpug-iron` and `-f compose.prod.yaml` outside it with exit 125.
- **No Dathost.** Nothing in this round rents a server.
- **The CS2 lane is shared with the platform loop** (its PRD-13 T16/T19/T20/T22 rows): the
  lane lock as the page says, release after the server has left the fleet, never across a
  task boundary.
- **Additive contract, released with a changelog line**, never a service tag.
- **The game's files stay the game's.** `rush_001.vpk` and `gamemode_rush.cfg` are read on
  the node and never copied into this repo; the cfg here execs the engine's.
- **Commit only your own paths.** Never `git add -A`.
- **Secrets**: RCON and join passwords, GSLTs and tokens live only in gitignored env
  files, the token store, process memory or `~/.npmrc`; fixtures are scrubbed; nothing is
  ever pasted into a log line or a progress line.

## When the PRD is complete

- One green `EZPUG_CS2_TESTS=required` extended run with the Rush row in it.
- Every contract change released to the box's Verdaccio, `latest` pointing at the last.
- Closing note: the versions, the `game_type`/`game_mode` pair, the round-end vocabulary
  in one table, what a Rush match does and does not record, and the line the platform's
  PRD-13 T19 unblocks on.
