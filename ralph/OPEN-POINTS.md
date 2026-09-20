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
