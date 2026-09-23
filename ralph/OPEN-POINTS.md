# Open points

Things the field found that no current PRD owns. Every entry is something that **happened**,
with the evidence, parked here because it needs a decision rather than an iteration. A round
that takes one moves it into its PRD as a task and deletes it here.

§1 (`powerup-dm` has no end) became PRD-03 T9 and landed as decision 26: a manifest
`length` the SDK enforces. §2 (a body the request never named) closed with PRD-03 T7.
"The production platform key holds `simulation`" became PRD-04 T3 and closed with it:
`PATCH /v1/keys/:keyId/scopes` and `ezpug-iron keys scopes` exist, and `scopes.ts`,
`docs/match-api.md` and `ralph/DEPLOY.md` say what is actually true of that key. §6 (a
pause MatchZy refused came back `applied`) became PRD-04 T4: the core plugin watches the
gamerules for a beat after `css_forcepause` and answers `invalid_state` with a reason
word when nothing stood — `docs/match-api.md`, "A pause that says no". §4 (the stream's
"every 100 ms" was every 108) became PRD-04 T5: `GameThreadClock.Every` re-arms from the
due time and skips the beats a stalled frame swallowed — `docs/sdk.md`, "Timers". §5 (the
platform's lane released the CS2 lane before its server was gone) closed on the platform's
side with its PRD-10 T10q (`f3613fb` in `/root/ezpug`): its lane now waits for its match's
server to leave the fleet before it gives the lock back, as `docs/operations.md` ("The lane
lock") says. The lane lock's fairness (issue #1) is decision 31.

## §3 EZ Rating on a human's scoreboard has never been seen

**What is known** (PRD-04 T6, run `iron-match-2026-09-22T19-41-10-467Z`, `retakes`, three
puppets, dev node): `ezpug_status` read every puppet at Premier's rank type and a ranking of
`0` at a round's `round_start`, six seconds into the same round, and a second after the
same three profiles were pushed again mid-round and answered `applied` — a draw with no
spawn anywhere between it and the read. So cs2-retakes' spawn pass does not clear the
number after `RatingBoard`'s round-start redraw (it teleports, it never respawns); a bot
controller keeps the type and never the number, which is what PRD-02 T27 measured for
plain bots too. The lane's `retakes` row now asserts the path (three reads, every puppet
rated) and not the number; `docs/gamemodes.md` records the artefact.

**What only a human can close.** Whether the cell shows the number for a person: join a
`retakes` match on the dev node with a CS2 client, have the platform (or
`POST /v1/matches/:id/commands` with a `profile`) push a rating, and look at the
scoreboard, then read `ezpug_status`. If it says `0` for a human too, decision 21 is
failing for every open-roster mode and it becomes a task.

## §7 A mixed roster under `pug` needs the fork to learn a per-seat switch

**What happened.** PRD-04 T2 shipped `simulation.puppets` (match-api 0.19.0): a request
names which roster entries are puppets, the SDK's puppeteer seats exactly those, and the
three SDK-seated modes claim `capabilities.mixedRoster`. `pug` does not, and the door refuses
a partial list to it `validation_failed` on `simulation.puppets`. The platform's PRD-11 T23
("the owner in the chair") wants exactly that on the 5v5 queue, which is `pug` on Dathost.

**Why not.** Read at the pin (`references/MatchZy-Enhanced`, `v1.4.32`; `v1.4.34` upstream
is renames, map commands and diagnostics — nothing in `SimulationMode.cs`):
- `MatchConfig.Simulation` is a boolean; `BuildSimulationConfigPlayers` makes one identity
  per configured player and `SpawnSimulationBots` walks `bot_quota` up to that count.
- Outside simulation mode, `EventPlayerConnectFull` kicks any bot the roster does not
  hold ("Not a player in this game"), so seating our own puppets beside a plain MatchZy
  match is refused by the fork itself.
- Inside it, `ReconcileSimulationRoster` re-adds a bot for every slot no bot holds and
  `SimulationWatchdogTick` force-readies and, after two attempts, `HandleMatchStart`s with
  `allowAutoReadySimulationWithoutHumans` — a person's empty chair is filled and the match
  starts without them. The `matchzy_autoready_simulation_*` convars are a two-bot
  diagnostic for the ready system, not a roster feature.
So every unpatched route is a fight between two plugins over one body, and CLAUDE.md
pins the fork as upstream's binary, never patched.

**What it needs.** An owner call (decision 28 records why `pug` stays out until then): a PR upstream (Auto-Tournament/cs2-plugin, MIT; the
maintainer ships several releases a day) adding a per-player `simulated` flag to the match
file's `players` map — or the same field in a fork of ours, which decision 19 as amended
chose *not* to carry. Either way the change is: skip the identity for a human in
`BuildSimulationConfigPlayers`, count humans in `IsTeamReady` through the ordinary ready
gate, and never watchdog-start while a configured human is missing. Until then `pug` says
`mixedRoster: false` and the platform rehearses its queue with ten puppets or on an
SDK-seated mode. The lane row for the missing half ("nine ready up, the tenth arrives") is
written in `docs/operations.md` under `--humans` and waits on this.
