# The HUD

EZPug's in-game HUD is a CS2 `custom_hud_layout`: Panorama panels whose layout lives
on the player's machine and whose state (a class on a panel, a string variable) the
server sets. The layout reaches a client as a **Workshop addon**, so the HUD has a
client half, and this repo builds and publishes it. `ralph/PRD-07-hud.md` is the round
that made it; its Findings are the reading list.

This page covers the client half (where the sources are, how they become the addon, and
how the addon reaches Steam) and the server half: MultiAddonManager, which hands the
addon to a client, and the SDK's `Hud`, which draws. What the HUD is for and what it may
never do is decision 34 in `docs/decisions.md`. The layouts themselves and the three
switches written out for an operator come with the round's later tasks.

## The sources

`hud/` (`@ezpug/hud`) is laid out for the people who edit it. `hud/src/addon.ts` maps it
onto the addon:

| In `hud/` | In the addon |
| --------- | ------------ |
| `addoninfo.txt` | `addoninfo.txt` |
| `layout/ezpug_<name>.xml` | `panorama/layout/custom_game/ezpug_<name>.xml` |
| `styles/ezpug_<name>.css` | `panorama/styles/custom_game/ezpug_<name>.css` |
| `images/<path>.png` | `panorama/images/custom_game/ezpug/<path>.png`, plus a generated `.vtex` (BGRA8888) beside it |
| `banners/<key>.png` | `panorama/images/custom_game/ezpug/banners/<key>.png`, the same way |

The server names a layout by its **source** path with the extension
(`panorama/layout/custom_game/ezpug_welcome.xml`). A layout includes its stylesheet by the
**compiled** name (`s2r://…/ezpug_welcome.vcss_c`), and a stylesheet references a picture
the same way (`s2r://…/cast/hello.vtex`). Every name is `ezpug_`-prefixed or under `ezpug/`,
because a client mounts other servers' addons into the same `custom_game` folders.

`hud/test/addon.test.ts` turns the authoring rules into tests. A client breaks every one
of them silently, so a test is the only place anyone will see it fail:

- the root panel has no `id`;
- there is no inline `style`, no `<Image>` (pictures are backgrounds), no script, and
  nothing with `hittest="true"`;
- `@keyframes` names are quoted, and no keyframes animate `transform`;
- no selector has a comma in it, and every property is on a list in the test, each one
  looked up in the client's own (`dump_panorama_css_properties`, panorama-hud's reference);
- every stylesheet a layout includes and every picture a stylesheet names is in the addon.

**A clean compile proves nothing about the CSS.** Valve's compiler took a stylesheet with
`bogus-property: 3px`, `box-shadow: none` and a comma selector and said
`OK: 1 compiled, 0 failed` (tried on 2026-10-02). The client is what refuses them, by
dropping the rule or the whole layout without a word, which is why the list exists.

Biome skips `hud/styles/`, because Panorama CSS is Valve's dialect and the compiler is
the authority on it.

### The pictures a client asks for by key

Nothing can put a picture on a HUD at runtime, so a client names one by **key**, and a key
is a file in one of two folders:

| In `hud/` | A key for | The key every unknown one falls back to |
| --------- | --------- | --------------------------------------- |
| `banners/<key>.png` | the welcome's banner (`branding.banner` on a request) | `default`, the house banner |
| `art/<key>.png` | a moment's picture (`art` on a `moment`) | `empty`, the platform's empty card sleeve |

`pnpm hud:keys` writes the two lists into the contract
(`packages/match-api/src/resources/hud-keys.ts`, exported as `HUD_BANNER_KEYS` and
`HUD_ART_KEYS`), and `hud/test/keys.test.ts` fails when that file and the folders
disagree. A key is kebab-case, because it travels in the contract's grammar. Adding a
picture is therefore a change to `@ezpug/match-api` and needs a release
(`docs/match-api.md`, "Versioning and releases").

`art/` holds the platform's 26 house drop pictures under the platform's own keys
(`/root/ezpug/packages/ui/public/drops/<key>.webp`, the 1× files, converted to PNG with
`convert <key>.webp -strip png32:<key>.png` and not otherwise touched): 21 items, the four
`category-*` and `empty`. It is in the tree for the contract's list and is **not in the
addon yet**; the moment's card maps it (PRD-07 T7).

`banners/` is in the addon. Every banner is 800 × 450, the welcome's banner box (400 × 225)
at twice its size, and a test holds every file to it. `banners/default.png` is the house
banner: the cast's hello picture (`/root/ezpug/packages/ui/public/cast/hello@full.webp`,
the two mascots and the chicken), fitted whole and centred on a transparent canvas by the
same command anybody uses to add one:

```
pnpm hud:banner <key> <file>    fit <file> to 800 × 450 as hud/banners/<key>.png, then hud:keys
```

It uses ImageMagick's `convert` from the box, writes no metadata (the same picture is the
same bytes), and then runs `pnpm hud:keys`, which writes the contract's list **and**
`hud/styles/ezpug_banners.css`: one rule per key that puts the picture on the banner's box
when the welcome carries the class `banner-<key>`. A new key is a release of
`@ezpug/match-api` (the list) and of the addon (`pnpm hud:build`, `pnpm hud:publish`).
Until the addon a client holds has the picture, the class names no rule there and the
client draws the house banner, which is what "an unknown key is the default picture"
means on a screen.

## Building: `pnpm hud:build`

```
pnpm hud:build            compile hud/ into hud/dist/, pack, verify, read back
pnpm hud:build --tools    fetch or update the Windows depots first
pnpm hud:verify           is hud/dist/ honest? (no compiler, no network)
```

Valve's `resourcecompiler.exe` exists only for Windows. It runs here under Wine 10.0,
headless under Xvfb, inside a build image of its own (`docker/hud/Dockerfile`,
`ezpug-iron/hud-build:dev`, Debian trixie). The box itself gains no packages. A compile
of the welcome (a layout, two stylesheets and two textures) takes about fifteen seconds.

`hud/dist/` is **committed**: building it needs Wine, 10 GB of depots and a Steam session,
and using it needs none of them. It holds:

- the compiled files, loose (`panorama/**/*.vxml_c`, `*.vcss_c`, `*.vtex_c`);
- `ezpug_hud.vpk`, the same files in one VPK v2, which is what gets published;
- `manifest.json`: the sha-256 of every source the compile read, of every file it wrote
  and of the pack, plus the compiler's own hash and the depot manifests it came from.

The build is deterministic: the same sources give the same bytes, and two builds have
been diffed to prove it. `verifyDist` (`hud/src/dist.ts`) checks that the directory is
honest. It runs on every build, before every publish, and in `pnpm verify` through
`hud/test/dist.test.ts`. A source edited without a rebuild is a red verify.

After packing, the build reads every compiled file back with ValveResourceFormat's CLI
(release `20.0`, the platform's pin, `docs/pins.md`):

- a layout and a stylesheet must decompile to their source, comments and whitespace aside;
- a texture must decode to its source picture, pixel for pixel (ImageMagick's `compare`).

The CLI's `--vpk_verify` also accepts the pack's hashes and CRCs.

### The three volumes

| Volume | Mounted at | Holds | Size |
| ------ | ---------- | ----- | ---- |
| `ezpug-iron-hud-build` | `/build` | depot 2347771 (the Windows binaries, 7.3 GB) and 2347779 (the Workshop Tools, 2.0 GB) of app 730, and the compiler's scratch tree | 9.2 GB |
| `ezpug-iron-hud-steam` | `/serverdata/Steam` | the Steam session (see below) | 1.5 MB |
| `ezpug-iron-cs2_cs2-data` | `/cs2`, **read-only** | the dev node's install. Its common content (depot 2347770, 65 GB) is what the compiler reads instead of a second copy | (the node's) |

Nothing is written to the node's volume. The build image is local only, and `pnpm hud:build`
rebuilds it whenever it runs.

### What Wine needed

The approach is `cs2-workshop-publisher`'s (`/root/ezpug/references/cs2-custom-hud/`).
Its README says the Wine step was never proven end to end. It works, after these changes:

1. **No full Windows install.** The publisher fetches all of app 730 for Windows, about
   60 GB. Here only the two Windows depots are fetched, and the 65 GB of common content
   comes from the node.
2. **An overlay, not symlinks.** The compiler's tree is an overlayfs mount: the Workshop
   Tools over the Windows binaries over the node's install, with writes going to the
   build volume. A symlink farm fails because the engine's file system refuses every
   symlink, though Wine itself follows them. A symlinked VPK is "Failed to load file
   (invalid)", and a symlinked `gameinfo.gi` "can't be read". Hard links cannot cross
   into the node's volume. Mounting the overlay is why the compile container, and only
   it, runs with `--cap-add SYS_ADMIN --security-opt apparmor=unconfined`.
3. **`vpk.signatures` is hidden.** The file comes with the common content, so it is the
   node's. The node's install was a CS2 update behind the public build (buildid 25472966
   against 25640462 on 2026-10-01), so its signature list vouched for none of the
   current Windows `shaders_pc` VPKs. The compiler stopped at
   `shaders_pc.vpk: Failed to load file (invalid)`. With the list hidden, it reads the
   common content only to resolve references. What it writes is in its own format, the
   current one, which is what clients run.
4. **`download_depot` ignores `force_install_dir`.** It always writes into SteamCMD's own
   `linux32/steamapps/content`, so the build image links that directory to the build
   volume.
5. **The compiler does not create its output folders.** Without them it prints "Failed to
   write" and still exits 0. The build creates every folder first. It also counts a
   compile as done only when it sees the compiler's `OK: 1 compiled, 0 failed` *and* the
   file on disk.
6. **The game's own `gameinfo.gi`.** The node's copy has Metamod's loader line
   (`docker/cs2/entrypoint.sh`). The compiler gets the line removed, in the overlay's
   upper layer.
7. **A VPK writer of our own** (`hud/src/vpk.ts`, after the publisher's `vpk.py`, MIT).
   Neither Windows depot ships Valve's `vpk.exe`. The pack is a single file with no
   signature section, like the publisher's.

Wine also prints a few `out of memory for allocation` lines on every run. They are noise:
every compile still finishes and reads back.

### The Steam session

The account that fetches the depots and owns the Workshop item was logged in by hand once,
on 2026-10-01, into the volume `ezpug-iron-hud-steam`. SteamCMD there answers "Logging in
using cached credentials". The account's name is `EZPUG_HUD_STEAM_USER` in `.env`
(gitignored, mode 600). It reaches the container as an environment value passed by name,
never on a command line. Nothing in a log line, a commit or `.cache/` names the account
or its SteamID: the container redacts SteamCMD's transcript before handing it out.

**When the session expires**, `pnpm hud:build --tools` and `pnpm hud:publish` stop with
"Steam wants a password or a Steam Guard code". Logging in again is a human step, because
the Steam Guard code goes to the owner's mailbox:

```
docker run --rm -it --user steam -v ezpug-iron-hud-steam:/serverdata/Steam --entrypoint /opt/steamcmd/steamcmd.sh \
  ezpug-iron/hud-build:dev +login "<the account>" +quit
```

## Publishing: `pnpm hud:publish`

This uploads `hud/dist/ezpug_hud.vpk` to the one Workshop item that `hud/workshop.json`
names: **3811574606**, titled "EZPug HUD", with a description in German and English, and
`unlisted`.

- **Only what is committed.** A dirty tree (`git status --porcelain`, untracked files
  included) is refused, and so is a `hud/dist/` that fails `verifyDist`. The change note
  is the commit's short sha and subject. `pnpm hud:publish --dry-run` does all of this
  and prints the item VDF without going near Steam.
- **Under the name a client mounts.** The pack is uploaded as `<id>.vpk`.
  MultiAddonManager looks for `<id>/<id>_dir.vpk`, then `<id>/<id>.vpk`
  (`src/multiaddonmanager.cpp:425`). A run with no id in `hud/workshop.json` creates the
  item and writes the id there, even if the upload after the creation fails, so a rerun
  updates that item and never makes a second. Later runs send only the content. A title,
  description or visibility edited on the item's page is left alone.
- **No preview from here.** For app 730, SteamCMD fails every preview upload, on a new
  item and on an update alike: `clientugc.cpp (2069) :
  k_EPublishedFileStorageSystemLegacyCloud == eStorage`, then "Failed to update workshop
  item (Failure)". The same update without a preview commits. The preview,
  `hud/images/cast/hello.png`, is set on the item's page by hand.
- **Then it checks.** It asks the Steam Web API (`GetPublishedFileDetails`, no key) what
  Steam says about the item. Then it downloads the item **anonymously** with SteamCMD,
  the way a server or a stranger's client would, and compares the bytes with
  `hud/dist/ezpug_hud.vpk`. To run the check alone: `node hud/src/cli.ts check <id>`.

### What happened on 2026-10-02

The account is a limited one: it has not spent the five dollars Steam asks for
(`ralph/PRD-07-hud.md`, Findings). Steam **did not refuse** the upload. It created the
item and committed its content, and the owner's own session downloads it byte for byte.
**Nobody else can see it.** The public API answers `result 9` (not found), an anonymous
SteamCMD gets "Download item 3811574606 failed (Access Denied)", and the item's page
shows a stranger "Error". An anonymous SteamCMD does fetch a public CS2 item
(`3084291314`, 67 MB) through the same path, so the path works. A limited account, or
a Workshop legal agreement the account has not accepted yet, are the two reasons Steam
gives for keeping an item to its owner.

The next steps are the owner's, because they happen in a browser logged in as the account
and the Steam Guard code goes to the owner's mailbox:

1. Top the account up, and accept the
   [Steam Workshop legal agreement](https://steamcommunity.com/sharedfiles/workshoplegalagreement)
   if steamcommunity.com asks.
2. On the item's page, set the preview to `hud/images/cast/hello.png` and check that
   visibility says *Unlisted*.
3. Run `node hud/src/cli.ts check 3811574606`. It should end "an anonymous SteamCMD
   fetched 3811574606 by id, byte for byte hud/dist/ezpug_hud.vpk".
4. If it still says "Access Denied", set the item to *Public* for one check. If that
   fetches, unlisted is not enough and *Public* is what the HUD needs. If it still fails,
   the account is the problem, not the visibility.

## Handing it to a client: MultiAddonManager

The addon is client-only, and the engine tells a client which addons to mount while it
connects. [MultiAddonManager](https://github.com/Source2ZE/MultiAddonManager), a Metamod
plugin, adds addons to that list: `mm_add_client_addon <id>` and
`mm_remove_client_addon <id>` change it for every client who connects afterwards. The CS2
image carries **1.6.2**, the `steamrt3` build, pinned by sha-256 (`docs/pins.md`). It
breaks on CS2 updates (client addons stopped arriving after 1.41.8.x until 1.6.1), so
nothing may depend on it.

### Asleep unless the server has an id

`EZPUG_HUD_ADDON` is the Workshop id, set per server. **Unset or empty, MultiAddonManager
is not loaded at all.** Metamod loads every `.vdf` in `addons/metamod/`, so the image
keeps the release's `multiaddonmanager.vdf` outside the overlay
(`/opt/ezpug/asleep/metamod/`), and only the binary sits in `addons/multiaddonmanager/`.
At every boot `docker/cs2/entrypoint.sh` replaces `addons/metamod/` with the image's and
copies the `.vdf` in only when the id is digits. It then logs one line:
`hud: addon <id>; MultiAddonManager loads with an empty client list`. A value that is not
a Workshop id is logged and treated as unset.

Measured on the dev node on 2026-10-02 (CS2 build 11026673, CounterStrikeSharp 1.0.376):
with the id unset, `meta list` and `path` (the search paths) were byte for byte the image
without MultiAddonManager. The boot logs differed only in timings, bot names, the
server's Steam id and one Steam performance warning. With the id set, `meta list` named
MultiAddonManager 1.6.2 beside CounterStrikeSharp, the cvars read back as in the table
below, and `mm_add_client_addon <id>` / `mm_remove_client_addon <id>` over RCON filled
and emptied `mm_client_extra_addons` on the running server.

With the id set, the plugin loads at boot and reads
`cfg/multiaddonmanager/multiaddonmanager.cfg`, which is ours
(`docker/cs2/cfg/multiaddonmanager/`):

| Setting | Ours | Why |
| ------- | ---- | --- |
| `mm_client_extra_addons` | empty | the id reaches clients only when a match asks for the HUD: `mm_add_client_addon` at assign, `mm_remove_client_addon` at release (the SDK's `Hud`, below) |
| `mm_cache_clients_with_addons` | `1` | a player who has the addon is not sent through the download handshake again on a map change or a rejoin |
| `mm_cache_clients_duration` | `0` | for the life of the server, which is one match |
| `mm_block_disconnect_messages` | `0` | blocking it suppresses the `player_disconnect` **event** for the reason "loop shutdown", not just the chat line, so MatchZy, every CounterStrikeSharp plugin and our own vocabulary would stop seeing it. Upstream believes only the addon's reconnect uses that reason, but nobody has proved it. The HUD is decoration and must not change what a server says happened. The cost is one "left the game" line per player on a first join |
| `mm_addon_connection_timeout` | `30` (upstream's) | see the next section |

Two things change on a server that has the id, with or without a match asking for the
HUD:

- **One extra map load at boot.** When the server logs on to Steam, MultiAddonManager
  reloads the map (`Host activate: Changelevel`), even with nothing to mount.
- **It takes over the handshake on a Workshop map.** Its list starts with the current
  Workshop map (`GetClientAddons`), so on a map from `host_workshop_map` the timeout
  below applies to the map's own download too.

**Loaded at boot or not at all.** The first design loaded the plugin later, from the core
plugin with `meta load`. The dev node crashed in 5 boots of 6, right after
`[MultiAddonManager] Refreshing addons ()`. On a late load the plugin takes `gpGlobals`
while the server is still idle, and the map reload it asks for when Steam comes up reads
`gpGlobals->mapname` (`ReloadMap`). Loaded at boot from its `.vdf`, it booted 5 of 5. So
a server that is already running cannot be given the plugin. Restart it with the id set.

**Dathost.** The template carries the binary and the cfg (`pnpm dathost:image`) and never
the `.vdf`. `planFiles` refuses a tree that has it, and `--check` is red if the template
does. A clone gets the `.vdf` only from the provider, at `configure`, and only when the id is
set (next section).

### The servers the orchestrator starts

`EZPUG_IRON_HUD_ADDON` is the orchestrator's one value for it, and **it is unset in
production** until the owner has walked the look list. Set, every server the orchestrator
starts from then on gets the id, each provider in the way it can
(`apps/orchestrator/src/providers/hud-addon.ts`):

| Provider | What it does with the id |
| -------- | ------------------------ |
| `nodes` | puts `EZPUG_HUD_ADDON=<id>` in the container spec, warm and cold alike, and the entrypoint above does the rest |
| `dathost` | at `configure`, before the first boot, uploads the release's `.vdf` to `addons/metamod/multiaddonmanager.vdf` on the clone and adds `"hudAddon": "<id>"` to `ezpug.json`. A clone has no entrypoint, and Metamod reads its loader files only at boot |
| `sim` | nothing: there is no game |

Unset, the container spec and the files a clone receives are what they were before the
HUD existed, and the tests compare them exactly. A value that is not a Workshop id (digits
only) stops the orchestrator at boot rather than reaching servers that would each log it
and stay off. A server that is already running keeps what it booted with: changing the
value affects only the servers started after the orchestrator restarts with it. That includes a
warm container that booted on a node before the change: it keeps its environment until it
is replaced, at the latest when its seven-day ceiling runs out (`WARM_TTL_MS`).

`pnpm cs2:up` reads `EZPUG_HUD_ADDON` itself, because the dev container is started
by hand, not by the orchestrator.

### When the download cannot finish

This is why the switch exists. It is read from `src/multiaddonmanager.cpp` at 1.6.2 and
has not been watched on a real client yet (the look list, T11).

When a client connects, the plugin hooks the server's reply (`Hook_ReplyConnection`). On
the client's first attempt it notes the time and marks the client *connecting*. It
answers with the addon list, cut down to the addons the client already has plus the
**one** it should fetch next. A client that lacks that addon downloads it and connects
again, which is the "loop shutdown" disconnect. When it comes back and the engine
admits it (`ClientConnect`), the plugin marks it *joined*, and the next addon goes out
the same way.

The only clock is `mm_addon_connection_timeout` (30 s). It is checked only **when the
client comes back**. If a client returns more than 30 s after its first attempt and is
still *connecting*, the plugin withholds the reply. On the next frame it disconnects the
client with "Required Workshop addon download was not accepted in time", and forgets the
attempt. So:

- **A download that takes longer than 30 s costs one kick.** The player connects again.
  The addon is on their disk by then, so the second attempt should go through.
- **A download that cannot finish keeps the player out.** Steam may refuse the item to
  them, which is what happens to anyone but its owner today (see "What happened on
  2026-10-02"), or the Workshop may be down. Nothing on the server times out a client
  that sits in its loading screen. What the client does then is the client's business.
  Each retry after the first 30 s is kicked with the line above, and the one after that
  starts over with the same download. **No retry gets in while the id is on the client
  list.**
- `mm_addon_connection_timeout 0` removes the kick but not the loop. Taking the id off
  the list (`mm_remove_client_addon <id>`, effective from the player's next attempt,
  because the list is rebuilt for every attempt) or starting the server without
  `EZPUG_HUD_ADDON` are the ways out. A player who retries never gets in on their own.

## Drawing it: the plugin's half

The core plugin decides once, at load, whether this server can draw a HUD
(`EZPug.Sdk.HudAddon`): it needs the addon's id (`EZPUG_HUD_ADDON` in the environment, or
`hudAddon` in `ezpug.json` on a Dathost clone) **and** MultiAddonManager's loader file at
`addons/metamod/multiaddonmanager.vdf`. An id without the file is one warning in the log
and a server that cannot.

| The server | Its `hello` | A match whose assignment says `hud` | Any other match |
| ---------- | ----------- | ----------------------------------- | --------------- |
| has no id | what it was before the HUD existed | plays as any other: no console line, no entity, nothing read | the same |
| has the id and the loader file | lists `hud` after the manifest capabilities | `mm_add_client_addon <id>` at the assignment, the layouts at the first `round_start` of each map, everything removed and `mm_remove_client_addon <id>` at the release | no console line, no entity |

`hud` on the assignment is the link protocol's word for the client's switch, which is
`branding.hud` on the request (`false` unless a request says otherwise). The orchestrator
moves it out of the branding and onto the assignment only when it is `true`, so an
assignment for a match that never asked is byte for byte what it was before the HUD
existed (`apps/orchestrator/src/link/assign.ts`, and the recorded link conversation in
`packages/protocol/fixtures/link/match.json`, which gained a command and lost nothing).

A `moment` reaches every server, whether it can draw or not. For now the plugin answers it
the way a server without a HUD always will: the line in chat when the moment is due, to
each player in their language and to the person it is about in their own words
(`GamemodeRuntime.OnMoment`, `plugins/EZPug.Sdk.Tests/MomentTests.cs`). Nothing is drawn
for one yet; the welcome below is the only layout so far.

The id goes on the client list at the assignment because a client is told what to mount
while it connects, and players connect to a match after it is assigned. Somebody already
on the server at that moment keeps playing without the addon and sees nothing, which is
what the HUD being decoration means. `ezpug_status` on a server that can draw says where
it stands (`hud: addon <id>, on, 1 layout(s) in the world`); on one that cannot, the
report has no such line.

The rules the plugin keeps (no entity before a round has started, orphans removed by
name, a slot told everything again at connect, at spawn and two seconds later, bots
skipped, everything gone at release and unload) are in `docs/sdk.md`, "The HUD", and
`plugins/EZPug.Sdk.Tests/HudTests.cs` has a test for each. Every entity of ours carries
the targetname `ezpug_hud`, which is how a later load of the plugin finds what an earlier
one left behind.

Measured on the dev node on 2026-10-02 (CS2 1.41.8.2, CounterStrikeSharp 1.0.376), with
a throwaway console command calling the world's verbs on a server booted with the id:

- the entity spawns from its keyvalues and reads back its name, its layout path and 64
  slot states;
- a class and a string for everybody land in its global state, and a bot is told nothing;
- it **survives `mp_restartgame`**, so the layouts are made once per map and not per
  round;
- removal by name takes entities the plugin had no record of (three of one layout, two of
  them unremembered, all gone);
- a map change takes whatever was standing, and nothing crashed.

No client was connected, so nothing here says a layout was *drawn*. That is the look list.

### The welcome

The first layout (`hud/layout/ezpug_welcome.xml`, driven by `EZPug.Sdk.Welcome`) is the
connect card, drawn. Somebody who joins while nobody is playing sees a card slide in at the
right edge, below the kill feed: the banner, "Willkommen bei" / "Welcome to" and the
event's name (or EZPug), the request's tagline (or the house line, "PUGs für die
SaarLAN-Community"), the team they play for, the one thing to do, and `ezpug.com`, each in
the language of their roster profile. After eight seconds (`Welcome.CardMs`) it shrinks
into a small mark (the cast's hello picture, the event's name, `ezpug.com`) for the rest of
warmup. The marks go at the first round start that is not warmup, and everything goes the
instant somebody is playing. The whole layout steps aside, in CSS, for the buy menu, the
scoreboard, the team intro, the win panel and the end of the match.

**One card, never two.** The welcome is asked at the moment the centre card would be
printed, two seconds after the connect, and the centre card is printed only when it says
no:

| The player | What they get |
| ---------- | ------------- |
| joins a match with the HUD on, in warmup, before any round, or in a stretch of nobody playing at least eight seconds long | the welcome, and no centre card |
| joins a match with the HUD on while a round is played, or in a freeze with less than eight seconds left | the centre card, as before the HUD |
| was already on the server when the match was assigned | the centre card: they connected before the addon was handed out |
| any match with the HUD off | the centre card, unchanged |

The welcome says nothing that is not also in chat or on the centre card's lines: the team
line and the rating greeting go out as before, and the event's name is the chat prefix.

## Deleting it

```
docker volume rm ezpug-iron-hud-build        # the depots and the scratch tree, 9.2 GB
docker image rm ezpug-iron/hud-build:dev     # the build image
rm -rf .cache/hud                            # staged sources, compile logs, the last publish's files
```

The next `pnpm hud:build` fetches the depots again. Keep `ezpug-iron-hud-steam` unless
the account is retired: deleting it means a human logs in again. Never
`docker volume prune`: it would take the node's game install and the databases' volumes
with it.

## Open on purpose

These are questions only a real client can answer:

- whether a retail client mounts Panorama from a **packed** Workshop VPK.
  `PanoramaLayout`'s retest notes report a "hard stop" for packed VPKs on 2026-08-26, and
  cs2-ui-kit ships its addon that way on 2026-09-23;
- whether a client wants a signature section in an addon VPK.
