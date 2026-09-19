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

- [ ] **T1 (P1): a team of one can ready up.** The 2026-09-18 stall, fixed where it
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

- [ ] **T2 (fable): MatchZy-Enhanced, read and pinned.**
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

- [ ] **T3: the new events, translated once, at the edge.**
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

- [ ] **T3a: what real matches turn on** (owner decision, 2026-09-19).
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
  - `matchzy_autoready_simulation_enabled` (`:92`, spawns two bots) is one more switch
    for T2's off-list.

- [ ] **T3b: 1v1 and wingman on the wire** (owner decision, 2026-09-19: both presets, and
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

- [ ] **T4 (fable): the simulation switch in the contract.**
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

- [ ] **T5: ten puppets ready up for a pug.**
  - The MatchZy config builder emits `simulation` and `simulation_timescale` when the
    request asks.
  - The dev lane plays a 5v5 `pug` in which every puppet readies through MatchZy's own
    ready system: `player_ready` ×10, `going_live`, rounds, `map_result`, `series_end`, a
    demo uploaded. No RCON touches the flow.
  - `iron-match.mjs`'s force-start becomes an explicit `--force-start` flag, documented
    as the escape hatch.

- [ ] **T6: the regression matrix, on real hardware.** Lane cases that each assert their
  fact sequence:
  - `pug` at **every size from one to five a side**, and 2v1 (uneven: the platform's
    PRD-10 T1 makes customs allow it);
  - the `1v1` and `wingman` formats from T3b;
  - knife on, with the side decided by the new timer, and knife off;
  - a pause and an unpause;
  - a rostered puppet leaving and coming back;
  - an overtime, if short `mp_maxrounds` can force one reliably, otherwise sim-only with
    the reason.

  Before the fix, the 2026-09-18 stall is reproduced red against the old builder.

- [ ] **T7 (fable): puppets in the SDK.** For the modes MatchZy does not run
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

- [ ] **T8: a puppet taps the phone.**
  - Mint a widget token for a puppet's SteamID and drive `powerup-dm`'s widget socket
    against the dev server.
  - The grant reaches the SDK, the power-up applies and `plugin_event` lands.
  - A dead puppet is refused `NotAlive`. An unrostered SteamID is refused unless the
    mode is open-join.
  - This is the first automated proof of the path only the owner's finger has proved.

- [ ] **T9 (fable): a length for plugin modes** (`OPEN-POINTS.md` §1).
  - A manifest vocabulary the SDK enforces: a duration, a frag limit, and an idle timeout
    once the last body leaves.
  - A plugin-flow match ends with a real terminal fact, with no winner when
    `Slots.Teams == 1`.
  - `powerup-dm` gets a duration and the idle end. `retakes` gets whatever its community
    plugin can honestly end on.
  - The release names the field the platform turns into a countdown (PRD-10 T6).
  - This is also what lets an unattended puppet run finish.

- [ ] **T10: retakes is one team** (owner decision, 2026-09-19).
  - Manifest `slots.teams: 1` with `teamSize: 10`, since `retakes.ts:60` multiplies.
    `openJoin` stays.
  - `GenericFlow.cs:229-251` names no winner for one team, which fixes `powerup-dm` too.
  - Bump the manifest version; the package bundles the manifests.
  - Record the decision.
  - A lane case: three puppets in `retakes` play and end.

- [ ] **T11: the simulator's scenarios, executed by a real server.**
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

- [ ] **T12: movement that looks like a match** (radar; spike first, may end as a
  finding).
  - Can `Teleport` per tick move a puppet smoothly enough for the SDK's position ticks
    and the platform's radar?
  - Can a death at a demo's tick be credited to the right attacker?
  - If both hold: a tracks fixture (one round, positions per player per tick) produced
    once by the platform's parser from its corpus, checked in with its provenance (the
    iron never imports platform code), and replayed by puppets as a `radar` scenario.
  - If not: the finding, and puppets keep the engine's own movement.

- [ ] **T13: the lane is a tier.**
  - `EZPUG_CS2_TESTS=required` runs T5, T6, T8, T10 and T11 serially, under the lane's
    timescale, each with a budget from the load-scaled ladder.
  - Runtime per case goes in the note.
  - The one CS2 container is shared with the platform's PRD-10 T9. Agree a lock (a file
    both lanes take) so the two loops never start matches on it at once.
  - A flaky case is a P1.

- [ ] **T14: puppets on Dathost.** One live smoke (`EZPUG_DATHOST_TESTS=required`): a
  2v2 `pug` of puppets on a rented box, end to end.
  - It proves the refreshed template, the new MatchZy and simulation under a GSLT.
  - One server-hour at most, deallocated in `finally`, the ledger line in the note, and
    the account listing no tagged server afterwards.

- [ ] **T15: the operator's lever.**
  - `ezpug-iron matches create --simulate [--scenario <name>] [--timescale <n>]`,
    replacing the script-only `--bots`.
  - `docs/operations.md`: how to run a puppet match against `gs.ezpug.com` to show the
    platform to somebody, or to rehearse before a LAN.

- [ ] **T15a: this repo stops filling the box** (owner decision, 2026-09-19: prevent it
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
