# PRD 08: The unboxing

The owner walked the look list on 2026-10-04 with a real client on a Dathost server, and
everything PRD-07 drew was drawn: the welcome, the toast, the card, the turn and the sound.
Then they said what a drop should be. **When somebody wins, the whole server watches it
open**: at the start of a freeze time, everybody sees "X got a drop, let's see what it is!",
then a case-opening reel that slows down and stops on the prize, then the reveal, tinted and
loud by tier. Everybody keeps buying meanwhile, and it is gone before the round starts.
Drops are rare (a few an evening), so this may be prominent. It replaces the private card
as the way a **drop** is shown. A perk, a raffle and a moment without a reel stay as PRD-07
made them.

Runs beside the platform's `/root/ezpug/ralph/PRD-18-in-the-game.md`, whose T5b sends the
reel and waits for this round's release. The platform already holds a win until the next
`round_start` (its T1), so a moment for a drop arrives at the start of a freeze.

**Branch:** `main`. **Surface:** the whole repo. **Model:** `claude-opus-5-5`; tasks tagged
`(fable)` run on Fable 5.1; effort as tagged, `high` without a tag.

**The deadline: a playtest at 19:00 on 2026-10-04** (the owner, final preparation for the
SaarLAN the weekend after). Everything below must be published, released and deployed by
**18:00**. Order of work is therefore T1, T1a, T1b, T3, T4, T5, T7, T6, T8, and T2 last; if T2
does not fit, it moves to after the playtest with a `> note:` and nothing else waits for it.
Checkpoints are trimmed: `pnpm verify` every task, the lane plays **only the unboxing rows**
(never the whole matrix), and the extended tier runs once, in T6, detached, in parallel with
the lane. The Workshop serves a new revision about 47 minutes late, so the first publish
happens as soon as the layout and the sound are in (T7 before T6), and a later fix is a
republish started no later than 17:00.

**Budgets:**
- **Decision 34 holds as written.** Nothing depends on the unboxing; it never takes the
  mouse; off means untouched. A server without a HUD prints the line, as today. A freeze
  too short for the whole sequence gets PRD-07's toast and card, as today.
- **It never covers a fight, and never stops a purchase.** It runs only inside a quiet
  stretch that fits it, is put away the instant the freeze ends, and every panel stays
  `hittest="false"`. Where it sits must leave the buy menu usable.
- **Contract: additive only**, one release (`0.32.0`) to the box's Verdaccio with a
  changelog line naming the platform's PRD-18 T5b.
- **The dev CS2 lane** is the proving ground, behind the lane lock (`docs/operations.md`).
  The platform loops share it.
- **Dathost:** one template refresh (`pnpm dathost:image`) and its `--check`, no server.
- **Production keeps no addon id.** The owner turns the HUD on for a look; the round never
  does.
- **Workshop:** publish when the layout is done, then `node hud/src/cli.ts check 3811574606`
  until the "byte for byte" line. Steam serves a new revision about 47 minutes late
  (`docs/hud.md`, "What happened on 2026-10-02"): start the wait, do other work, come back.

## Findings

Read `docs/hud.md` (all of it) and `docs/decisions.md` 34 first. Then:

- **What exists.** `plugins/EZPug.Sdk/Hud/Moments.cs` (665 lines): toasts (3 rows, 6 s),
  the card (6 s, turns at 1 s, `CardWaitMs` 3 min), the queue per seat, the art classes,
  the sound (`EndMatch.ItemRevealSingleLocalPlayer`, volume by tier, `:123`, `:147`).
  `plugins/EZPug.Sdk/Hud/Hud.cs:304` is `Quiet`, the one answer to "is anybody playing,
  and for how long not" (`FreezeTime` with `LeftMs`, `RoundOver` with the restart delay
  plus the next freeze). `IGameWorld.PlaySound(player, event, volume)` at
  `plugins/EZPug.Sdk/World/IGameWorld.cs:311`. The layout and styles are
  `hud/layout/ezpug_moment.xml` (57 lines) and `hud/styles/ezpug_moment.css` (330),
  the art rules `hud/styles/ezpug_art.css`, the pictures `hud/images/` (the drop line's
  `big-*`, `category-*`, `double-*`… keys, `HUD_ART_KEYS` in
  `packages/match-api/src/resources/hud-keys.ts:9`). The contract is
  `momentCommandSchema`, `packages/match-api/src/resources/commands.ts:94`.
- **The gotchas that shape this round** (`/root/ezpug/references/cs2-custom-hud/cs2-ui-kit/docs/GOTCHAS.md`):
  `@keyframes` on `transform` never play, a `transition` started by a class does, and
  keyframes on `opacity` do. So a reel is a strip whose `transform` transitions from one
  class to another with a long duration and an ease-out curve, and the stop is a position
  the server chose by putting the prize in a known slot. Pictures go in as
  `background-image`, never `<Image>`. Per-player state is keyed by slot. A class set while
  a client is still loading is lost. No inline `style`, no `id` on the root.
- **The avatar is unknown.** Valve documents four panel types (`Panel`, `Label`, `Image`,
  `Button`) and a picture cannot arrive at runtime. Whether anything else gets through
  Valve's compiler and a retail client (the game's own avatar panel by SteamID, an image
  source bound to a dialog variable, a remote URL) nobody has written down. The owner
  wants the winner's Steam avatar; a bot has no client, so only a person can see whether
  a candidate draws.
- **The freeze.** A PUG plays MatchZy's live config. `docs/hud.md` and the lane have the
  number as the server reads it (`Scaled("mp_freezetime")`); measure it, don't assume it.
  Rush is 13 s, flying-scoutsman 5, powerup-dm 0.
- **Sound.** The game ships its own case-opening sounds (the reel's ticks, the reveal).
  Their event names are in the game's sound event files on the dev node's read-only game
  volume. Decision 34 lists the events PRD-07 looked at.
- **What the owner saw on 2026-10-04** (production orchestrator at `4424c0a`, match-api
  0.31.1, Dathost Düsseldorf): the welcome slid in, shrank to the mark; a rare and an
  uncommon card turned with the sound; a legendary mid-round gave the toast now and the
  card at the next quiet stretch; a moment at `round_start` played the card at once. No
  input was taken (the owner's mouse trouble reproduced in an offline practice game, so it
  was the client).

## Attitude

- **The server plays the whole show from one command.** The platform says "this person
  won this, and these are the decoys"; the server chooses the slots, the timing and the
  sound. Nothing in the contract names a panel, a class or a duration a client must obey.
- **Everybody sees the same unboxing at the same instant**; the winner hears and reads it
  as theirs. Spectators and GOTV see what the person they watch sees.
- **Excitement, then out of the way.** The sequence ends with time to spare before the
  freeze does, and a long freeze does not stretch it. It is better to show the old card
  than to start an unboxing that will be cut off.
- **The look is a person's.** Every task that changes what is drawn adds or updates a step
  on the look list (`docs/hud.md`). No task claims a picture is right because a test
  passed.

## Tasks

- [x] **T1 (fable): the contract.** Additive, in `@ezpug/match-api`. A `moment` may carry
  a **reel**: the decoys the platform could have drawn, each an art key and a tier, in a
  bounded list. A moment with a reel and a person is an **unboxing**; without either, the
  moment is PRD-07's. Export the sequence's timing that a client needs to keep its own
  surfaces in step (when, after the moment is due, the prize shows), as a constant with
  its reason, because the platform's crate, phone and feed reveal at that instant. The
  server is told nothing else new. Fixtures, the fake orchestrator's behaviour, the
  changelog. `docs/match-api.md` says what a client sends. No release yet (T8).
- [x] **T1a (effort: medium): release 0.32.0 now.** The platform's PRD-18 T5b waits for
  the contract, and the playtest is today: publish `@ezpug/match-api` 0.32.0 to the box's
  Verdaccio as soon as T1 is green, with the changelog line naming PRD-18 T5b, so the
  platform builds against it while this round draws. A later fix is 0.32.1, additive.
- [x] **T1b (effort: high): Rush waits for its people.** Urgent for tonight's Playtest Rush
  Cup (owner, 2026-10-04). A `flow: none` mode goes live `GenericFlow.GoLiveDelayMs` (20 s)
  after its map is up whether or not anybody came
  (`plugins/EZPug.Sdk/Gamemodes/GenericFlow.cs:51-78`, `:347-366`). Puppets connect at once,
  people take 30–90 s (more on a first join with the HUD's addon download and reconnect), so
  a real Rush match starts 1v3. With people on the roster (`matchHumans`: every entry not a
  puppet), warmup holds until every rostered person is connected and on a team, then the
  server says so in chat in both languages (the platform's voice, `Branding`'s prefix) and
  goes live after a short countdown. A seat that never fills is the platform's join
  deadline's business (5 min for a queue match, **15 min for a cup's**, at most 19 with
  extensions; platform PRD-18 T4b), so the server keeps no ceiling of its own: the
  orchestrator's 20-minute "no `going_live` within … of ready" release is the backstop. An
  all-puppet match keeps today's 20 s. The welcome (`Welcome.cs`) then shows in a Rush
  warmup as it does in a PUG's. Tests on the fake clock for each line; `docs/gamemodes.md`
  "The generic flow" amended; the lane's Rush row green on the dev node behind the lock. This
  ships with T7's template refresh and deploy; if T7 is far off, deploy it on its own
  (`pnpm dathost:image`, `./scripts/deploy.sh all`) by 17:00.
- [ ] **T1c (effort: medium): the hostname holds (ezpug-iron#8).** Found by the platform's
  lane (PRD-18 T4, 2026-10-04): in warmup the server reads MatchZy's own
  `Team_Kev1n vs Team_Murmeltier`, because `matchzy_loadmatch` rewrites the hostname
  `GamemodeLoader` set on assign before the match file's `matchzy_hostname_format` takes
  effect. Make `Branding.HostnameFor`'s name hold from assign through warmup and live:
  set `matchzy_hostname_format` before `matchzy_loadmatch` too, and/or re-assert
  `hostname` after the load. A test or fixture reads it back after the load. #7 (the RCON
  readback is 7-bit, `·` comes back as `B7`) is **not** for tonight: leave it open. Ships
  with T1b in the same deploy by 17:00 (`pnpm dathost:image`, `./scripts/deploy.sh all`);
  if T1b is already deployed, deploy this on its own. Close #8 with the commit.
- [ ] **T3: the unboxing, drawn.** A layout (or a section of the moment's layout) with
  three beats: **the call** (the name or avatar, "hat einen Drop! Mal sehen…" / "got a
  drop! Let's see…", from the server's catalog in both languages), **the reel** (a strip
  of pictures that slides and slows to a stop on the slot the server marks, with a
  centre marker), **the reveal** (the prize grows, the tier's colour and a burst, the
  item's line for everybody and the winner's own line for them). Placement leaves the
  buy menu usable and readable: decide where from the game's own layout of the buy menu,
  and whether the unboxing stays drawn while it is open (the owner wants people to keep
  buying while they watch). 16:9 and 4:3. In the house style of the welcome and the card
  (`hud/styles/`), with the cast where a hand is needed. Gotchas above; transitions on
  classes, never keyframes on transforms.
- [ ] **T4 (fable): the unboxing, played.** In the SDK, beside `Moments`. A drop moment
  with a reel, due in a quiet stretch that fits the whole sequence, plays the unboxing for
  everybody on the server: slots chosen deterministically (seeded by the moment, so a
  redelivery shows the same reel), the prize in the stopping slot, classes set per beat on
  the SDK's clock. Rules, each a test on the fake clock: a stretch too short (Rush,
  flying-scoutsman) gives PRD-07's toast and card; a freeze that ends early puts it away
  in that instant; two unboxings never overlap (the second waits for the next stretch that
  fits, bounded like `CardWaitMs`); somebody who connects mid-sequence sees nothing of it;
  the winner not on the server still has everybody watch; the line is said in chat, as
  every moment's is; a map change, a pause and the match ending behave as `docs/hud.md`
  says a card does. Spectators follow `observable`.
- [ ] **T5 (effort: medium): the sound.** Find the game's case-opening sound events and
  choose: a tick as the reel passes slots (slowing with it, within what the server can
  schedule), and the reveal by tier, for everybody, at a volume that does not drown the
  round's audio. If the volume argument does not scale an event (PRD-07's open question),
  say so and pick events that differ by tier instead. `PlaySound` only; no shipped audio.
- [ ] **T7 (effort: medium): publish and the template.** `pnpm hud:build`,
  `pnpm hud:publish`, the check until byte for byte. `pnpm dathost:image` and `--check`
  green. `./scripts/deploy.sh all` for the orchestrator.
- [ ] **T6 (checkpoint, trimmed): the lane.** The unboxing rows only, never the matrix,
  with the extended tier detached in parallel. A row on the dev node behind the lock: a puppeted
  match, a drop moment with a reel sent at a `round_start`, and the layout's state read
  back over the freeze (`ezpug_status`, the entity read-back of PRD-07 T9): the beats in
  order, their instants, everything cleared before `round_freeze_end`. The same with a
  freeze too short, and with the HUD off (the line only). The extended tier green.
- [ ] **T8 (effort: medium): the books.** (0.32.0 shipped in T1a; a 0.32.1 only if
  something changed.) `docs/hud.md`: the unboxing section, the
  avatar's finding, the timing table, and **the look list's new steps**: the unboxing at
  16:9 and 4:3 in both languages, with the buy menu open, as a spectator, a freeze too
  short, the avatar debug layout. `docs/decisions.md` 34 amended for "the whole server
  watches a drop". A closing note for the platform: the version, the reveal constant, what
  a reel needs.

- [ ] **T2 (effort: medium): the avatar, tried.** (Last; after the playtest if it does not fit.) Find out what can show a person's Steam
  avatar in a `custom_hud_layout`: read Valve's panel registry and the game's own layouts
  (the scoreboard draws avatars), then build each plausible candidate in a **debug
  layout** that only an rcon command shows, never a moment. Write down what the compiler
  accepts and refuses. Whatever compiles goes into the addon and onto the look list as one
  step. The unboxing's default design must not need it: the fallback is the person's name,
  large, in their team's colour with the cast's mascot of that side. When the owner has
  looked, the winner is wired into T4 or the step says why not.

## Working rules

- **Production is `./scripts/deploy.sh` and nothing else.** Never `docker compose -p
  ezpug-iron` and never `-f compose.prod.yaml` by hand, not even for `ps`. The box's
  `docker` shim refuses both with exit 125.
- **Nothing in this round sets `EZPUG_IRON_HUD_ADDON` in production.**
- **No input capture, anywhere.** `SetInputCaptureEnabled` in this repo is a failing test.
- **The CS2 lane is shared with the platform loops**: the lane lock as the page says,
  release after the server has left the fleet, never across a task boundary.
- **The game's files stay the game's.** Anything read out of `pak01_dir.vpk` lives in the
  build volume and is never copied into the repo.
- **The art is the platform's.** A new picture is the platform's `scripts/cast-art.mjs`,
  never drawn here; if the unboxing needs one, write `> blocked:` naming it and use what
  exists.
- **This repo is public.** Nothing about the Steam account, its session or the Workshop
  item's owner goes into a commit, a log line or a progress line.
- **Commit only your own paths.** Never `git add -A`.
- **Secrets**: RCON and join passwords, GSLTs and tokens live only in gitignored env
  files, the token store, process memory or `~/.npmrc`; fixtures are scrubbed.

## When the PRD is complete

Every box ticked, `pnpm verify` and the extended tier green, 0.32.0 on Verdaccio, the addon
published and checked, the template refreshed, and a closing note at the end of this file
for the platform and the owner.
