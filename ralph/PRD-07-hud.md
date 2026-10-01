# PRD 07: The HUD

Somebody who joins an EZPug server should know where they are: the platform's name, its
mascots, tonight's event, what to do next, in their language. And when a drop lands, the
server should show it like it matters, without costing anybody a round. Valve gave servers
the tool for this on 2026-08-24 (`custom_hud_layout`, a Panorama panel a server drives),
and decision 22 deferred exactly this ("in-world banners need a Steam Workshop addon
players download and are a later round"). This is that round: a small client addon, the
plumbing that hands it to players, a HUD seam in the SDK, a welcome card, and one new
command (`moment`) that lets the platform say "this happened to this player" and lets the
server decide how and when to show it.

Runs beside the platform's `/root/ezpug/ralph/PRD-18-in-the-game.md`. Its T5 waits for this
round's release; nothing else of it does.

**Branch:** `main`. **Surface:** the whole repo. **Model:** `claude-opus-5-5`; tasks tagged
`(fable)` run on Fable 5.1; effort as tagged, `high` without a tag.

**Budgets:**
- **Off is the default, at every layer, until the owner has looked.** A human has never
  seen any of this, and bots have no client. The round ships everything switched off and
  ends with a look list (T11); nothing in this round turns the HUD on in production.
- **The dev CS2 lane** is the proving ground (the lane lock in `docs/operations.md`). The
  platform loops share it.
- **Dathost:** one template refresh (`pnpm dathost:image`) and at most one server-hour, in
  T10 only.
- **Contract:** additive only; one release to the box's Verdaccio with a changelog line
  naming PRD-18 T5.
- **Disk:** what the compiler needs lives in a named volume of its own, outside git, and
  `docs/hud.md` says how to delete it. The node's game volume is mounted read-only and
  never written. Never `docker volume prune`.
- **The Steam session exists** (logged in by hand, 2026-10-01): volume
  `ezpug-iron-hud-steam`, mounted at `/serverdata/Steam` for the `steam` user of the cs2
  image, where `steamcmd +login "$EZPUG_HUD_STEAM_USER"` answers "Logging in using cached
  credentials". The account's name and password are in `.env` (`EZPUG_HUD_STEAM_USER`,
  `EZPUG_HUD_STEAM_PASSWORD`, gitignored, mode 600). If Steam asks for a Steam Guard code
  again, that is the owner's mailbox and not a loop's: write `> blocked:` and go on with the
  tasks that need no compiler.

## Findings

Traced 2026-10-01 against the tree at match-api `0.30.0`. The research note is
`/root/ezpug/references/cs2-custom-hud.md`; the clones it indexes are in
`/root/ezpug/references/cs2-custom-hud/` (read them, never vendor them).

- **What the entity is.** Valve's own description is
  `/root/ezpug/references/cs2-custom-hud/valve-gametracking/content/csgo_addons/cs_script_demo/maps/scripts/point_script.d.ts:893-962`
  (`@experimental`). Four panel types (`Panel`, `Label`, `Image`, `Button`), CSS, no events
  and no client script. The server sets two things, for everyone or per player slot: a class
  on a panel and a string dialog variable. `SetInputCaptureEnabled` takes the mouse and
  freezes movement. The game puts `HUD_BUYMENU_VISIBLE`, `HUD_SCOREBOARD_VISIBLE`,
  `HUD_WINPANEL_VISIBLE`, `HUD_TEAMINTRO_VISIBLE` and `HUD_ENDOFMATCH_VISIBLE` on an
  ancestor, so a layout can step aside in CSS alone. `observable` (9 Sep) shows a spectator
  the watched player's HUD.
- **The layout is a client file.** Only entity state is networked. The compiled `.vxml_c`
  and `.vcss_c` must already be on the client under `panorama/layout/custom_game/` and
  `panorama/styles/custom_game/`, which means a Workshop addon. Images are compiled into it
  too: nothing can put a picture on screen at runtime, only switch a class.
- **CounterStrikeSharp drives it since 1.0.374** (`CCSCustomHudLayoutExtensions.cs`,
  `natives_customhud.cpp` in `/root/ezpug/references/CounterStrikeSharp`). We pin **1.0.375**
  (`plugins/Directory.Build.props:16`, `docker/cs2/Dockerfile:78-122`), which has the bug
  that leaves every `{s:text}` blank after a player takes a slot; **1.0.376** carries the fix
  (#1434, `ffe84cfc`).
- **What costs people days** is written down in
  `/root/ezpug/references/cs2-custom-hud/cs2-ui-kit/docs/GOTCHAS.md`. Read all of it before
  T3. The ones that shape this round:
  - the layout name is the full **source** path with its extension;
  - the root panel carries no `id`, and no panel carries inline `style`;
  - `@keyframes` on `transform` never play, a `transition` started by a class does, and
    keyframes on `opacity` do;
  - pictures go in as `background-image`, never `<Image>`;
  - per-player state is keyed by **slot** and slots are reused;
  - a class set while the client is still loading is lost, so nothing may remember "already
    set" across a connect;
  - the entity outlives a plugin reload, so orphans are removed by name on spawn;
  - no entity may be touched before the first `round_start` (CounterStrikeSharp caches the
    failure for the life of the process);
  - a changed layout needs the client restarted and the addon republished.
  `panorama-hud/plugins/panorama-hud/skills/panorama-hud/` has the CSS subset and the 140
  properties.
- **How an addon reaches a client.** MultiAddonManager
  (`/root/ezpug/references/cs2-custom-hud/MultiAddonManager`, v1.6.2 of 2026-09-28), a
  Metamod plugin: `mm_client_extra_addons <ids>` names client-only addons, and
  `mm_add_client_addon <id>` / `mm_remove_client_addon <id>` change the list for future
  clients at runtime. The mechanism is the engine's own (`src/multiaddonmanager.cpp:150-157`):
  the client is told the addon during the connection handshake, downloads it and connects
  again, which a player sees as a longer loading screen on the first join.
  `mm_cache_clients_with_addons 1` stops it repeating on a map change or a rejoin. **It
  breaks on CS2 updates**: client addons stopped arriving after 1.41.8.x until v1.6.1 on
  23 September (issue 75). Nothing may depend on it.
- **Today's image has neither.** Metamod and CounterStrikeSharp are the only Metamod-level
  pieces (`docker/cs2/Dockerfile:78-122`, `docs/pins.md:43-46`); `gameinfo.gi` is patched
  for the Metamod line only (`docker/cs2/entrypoint.sh:40-49`,
  `scripts/dathost-image.mjs:104-112`); Dathost gets the files from the image through the
  template (`docs/operations.md:1190-1277`). `plugins/vendor/README.md:60-64` already notes
  that the retakes allocator's menu wants this same delivery.
- **What a player sees today** is `plugins/EZPug.Sdk/Branding/Branding.cs`: the hostname
  (`:82-102`), the chat prefix (`:132-153`), the "you play for" line (`:162-170`) and a
  four-line centre card two seconds after connect (`:183-231`, `PrintToCenterHtml`).
  `WarmupChat.cs:32,92-105` rotates the platform's warmup lines. `RatingBoard.cs:96-117`
  greets with the rating. None of it has been seen by a human
  (`ralph/PRD-02-iron.md:845-861`).
- **The one way text reaches a running match** is `announce`: one line to everybody
  (`packages/protocol/src/server-link.ts:240-252`, `GamemodeRuntime.cs:459-470`,
  `SaidLine.cs:36-39`). There is no per-player message. The platform's drop herald and perk
  herald both use it.
- **The seam for a new capability** is stated in `docs/sdk.md:23-25`: it grows once, in
  `IGameWorld` (`plugins/EZPug.Sdk/World/IGameWorld.cs:267-272` holds today's text verbs),
  in `FakeGameWorld` (`plugins/EZPug.Sdk.Testing/FakeGameWorld.cs:73-79,154-178`), with a
  test. Runtime services sit beside `Branding` (`GamemodeRuntime.cs:64-66`); capabilities
  are named in `HelloFactsBuilder.cs:18-25` and `gamemode.ts:265-286`.
- **What the plugin knows about the round.** `CounterStrikeWorld.cs:256-406` hooks
  `round_start`, `round_end`, `player_death`, `player_spawn`, `cs_win_panel_match`;
  `IGameWorld.Rules` (`IGameWorld.cs:111-148`) polls `Warmup`, `Paused` and `GamePhase`.
  **Freeze end is not on the seam**: `UtilityTracker.cs:60-122` registers
  `round_freeze_end` privately for the radar. Freeze lengths differ by mode: 18 s under
  MatchZy's `live.cfg`, 13 s in Rush, 5 s in flying-scoutsman, 0 in powerup-dm.
- **Compiling without Windows.** Valve's `resourcecompiler.exe` is Windows-only.
  `/root/ezpug/references/cs2-custom-hud/cs2-workshop-publisher` is a pipeline for exactly
  this on a Linux server (SteamCMD fetches the Windows build with
  `@sSteamCmdForcePlatformType windows` plus the Workshop Tools depot, Wine under `xvfb-run`
  runs the compiler, a VPK is packed, SteamCMD uploads). Its own README says the Wine step
  is **not proven end to end**, so T1 is a spike with a fallback, and
  `cs2-ui-kit/kit/build.ps1` is the fallback's shape.
- **What the compiler needs is about 10 GB, not 60.** App 730's depots, read with the
  session above: `2347770` is the common content (65 GB, no OS, the same files the dev
  node already holds in the `ezpug-iron-cs2_cs2-data` volume), `2347771` is the Windows
  binaries (7.75 GB), and `2347779` is the Workshop Tools (2.11 GB, DLC app `2279721`,
  which the account's licence covers). So the build tree can be the two Windows depots laid
  over a read-only view of the node's content rather than a second copy of the game.
  **The account cannot publish yet**: it is a limited account (the owner, 2026-10-01: it has
  not spent the five dollars Steam asks for), and Steam refuses Workshop uploads from one.
  Downloading the tools and compiling are not affected. So T1 builds `hud:publish` and
  proves it as far as a dry run goes, and the first real upload (T9) writes `> blocked:` if
  Steam still refuses, with Steam's own words; nothing else in the round waits for it.
- **The box.** No Wine, no SteamCMD outside the cs2 image, 308 GB free, no GPU.
- **Still open from before:** `ralph/PRD-06-rush.md:164`, its T5 (the manifests in the
  platform's voice). It is T12 here.

## Attitude

- **Decoration, never structure.** A match plays, a drop is announced and a player is
  greeted with the HUD missing, broken or switched off. Everything the HUD shows is also a
  chat line that needs no addon. No code path waits for the HUD, reads anything back from
  it or fails because of it.
- **Off means untouched.** With the switch off, a server boots without MultiAddonManager
  loaded, tells no client to download anything and says nothing new in its hello. The proof
  is a diff against today, not an assertion that nothing went wrong.
- **Three switches, each enough on its own.** The platform leaves the block out of a
  request, an operator unsets one env value, an admin types one console line into a live
  server. Each is written down with what it stops and how fast.
- **It never takes the mouse and never covers a fight.** No verb for input capture exists
  on our seam. A card appears only when nobody is playing, and it yields to the buy menu.
- **The platform says what happened; the server decides how it looks.** A `moment` names a
  kind, a person, a tier, a picture key and the words. It never names a layout, a panel or
  a class, so the platform stays as blind to the HUD as it is to MatchZy.
- **Honest about eyes.** The loop proves what a machine can: the compile, the pack, the
  entity's state, the timing against a fake clock. What only a person can confirm goes on
  the look list with the exact steps, and is never reported as verified.

## Tasks

- [ ] **T1: the addon builds on this box.** A source folder (`hud/`: layouts, styles,
  images, an `addoninfo.txt`) and `pnpm hud:build`, which compiles it and packs the VPK
  without a Windows machine: a build image of our own (Wine, Xvfb, SteamCMD) so the box
  itself gains no packages, the Windows build of CS2 and the Workshop Tools depot in a
  named volume, the Steam session in another. Start from
  `cs2-workshop-publisher`'s approach and say what had to change. The spike's question is
  whether `resourcecompiler.exe` compiles a layout, a stylesheet and a texture headless
  under Wine; prove it with one hello panel (a label with a dialog variable, a picture as a
  background, a class that slides it in) and read the outputs back with the pinned VRF CLI
  the platform uses (`/root/ezpug/references/radar-overviews.md`). The Steam session is the volume named in Budgets; mount it where
  the build's SteamCMD looks. The session is a secret: a volume, never a file in the repo,
  never a log line. If
  Steam refuses it, write `> blocked:` with what it said and go on. **If Wine cannot do
  it**, say exactly where it failed, ship `hud/build.ps1` for a Windows machine instead, and
  keep the rest of the pipeline (pack, verify, publish) on this box. Either way the compiled
  output is committed under `hud/dist/` with a manifest of hashes, so every later task and a
  revert work without the compiler. `pnpm hud:publish` uploads to one Workshop item
  (unlisted; prove a client can fetch an unlisted item by id, or say what visibility it
  needs) and refuses to run when the tree is dirty.
- [ ] **T2: MultiAddonManager, in the image and asleep.** Pinned by sha256 like its
  neighbours (`docker/cs2/Dockerfile`, `docs/pins.md`, `scripts/check-pins.mjs`), in the
  Dathost template through `dathost-image.mjs` with its `--check`. **It loads only when
  `EZPUG_HUD_ADDON` (the Workshop id) is set for the server**: unset, the Metamod plugin is
  not loaded at all, and the test is that `meta list`, the search paths and the boot log
  match today's. Set, it loads with an empty client list, `mm_cache_clients_with_addons 1`,
  and the disconnect-message setting chosen with its reason. The id reaches clients only
  when a match asks for the HUD (T3 adds it with `mm_add_client_addon` at assign and removes
  it at release). Bump CounterStrikeSharp to 1.0.376 in its own commit, with the reason.
  Write down what a client goes through when the download cannot finish (read
  `multiaddonmanager.cpp`'s timeout path): whether they still get in, after how long, and
  which setting decides. That paragraph is the reason the switch exists.
- [ ] **T3 (fable): the HUD seam.** `IGameWorld` grows the smallest set of verbs that can
  show a layout to people (create and remove a layout, set a class and a variable for one
  player or all) and **no input-capture verb**; `CounterStrikeWorld` implements them;
  `FakeGameWorld` records them the way it records `Said` and `Hudded`. A `Hud` runtime
  service beside `Branding` owns the lifetime rules from Findings, each with a test: nothing
  before the first `round_start`, orphans removed by name, a slot reset at spawn and again
  shortly after, no memo across a connect, everything gone at release and on `Unload`,
  bots and puppets skipped. Expose freeze end on the seam, and give the service one question
  it can answer at any instant: **is anybody playing, and for how long not** (warmup, freeze
  time with what is left of it, the round decided, a pause, halftime, the match over). The
  service is inert, to the last call, when the server has no addon id or the assignment asks
  for no HUD. The hello names a `hud` capability only when both the plugin and the addon id
  are there. Decision 34 in `docs/decisions.md`: what the HUD is for, what it may never do,
  and that it supersedes decision 22's deferral.
- [ ] **T4 (fable): the contract.** Additive, in `@ezpug/match-api` and the link protocol.
  (a) The request's `branding` (`resources/match-request.ts:267-273`) gains what a welcome
  needs: a tagline, an optional banner key, and `hud` (a boolean, default false: this is the
  platform's switch). (b) A `moment` command beside `announce`
  (`resources/commands.ts:95-112`): a kind (`drop`, `perk`, `raffle`, open to more), the
  person it is about when there is one, a tier, an optional art key, the words in both
  languages (the line everybody reads and the line the person reads), and `inMs` (when to
  show it, relative, because the two clocks are not one). (c) The keys the addon ships
  (banners, art) exported as closed lists the platform can offer in a picker, generated from
  `hud/` so the list and the files cannot disagree. An unknown key is the default picture,
  never a refusal. (d) The fake and the sim answer `moment` and record it; conformance
  fixtures for each shape. **A server with no HUD answers `moment` by printing the line**,
  exactly as `announce` does today, so a caller needs no knowledge of what the server can
  draw. Release **0.31.0** to Verdaccio, changelog line "PRD-18 T5".
- [ ] **T5: the welcome.** One layout, shown to a person who joins while nobody is
  playing: a mascot, the event's name and tagline (or EZPug's own), the team they play for,
  the one thing to do (`Branding.WhatToDo`, `Branding.cs:224-231`), `ezpug.com`. In the
  player's language, from the roster's locale, with the words in the SDK's resx pair. It
  slides in at an edge, stays a few seconds, shrinks to a small mark for the rest of warmup
  and is gone when the match goes live. When the HUD is on for a match the centre card is
  not printed as well; when it is off, today's card is unchanged. The cast comes from
  `/root/ezpug/packages/ui/public/cast/` (`hello@full.webp` and the chicken; the platform's
  `packages/ui/src/cast.ts` names the keys): the same two characters and the chicken, never
  a new design. A banner is a picture with a key (`hud/banners/<key>.png`, a `default` that
  is the house one), and `pnpm hud:banner <key> <file>` adds one at the right size.
- [ ] **T6 (fable): the moment.** `moment` handled in the runtime. The chat line always,
  through the brand's prefix, so a player without the addon loses nothing. Then, when the
  HUD is on: a slim toast for everybody (who, what, tinted by tier), and for the person it
  is about a card that turns over. **The timing rule**, with a table test on the fake clock:
  the moment is due `inMs` after it arrived; a card needs a stretch of nobody playing long
  enough to finish, so if the service says there is one it plays now, and if there is not
  (a round is live, or the freeze is nearly over, or the mode's freeze is too short) the
  toast and the line go out at the due time and the card waits for the next such stretch,
  and is dropped after a cap or at a map change. A card on screen when the freeze ends is
  put away at once. Two moments for one player queue; toasts stack to a small number. A
  person who has left gets nothing and nothing waits for them. One stock sound for the
  person, louder with the tier (find the game's own item-reveal sound events in the node's
  files and name them in the decision; no sound file ships in the addon).
- [ ] **T7: the card and its pictures.** The layout and styles for T6. The turn is a
  `transition` (Findings). The card yields to the buy menu and the scoreboard in CSS
  (`HUD_BUYMENU_VISIBLE`, `HUD_SCOREBOARD_VISIBLE`), and never sits on the radar, the kill
  feed, the win panel or the chat. Art: the platform's house drop pictures
  (`/root/ezpug/packages/ui/public/drops/`, 26 keys including four `category-*` and
  `empty`) baked in under their own keys, so a template item shows its real picture and
  anything else shows its category's. Four tiers (`common`, `uncommon`, `rare`,
  `legendary`) as tints. `observable` set so a spectator sees what the watched player sees,
  if a check on the dev node shows it does what the entity's description says.
- [ ] **T8 (effort: medium): the mode's own words.** `Gamemode` gains the helpers a mode
  author would reach for (a toast to one player or all, localized like `Say`), on top of T3
  and nothing else; `powerup-dm`'s peek countdown stays on the centre panel. `docs/sdk.md`
  gains the HUD section with the rules a mode must not break.
- [ ] **T9 (checkpoint): the lane, both ways.** Two rows on the dev node behind the lock.
  **Off:** a puppeted match with no `EZPUG_HUD_ADDON`: the boot log, `meta list` and the
  hello are today's; a `moment` prints its line. **On:** the same match with the id set and
  `hud: true`: MultiAddonManager is loaded, the client list holds the id while the match is
  assigned and is empty after release, the layouts exist as entities with the state a
  welcome and a `moment` leave behind (read the networked vectors back), and nothing remains
  after release. Publish the addon from `hud/dist/`. The extended tier green at this sha.
- [ ] **T10 (effort: medium): Dathost.** Refresh the template, `--check` green, and one
  short server with the id set: it boots, the plugin loads, a clone of the template carries
  it. One server-hour at most. If the template cannot carry a second Metamod plugin, say
  why and leave the HUD a node-only feature for now.
- [ ] **T11 (effort: medium): the books and the look list.** `docs/hud.md`: what each of
  the three switches stops and how fast (the request's `hud`, `EZPUG_HUD_ADDON`, and
  `mm_remove_client_addon` on a live server as an RCON preset the platform can offer), the
  drill after a CS2 update (what to check before an evening, in what order), how to rebuild,
  republish and add a banner, how to delete the build volume, and **the look list**: the
  steps for one person with a real client to confirm what no test saw (the first join's
  loading screen and how long it adds, the welcome at 16:9 and 4:3, the card against the buy
  menu, the toast against the kill feed, a spectator's view, a demo and GOTV, a second join
  after the cache). `docs/pins.md`, `docs/operations.md`, `docs/match-api.md`, the README's
  map of the repo. `/root/ezpug/references/cs2-custom-hud.md` is the platform's file; send
  corrections to it in the closing note rather than editing it.
- [ ] **T12 (effort: medium): PRD-06 T5.** The manifests in the platform's voice, as
  `ralph/PRD-06-rush.md:164` describes it; tick it there too.

## Working rules

- **Production is `./scripts/deploy.sh` and nothing else**: the box's `docker` shim
  refuses `-p ezpug-iron` and `-f compose.prod.yaml` outside it with exit 125.
- **Nothing in this round sets `EZPUG_HUD_ADDON` in production.** The deploy carries the
  code; the owner turns it on after the look list.
- **No input capture, anywhere.** A call to `SetInputCaptureEnabled` in this repo is a
  failing test.
- **The CS2 lane is shared with the platform loops**: the lane lock as the page says,
  release after the server has left the fleet, never across a task boundary.
- **The game's files stay the game's.** The Windows build, the tools depot and anything
  read out of `pak01_dir.vpk` live in the build volume and are never copied into the repo.
  What is committed is our own source and our own compiled output.
- **The art is the platform's.** Cast and drop pictures are copied from `/root/ezpug` as
  they are; a new picture is the platform's `scripts/cast-art.mjs`, never drawn here.
- **This repo is public.** Nothing about the Steam account, its session or the Workshop
  item's owner goes into a commit, a log line or a progress line.
- **Additive contract, released with a changelog line**, never a service tag.
- **Commit only your own paths.** Never `git add -A`.
- **Secrets**: RCON and join passwords, GSLTs and tokens live only in gitignored env
  files, the token store, process memory or `~/.npmrc`; fixtures are scrubbed.

## When the PRD is complete

Every box ticked, `pnpm verify` and the extended tier green, the release on Verdaccio, the
addon published, and a closing note at the end of this file for the platform and the owner:
the version to pin, the Workshop id, whether Wine did the compile or the fallback did, what
a first join costs as far as a log can say, every item on the look list, and anything in
`/root/ezpug/references/cs2-custom-hud.md` that turned out wrong.
