# PRD 04: Mixed rosters

The platform's PRD-11 makes the 5v5 queue on Dathost the thing it proves, and it can do
that with ten puppets today. What it cannot do is seat the owner as the tenth: the
contract fills every roster seat with a puppet or none. This round releases the "later
contract" `matchSimulationSchema` promised, and closes the four open points PRD-03 left
behind that the platform's admin console and lane now lean on — a fair lane lock, a
pause that says no, a key whose scopes are edited by a route, and a timer that holds its
period. One Dathost smoke is actually run, so the provider that the next evening stands on
has been seen working from this repo and not only from the platform's page.

Runs in parallel with `/root/ezpug/ralph/PRD-11-the-night.md`. Its T21 waits for T1 here,
its T23 for T2, its T12 reads T4's `rejected`.

**Branch:** `main`. **Surface:** the whole repo. **Model:** `claude-opus-5-5`; tasks tagged
`(fable)` run on Fable 5.1.

**Budgets:**
- **The dev CS2 lane** is the proving ground (`EZPUG_CS2_TESTS`, the dev node, the lane
  lock). The platform loop shares it.
- **Dathost:** T7 and T8 each allocate at most one server, one server-hour, deallocated
  in `finally`. Nothing else does.
- **Contract:** additive only; every change is a release to the box's Verdaccio with a
  changelog line naming the platform task it serves. Cutting a service tag publishes and
  stays the owner's.

## Findings

From PRD-03's closing note and `ralph/OPEN-POINTS.md` (2026-09-21/22). Trust the file.

- **Every seat or none.** `packages/match-api/src/resources/match-request.ts:303-340`:
  MatchZy-Enhanced's `SimulationMode.cs` spawns one bot per configured player, and the
  SDK's puppets (PRD-03 T7) follow the same roster. `docs/match-api.md:176-190` documents
  the limitation. The platform rehearses with all-puppet rosters until this changes.
- **No fairness in the lane lock.** `docs/operations.md` ("The lane lock") has no queue;
  the platform's lane waited 1,902 s across six handovers
  ([#1](https://github.com/ezpug/ezpug-iron/issues/1)); the issue proposes a ticket queue
  at `<lock>.queue/<sinceMs>-<token>.json`, oldest living ticket creates next, dead
  tickets judged by the lock's own corpse rules, backward compatible.
- **A refused pause comes back `applied`** (OPEN-POINTS §6): `css_forcepause` runs, MatchZy
  returns early at halftime/post-game/timeout (`references/MatchZy-Enhanced/src/Utility.cs`
  ~2898) and says so only in chat; the core plugin answers `applied` because the command
  ran. The lane now retries after halftime (`iron-match.mjs`, `PAUSE_TRIES`).
- **The production key's scopes were edited by SQL** (OPEN-POINTS, "the production
  platform key holds `simulation`"): no route, no CLI verb; `scopes.ts` and
  `ralph/DEPLOY.md`'s mint line still say the platform key does not hold it.
- **Every SDK timer overshoots by a frame** (OPEN-POINTS §4): `GameThreadClock.Every`
  re-arms at `now + interval`; 100 ms ticks are 108 ms at 128 fps.
- **Retakes draws a zero rating on puppets** (OPEN-POINTS §3): two candidates, neither
  isolated; the cheap next step is one run reading `ezpug_status` twice per round.
- **Dathost's live smoke has never been run from this repo**
  (`apps/orchestrator/src/providers/dathost/dathost.extended.test.ts`, opt-in on
  `EZPUG_DATHOST_TESTS`); the provider's unit suite is thorough
  (`provider.test.ts`, ~30 cases) and one location is configured
  (`DATHOST_DEFAULT_LOCATION = 'dusseldorf'`, `provider.ts:82-85`).
- **`restore` is in the vocabulary and no client has used it**
  (`packages/match-api/src/resources/commands.ts`); the platform's PRD-11 T3 puts it in
  the admin's hand and needs to know it works on MatchZy-Enhanced's round backups.

## Attitude

1. **The contract says what the server can do, and nothing more.** A mixed roster ships
   when a real server seats it, not when the schema parses it.
2. **A command's answer is the server's, not the relay's.** `applied` means the match
   software did it; anything less is `rejected` with a code, or `accepted` while we
   wait. The platform builds its receipts on that.
3. **Operations are routes.** Anything done to production by a SQL line this month gets
   the route and the CLI verb that should have existed.
4. **The lane is the proof.** Every task that touches a server adds a lane row; the
   Dathost smoke is run, once, for real.

## Tasks

- [x] **T1: the lane lock queues fairly.** Decide #1 on `docs/operations.md` ("The lane
  lock"): the ticket queue as proposed unless a reason on the page says otherwise —
  stale-ticket rules, the handover interval, backward compatibility with a waiter that
  knows no queue. Implement the page in `scripts/iron-match.mjs`'s lock and prove it with
  two waiters and a matrix in the lane's tests. Close #1 with the commit. The platform's
  PRD-11 T21 implements the same page.

- [x] **T2 (fable): mixed rosters.** `matchSimulationSchema` names which roster entries
  are puppets (a shape that keeps today's "all" as the default and is additive on the
  wire — e.g. `puppets: 'all' | steamId[]`), `matchSimulationProblem` refuses a name not
  on the roster, MatchZy-Enhanced's simulation mode spawns a bot only for the named
  entries and waits for the humans through the ordinary ready gate, the SDK's puppets
  (PRD-03 T7) do the same for plugin modes, the simulator provider honours it, and every
  fact keeps `source.simulated: true` for the match. `docs/match-api.md:176-190`
  rewritten. Lane row: nine puppets and one seat left empty ready up to nine and go live
  when the tenth (the lane's own client, or `bot_add` standing in for a human) arrives.
  Release with a changelog line naming the platform's PRD-11 T23.

- [ ] **T2b: mixed rosters under `pug`.** OPEN-POINTS §7: MatchZy-Enhanced at the pin
  seats every configured entry or none and force-starts without anybody, and it is never
  patched here — so `pug` says `capabilities.mixedRoster: false` and the platform's T23
  cannot seat the owner on the queue until the fork learns a per-seat switch. Needs an
  owner call (a PR upstream, or a fork of ours against decision 19) before the lane row
  "nine puppets ready up, the tenth arrives" can exist.
  > blocked: an unpatched fork cannot do it; owner decides upstream PR vs. fork (§7).

- [x] **T3: scopes are edited by a route.** `PATCH /v1/keys/:keyId/scopes` (admin scope,
  audited like `rotate` and `budget`), `ezpug-iron keys scopes <id> --add/--remove`,
  the conformance suite's case, `docs/match-api.md`, and the truth in two places that
  lie today: `packages/match-api/src/scopes.ts`'s comment and `ralph/DEPLOY.md`'s mint
  line both say the platform key holds `simulation` (owner call, 2026-09-21). Delete the
  OPEN-POINTS entry.

- [x] **T4: a pause that says no** (OPEN-POINTS §6). The core plugin answers
  `css_forcepause` by reading the gamerules for a beat and returning `rejected` with a
  code (`halftime`, `post_game`, `timeout_active`, …) when nothing paused, `applied` only
  when it did; the same for `unpause`. `docs/match-api.md`'s command table says what
  `applied` means. Lane: the pause row loses its retry loop and asserts the code at
  halftime instead. Delete §6.

- [x] **T5: timers hold their period** (OPEN-POINTS §4). `GameThreadClock.Every` re-arms
  from the due time, with a catch-up rule for a frame that stalls past two periods
  (skip, never burst); the position stream measures 100 ms within a frame in the T12
  spike harness; `docs/sdk.md` documents the guarantee. Delete §4.

- [ ] **T6: the retakes rating** (OPEN-POINTS §3). The two-read run: `ezpug_status`
  right after `round_start` and again mid-round, on a retakes match with puppets; if the
  number is cleared by the respawn, redraw after the retake's spawn pass; if
  `SetScoreboardRating` never sticks on a bot controller, say so in `docs/gamemodes.md`
  as a puppet-only artefact and leave the human half as the one line that needs a human.
  Either way §3 becomes a sentence with evidence, not a question.

- [ ] **T7: the Dathost smoke, run.** `EZPUG_DATHOST_TESTS=required` once, from this
  checkout, against the real account: allocate, configure, start, the plugin's boot
  walk, `list()`'s scoping against whatever the account holds, deallocate, and the
  ledger row closed. Whatever it finds is a task here; the run's output (secrets
  scrubbed) is the progress line. Confirm the location knob
  (`EZPUG_IRON_DATHOST_LOCATION`) and its region label are documented in
  `docs/operations.md` and that `EZPUG_IRON_PROVIDERS` on production names `dathost`.

- [ ] **T8: `restore` works on hardware.** A lane row on the dev node: play three rounds
  with puppets, `restore` to round 2, assert the score and the `round_start` that
  follows; then the same once on Dathost (the T7 budget's sibling: one server, one
  hour). `docs/match-api.md` states what a client may expect after `restore`
  (`accepted` then facts, or `applied`). Serves the platform's PRD-11 T3.

- [ ] **T9: releases, as they go.** Every contract change above is its own release to
  Verdaccio with its changelog line; the platform's T22 pins each. No task folds a
  release into another's commit.

- [ ] **T10: the docs catch up, and the sweep.** `docs/decisions.md` gets one decision
  per change that deserves it (mixed rosters, the pause answer, the timer rule, the
  lane queue); `OPEN-POINTS.md` holds only what is still open; CHANGELOG `Unreleased`
  lists the services touched. Two green `EZPUG_CS2_TESTS=required` extended runs,
  deploy `gs.ezpug.com`, the closing note with the Dathost server-hours spent.

## Working rules

- **Production is `./scripts/deploy.sh` and nothing else** — the box's `docker` shim
  refuses `-p ezpug-iron` and `-f compose.prod.yaml` outside it with exit 125.
- **Dathost is money**: T7 and T8 only, one server at a time, one hour, `finally`.
- **The CS2 lane is shared with the platform loop**: the lane lock as the page says,
  release after the server has left the fleet, never across a task boundary.
- **Additive contract, released with a changelog line**, never a service tag.
- **Commit only your own paths.** Never `git add -A`.
- **Secrets**: Dathost credentials, RCON and join passwords, GSLTs and tokens live only
  in gitignored env files, the token store, process memory or `~/.npmrc`; fixtures are
  scrubbed; nothing is ever pasted into a log line or a progress line.

## When the PRD is complete

- Two consecutive green `EZPUG_CS2_TESTS=required` extended runs.
- Every contract change released and pinned by the platform (their T22).
- `gs.ezpug.com` deployed with the plugin that answers pauses and seats mixed rosters.
- OPEN-POINTS holds only what needs a human (the retakes human read, if T6 leaves it).
- Closing note: the Dathost hours spent, what T7 found, and what the platform's first
  mixed-roster run showed.
