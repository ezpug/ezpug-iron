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
lock") says. The lane lock's fairness (issue #1) is decision 31. §7 (a mixed roster under
`pug` needed MatchZy-Enhanced to learn a per-seat switch) became PRD-04 T2b: the owner chose
a fork of our own, `ezpug/MatchZy-Enhanced`, and `pug` claims `capabilities.mixedRoster`
(decisions 19 and 28 as amended). What only a person can show of it is §8.
PRD-05 (workshop maps) took neither §3 nor §8. It found §9 and §10, and decision 32 records
what it decided.

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

## §8 A person has never taken the seat a `pug` held for them

**What is known** (PRD-04 T2b, dev node, 2026-09-23, `pug` 5v5 with the last seat left to
a person, on our fork `1.4.32-ezpug.1`): nine bots spawned for the nine named entries and
none for the tenth. All nine readied, and the fork's warmup held at CT 5/5 and T 4/5
through every watchdog pass, logging `not force-starting; the roster leaves seats to
people` each time. Nothing went live until the run cancelled it. The lane's `mixed-pug`
row asserts exactly that.

**What only a human can close.** A plain bot cannot stand in for the person. It fires no
`player_connect_full`, and MatchZy's team hook skips bots, so the gate never counts it: a
`bot_add_t` connected and T stayed at 4 of 5. The arrival is upstream's ordinary path for
a human (connect, whitelist against the roster, team, auto-ready, `IsTeamReady`), and the
series only stops the simulation skipping it (`EZPUG.md` in the fork). To close it, join
the person's seat with a CS2 client on a `pug` whose `simulation.puppets` names the other
nine, on the dev node or on the platform's queue, and see the match go live and play out
with the person announced as themselves. The platform's PRD-11 T23 (the owner as the
tenth on the 5v5 queue) is that run. If the gate does not pass for a person, it becomes a
task against the fork's series.

## §9 A defuse on a real server has never named its site

**What is known** (PRD-05 T2e, 2026-09-25): the core plugin read `site` wrong for every
bomb fact, because the event's `site` is the entity index of the site's trigger, not 0 or 1.
`bomb_planted`, `bomb_defused` and `bomb_exploded` now share one resolver:
`planted_c4`'s `m_nBombSite`, and failing that the site this round's plant recorded. The
proving run (the lane's `grenades` row, iron `9bd2bdd3-5ae5-468c-ae1b-2a3768a89d5c`) planted
four times and exploded three times, each with a site. Nobody defused. Bots rarely do,
and the lane's rows assert that no bomb fact they did see lacks a site, not that a defuse
happened.

**What closes it.** A `bomb_defused` with a `site` from the dev node or production, read
off the durable log. The platform's matches will produce one sooner than a lane row can
force it. If it arrives without a site, the resolver's fallback after the planted entity
is gone is the suspect, and it becomes a task.

## §10 The dev orchestrator's watcher can stop watching

**What is known** (PRD-05 T2d, 2026-09-25): the dev orchestrator on 3430 runs under
`tsx watch` from this checkout. After a burst of edits it stopped reacting. The last
restart line in `/tmp/orchestrator-dev.log` was 16:19, and a later content change and a
`touch` did nothing. A lane run then went against the old machine code and failed for
that reason alone. A restart by hand fixed it. The opposite also happened in PRD-05 T1 and
T2: an edit mid-run restarted it and stranded a match (T1a made the demo wait survive a
restart; nothing else in the runtime was checked for the same gap).

**What needs a decision.** Whether the dev world keeps a watcher at all while two loops
play lane rows through it, or runs the orchestrator the way production does and restarts
it on purpose. Until then, a proving run compares the serving process's start time with the
source it depends on.
