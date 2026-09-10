# Open points

Things the field found that no current PRD owns. Every entry is something that **happened**,
with the evidence, parked here because it needs a decision rather than an iteration. A round
that takes one moves it into its PRD as a task and deletes it here.

## 1. `powerup-dm` has no end, so only a human or the TTL stops the bill

Found in the owner's first real `powerup-dm` room on `gs.ezpug.com`, 2026-09-09
(orchestrator match `14e74d84`, the platform's `9bf161cd`, a rented Dathost box in
Frankfurt).

The mode played correctly for eight minutes: two humans, respawns, `powerup_claimed` twice,
skins from the roster's loadout. What it never did is **finish**. One `round_start` at
19:12:11 UTC with `score {teamA: 0, teamB: 0}`, then forty-odd `player_death` events and no
`round_end`, no score movement and no terminal fact. The manifest says `records: "events"`
and `flow: "plugin"` — a free-for-all with nothing to win — so there is no condition in the
mode that could ever end it. The match ended because the owner deleted the server from the
fleet console.

That is a rented box billing until somebody notices. `ttlMinutes` is the only backstop, and
a backstop is not a design.

**The decision:** give a `flow: plugin` mode a *length* the manifest declares — a duration,
a frag limit, an idle timeout when the last body leaves, or all three as a small vocabulary
every future creative mode inherits. An empty server that nobody has been on for N minutes
ending itself is probably the general answer, and it is the SDK's to own rather than each
mode's.

## 2. An unrostered body reports as `team: "spec"`

The same match: a third player (`Krikey`, `90000000000000002`) appears in `player_death`
events as killer and victim with `team: "spec"`, because the roster does not name it and
the mode is `openJoin`. The SDK reports what the server knows, which is honest; whether
"a body the request never named" deserves its own team value rather than the spectator one
is a wire-shape question, and the platform's half of it is in that repo's
`ralph/OPEN-POINTS.md`. Answer both together — it is one sentence in `match-api` either way.
