# Open points

Things the field found that no current PRD owns. Every entry is something that **happened**,
with the evidence, parked here because it needs a decision rather than an iteration. A round
that takes one moves it into its PRD as a task and deletes it here.

§1 (`powerup-dm` has no end) became PRD-03 T9 and landed as decision 26: a manifest
`length` the SDK enforces. §2 (a body the request never named) closed with PRD-03 T7.

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

## The production platform key holds `simulation` (owner call, 2026-09-21)

**What happened.** The owner pressed "test match with puppets" on ezpug.com's fleet page
and got `forbidden`, `details.scope: simulation`. The platform's fleet door (its PRD-10 T8)
is built to send puppets through production. But `packages/match-api/src/scopes.ts` says
"a production platform key does not hold it", and `ralph/DEPLOY.md` mints `platform` with
`matches,fleet`. The two rounds disagreed, and the owner wants the button to work.

**What was done.** The live `platform` key (`d22fcf5b…`, prefix `ezik_ocE9Mf0`) had
`simulation` appended in `ezpug-iron-prod-postgres` by one scoped `UPDATE`. There is no
scope-edit route, and a new key would have meant new webhook secrets and orphaned
in-flight matches. It is undone by `array_remove(scopes, 'simulation')` on that row. Key
lookups aren't cached, so the change took effect immediately.

**Why it is safe enough.** The platform marks a puppeted match `puppets` from creation and
never counts it (its PRD-10 T7). Every fact carries `source.simulated`. And the request
must carry the `simulation` block explicitly. That block is set only by the admin fleet
door.

**What it needs.** Either (a) a `PATCH /v1/keys/:id/scopes` route and CLI verb so this is
never a SQL line again, plus `scopes.ts`'s comment and `DEPLOY.md`'s mint line updated to
say the platform key holds `simulation`. Or (b) a separate rehearsal key that the platform
uses only on its fleet door, which is the path `scopes.ts` intended. Recommended: (a). The
safety lives in the platform's `puppets` flag, not in which key asked.

## §6 A `pause` MatchZy refused comes back `applied`

**What happened.** The sixth `verify:extended` of PRD-03 T18's sweep (2026-09-21) went
red on the `pause` row with "the match never paused". Both commands came back `applied`
over the link, yet the fork sent no `match_paused`, and neither did the core plugin
(`.cache/iron-match/iron-match-2026-09-21T20-05-52-934Z`). The pause landed after round 2
of a four-round 1v1. That is halftime (the run has one `side_swap`), and
`ForcePauseMatch` returns early there (`references/MatchZy-Enhanced/src/Utility.cs`
around line 2898: halftime, post-game, an active tactical timeout). It says why only in
chat and on the console.

**Why.** The core plugin relays `pause` as `css_forcepause` and answers `applied` once the
command has run. It cannot read MatchZy's refusal, and `MatchZyFlow` reports the pause
later off the gamerules, so a refusal is simply a fact that never comes. The platform's
admin console reads `applied` as "the match is paused".

**The decision.** Pick one:
- `applied` means only that the server executed the command, and the pause is whatever
  `match_paused` says (document it in `docs/match-api.md`);
- the plugin watches the gamerules for a beat after `css_forcepause` and answers
  `rejected` with a code when nothing changed;
- the plugin refuses up front in the three states it can read off the gamerules itself.

The lane now waits for `match_paused` and asks again (`iron-match.mjs`, `PAUSE_TRIES`),
which is what a client has to do today.

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
