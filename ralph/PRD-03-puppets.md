# PRD 03: Puppets

A real CS2 server plays a whole match with nobody on it, and it gets there through the
doors a human uses: connect, ready up, play, end. Every server bug the owner hit in the
last two weeks sat on that path, and none of them sat on the path a test takes. The dev
lane rosters nobody and force-starts MatchZy over RCON, so ready-up has never run outside
production. In order, the owner found: a ten-player ready gate in a 1v1, a warmup death
recorded as going live, the connect details refused, and on 2026-09-18
`players_per_team: 5` for one player a side. This round closes that gap.

- **MatchZy-Enhanced** replaces stock MatchZy. This is decision 19's own clause, "fork the
  day a hook is missing", coming due.
- **Its simulation mode** turns bots into rostered players that ready up for real.
- **The SDK** gets the same for the modes MatchZy does not run.
- **The simulator's scenarios** become scripts a real server executes.
- **Plugin modes** get the length they lack, so an unattended run can end.

Runs in parallel with the platform's `PRD-10-puppets-platform.md` in `/root/ezpug`. That
PRD consumes the releases this round cuts and adds its own real-server lane on top.

**Branch:** `main`. **Surface:** the whole repo. **Model:** `claude-opus-5`; tasks tagged
`(fable)` run on Fable 5.1.

**Budgets:**
- **Main proving ground.** The dev CS2 lane (`EZPUG_CS2_TESTS`, the dev node, the
  `ezpug-iron-cs2` container, a 68 GB install on disk). It runs serially and in the
  foreground. The box has 12 cores and the platform loop runs beside this one.
- **Dathost.** At most one server per live task, bounded to one server-hour and
  deallocated in `finally`. Only T14 allocates one.
- **Contract.** Additive only. Every change is a release to the box's Verdaccio with a
  changelog line naming the platform task it serves.
- **Deploys.** `./scripts/deploy.sh` is pre-authorized. T1 deploys `gs.ezpug.com` as its
  last step, because the owner plays on it.

## Findings

Traced 2026-09-19. Trust the file over this note. The platform checkout is at
`/root/ezpug` (read it, never import it).

**The 2026-09-18 stall (platform matches `da31000f`, `d6fb7fb6`, pug 1v1).**
- The platform sent `warmup.minPlayersToReady: 2`, so its T61 worked. Both players typed
  `!ready` twice and nothing went live on either side.
- **Cause.** `apps/orchestrator/src/match-config/matchzy.ts:167` sets
  `players_per_team: manifest.slots.teamSize` (pug: 5). Lines 41-42 call that
  deliberate: "not the roster's length".
- **MatchZy's rule.** `references/MatchZy/ReadySystem.cs:48` passes a team only if
  `playerCount == readyCount && playerCount >= players_per_team`. One player a side can
  never pass.
- **Second mismatch.** MatchZy's `min_players_to_ready` is per team (`GetTeamMinReady`).
  The platform's `gamemodeReadyGate`
  (`/root/ezpug/packages/contracts/src/gamemodes.ts:297`) computes a total across both
  teams. `packages/match-api/src/resources/match-request.ts:94` says neither.
- **Why no test caught it.** `matchzy.test.ts:297-320` pins 5 only for a full 5v5 roster
  and for an unrostered bots match.

**The dev lane never readies.**
- `scripts/iron-match.mjs:1150-1176` sends `bot_kick; bot_quota 0`, then `css_start`,
  then `bot_quota N`, then `mp_warmup_end`. The match rosters nobody (lines 840-842 and
  970-971).
- `ezpug-iron matches create` has no bots option (`apps/cli/src/commands/matches.ts:44`).

**Bots in the SDK.**
- `plugins/EZPug.Sdk/Players/BotIdentity.cs:14-24` gives each bot
  `90_000_000_000_000_000 + slot`, so a bot can never be pre-rostered.
- `player_connected` and `player_disconnected` are emitted for humans only
  (`GamemodeRuntime.cs:588`, `:605`).
- Branding, rating, skins and rank skip bots (`Gamemode.cs:138`, `RatingBoard.cs:98`,
  `RosterLoadouts.cs:19`).
- Retakes' queue ignores bots (`QueueManager.cs:49`, `:303`, `:331`).
- The widget refusal (`GamemodeRuntime.cs:472-476`) finds a bot by its synthetic id, so a
  command can reach a bot today.
- An unrostered body reports `team: "spec"` (`ralph/OPEN-POINTS.md` §2).

**One-team modes.**
- `plugins/EZPug.Sdk/Gamemodes/GenericFlow.cs:229-251` scores by side and names a
  `team_a`/`team_b` winner even when `Slots.Teams == 1`. `Facts.cs:47` already has that
  rule for slots.
- No free-for-all match has ever finished on production: all seven powerup-dm matches
  were aborted.
- The retakes manifest is `teams: 2`, `teamSize: 5`. `apps/orchestrator/src/match-config/retakes.ts:60`
  sets the plugin's `MaxPlayers = teamSize × teams`.
- **Owner decision, 2026-09-19:** retakes is one team. The plugin balances sides itself
  and there is no real winner.

**Plugin modes never end** (`ralph/OPEN-POINTS.md` §1, seen twice with humans on them).
- One `round_start` at 0:0, then deaths, no score and no terminal fact.
- The box bills until a human releases it, and an unattended run cannot finish.

**MatchZy-Enhanced**
([sivert-io/MatchZy-Enhanced](https://github.com/sivert-io/MatchZy-Enhanced)).
- **Status.** MIT, a fork of MatchZy, v1.4.32 released 2026-09-16 (five releases that
  day), 22 stars, one maintainer. CounterStrikeSharp.API 1.0.342 on `net8.0`, the same as
  our 0.8.15 pin. It carries xUnit tests (`tests/MatchZy.Tests/`, including
  `SimulationRosterLogicTests.cs`).
- **Simulation.** The match JSON gains `simulation: true` and `simulation_timescale`
  (`src/MatchConfig.cs:84-91`, `src/MatchManagement.cs:781-791`). `src/SimulationMode.cs`
  (1077 lines):
  - spawns one bot per roster entry;
  - maps it to the configured SteamID;
  - rewrites outgoing stats to that SteamID;
  - synthesises the connect, because `EventPlayerConnectFull` is unreliable for bots;
  - readies the bots;
  - runs a warmup watchdog and reconcile pass;
  - applies `sv_cheats 1; host_timescale N`, and forces 0/1 for a non-simulation match
    (`:830-868`).
- **Events.** A superset of 0.8.15's. Added: `player_ready`, `player_unready`,
  `team_ready`, `match_loaded`, `warmup_start`, `warmup_ended`, `knife_round_started`,
  `knife_round_ended`, `knife_decision`, `round_started`, `side_swap`, `match_paused`,
  `match_unpaused`, `demo_recording_start`, `demo_recording_stop`, `demo_upload_start`,
  `demo_upload_success`, `demo_upload_fail`, `player_connect`, `server_configured`,
  `server_health`. The names we translate today (`series_start`, `going_live`,
  `round_end`, `map_result`, `series_end`) are unchanged.
- **Also added:**
  - a side-selection timer that decides after the knife round (a bots-only match needs
    this, since stock `css_stay`/`css_switch` need a player);
  - auto-ready;
  - `.gg`;
  - FFW;
  - queued match loads;
  - an event retry queue.
- **Reaches out by itself, must stay off:**
  - `MatchZySafeAutoUpdater` (`matchzy_safeautoupdater_*`, `src/ConfigConvars.cs:49-60`);
  - bootstrap config fetch;
  - `MatHeartbeat`;
  - the multi-server database;
  - `G5API`;
  - the pull API.
- **Stock bug it may fix.** 0.8.15's `EventHandlers.cs:19` (`!IsBot || !IsHLTV`) is
  always true, so stock kicks bots from a loaded match.

**What the 2026-09-15 research ruled out.**
- **Real game clients.** Each needs its own Steam account and a Vulkan GPU (this box
  exposes no `/dev/dri`). The Steam Subscriber Agreement, updated 2026-09-10, forbids
  automation.
- **A protocol-level fake client.** None exists publicly. Building one is months of
  reverse engineering and would break with most CS2 updates.
- **Engine-level input injection.** XBribo/CS2-Bot-Controller is AGPL and native Metamod,
  and it broke on the 2026-08-04 update. Optional, and not this round.
- **What CounterStrikeSharp alone offers.** `Teleport`, `GiveNamedItem`, `ChangeTeam`,
  `ExecuteClientCommandFromServer`. There is no usercmd hook.
- **Movement source.** The platform's demo corpus and parser (`/root/ezpug/data/demos`,
  `packages/demo`) already extract every player's position per tick.

## Attitude

1. **One MatchZy, everywhere.** The build a test proves is the build production runs.
   Simulation is a per-match switch, never a different binary, and production requests
   cannot flip it.
2. **Through the front door.** A puppet connects, readies, plays and leaves by the paths
   a human takes. An RCON shortcut in a test is an assertion skipped. The lane's
   `css_start` sequence becomes a named escape hatch that no green run depends on.
3. **One scenario language.** A sim scenario and a real-server script are the same thing
   with the same name. A knob a real server cannot execute is listed as sim-only in the
   docs, never silently ignored.
4. **Every red gets a class.** It is either a product bug (fix it, plus a test that goes
   red without the fix), a harness bug, or a vendor bug (an issue upstream with the
   reproduction). The class goes in the progress line.

## Tasks

- [x] **T1 (P1): a team of one can ready up.** The 2026-09-18 stall, fixed where it
  lives.
  - `players_per_team` comes from the roster: the larger team, capped at the manifest's
    `teamSize`. The manifest's number stands only for an unrostered match.
  - `warmup.minPlayersToReady` gets one meaning on the wire, per team or total. Pick the
    one a platform can compute without knowing MatchZy, write it into the schema's
    description and `docs/match-api.md`, and convert it in the builder. Say which in the
    progress line: the platform's PRD-10 T3 conforms to it.
  - Builder tests for 1v1, 2v1, 5v5 and unrostered, replayed against the vendored
    `ReadySystem` rule so a regression reads as MatchZy refusing, not as a number
    changing.
  - Release the change (docs-only if no schema moved) and deploy `gs.ezpug.com`. Say in
    the note that a 1v1 pug is playable tonight.

- [x] **T2 (fable): MatchZy-Enhanced, read and pinned.**
  - Clone the pinned tag into `references/MatchZy-Enhanced` and read it against
    `references/MatchZy` (0.8.15). Cover the licence, the CounterStrikeSharp API it
    compiles against, what changed in ready, knife, side choice, backups and the remote
    log, and every path that opens a socket by itself.
  - Our `cfg/MatchZy` keeps each of those paths off, and a test reads the shipped cfg and
    fails if one is on.
  - Pin it like every vendor: `docker/cs2/Dockerfile` ARG plus sha256, `docs/pins.md`,
    `check-pins`. **Owner decision, 2026-09-19: we pin upstream's release and do not
    customise it.** One maintainer shipped five releases on 2026-09-16, so the sha is the
    point: nothing unpinned reaches a server. A fork of our own is the escape hatch for a
    task that cannot be done without a patch. If a task takes it, that task records why
    and files the change upstream first. Run its own test project in our plugin verify if it builds on our
    toolchain; say so if not.
  - Amend decision 19, and strike PRD-02's "no fork of MatchZy" don't with the reason:
    the stall, simulation mode, the ready events.
  - Done when the dev lane's recorded `pug` plays on the new build as it did on the old
    (review the fixture diff), the image is rebuilt, and the Dathost template is
    refreshed (`pnpm dathost:image`), because the template carries MatchZy.

- [x] **T3: the new events, translated once, at the edge.**
  - Decide per added event whether it becomes vocabulary, stays internal to the
    orchestrator, or duplicates what `EZPug.Core` already says (decision 19: neither
    double-speaks).
    - Vocabulary candidates: `player_ready`, `player_unready`, `team_ready`,
      `warmup_ended`, the knife events, `demo_upload_*`.
    - Internal: `server_health`, `server_configured`.
    - Already said by the core: `player_connect`, `round_started`, `side_swap`, pauses.
  - New fixtures recorded from a real run go in `apps/orchestrator/src/matchzy/fixtures`.
  - Additive release. The changelog tells the platform what it can now draw: who is
    ready, a countdown, the knife decision.

- [x] **T3a: what real matches turn on** (owner decision, 2026-09-19).
  - Two of the fork's player features go **on** for real matches:
    - **the side-pick timer**: a knife winner who never answers no longer holds a server
      forever (`matchzy_side_selection_enabled`, `matchzy_side_selection_time`,
      `src/ConfigConvars.cs:132-134`);
    - **auto-ready**: nobody types `.ready`, and the match counts down once everyone is
      in (`matchzy_autoready_enabled`, `matchzy_autoready_start_delay`, `:84-87`).
  - **`.gg` and forfeit-on-disconnect stay off.** The platform has no forfeit result yet,
    and a server must not end a match in a way the platform cannot record.
  - Read how auto-ready decides: whether it waits for the full roster or for
    `players_per_team`, and what it does with a rostered player who never connects. Make
    that one sentence in `docs/match-api.md`.
  - The platform's join deadline stays the only thing that gives up on a missing player.
  - Whether auto-ready is the cfg's or the request's (`rules.warmup.autoReady`, additive)
    is this task's call. A LAN admin may well want manual ready back, so lean to the
    request with the preset deciding.
  - `.ready` still works for anyone who types it.
  - Lane cases:
    - a 1v1 of puppets with auto-ready starts with no ready command sent;
    - a knife round nobody answers resolves on the timer.

    > Both moved to T6, where puppets exist. A non-simulation match execs
    > `cfg/MatchZy/humans.cfg` (`bot_kick; bot_quota 0`) at every warmup start
    > (`Utility.cs` ExecWarmupCfg), so there is no body on a side for auto-ready to ready
    > until T4/T5 put rostered puppets there — the fork's own workaround for this is
    > `matchzy_autoready_simulation_enabled`, which is on our off-list. The lane ran the
    > recorded `pug` instead, which proves the switches reach a real server.
  - `matchzy_autoready_simulation_enabled` (`:92`, spawns two bots) is one more switch
    for T2's off-list.

- [x] **T3b: 1v1 and wingman on the wire** (owner decision, 2026-09-19: both presets, and
  every configured size works).
  - The platform already has a `wingman` preset and is adding `1v1` (PRD-10 T2a).
  - **Wingman.** MatchZy's match JSON has `wingman: true`, which switches `game_mode` and
    execs the wingman live cfg, with a map reload (`src/MatchManagement.cs:433`, `:590`,
    `:775-777`, `:1188`).
    - Decide how a request says so, additively: a `rules.format`, or reading 2v2 plus
      MR8 off the roster is too clever, so prefer the explicit field.
    - Decide what a wingman match means for maps: Valve's wingman layouts use one bomb
      site, and our catalog has no such notion yet. Say what happens on a full map.
  - **1v1** needs no engine mode, only T1's roster-derived gate and short rules.
  - Released, with the PRD-10 task named in the changelog.

- [x] **T4 (fable): the simulation switch in the contract.**
  - A match request may ask for simulated players. Decide the shape: which roster
    entries get a puppet (all, or all but the ones the request names as human), an
    optional scenario name, an optional timescale.
  - Who may ask: a key scope, `simulation`. Production's platform key does not hold it,
    and asking without it is a refusal with a name.
  - What the manifest says: a capability per mode.
  - The ledger: a simulated match on Dathost is still real money, capped like any other.
  - A simulated match says so in every fact's `source`, so no consumer can mistake it
    for a real one. The platform's PRD-10 T7 relies on this.
  - The fake and the sim honour it. Additive release.

- [x] **T5: ten puppets ready up for a pug.**
  - The MatchZy config builder emits `simulation` and `simulation_timescale` when the
    request asks.

    > Landed in T4, because `pug` claims `capabilities.simulation` there and a capability
    > the builder did not honour would have been a lie for one iteration: `simulation: true`
    > and `simulation_timescale` (the request's `timeScale`, `1` unsaid) are in the match
    > file exactly when the request carries `simulation`, and a real match's file is byte
    > for byte what it was. Unproven on hardware until this task plays it.
  - The dev lane plays a 5v5 `pug` in which every puppet readies through MatchZy's own
    ready system: `player_ready` ×10, `going_live`, rounds, `map_result`, `series_end`, a
    demo uploaded. No RCON touches the flow.
  - `iron-match.mjs`'s force-start becomes an explicit `--force-start` flag, documented
    as the escape hatch.

- [x] **T5a: the ready floor the door does not know.** `team_ready` only travels when
  MatchZy's count for that team matches the roster the request named
  (`matchzy/translate.ts`, T5): the fork calls a team through the gate from one player
  ready upwards while its bots are still being mapped, and forwarding that put "team A is
  ready" in a durable log with one of five. The filter costs the one case MatchZy really
  means it — a team let through on `min_players_to_ready` with somebody still missing.
  Teach the door that floor (it is the request's `warmup.minPlayersToReady`, halved by the
  builder) and play the case: a 5v5 whose gate is four a side, one player never connecting.

    > Played as a 5v5 of puppets whose gate is four a side, **without** the missing player,
    > because the fork cannot produce that half: `ReadySystem.cs` `IsTeamReady` refuses a
    > side holding fewer than `players_per_team` bodies *before* it reads the floor at all,
    > and `AreAllConfiguredPlayersConnectedAndOnCorrectTeams` holds the whole match in
    > warmup while any rostered SteamID is absent (T3a's sentence). So the floor is only
    > ever crossed by somebody who is **there and silent**, never by somebody missing — the
    > platform's join deadline is still the only thing that gives up on them. Both halves
    > are pinned in `matchzy.test.ts` against the fork's gate transcribed beside stock's.

- [x] **T6: the regression matrix, on real hardware.** Lane cases that each assert their
  fact sequence:
  - `pug` at **every size from one to five a side**, and 2v1 (uneven: the platform's
    PRD-10 T1 makes customs allow it);
  - the `1v1` and `wingman` formats from T3b;
  - knife on, with the side decided by the new timer (nobody types `.stay`), and knife
    off;
  - a 1v1 of puppets that goes live with **no ready command sent at all** — T3a's two
    lane cases, which need puppets on a side to be possible;
  - a pause and an unpause;
  - a rostered puppet leaving and coming back;
  - an overtime, if short `mp_maxrounds` can force one reliably, otherwise sim-only with
    the reason.

  Before the fix, the 2026-09-18 stall is reproduced red against the old builder.

    > **Overtime is counted, not asserted — sim-only, with the reason.** Four regulation
    > rounds end 2–2 often enough to be seen (five of the matrix's ten rows went to one,
    > up to fifteen rounds) and never on demand: two even teams of bots cannot be made to
    > draw, and CS2 works the clinch out from the `mp_maxrounds 24` MatchZy's own
    > `live.cfg` sets rather than the four the request asked for. So the lane prints what
    > each row happened to get and the seeded PRNG keeps the case.
    >
    > **The puppet that leaves cannot leave by the front door yet.** `kick` is gated on the
    > orchestrator's presence map, which is filled from `player_connected` /
    > `player_disconnected` — emitted **for humans only** — so for a room of puppets it is
    > empty and *no* player command can reach any of them. The run knocks twice (the
    > rostered SteamID and the synthetic one) and records both refusals as the case's real
    > assertion, red the day **T7** lands; the stimulus is then `bot_kick ct`, declared as
    > the matrix's only `rcon`. T8's widget path depends on the same gap.
    >
    > **Nothing announces a puppet's coming and going.** The fork synthesises
    > `player_connect` only on the `bot_quota` walk that first fills the room; a body its
    > reconcile pass adds later is mapped and re-readied but never announced. Measured: a
    > 1v1 that lost and regained a body sent two connects and two disconnects, and *three*
    > `player_ready` for two puppets. Position ticks and the go-live are the evidence
    > instead.
    >
    > T3a's two lane cases are satisfied by **every** row: no ready command is ever sent
    > and each asserts its own `commands.rcon`.

- [x] **T7 (fable): puppets in the SDK.** For the modes MatchZy does not run
  (`powerup-dm`, `retakes`, `flying-scoutsman`):
  - A roster-driven puppet identity replaces the slot-based `BotIdentity`. A bot takes a
    rostered SteamID, is announced like a human, and carries the `simulated` marker from
    T4.
  - Bots and puppets are two different things. A plain bot stays a bot: never rostered,
    never announced.
  - Answer `OPEN-POINTS.md` §2 here: a body the request never named gets its own team
    value rather than `spec`. One sentence in `match-api`, released; the platform's half
    of the open point closes with it.
  - The same request field switches it on.

    > **The `spec` of §2 was not the wire's shape but a bug in the world.** The recorded
    > `powerup-dm` run has one bot that is `spec` in all 219 of its appearances and wears
    > another bot's name: a kicked bot's disconnect named a controller that was already
    > gone, the slot kept its player, and the next body in that slot played the match as
    > the dead one, with no side to read. Production's "Krikey" was the same body. Fixed in
    > `CounterStrikeWorld` (the slot-named disconnect listener, and a newcomer to a held
    > slot sees the stale player out first). The team value was still answered, because
    > the rule underneath was a guess: `unrostered` for a body the request never named
    > while it plays on a side, `spec` on none, `team_a`/`team_b` the roster's word only.
    >
    > **`retakes` does not claim the capability here.** cs2-retakes keeps bots out of its
    > queue, so what a puppet does there is unproven; T10 turns the mode into one team and
    > owns the lane case, and claims it with the proof. `powerup-dm` and `flying-scoutsman`
    > claim it and were each played on the dev node.
    >
    > **A new enum value is not additive for a strict parser.** A platform on ≤ 0.15.0
    > refuses a delivery that says `unrostered`. Nothing in production sends it before T16
    > deploys; the platform's pin has to move first, and T16 must check that it has.

- [x] **T7a: a puppet in a pug is announced too.** T7 seats and announces puppets for the
  flows the SDK owns. Under `matchzy` the fork seats them and keeps which bot is which
  roster entry in a private dictionary (`SimulationMode.cs` `simulationPlayersByUserId`),
  so the core plugin still sees ten plain bots: no `player_connected`, an empty presence
  map, `kick` and a widget tap refused `player_not_in_match`, and deaths over the link
  under synthetic ids while MatchZy's stats carry the rostered ones. Find a way to read
  the fork's mapping rather than hold a second opinion about it (its `player_connect`
  payloads carry the rostered SteamID and the bot's name in order of arrival; its log
  lines say `Assigned bot <name> … to simulated player …`), cast the world's bots from
  it, and turn the lane's `drop` row into the front-door case: the two refusals it pins
  today go red, `rcon` goes to zero.

    > **The mapping is read off the fork's console, because that is the only place it is.**
    > Its `player_connect` payloads carry the rostered SteamID and the roster's *name*, not
    > the bot's (`BuildPlayerInfo` returns the identity whole in simulation), so they name
    > nobody's body; and they reach the orchestrator, not a plugin beside it. The log lines
    > do carry both, CounterStrikeSharp runs both plugins in one process and therefore one
    > `Console.Out`, and `matchzy_debug_console` is now an invariant of the image with its
    > own line in the cfg check.
    >
    > **The cast arrives after the body does**, which the SDK's seam could not express:
    > `IGameWorld.Casting` is asked at the door and the fork decides seconds later. Hence
    > `IGameWorld.Recast`.
    >
    > **What the `drop` row deliberately stopped asserting is the gate.** The kick now lands
    > the moment the room is announced, which is before either side has crossed it; the fork
    > refills with `bot_join_team <side>; bot_quota n+1` and the engine is free to put that
    > body on the *other* side while the fork maps it onto the empty roster slot anyway. Its
    > `IsTeamReady` counts per CT/T side, so the emptied team then never passes, no
    > `all_players_ready` is sent, and the fork force-readies both sides to get live — ten
    > `team_ready` on the wire, every one `team2`. Which side the replacement lands on is
    > the engine's lottery, so the row pins one `player_ready` per puppet and leaves the
    > whole gate to the other nine. A vendor property recorded, not filed.

- [x] **T8: a puppet taps the phone.**
  - Mint a widget token for a puppet's SteamID and drive `powerup-dm`'s widget socket
    against the dev server.
  - The grant reaches the SDK, the power-up applies and `plugin_event` lands.
  - A dead puppet is refused `NotAlive`. An unrostered SteamID is refused unless the
    mode is open-join.
  - This is the first automated proof of the path only the owner's finger has proved.

    > **The corpse is a race, and it is won from the frame.** A body in `powerup-dm`
    > respawns as fast as the engine can manage, so a tap fired from the script's
    > five-second poll would never meet one. The phone sees the match it is a phone for, so
    > the tap goes out from the `player_death` `event` frame on the widget socket itself —
    > answered **15–17 ms** after the death on both runs. The sequence around it is the
    > charge rule showing through (`charges: 1 per life`, refilled on spawn): `no_charges`
    > for the grant's own life, `applied` for a tap that lands a hair late on the respawned
    > body, then the `not_alive` the row asserts. Every attempt is recorded with its delay,
    > so a race that started losing reads as a measurement rather than as a flake.
    >
    > **"Unless the mode is open-join" is two halves and this row can only play one.**
    > `powerup-dm` opens its roster, so the *token* is minted for a SteamID the request
    > never named — that is the half a run on this mode proves, and the tap is then the
    > SDK's to refuse (`not_in_match`, because no body on the server answers for that id).
    > The closed half is the door's `player_not_in_match` on `mintPlayerToken`, which no
    > mode with a widget can be made to do: it is pinned against the fake and against the
    > real orchestrator by the conformance suite instead, and a second live match to replay
    > it would buy nothing.

- [x] **T9 (fable): a length for plugin modes** (`OPEN-POINTS.md` §1).
  - A manifest vocabulary the SDK enforces: a duration, a frag limit, and an idle timeout
    once the last body leaves.
  - A plugin-flow match ends with a real terminal fact, with no winner when
    `Slots.Teams == 1`.
  - `powerup-dm` gets a duration and the idle end. `retakes` gets whatever its community
    plugin can honestly end on.
  - The release names the field the platform turns into a countdown (PRD-10 T6).
  - This is also what lets an unattended puppet run finish.

    > **The field is `going_live.length.durationSeconds`**, counted from that fact's
    > arrival — no server timestamp travels (the vocabulary never trusted a gameserver's
    > calendar), and a simulated match's time scale is already divided out of it. The
    > manifest's `length` is what a room says before anyone joins; `map_end.reason` and
    > `series_end.reason` (`time_limit`, `frag_limit`, `idle`) are the end reason.
    >
    > **The engine's clocks were the bug underneath.** `powerup-dm.cfg` had `mp_timelimit 10`
    > all along, which is why the lane's puppets always finished while production's humans
    > gave up first: nothing told a client there *was* an end. And `mp_timelimit` counts
    > from the map load while the SDK counts from going live, so two equal clocks meant the
    > engine won by the length of the warmup and the end carried no reason. The SDK owns the
    > clock now (`mp_timelimit 0`, `mp_roundtime 60`), which makes the mode **one round
    > nobody wins**: a `round_start` and never a `round_end`. The lane's row says so out
    > loud (`roundless`).
    >
    > **`retakes` honestly ends on its rounds** — cs2-retakes plays `mp_maxrounds` like any
    > round-based game and the generic flow reports the win panel — so it gets the idle end
    > only, and so does `flying-scoutsman`, which has the same open door and the same bill.
    >
    > **An idle end can come from `ready`**: a `series_end` with no `going_live` before it.
    > The machine already ended a match on `series_end` from any open state; a test pins it.

- [x] **T9a: the simulator plays a length.** The sim tells every mode as a round-based
  story and says none of T9's three fields, so a `powerup-dm` match on the `sim` provider
  — which is what the platform's dev world and its PRD-10 T6 draw from — has no countdown
  and names a winning team for a free-for-all. For a mode whose manifest declares a
  `length`: `going_live.length` in story time, one round of deaths that lasts the
  duration (or to the frag limit), `map_end`/`series_end` with the `reason`, no winner for
  `slots.teams: 1`; an `idle` scenario knob if a story with nobody in it can be told. The
  fake inherits it. Released, naming PRD-10 T6.

    > **The `idle` knob is one story with two honest ends**, because what happens to an
    > empty server is the *mode's* to say and not the scenario's: nobody connects, and a
    > manifest naming an `idleTimeoutSeconds` ends itself on it while a manifest naming
    > none waits for ever and leaves the join deadline the only thing that gives up — the
    > same two answers a real server gives.
    >
    > **A one-team mode names no winner in the round-based story too**, not only in the
    > length one, which is T10's second bullet arriving early: `winnerOf` reads
    > `assignment.teamCount` for every `map_end` and `series_end` the simulator emits, so
    > T10's manifest flip needs nothing here.

- [x] **T9b (P1): a key the Match API cannot list.** `keys.mint` is the service, not the
  route, so it accepts a `name` longer than `ApiKey.name`'s 64 characters — and then
  `GET /v1/keys` is `internal` **for every caller of that database**, because the response
  no longer parses. Found on 2026-09-20 with `standing.test.ts` red on a clean tree: six
  rows an earlier `verify:extended` conformance run left in `ezpug_iron_test`, minted
  `${namespace}-${flow.id}-${mints}-puppeteer`. T9a capped the names that call site mints
  and renamed the rows; the guard is missing. The service refuses what the contract cannot
  carry (name, scopes, budget), a test says so, and the bootstrap and node-enrolment mints
  are checked for the same reach.

- [x] **T9c: a mode that records events is handed a demo it never made.** The simulator
  emits `demo_available` for every map of every mode, `records: "events"` included — the
  orchestrator gates the *upload* on `records` (`providers/sim/provider.ts`) but the fact
  travels, and a real `powerup-dm` or `flying-scoutsman` server produces none. Thread the
  manifest's `records` into the assignment as T9a threaded `length` and `teamCount`, and
  say it only where a demo exists. T11 compares sim and real by the classes of fact they
  emit, so this is a diff it would otherwise find.

    > **The real server was never the liar** — `DemoFlow.cs` has read
    > `Gamemode.Records == Demo` since it was written, and MatchZy only records for a
    > `matchzy` mode, all of which record demos. The simulator was the one place that told
    > every mode the same story, so this is a one-sided fix and the lane had nothing to
    > prove: no `EZPUG_CS2_TESTS` run, and T11's comparison loses a diff rather than
    > gaining one.
    >
    > **The demo took its GOTV wait with it.** A story's `series_end` used to follow
    > `map_end` by eight seconds — six of them the file being written — and for a mode that
    > writes none it now follows by two, which also cost the `config-only` and `open-join`
    > goldens a heartbeat that no longer fits. That is the honest shape: the orchestrator's
    > demo window (`machine.ts` `demoPending`) was never armed for such a match either.

- [x] **T10: retakes is one team** (owner decision, 2026-09-19).
  - Manifest `slots.teams: 1` with `teamSize: 10`, since `retakes.ts:60` multiplies.
    `openJoin` stays.
  - `GenericFlow.cs:229-251` names no winner for one team, which fixes `powerup-dm` too.

    > Landed with T9, whose own bullet asked for it ("no winner when `Slots.Teams == 1`"):
    > `GenericFlow.Winner` reads the assignment's slots, for the win panel and for a length
    > alike, and `MatchLengthTests` pins both. What is left here is the manifest.
  - Bump the manifest version; the package bundles the manifests.
  - Record the decision.
  - A lane case: three puppets in `retakes` play and end.
  - Claim `capabilities.simulation` for `retakes` with that proof (T7 left it unclaimed:
    cs2-retakes keeps bots out of its queue, so read what a puppet does there first). The
    conformance flow `simulation-switch` already copes with a catalog in which every mode
    seats puppets; `machine.test.ts` and `assign.test.ts` name `retakes` as the mode that
    refuses and need another answer.

    > **The queue was the wrong door to worry about.** cs2-retakes does keep bots out of
    > `AddConnectingPlayer` and out of `SyncActivePlayersFromTeams`, but nothing seats a
    > puppet through either: the SDK's puppeteer asks the engine (`bot_add`), the engine
    > puts the body on a side, and `PlayerJoinedTeam` — which has no bot filter — takes it
    > into `ActivePlayers`. `PlayerEventHandlers.OnPlayerSpawn` even force-adds a spawned
    > bot that is missing from them. Three puppets played four rounds first time out.
    >
    > **The lane's rating path had never run before this row**, because `RATED` in
    > `iron-match.mjs` is `scoreboardRating && openJoin` and `retakes` is the only mode
    > that is both. Two things fell out: a harness bug fixed here (the profiles were
    > addressed to `BotIdentity`'s synthetic ids while the bodies carried the roster's, so
    > three commands reached nobody), and a finding parked in `OPEN-POINTS.md` §3 — the
    > three puppets are on the board under the roster's names with the number reading
    > **zero** on a live server, and which of the two candidate causes it is needs a human
    > or a human-played retakes match to settle.

- [x] **T11: the simulator's scenarios, executed by a real server.**
  - For each knob in `packages/sim/src/scenario.ts:88-112`, make it a puppet behaviour
    where the server can honestly do it:
    - `absentPlayers`: a roster entry with no puppet;
    - `neverReady`: puppets that never ready, which needs per-puppet control over the
      auto-ready Enhanced does, so read how its reconcile pass decides;
    - `pauses`: a puppet's pause command;
    - `crashAfterRound`: kill the container, so the node provider's recovery runs.
  - Otherwise it is sim-only with the reason, in a table in `docs/sdk.md` or
    `docs/gamemodes.md`.
  - Proof: one scenario run twice, on the sim and on the dev server, compared by the
    classes and order of facts. The diff between them is a bug in one of the two, and
    the note says which.

    > **Two of the seven knobs are a puppet's, and the other five are refused rather
    > than listed.** `absentPlayers` (a roster entry with no body) and `idle` (nobody
    > seated at all) are what the SDK's puppeteer can honestly do, and it is handed the
    > *knobs* — the orchestrator resolves the scenario into `assign.puppets`, so no
    > plugin holds a second copy of the catalog. The rest are `validation_failed` on
    > `simulation.scenario` with the knob named: `neverReady` is the **server** that
    > never boots (the knob was never about a silent player, which is what the task
    > summary read into it) and so is the fault suite's, `crashAfterRound` is a request
    > asking a box to die, `pauses` is the Match API's own admin verb — the matrix's
    > `pause` row already takes it through the front door — and `overtimes`/`comeback`
    > are outside anything that can be asked of a bot's aim. Under a `matchzy` flow
    > even the two are refused: the fork seats one bot per configured player and
    > force-readies both teams from its watchdog. The table is
    > `packages/sim/src/scenario.ts`, `docs/sdk.md` prints it and a test holds the doc
    > to it, which is what "never silently ignored" had to become to be worth anything.
    >
    > **The diff is the simulator's** (`idle`, played twice at timescale 2, 5.5 minutes
    > for both legs). Real: `server_ready`, `going_live`, `round_start`, `map_end`,
    > `series_end` — a mode the SDK tells the story of ends its own warmup twenty
    > seconds after the map is up whether or not anybody came, which is right for a
    > drop-in mode where people join a *live* server. Sim: `server_ready`, `series_end`
    > and nothing between, because the simulator tells every mode MatchZy's story, where
    > an empty server stays in warmup. Both end on the mode's idle timeout and name
    > nobody. T11a is the fix.

- [x] **T11a: the simulator's empty server never goes live** (found by T11, 2026-09-21).
  The `idle` and `no-show` stories hold an empty (or short-handed) server in warmup and
  end with `series_end` alone, which is MatchZy's behaviour and not the SDK's: a real
  `powerup-dm`, `retakes` or `flying-scoutsman` server ends its warmup itself
  (`GenericFlow.GoLiveDelayMs`) and ends on `map_end` + `series_end`. Measured side by
  side on the dev node and the `sim` provider in the lane's `idle` row, whose two
  assertions are the record of it. Thread the manifest's `flow` into the sim assignment
  as T9a threaded `length` and T9c threaded `records`, and tell the SDK-told flows the
  story a real one of them tells. The platform's dev world draws its `powerup-dm`
  matches from here (PRD-10 T6), so until then it is rehearsing against a match that
  cannot happen.

    > **The `flow` decides, and it decides for `no-show` too.** The manifest's `flow` now
    > reaches the assignment beside `length`, `teamCount` and `records`, and the two
    > stories that held a server in warmup ask it: MatchZy's warmup is held open until two
    > teams have readied up, so an empty or short-handed `pug` still runs dry and the join
    > deadline is still the only thing that gives up on it, while a `plugin` or `none` mode
    > ends its own warmup on `GenericFlow.GoLiveDelayMs` and is live with whoever is
    > standing there — which for `no-show` means the match is *played* short-handed, the
    > absentees in nobody's kill feed and nobody's scoreboard, and for `idle` means a room
    > with nobody in it goes live and ends on whichever of the mode's clocks runs out first
    > (the idle timeout from `server_ready`, the duration from `going_live`), `map_end`
    > carrying the reason because the map *was* live.
    >
    > **A `length` on a `matchzy` mode is nobody's**, so the simulator stopped pretending it
    > could end one: `MatchLength.OnAssigned` drops it for that flow on a real server and
    > the manifest rules refuse to carry one there, which makes the old branch dead code
    > wearing a test.
    >
    > **Every seeded story is byte for byte the one it was**, which took some care: the
    > absent draw is `prng.sample`, which shuffles the *whole* pool, so narrowing the pool
    > would have moved every subsequent number in every SDK-told story. The shuffle stays
    > over the whole room and the bodies kept back — one a side, so a round-based story can
    > never be handed an empty team — are filtered out of the shuffled order instead. The
    > recorded conformance goldens are the proof.
    >
    > **The lane's `idle` row is now one list held against both engines** rather than two
    > lists and a note. Re-run on the dev node and the `sim` provider, 5.5 minutes, no
    > rounds, and they agree beat for beat.

- [x] **T12: movement that looks like a match** (radar; spike first, may end as a
  finding).
  - Can `Teleport` per tick move a puppet smoothly enough for the SDK's position ticks
    and the platform's radar?
  - Can a death at a demo's tick be credited to the right attacker?
  - If both hold: a tracks fixture (one round, positions per player per tick) produced
    once by the platform's parser from its corpus, checked in with its provenance (the
    iron never imports platform code), and replayed by puppets as a `radar` scenario.
  - If not: the finding, and puppets keep the engine's own movement.

    > **It ends as the finding: puppets keep the engine's own movement.** The first
    > question holds and was measured rather than argued — four puppets walked around a
    > circle by `Teleport` once an engine frame come out of the Match API's stream
    > *smoother than the engine's own bots*: step median 54.1 against a commanded 50, p95
    > 55.6, max 56.6, standing still 2 % of samples, p95/median 1.03, where the same four
    > bodies moved by their own AI ten seconds earlier read 28.1 / 49.9 / 61.6, 25 % and
    > 1.77. Two runs agree to the decimal, every body is in every tick, nothing is
    > dropped.
    >
    > **The second question is a flat no, and it takes the first down with it.**
    > CounterStrikeSharp has no supported verb that credits a death to a chosen attacker:
    > `CommitSuicide` credits nobody, there is no usercmd hook so a bot cannot be made to
    > fire, and the only entry point that takes an attacker
    > (`VirtualFunctions.CBaseEntity_TakeDamageOld` with a hand-built `CTakeDamageInfo`,
    > whose one constructor takes a raw pointer) is bound to a **byte signature** in
    > `server.so` — the class of fragility that ruled out input injection, and against
    > which `CBaseEntity_Teleport` is a vtable offset. And the fallback of letting the AI
    > kill while the feet follow a demo does not survive contact: **the engine stops
    > telling its own story under a teleport.** Zero deaths in the durable log inside the
    > twenty seconds the puppets were walked, against four in the ten seconds before, in
    > a deathmatch that resumed within ten seconds after; the other run has none in the
    > two buckets the walk falls in against ten in the thirty seconds before. A replayed
    > round would be a round in which nobody ever dies, so there is no tracks fixture and
    > no `radar` scenario.
    >
    > **What stays is the instrument and the number.** `IGameWorld.Teleport`,
    > `PuppetWalk` (puppets only, a death restarts the circle where the body woke up),
    > the core plugin's `ezpug_walk` behind the assignment's own `simulation`, and the
    > lane's `radar` **spike** row — the one row that types at a match, declaring its
    > single RCON, and the first row that is not part of the matrix: a demanded lane
    > skips it and `EZPUG_CS2_CASES=radar` repeats it. `docs/sdk.md` carries the finding
    > with the table, so a CounterStrikeSharp release with a damage verb has a number to
    > beat.
    >
    > **One thing fell out of the measurement and is parked**, `OPEN-POINTS.md` §4: the
    > 54.1 where 50 was commanded is the position ticker's real period — 108 ms, not the
    > 100 the runtime asks for, because `GameThreadClock.Every` re-arms at `now +
    > interval` on the frame it fires. Nothing on the wire claims otherwise (a tick
    > carries no timestamp), but a radar interpolating on an assumed 100 ms runs 8 %
    > ahead.

- [x] **T13: the lane is a tier.**
  - `EZPUG_CS2_TESTS=required` runs T5, T6, T8, T10 and T11 serially, under the lane's
    timescale, each with a budget from the load-scaled ladder.
  - Runtime per case goes in the note.
  - The one CS2 container is shared with the platform's PRD-10 T9. Agree a lock (a file
    both lanes take) so the two loops never start matches on it at once.
  - A flaky case is a P1.

    > **The lock is a protocol, not a library.** The platform is a different checkout that
    > never imports this one, so what both sides implement is a page in `docs/operations.md`
    > — `/tmp/ezpug-cs2-lane.lock` (the box's, not either repo's), one `O_EXCL` create,
    > JSON carrying `token`, `holder`, `what`, `pid`, `host` and `since`, a look every five
    > seconds, and a break only for a holder that is provably gone (no such pid on this
    > host, ninety minutes old, or contents that are not this JSON). `scripts/cs2-lane-lock.mjs`
    > is our forty lines of it, `status` and `break` are the two verbs an operator has, and
    > `iron-match.mjs` takes it before it creates the match and releases it in the `finally`
    > that releases the server. A run that **pins** a provider which is not `nodes` takes
    > nothing, which is what keeps the `idle` row's simulated leg out of the queue. It is
    > cooperative and says so: the node's own capacity refusal is still the floor under it.
    >
    > **The stale paths are tested off hardware, on an injected clock**, because a lock
    > only ever exercised by the thing it protects has its interesting branches exercised by
    > a night nobody is watching. `cs2-lane-lock.test.ts` queues behind a live holder, gives
    > up naming it, steps over a dead pid, a lock past the TTL and a file it did not write,
    > judges another host by age alone, and — the one that matters — refuses to remove a
    > lock that is no longer its own.
    >
    > **The ladder is rungs, and so is the load**: 18 minutes for a room of four puppets or
    > fewer, 24 up to eight, 32 for the 5v5 with a demo, times 1 / 1.25 / 1.5 / 2 by the
    > one-minute load average per core, sampled per row. One flat thirty-five for everything
    > meant a two-minute `retakes` row could hang for half an hour before anybody was told.
    > The script's force-end sits **six minutes inside** the budget, so a match that wanders
    > ends `force_ended` with its ledger row closed rather than being cancelled by a
    > timeout — which is exactly what `wingman` did, at fourteen rounds.

- [ ] **T14: puppets on Dathost.** One live smoke (`EZPUG_DATHOST_TESTS=required`): a
  2v2 `pug` of puppets on a rented box, end to end.
  - It proves the refreshed template, the new MatchZy and simulation under a GSLT.
  - One server-hour at most, deallocated in `finally`, the ledger line in the note, and
    the account listing no tagged server afterwards.

    > blocked (2026-09-21): **the only orchestrator a datacentre can reach cannot take this
    > tree yet.** A rented box dials `gs.ezpug.com`, which still runs T1's build: it knows
    > no `simulation` (T4). Deploying it now would put `team: "unrostered"` (0.16.0) in
    > front of the platform's **production**, which runs `@ezpug/match-api` **0.15.0**
    > (`ezpug/api:latest`, revision `fb77243`) — the strict parser T7 warned about. The
    > platform's `main` already pins 0.17.0 (`c36c3fa`). This unblocks when its production
    > carries ≥ 0.16.0, or when a human gives a dev orchestrator a TLS route. The dev
    > orchestrators listen on loopback only, and no tunnel tool is on the box.
    > **Everything else is done**:
    > - `pnpm dathost:smoke --puppets 4` is rehearsed offline in `smoke-script.test.ts`;
    > - the `EZPUG_DATHOST_TESTS` lane runs it inside a 45-minute wall;
    > - the CS2 image is rebuilt from `7ed871a`;
    > - the Dathost template is refreshed (`6a9fe695…`, `--check` green, never started).
    >
    > The live run is one command once the deploy can happen:
    > `EZPUG_DATHOST_TESTS=required EZPUG_IRON_BASE_URL=https://gs.ezpug.com`.

- [x] **T15: the operator's lever.**
  - `ezpug-iron matches create --simulate [--scenario <name>] [--timescale <n>]`,
    replacing the script-only `--bots`.
  - `docs/operations.md`: how to run a puppet match against `gs.ezpug.com` to show the
    platform to somebody, or to rehearse before a LAN.

- [x] **T15a: this repo stops filling the box** (owner decision, 2026-09-19: prevent it
  rather than alert on it).
  - The root disk hit 100 % on 2026-09-15 and twice on 2026-09-17. Measured 2026-09-19:
    - 42 GB of Docker build cache across 1,151 entries, none in use;
    - 322 dangling images;
    - no log cap on any compose service in either repo;
    - this repo's `.cache/dathost-image` and lane artefacts.
  - After a successful deploy or image build, `scripts/deploy.sh` and `cs2-env.sh build`
    remove dangling images and bound the build cache by age
    (`docker builder prune --filter until=...`).
  - Every service in `compose.yaml`, `compose.prod.yaml` and `compose.cs2.yaml` caps its
    json log (`max-size`, `max-file`).
  - Preflight refuses to build below a free-space floor and prints `df` when it does.
  - **Never `docker volume prune`, never `system prune --volumes`.** The CS2 install is a
    68 GB volume whose container is usually stopped, so Docker lists it as reclaimable,
    and other projects' data sits beside it on this box.
  - **Never edit `/etc/docker/daemon.json` and never restart dockerd.** Every project on
    the box would restart with it.
  - The platform's PRD-10 T10a does the same there.

- [ ] **T16: release and deploy.**
  - `@ezpug/match-api` carries every additive change of the round, each changelog line
    naming the PRD-10 task it serves.
  - Images tagged, the Dathost template refreshed, `./scripts/deploy.sh` from a clean
    tree.
  - The platform's pin named in the note.

- [ ] **T17: the docs catch up.**
  - `docs/sdk.md`: a puppets chapter.
  - `docs/gamemodes.md`: length and one team.
  - `docs/match-api.md`: simulation and ready semantics.
  - `docs/decisions.md`: 19 amended, plus new decisions for simulation and one-team
    retakes.
  - `docs/pins.md`, `CLAUDE.md`, `README.md`.
  - `ralph/OPEN-POINTS.md` emptied of what landed.

- [ ] **T18: the sweep.** Everything in "When the PRD is complete", with the closing note.

## Working rules

- **Production is `./scripts/deploy.sh` and nothing else.** Never `docker compose -p <prod
  project>` and never `-f compose.prod.yaml` by hand, not even for `ps`: the dev world is
  plain `docker compose` in the repo. The box's `docker` shim refuses both with exit 125.
  If you meet that refusal, you were about to touch production; use the deploy script's
  verb or leave it alone.
- **Never wait on a background task.** In the loop the run ends the moment you stop
  talking. A command started in the background, or a turn that ends with "I'll report
  when it lands", loses the iteration and leaves the task half-done. Long commands run in
  the foreground with an explicit timeout; if a lane takes twenty minutes, wait twenty
  minutes.
- **`pnpm verify` green before every commit**, TS and C# both. The `EZPUG_CS2_TESTS` lane
  runs for every task from T2 on that touches a flow, a plugin or a config builder, and
  the iteration says what ran. A flaky case is a P1 and is fixed before the next task,
  never retried into green.
- **The one CS2 container is shared.** The platform loop's real-server lane (PRD-10 T9)
  uses the same `ezpug-iron-cs2` container. Take the lane lock from T13 before starting a
  match on it, and release it in `finally`.
- **Money is a budget.** Only T14 allocates a real server: at most one, in `finally`,
  bounded to one server-hour, the reaper in the test.
- **Contract discipline.** `@ezpug/match-api` changes are additive, released and
  changelogged. `packages/protocol` regenerates the C# in the same commit. Recorded
  fixtures arbitrate every shape disagreement.
- **Secrets stay in the process** (CLAUDE.md). Recorded fixtures are scrubbed and a test
  greps them.
- **Determinism**: fakes on the injected clock, `eventually()`, C# on `IClock`. Timescale
  is the lane's, never a production request's.
- **Visual honesty.** Anything that needed eyes is written as visual in the progress
  line.
- **Hard don'ts:**
  - no real game clients and no protocol-level client (see Findings);
  - no native Metamod input-injection plugin in the image this round;
  - no `simulation` on a request without the scope;
  - no auto-updater, heartbeat or bootstrap fetch left on in MatchZy-Enhanced;
  - no CS:GO provider;
  - no cron;
  - no `Date.now()`;
  - no hand-written wire types in C#.

## When the PRD is complete

- `pnpm verify:extended` green **twice in a row** with the `EZPUG_CS2_TESTS` lane
  demanded: T5, T6, T8, T10 and T11 green on the dev server, and the conformance and
  fault suites green.
- T14's Dathost smoke in the closing note with its ledger line, and the account listing
  no tagged server afterwards.
- `./scripts/deploy.sh` end to end **from a clean tree**, smoke green, `gs.ezpug.com`
  serving the new MatchZy and the new manifests.
- Docs, pins, `CHANGELOG.md`, `CLAUDE.md` and decisions true to what shipped. The
  platform's pin for `@ezpug/match-api` named.
- The closing note names what this round left:
  - real clients, and why;
  - native input injection, and whether T12's finding makes it worth it;
  - any scenario knob still sim-only;
  - any upstream issue filed against MatchZy-Enhanced.
