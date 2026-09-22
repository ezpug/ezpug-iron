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
word when nothing stood — `docs/match-api.md`, "A pause that says no".

## §3 EZ Rating draws a zero on a retakes scoreboard

**What happened.** PRD-03 T10's lane row is the first time this box has ever run the
rating path on hardware: `RATED` in `scripts/iron-match.mjs` is
`capabilities.scoreboardRating && slots.openJoin`, and `retakes` is the only mode that is
both — `pug` rates but closes its roster, `powerup-dm` and `flying-scoutsman` open theirs
but ask for no number. Every earlier run in `.cache/iron-match/` records
`scoreboard: null`.

Run `iron-match-2026-09-20T20-53-18-977Z`, three puppets, `de_dust2`: three `profile`
commands carrying `rating` 1000, 1111 and 1222 were accepted while the match was `ready`,
and `ezpug_status` read back on a **live** server — after `going_live` and at least one
`round_start`, so after a `RatingBoard.DrawAll` — said

    [status] scoreboard: 3 rated: tk 0, maex 0, puppet-3 0

The three bodies are the puppets, under the roster's own names, and
`IGamePlayer.ScoreboardRating` is non-null for each: the number was written and the engine
is holding **zero**.

**What it is not.** It is not the profiles going to the wrong ids — that was a harness bug
in the same run and is fixed (the first attempt addressed `BotIdentity`'s synthetic
SteamIDs while the bodies carried the roster's, and read
`scoreboard: 1 rated: SourceTV 1000`). It is not the read landing too early: call 15 of
that run is after three `live` polls.

**The two candidates, neither isolated.** Either the engine clears a bot's competitive
fields at the respawn cs2-retakes performs every round — which would mean the
`round_start` redraw `RatingBoard` relies on runs *before* the retake's own spawn pass and
loses — or `SetScoreboardRating` does not stick on a bot controller at all, in which case
a puppet can never show one and only a human would.

**Why it needs a decision rather than an iteration.** Nobody knows which, because no human
has played `retakes` on this box, and the answer decides whether this is a puppet-only
measurement artefact (record it and move on) or decision 21 quietly failing for the one
shipped mode that opens its roster. Cheapest next step: one retakes run that reads
`ezpug_status` twice, once right after a `round_start` and once a few seconds into the
round, and one with a human on the server.

## §4 The stream's "every 100 ms" is every 108

**What happened.** PRD-03 T12's spike walked four puppets around a circle at a known
speed and read the `position_tick`s back off the Match API's stream. The commanded step
between two samples was 50 units; the measured median was **54.1**, in both runs, to the
decimal (`.cache/iron-match/iron-match-2026-09-21T00-08-27-645Z` and
`…T00-15-36-960Z`). 54.1 ÷ 500 units/s is
108 ms, not the `GamemodeRuntime.PositionTickIntervalMs` of 100.

**Why.** `GameThreadClock.Every` fires a due timer on the next engine frame and re-arms it
at `now + interval` rather than at `due + interval`, so every repeat carries one frame of
overshoot: 100 ms plus a frame is 108 ms at the 128 fps `host_timescale 2` was driving.
Every repeating timer in the SDK drifts the same way — a cooldown, a heartbeat, the
seating pass — which is why this is a decision and not an obvious bug.

**What it costs today: nothing measurable.** A `position_tick` carries no timestamp by
design (a gameserver is not trusted with a calendar), so nothing on the wire claims 100 ms
and no consumer can be wrong about an instant. What a consumer *could* get wrong is a
**rate**: a radar that interpolates between two ticks assuming 100 ms runs 8 % ahead of
the bodies, and anything deriving a speed from the tick rate is 8 % low.

**The decision.** Either `Every` re-arms from the due time (which makes every SDK timer
hold its period and changes the timing of things nobody has complained about), or the
stream's interval is documented as "about ten a second, never exactly", or the vocabulary
grows a monotonic `uptimeMs` on the tick so a consumer can interpolate on the server's own
numbers. Nobody drawing a radar has hit this yet; the platform's PRD-10 is the first that
will.

## §5 The platform's lane releases the CS2 lane before its server is gone

**What happened.** The second `verify:extended` of PRD-03 T18's sweep (2026-09-21) went
red on its first row, `pug-1v1`, with "a server is still running". The server was not
ours. The platform's lane (`platform-cs2-lane-860ad73c`) held the lock from 12:18:34 and
released it at 12:34:49. Its server `9fe2635d` (match `28250c0c`) stayed `running` on the
dev node until 12:40:36 (the dev orchestrator's `servers` table). Our row took the lane
two seconds after the release, played its whole match (12:34:51–12:38:05), and found the
platform's server still on `GET /v1/fleet/servers` at the end
(`.cache/iron-match/iron-match-2026-09-21T12-27-59-351Z/raw.json`). Its own ledger row
was closed.

**Why.** Our protocol page (`docs/operations.md`, "The lane lock") never said the lock has
to outlive the server. It now says so: release only once the fleet lists no server for
your match. The platform's `scripts/cs2-lane-lock.mjs` and its lane in
`/root/ezpug/apps/api/src/cs2-lane.test.ts` implement the page. Judging by the timeline,
the lane releases when its match ends.

**What it needs.** The platform's half waits for its server to leave the fleet before it
releases, and its PRD-10 names the task. Until then, either lane can fail its first row
behind the other's release. Our lane's fleet-wide "no server running" assertion is the
right check under an exclusive lock and stays as it is. Our side now also waits up to ten
minutes for an empty fleet after taking the lock, so our lane no longer fails behind an
early release. The platform's lane still can, behind anyone's.

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

**What it needs.** An owner call: a PR upstream (Auto-Tournament/cs2-plugin, MIT; the
maintainer ships several releases a day) adding a per-player `simulated` flag to the match
file's `players` map — or the same field in a fork of ours, which decision 19 as amended
chose *not* to carry. Either way the change is: skip the identity for a human in
`BuildSimulationConfigPlayers`, count humans in `IsTeamReady` through the ordinary ready
gate, and never watchdog-start while a configured human is missing. Until then `pug` says
`mixedRoster: false` and the platform rehearses its queue with ten puppets or on an
SDK-seated mode. The lane row for the missing half ("nine ready up, the tenth arrives") is
written in `docs/operations.md` under `--humans` and waits on this.
