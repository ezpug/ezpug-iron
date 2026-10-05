# PRD 09: After the playtest

The playtest of 2026-10-04 left the server four things, and the SaarLAN is this coming
weekend. **Rush does not put people on their teams** ("it doesn't automatically assign teams
properly"); **the chat still says MatchZy** where it should say EZPug; **half time should be
all-talk**, from the second the half's last round ends until the next freeze time begins,
and the HUD should show it; and **the reel fix is not shipped**: the unboxing's case still
jumps and sticks on every server because `fix/unbox-reel-spin` was never merged, published or
deployed. One more thing the platform asked for: the live map colours its dots by a side the
wire never sends, so a position tick should carry one. Runs beside the platform's
`/root/ezpug/ralph/PRD-20-after-the-playtest.md`, whose T3 reads the side, T5 sends
`autoReady: false` for a cup, and T17 consumes this round's release.

**Branch:** `main`. **Surface:** the whole repo. **Model:** `claude-opus-5-5` for every task,
nothing tagged `(fable)`; effort as tagged. **Order:** T1 (the reel, shipped) first because it
is a merge and a publish; then T2, T3, T4, T5, T6, T7. PRD-08's open T8 (the books) closes
inside T7 here; its T2 (the avatar) stays parked.

**Budgets:**
- **Contract: additive only**, one release (`0.34.0`) with a changelog naming the platform's
  PRD-20 T17, from T7 and nowhere else.
- **MatchZy does not run Rush** (decision 33 stands; upstream MatchZy 0.9.1 of 2026-10-03
  adds a ready-up time limit, a join-ready mode and technical pauses, and nothing for a
  `cs_script` mode). The owner asked whether it could; the answer is written in T2's
  decision, and Rush is seated by the SDK's generic flow.
- **The dev CS2 lane** is the proving ground, behind the lane lock (`docs/operations.md`).
  The platform loops share it. Dathost rents one server only in T1's and T7's `dathost:image`
  check, as before.

## Findings

Traced 2026-10-05 at `5e82630`. Trust the file over this note.

- **The reel.** `3dd4a6a` "the unboxing's reel spins and slows instead of jumping and
  sticking" and `ae9fdff` (its test) sit on `fix/unbox-reel-spin` (worktree
  `/root/ezpug-iron-fix-reel`, based on `5e82630`): the curve `cubic-bezier(0.2, 0.65, 0.4, 1)`
  and 29 ticks, touching `hud/styles/ezpug_unbox.css`, `plugins/EZPug.Sdk/Hud/Unboxing.cs`,
  the rebuilt `hud/dist`, `docs/hud.md` ("The roll's curve", "Shipping the roll"). Workshop
  item 3811574606 still serves the revision published from `2d78da0` (pack `56085a51…`);
  production's orchestrator was last deployed at `2d78da0`; `eb3a029` (PRD-08 T6) is not
  deployed. The fix's changelog says both halves ship the same day: `hud:build` + `hud:publish`
  and `cs2:build` + `dathost:image`; Steam served the previous revision 47 and 66 minutes late
  (`docs/hud.md` → What happened on 2026-10-02).
- **Rush seats nobody.** `gamemodes/rush/manifest.json:4,11,17` (`tier: config`, `flow: none`,
  `plugins: []`); `gamemodes/rush/cfg/ezpug/rush.cfg:21-22` (`game_type 0 / game_mode 6`),
  `:45-46` (`mp_autoteambalance 0`, `mp_limitteams 0`). Puppets are placed on their side
  (`plugins/EZPug.Sdk/Players/Puppeteer.cs:224-237`, `SideOf` → `AddBot(side)`); **a person
  is placed by nothing**: `IGameWorld.SetTeam` (`World/IGameWorld.cs:338`, implemented
  `plugins/EZPug.Core/World/CounterStrikeWorld.cs:945`) has no production caller. The warmup
  hold (PRD-08 T1b, `GenericFlow.cs:416-424`) counts a person present on *any* team, so a whole
  roster on CT starts the countdown. `openJoin: false` turns nobody away outside MatchZy
  (`docs/gamemodes.md:77` promises it; the only reader is the idle clock,
  `Gamemodes/MatchLength.cs:226`). The welcome card already names the rostered team
  (`Hud/Welcome.cs:128`). MatchZy-Enhanced's own gate (`docs/match-api.md:353-362`, decision
  19) is "connected *and on its side*".
- **The prefix.** MatchZy-Enhanced's default is `[{Green}MatchZy{Default}]`
  (`references/MatchZy-Enhanced/src/MatchZy.cs:24`, `cfg/MatchZy/config.cfg:140`; admin
  `:144`; the handler `src/ConfigConvars.cs:385-421` also persists the value in MatchZy's
  database and reloads it at startup, `src/Utility.cs:3847`). Nothing in this repo sets
  `matchzy_chat_prefix` or `matchzy_admin_chat_prefix`; `Branding.PrefixFor`
  (`plugins/EZPug.Sdk/Branding/Branding.cs:137-143`) brands only the SDK's own lines, and the
  loader hands MatchZy the hostname alone (`GamemodeLoader.cs:294-314`). `docker/cs2/cfg/MatchZy/ezpug.cfg`
  is appended to MatchZy's config and wins (`Dockerfile:149`); `docker/cs2/matchzy-cfg-check.sh`
  pins its lines.
- **Half-time voice.** MatchZy's `live.cfg:92-99` turns every cross-team path off
  (`sv_auto_full_alltalk_during_warmup_half_end 0`, `sv_deadtalk 1`, `sv_talk_enemy_dead 0`,
  `sv_talk_enemy_living 0`), `warmup.cfg:16-19` too; nothing here sets `sv_alltalk`,
  `sv_full_alltalk` or `sv_talk_enemy_*`. The engine's own switch
  (`sv_auto_full_alltalk_during_warmup_half_end`) is not protected
  (`packages/match-api/src/resources/gamemode.ts:221`) and the match file's cvars are
  re-applied after `live.cfg` (`apps/orchestrator/src/match-config/matchzy.ts:28-35`), but it
  also opens warmup and the match's end, and its timing is the engine's, not the owner's. The
  server knows half time: `GamePhase.Halftime` (`IGameWorld.cs:144-153`), `Hud.Quiet` answers
  `QuietReason.Halftime` (`Hud/Hud.cs:331-333`), `MatchZyFlow` reads it for pause refusals
  (`EZPug.Core/MatchZy/MatchZyFlow.cs:395`), and MatchZy's `halftime_started` is dropped by the
  translator on purpose (`apps/orchestrator/src/matchzy/translate.ts:388`). A `moment` takes
  any kebab `kind` and no person (`packages/match-api/src/resources/commands.ts:149`): a toast
  for everybody, or the line where there is no HUD.
- **The side on the wire.** `positionTickEventSchema` carries `{ steamId64, x, y, z, yaw? }`
  per position and nothing about the team (`packages/match-api`, `dist/match-*.js`
  `positionTickEventSchema`); the emitter has the player and sends no side
  (`plugins/EZPug.Sdk/Gamemodes/Facts.cs:166-188`). The platform's radar guesses CT when it
  cannot know (its PRD-20 Findings → The live map's colour).
- **The ready gate.** `rules.warmup.autoReady` becomes `matchzy_autoready_enabled`
  (`apps/orchestrator/src/match-config/matchzy.ts:322-325`); the image's baseline is off
  (`docker/cs2/cfg/MatchZy/ezpug.cfg:52-59`); `.ready`/`.unready` always work under MatchZy
  (decision 19). Nothing to change here; the platform's PRD-20 T5 sends `false` for a cup.
- **Open issues**: #7 (RCON is 7-bit, left open), #9 (widget kit size race, open), #6 (sim
  knife kill + line, open); #8 closed by `a34ce8d`.

## Attitude

- **The weekend first.** The reel is a merge and a publish and happens before anything
  else; Rush seating and the prefix are what people see on Saturday; voice is the one
  feature. If the clock runs out, T5 and T6 move behind the LAN with a `> note:`.
- **Timing is the owner's sentence, not the engine's switch.** "From the second the last
  round of the half ends until the next freeze time begins." A cvar the engine flips on its
  own schedule is not that; the SDK flips the cvars on the phase and the HUD shows the whole
  stretch and nothing outside it.
- **The HUD shows a state the server holds; it never decides one.** Voice on is a server
  fact; the band is drawn from it and put away with it. Decision 34 holds: off is untouched.
- **Additive, one release.** The side on a tick and the voice field are optional fields the
  platform reads when present; a 0.33.0 platform keeps working against a 0.34.0 server.

## Tasks

- [x] **T1 (effort: medium): The reel, shipped.** Merge `fix/unbox-reel-spin` (`3dd4a6a`,
  `ae9fdff`) into `main` (the worktree goes afterwards), `pnpm hud:build` + `pnpm hud:publish`
  (the Workshop revision check every five minutes until the pack reads back byte for byte;
  the wait goes in the progress line), `cs2:build` + `dathost:image` + `--check`,
  `./scripts/deploy.sh all`, smoke green. The lane's `unbox` row on the dev node reads the
  console's beats as PRD-08 T6 did, and the owner's look is the reel on a real client.
  `docs/hud.md` → Shipping the roll records the day's two halves and their shas.
- [x] **T2 (effort: high): Rush seats its people.** A `flow: none` mode with `teams: 2`
  seats a person the way it seats a puppet: on connect and on every team change, a rostered
  person is put on their roster's side (`SetTeam`, the same side logic as `Puppeteer.SideOf`),
  with one chat line saying so; a person is counted present for the warmup hold only on
  their own side (`GenericFlow.cs:416-424`); with `openJoin: false` a SteamID off the roster is
  kicked with the reason, so `docs/gamemodes.md:77` is true. Test on the fake world (a roster
  that all joined CT, a person who switches, a stranger); the lane's `rush` row asserts both
  sides after the hold. A new decision (35) records it and answers the owner's question in
  one paragraph: MatchZy cannot run Rush (decision 33, the map's script owns the rounds;
  upstream 0.9.1 changes nothing there), so the SDK seats.
- [x] **T3 (effort: medium): The chat says EZPug.** `docker/cs2/cfg/MatchZy/ezpug.cfg` sets
  `matchzy_chat_prefix [{Green}EZPug{Default}]` and the admin prefix beside it, pinned by
  `matchzy-cfg-check.sh`; the loader sets the prefix per match from the branding the request
  carries (the event's name when there is one, `EZPug` otherwise), the way `WithHostnameFormat`
  sets the hostname, and it survives `matchzy_reset_cvars_on_series_end` and MatchZy's
  persisted value (`Utility.cs:3847`). `cs2:build` + `dathost:image`. The lane's `ingame` row
  reads the prefix back off a MatchZy line (7-bit, #7: no `·` in it).
- [x] **T4 (effort: high): Half time is all-talk, and the HUD says so.** For the `pug`
  manifest (a capability `halftimeVoice`, never Rush): when the half's last round ends
  (`round_end` with the half over, the phase about to be `Halftime`) the SDK sets
  `sv_talk_enemy_living 1` and `sv_talk_enemy_dead 1` (and whatever else CS2 needs for
  living players to hear the other side; checked on the dev node with two clients), and
  resets them the instant the next `round_start` begins its freeze time; also reset on a
  pause's end, a map change, a restore and the match's end, so a server is never left open.
  The HUD draws a band for the whole stretch ("Halbzeit, alle hören alle" / "Half time,
  everyone can talk", the event's accent, no person), put away with the cvars; without the
  HUD, one chat line at each edge. **The contract (additive):** the request may say
  `voice: { halftime: boolean }` (default on for `pug`; the platform may turn it off), and a
  fact `halftime_started` (sides, the stretch's start) leaves the translator's drop list
  (`translate.ts:388`) so the platform can draw its own band. A test on the fake clock for
  every edge; the lane's `queue` row reads the two cvars at half time and after it.
- [ ] **T5 (effort: medium): A position carries its side.** `position_tick`'s positions gain
  an optional `side: 'ct' | 't'` (and the SDK emitter sends it, `Facts.cs:166-188`; the
  simulator too), additive in `packages/match-api` with its JSON schema and fixtures. The
  platform reads it in PRD-20 T17 and keeps its fallbacks for an older server.
- [ ] **T6 (effort: medium): Upstream MatchZy 0.9.1, weighed.** The owner asked for updates
  on the MatchZy-Enhanced fork. Diff upstream `0.9.0`/`0.9.1` (ready-up time limit, join-ready
  mode, technical pauses, Get5 live events, same-map loading) against the fork at
  `1.4.32-ezpug.1` (`docs/pins.md:81`, OPEN-POINTS §7/§8); write what each would give the
  platform (join-ready could retire our `.ready` handling; the tech pause meets
  `match_paused`'s source vocabulary) into `docs/decisions.md` as a note under decision 19.
  **Rebase only if** the fork's patches apply clean and the lane's `queue` row is green on
  the rebuilt image; otherwise the note says why not, and the pin stays. Never the week of
  the LAN if the lane is not green by Thursday.
- [ ] **T7 (effort: medium): Release and the books.** `@ezpug/match-api` 0.34.0 to Verdaccio
  (changelog: the side, the voice field and fact, naming PRD-20 T17); `cs2:build` +
  `dathost:image` + `--check`; `./scripts/deploy.sh all`, smoke green; the lane's `rush`,
  `ingame`, `queue` and `unbox` rows green on the dev node at this sha. PRD-08 T8's books
  folded in (`docs/hud.md` the unboxing's sections and the reel's curve, `docs/gamemodes.md`
  Rush's seating and the voice capability, `docs/match-api.md` the two new fields, decisions
  35 and the 19 note). `ralph/OPEN-POINTS.md`: whatever T4 found CS2 will not do.

## Working rules

- **Production is `./scripts/deploy.sh` and nothing else.** Never `docker compose -p <prod
  project>` and never `-f compose.prod.yaml` by hand, not even for `ps`: the dev world is
  plain `docker compose` in the repo. The box's `docker` shim refuses both with exit 125 —
  if you meet that refusal, you were about to touch production; use the deploy script's
  verb or leave it alone.
- **The lane lock first, always** (`docs/operations.md`); the platform's loops share the CS2
  container. Give it back only after the server has left the fleet.
- **A HUD change is two halves on one day** (`hud:publish` and the image); half of one is a
  server whose ticks disagree with its picture. Start the publish early; Steam is an hour
  late.
- **Nothing here edits a schema the platform owns**; a platform shape the server needs is a
  line in PRD-20, never a patch there.
- **Commit only your own paths; never `git add -A`.** The platform's worktrees share this box.

## When the PRD is complete

0.34.0 is on Verdaccio, production runs it with the reel fixed, Rush seating its people, the
chat saying EZPug and half time open; the lane's four rows are green at the release sha; the
closing note names what the owner should look at on a real client (the reel, a Rush match's
first ten seconds, the half-time band), what T6 decided about upstream, and what was not
checked (a full LAN room's voice at once, Dathost's own cvar whitelist).
