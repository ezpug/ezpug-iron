# The HUD

EZPug's in-game HUD is a CS2 `custom_hud_layout`: Panorama panels whose layout lives
on the player's machine and whose state (a class on a panel, a string variable) the
server sets. The layout reaches a client as a **Workshop addon**, so the HUD has a
client half, and this repo builds and publishes it. `ralph/PRD-07-hud.md` is the round
that made it; its Findings are the reading list.

This page starts with what an operator needs on an evening: the three switches that turn
the HUD off, and the drill after a CS2 update. Then it covers the client half (where the
sources are, how they become the addon, and how the addon reaches Steam) and the server
half: MultiAddonManager, which hands the addon to a client, and the SDK's `Hud`, which
draws. What the HUD is for and what it may never do is decision 34 in
`docs/decisions.md`. The two layouts, the welcome and the moment, are at the end of the
server half. **The look list**, at the end, is what no test has seen: the steps for one
person with a real client.

**Today it is off everywhere.** Production's orchestrator has no `EZPUG_IRON_HUD_ADDON`, so
no server it starts loads MultiAddonManager, and the platform sends no `branding.hud`. It
stays that way until the owner has walked the look list.

## The three switches

Any one of them is enough to keep the HUD off. Each is a different person's hand:

| Switch | Whose | What it stops | How fast | What it leaves |
| ------ | ----- | ------------- | -------- | -------------- |
| `branding.hud` on the request (`false` unless said) | the platform | the HUD for that match: no `mm_add_client_addon`, no layout, no card, no toast | the next match created without it | a match already running keeps what its request said until it is released. Its moments are still said in chat |
| `EZPUG_IRON_HUD_ADDON` on the orchestrator (unset in production) | an operator | MultiAddonManager on every server started afterwards: not loaded, nothing handed to anybody, the `hello` as before the HUD | the orchestrator's restart (`./scripts/deploy.sh up`, seconds), then each new server | servers already running keep the id they booted with until they are released. That includes **warm containers on a node**, which a later match would claim with the id still set (below) |
| `mm_client_extra_addons ""` on one live server | an admin, from the platform's RCON panel | handing the addon to anybody who connects to that server from now on | at once: the list is empty in the same RCON call | everybody who already has the addon keeps drawing it until the match is released. The plugin still draws for them |

**The first switch** is the platform's own (`docs/match-api.md`, "The HUD, from a client's
side"). It is the normal way to turn the HUD off for an evening, because it needs nobody on
this box.

**The second switch.** To turn it off in production, remove `EZPUG_IRON_HUD_ADDON` from
`.env.production` and run `./scripts/deploy.sh up`. That restarts the orchestrator, and
every server it starts from then on is a server without the HUD. Two kinds of server stay
as they were:

- A match that is running keeps its server and its HUD to the end.
- A node's warm container booted with the orchestrator's value at the time and keeps it
  until it is claimed or reaches its seven-day ceiling (`WARM_TTL_MS`). To be sure, close
  each warm row by hand: `pnpm iron servers list` shows them (provider `nodes`, no
  match), and `pnpm iron servers kill <serverId> --reason 'HUD off'` stops the container.
  The pool then warms a new one with the orchestrator's value of now.

A Dathost clone is made per match, so the next one has no `.vdf` and no `hudAddon`.

**The third switch** is for one server, while a match is on it. The usual reason is somebody
stuck in their loading screen because the addon will not download ("When the download
cannot finish", below). It is one console line, and it needs no Workshop id:

```
mm_client_extra_addons ""
```

It empties MultiAddonManager's client list, so the next connection attempt of anybody,
including the stuck player's retry, is told to mount nothing and gets in. The platform can
offer it as a preset on its RCON shelf (`packages/contracts/src/rcon-presets.ts` in the
platform): it goes through the match's `rcon` command (`docs/match-api.md`), and from this
box it is `pnpm iron matches command <matchId> rcon --command 'mm_client_extra_addons ""'`.

Measured on 2026-10-02 on the dev node (CS2 1.41.8.2, MultiAddonManager 1.6.2), through
`POST /v1/fleet/servers/:id/rcon` on a puppeted match with the HUD on, and on the dev
container with the id set:

| Line | Answer |
| ---- | ------ |
| `mm_client_extra_addons` | `mm_client_extra_addons = 3811574606` |
| `mm_client_extra_addons ""` | nothing (`""`) |
| `mm_client_extra_addons` | `mm_client_extra_addons = ` (empty) |
| `ezpug_status` | `hud: clients who connect now are handed no addon`, and still `hud: addon 3811574606, on, 2 layout(s) in the world` |
| `mm_add_client_addon 3811574606` | nothing; the list holds the id again, so the switch can be undone |
| `mm_add_client_addon 3811574606`, again | `[MultiAddonManager] Addon 3811574606 is already in the list!` |

So **the line itself answers nothing**: a preset should read `mm_client_extra_addons` back
after it and show that answer. `mm_remove_client_addon 3811574606` does the same, but
needs the id. Both are harmless to repeat. On a server without MultiAddonManager either
answers `Unknown command`, which is also harmless. At the release, the plugin's own
`mm_remove_client_addon` finds nothing to remove, and the puppeted match above went on to
`completed` with its ledger row closed.

What the third switch does **not** do: take a layout off a screen that already draws it.
Nothing typed into a live server does that. The match's release does, and the next match's
request decides again. That is acceptable because everything on the HUD is also said in
chat, and a card only ever plays while nobody is playing.

## The drill after a CS2 update

Valve ships, Dathost updates its servers within hours, and the dev node does not move
until somebody runs `pnpm cs2:install`. MultiAddonManager has broken on a CS2 update
before (client addons stopped arriving after 1.41.8.x until its 1.6.1), and so has the
template's `gameinfo.gi` (2026-09-30, `docs/operations.md`, "The template server"). Before
an evening that uses the HUD, in this order:

1. **The rented side boots at all.** `pnpm dathost:image --check`. If it is red, run
   `pnpm dathost:image` before anything else: a template whose clones cannot boot fails
   every Dathost match after a three-minute deadline, with or without the HUD, and nothing
   in the orchestrator's health notices.
2. **The dev node is on the same game.** `pnpm cs2:status` names the installed build. If it
   trails what Dathost boots, run `pnpm cs2:install` with the lane free. Until then the lane
   proves the plugins on a game production no longer runs.
3. **The plugins load.** The lane's `retakes` row first: it is the canary for a CS2 update
   that outran CounterStrikeSharp (exit 139 is a segfault). Then `hud-off` from the matrix,
   then `hud-on` inside a hold of the lane ("The lane, both ways", below). `hud-on` is the
   one that says MultiAddonManager loaded and holds the id.
4. **MultiAddonManager upstream.** Read its releases and open issues for the build. A new
   release is a pin bump (`docs/pins.md`: version and sha-256 in `docker/cs2/Dockerfile`,
   `node scripts/check-pins.mjs`, part of `pnpm lint`), a rebuilt image, and step 1 again.
5. **The addon on a client.** Whether a client still downloads and draws the addon is a
   person's to see: the look list's first two steps, on one server, before the evening.
6. **If anything above is red or nobody could look:** leave the HUD off for the evening
   (the platform's switch, or the second switch). A match without it loses nothing it needs.

The addon itself does not have to be rebuilt after an update unless step 5 shows it broken.
Then: `pnpm hud:build --tools` (new depots), `pnpm hud:build`, commit, `pnpm hud:publish`,
and wait for the check ("Changing it", below).

## Changing it

| To | Do |
| -- | -- |
| change a layout, a stylesheet or a picture | edit `hud/`, then `pnpm hud:build` (about a minute and a half), commit `hud/` with `hud/dist/`, then `pnpm hud:publish` from the clean tree |
| add a banner | `pnpm hud:banner <key> <file>` ("The pictures a client asks for by key"), then the same build, commit and publish, **and** a release of `@ezpug/match-api` for the new key in `HUD_BANNER_KEYS` |
| republish without a change | `pnpm hud:publish` refuses nothing for that, but Steam serves the revision before for most of an hour |
| know the republish is live | `node hud/src/cli.ts check 3811574606` until it prints the "byte for byte" line ("What happened on 2026-10-02") |
| fetch new compiler depots | `pnpm hud:build --tools` |
| delete what the compiler needs | "Deleting it", at the end |

**A changed layout needs every player's client restarted.** A client that mounted the
revision before keeps it until the game restarts, and a server driving the new layout's
names draws nothing there. Publish before an evening, not during one.

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
| `art/<key>.png` | `panorama/images/custom_game/ezpug/art/<key>.png`, the same way |

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
- every stylesheet a layout includes and every picture a stylesheet names is in the addon;
- a layout and the stylesheets it includes name the same `ezpug-` classes: one the layout
  carries and no rule styles, or a rule for one no panel carries, is a typo.

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
`category-*` and `empty`. So a drop pressed from a template shows its own picture, and the
platform names the category's for anything else. Each is at most 384 pixels a side, which
is the card's picture box (150 × 150) on a 4K screen with room to spare, and they are
what makes the pack 8.4 MB: a picture in a custom HUD has to be uncompressed (BGRA8888).
`pnpm hud:keys` writes `hud/styles/ezpug_art.css` from the folder, one rule per key that
puts the picture on the card's picture box when the card carries the class `art-<key>`,
the way a banner's class works on the welcome. `hud/test/art.test.ts` fails when the file
and the folder disagree.

`banners/` is in the addon. Every banner is 800 × 450, the welcome's banner box (400 × 225)
at twice its size, and a test holds every file to it. `banners/default.png` is the house
banner: the cast's hello picture (`/root/ezpug/packages/ui/public/cast/hello@full.webp`,
the two mascots and the chicken), fitted whole and centred on a transparent canvas by the
same command anybody uses to add one:

```
pnpm hud:banner <key> <file>    fit <file> to 800 × 450 as hud/banners/<key>.png, then hud:keys
```

It uses ImageMagick's `convert` from the box, writes no metadata (the same picture is the
same bytes), and then runs `pnpm hud:keys`, which writes the contract's list, the art's
stylesheet above **and** `hud/styles/ezpug_banners.css`: one rule per key that puts the picture on the banner's box
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
of everything (two layouts, four stylesheets and 28 textures) takes about a minute and a
half, most of it Wine starting once per file.

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
| `ezpug-iron-hud-build` | `/build` | depot 2347771 (the Windows binaries, 7.3 GB) and 2347779 (the Workshop Tools, 2.0 GB) of app 730, the compiler's scratch tree, and `reference/`, the game's own Panorama stylesheets decompiled for reading (2 MB) | 9.2 GB |
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
  Steam says about the item, which for this unlisted item is `result 9` whatever is true
  of it. Then it downloads the item **anonymously** with SteamCMD, the way a server or a
  stranger's client would, and compares the bytes with `hud/dist/ezpug_hud.vpk`: that is
  the test. To run the check alone: `node hud/src/cli.ts check <id>`. **Right after an
  upload it fails**, because Steam goes on serving the revision before for most of an
  hour (below); run it again later.

### What happened on 2026-10-02

**The first upload** (PRD-07 T1). The account is a limited one: it has not spent the five
dollars Steam asks for (`ralph/PRD-07-hud.md`, Findings). Steam **did not refuse** the
upload. It created the item and committed its content, and the owner's own session
downloaded it byte for byte. **Nobody else could see it**: the public API answered
`result 9` (not found), an anonymous SteamCMD got "Download item 3811574606 failed
(Access Denied)", and the item's page showed a stranger "Error". An anonymous SteamCMD
did fetch a public CS2 item (`3084291314`, 67 MB) through the same path, so the path
works. A limited account, or a Workshop legal agreement the account has not accepted
yet, are the two reasons Steam gives for keeping an item to its owner.

**Later the same day** (PRD-07 T9), with nothing done from this box in between:

- **An anonymous SteamCMD fetches the item by id.** `node hud/src/cli.ts check 3811574606`
  downloaded it "Connecting anonymously to Steam Public", 409,967 bytes, byte for byte
  the first upload's pack (`b44bf8fa…`, commit `e3d0c64`). So an unlisted item is enough
  for a client who is told the id, and whatever kept the first upload to its owner did
  not last. The public Web API still answers `result 9` for it, so that API is not the
  test of whether a client can fetch it; the anonymous download is.
- **Steam serves a new revision late.** `pnpm hud:publish` uploaded
  `hud/dist/ezpug_hud.vpk` (8,422,739 bytes, `f4e428dc…`) as `3811574606.vpk` at 06:52
  CEST and SteamCMD ended "Committing update... Success.". At 06:53, at 07:33 and through
  the owner's own session at 07:36, a download still got the first upload's 409,967
  bytes. **At 07:39 an anonymous SteamCMD got today's pack, byte for byte.** Steam said
  nothing in between. The first upload went the same way (kept to its owner right after
  it was made, fetchable by anybody by the time this task looked), so what the first
  note took for a limited account's wall was most likely this delay. **A republish is
  therefore not live when `hud:publish` returns**: its own check fails for most of an
  hour, and until `node hud/src/cli.ts check 3811574606` prints the "byte for byte" line
  a client downloads the revision before, whose layouts may not be the ones the server
  drives.

`hud:publish` judged that upload a failure, because SteamCMD had put an IPC warning
between "Committing update..." and "Success." and coloured both; the verdict now strips
the colours and takes "Success." anywhere after the commit line
(`hud/test/workshop.test.ts` holds the transcript).

So the item holds what the tree holds (`hud/dist/` at `4677bf5`, change note "4ff69ef:
chore(ralph): T8 progress line"), unlisted, and anybody who is told the id can fetch it.
What is left is the owner's, in a browser logged in as the account:

1. On the item's page, set the preview to `hud/images/cast/hello.png` and check that
   visibility says *Unlisted*.
2. If a later republish never turns up in the check, the item's page is where Steam
   says why (an update waiting, a
   [legal agreement](https://steamcommunity.com/sharedfiles/workshoplegalagreement) to
   accept, the account's limit).

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

### On Dathost

Proven once, on 2026-10-02 (PRD-07 T10), on one rented server in Düsseldorf: **the
template carries a second Metamod plugin, and a clone with the id draws.** The template
was refreshed from the tree (`pnpm dathost:image`: Metamod git1469, CounterStrikeSharp
1.0.376, MultiAddonManager 1.6.2 asleep; it had been at git1411 and 1.0.373) and
`--check` is green. Then `pnpm dathost:smoke --puppets 4 --hud 3811574606` against an
orchestrator started with `EZPUG_IRON_HUD_ADDON`:

- The clone booted on the game Dathost runs today (build 11064488, the update of
  2026-09-30; the dev node is still on 11026673), with no missing signature in its
  console.
- `[MultiAddonManager] Plugin loaded successfully!`, and `meta list` named
  MultiAddonManager 1.6.2 and CounterStrikeSharp 1.0.376. So the `.vdf` the provider
  uploads at `configure` is read at the clone's first boot.
- `ezpug_status`, asked over the link: `hud: addon 3811574606, on, 2 layout(s) in the
  world`, `hud: clients who connect now are handed 3811574606`, both layouts as entities
  (the moment's observable), the welcome's strings set, 64 of 64 slots empty.
- A 2v2 of puppets readied, went live and ended (4 rounds, `series_end`, every fact
  `source.simulated`). The ledger row closed at 2 cents and the account was left as it
  was found.

**Not proven**: a client. Nobody connected, so the download, the reconnect and the picture
are the look list's on Dathost as they are on a node. The server also had no GSLT (the dev
orchestrator has no Steam key), so it would have taken LAN connections only.

**How it was run.** Production must not have the id, and a clone in a datacentre has to
reach the orchestrator that started it. So the run used the **dev** orchestrator, inside a
hold of the CS2 lane: restarted with `EZPUG_IRON_PROVIDERS=sim,nodes,dathost`,
`EZPUG_IRON_HUD_ADDON=<id>` and `EZPUG_IRON_PUBLIC_URL` set to a throwaway HTTPS tunnel to
port 3430 (a Cloudflare quick tunnel in a container, removed afterwards), the smoke pointed
at `http://localhost:3430`, then the orchestrator restarted without the three values before
the lane was released. The dev deployment's tag is not production's, so production's reaper
never saw the clone. `docs/operations.md`, "The live smoke", has the flag.

**What the first attempt found.** The first clone died in its first second, and not because
of the HUD: the template still carried the `gameinfo.gi` from before the CS2 update of
2026-09-30, which no longer fits the game (`docs/operations.md`, "The template server").
Any clone made since that update died the same way, production's included: its ledger
holds three `failed` Dathost rows from 2026-10-01 and 2026-10-02, each the three minutes
of a boot deadline, where every row before the update was `released`.
`dathost-image` now rebuilds the file from the game's own, and `--check` is red when it
moves. **This belongs in the drill after a CS2 update.**

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
- `mm_addon_connection_timeout 0` removes the kick but not the loop. Emptying the list
  (the third switch, `mm_client_extra_addons ""`, or `mm_remove_client_addon <id>`,
  effective from the player's next attempt, because the list is rebuilt for every
  attempt) or starting the server without `EZPUG_HUD_ADDON` are the ways out. A player
  who retries never gets in on their own.

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

A `moment` reaches every server, whether it can draw or not, and every server says its
line in chat when it is due. What a server that can draw does on top of that is "The
moment", below.

The id goes on the client list at the assignment because a client is told what to mount
while it connects, and players connect to a match after it is assigned. Somebody already
on the server at that moment keeps playing without the addon and sees nothing, which is
what the HUD being decoration means. `ezpug_status` on a server that can draw says where
it stands and what it holds ("What the server holds", below); on one that cannot, the
report has no such line.

The rules the plugin keeps (no entity before a round has started, orphans removed by
name, layouts that went with the map before made again, a slot told everything again at
connect, at spawn and two seconds later, bots skipped, everything gone at release and
unload) are in `docs/sdk.md`, "The HUD", and `plugins/EZPug.Sdk.Tests/HudTests.cs` has a
test for each. Every entity of ours carries the targetname `ezpug_hud`, which is how a
later load of the plugin finds what an earlier one left behind.

### What the server holds

`ezpug_status` (the fleet's RCON route runs it, the fleet's console route reads it) says
three things about the HUD on a server that can draw one, the last two **read back** and
not remembered:

```
hud: addon 3811574606, on, 2 layout(s) in the world
hud: clients who connect now are handed 3811574606
hud: layout panorama/layout/custom_game/ezpug_moment.xml is entity 371, observable, 64 slot(s); panels [moment_toast_1, moment_toast_2], classes [tier-common, tier-uncommon, tier-rare, tier-legendary], strings []
hud:   everybody, moment_toast_1: +tier-common -tier-uncommon -tier-rare -tier-legendary
hud:   everybody, moment_toast_2: -tier-common -tier-uncommon +tier-rare -tier-legendary
hud:   64 of 64 slot(s) hold nothing
hud: layout panorama/layout/custom_game/ezpug_welcome.xml is entity 370, 64 slot(s); panels [welcome_title, welcome_mark_title, welcome_url, welcome_mark_url], classes [], strings [text]
hud:   everybody, welcome_title: {s:text}="iron-match"
…
```

- The first line is what the SDK believes: on or off for this match, and whether a round
  start has made the layouts.
- The second is MultiAddonManager's own `mm_client_extra_addons`: what a client who
  connects **now** is told to mount. This is the line to look at after
  `mm_remove_client_addon <id>` on a live server ("no addon"), and it says
  "does not answer" when the Metamod plugin is not there.
- The rest is every `custom_hud_layout` named `ezpug_hud`, off the entity
  (`CounterStrikeWorld.ReadHudLayouts`): its path, `observable`, the entity's three
  tables of names (the engine networks a panel, a class and a variable as an index into
  them), everybody's state, and each slot that holds anything. `+` is "has the class",
  `-` "does not", `?` "was told once and says nothing now". A slot that took the mouse
  would be one loud line; nothing of ours can ask for that. "No layout of ours is in the
  world" while the first line says they are is the report catching the SDK out, which
  is how the map-change rule above was found.

CounterStrikeSharp's `NetworkedVector` hands out elements for entity handles only
("Networked vectors currently only support CHandle<T>"), so the read walks them itself:
the vector's count and first element from CounterStrikeSharp's own natives, the stride
from the schema's class size, a string as one pointer. It writes nothing and runs only
when somebody asks for the status.

### The lane, both ways

Two rows of the CS2 lane (`apps/orchestrator/src/cs2.extended.test.ts`,
`docs/operations.md`, "The `EZPUG_CS2_TESTS` lane") play the same puppeted 1v1 pug with
`branding.hud: true` and two `moment`s, and hold the server to its own account: the
status above, the engine's own answers to `meta list` and `mm_client_extra_addons` through
`POST /v1/fleet/servers/:id/rcon` (asked at the same moment), and the container's whole
console, which `iron-match --console` keeps.

| Row | The server | What it is held to |
| --- | ---------- | ------------------ |
| `hud-off`, in the matrix | no `EZPUG_HUD_ADDON`: what production runs | the hello names no `hud`; `meta list` answers `Listing 1 plugin:` (CounterStrikeSharp) and `mm_client_extra_addons` is an unknown command; not one `hud:` or MultiAddonManager line in the whole console; the status says nothing about a HUD; both moments `applied` |
| `hud-on`, by name only | has the id | the hello names `hud`; `meta list` answers `Listing 2 plugins:` with MultiAddonManager, and its "Plugin loaded successfully!" is in the console; `mm_client_extra_addons` holds the id while the match is assigned, and the status says clients are handed it; both layouts are entities, the moment's `observable` and the welcome's not; a toast row tinted `tier-rare` and one `tier-common` for everybody, which is what the two moments left; every slot holds nothing and nobody's mouse is taken |

Three more rows (PRD-08 T6) send the unboxing the way the platform does: `iron-match
--unbox` waits for a `round_start` on the stream and tells a drop about the first rostered
player with a four-item reel in that instant, reads `ezpug_status` 5 s into the round and
again 21 s in, and times every console line of the unboxing against the round start. No
fact marks a freeze's end, so the server's own reading of what is left of it is said with
the call (`hud: unboxing for <id> (FreezeTime, <n> ms left), …`), and the row puts the end
there. Every player is a puppet, so nobody watches (`0 watching`) and no slot is told a
beat; what the rows hold the server to is its console, one line a beat on the SDK's clock,
and the reel laid out for everybody.

| Row | The server | What it is held to |
| --- | ---------- | ------------------ |
| `unbox`, by name only, timescale 1 | has the id; MatchZy's `live.cfg` freeze (the lane's 5 s is not sent) | the drop `applied`; the call with at least 13.5 s of freeze left, the reel 2 s after it, the prize (`legendary`) at 8 s, put away "its prize was shown" at 12 s, each within 0.75 s, and before the freeze ends; no line "without its reel"; inside the reel, everybody's 36 slots dressed, slot 33 `+tier-legendary +art-big-jersey`, `unbox` tinted and named; no toast; every slot holds nothing and nobody's mouse is taken |
| `unbox-short`, by name only | has the id; Rush at the lane's time scale | one line, "no stretch fits the unboxing … 13500 ms wanted; it is shown without its reel"; a toast row tinted `tier-legendary` for everybody; no slot of the reel dressed |
| `unbox-off`, in the matrix, timescale 1 | no id | the drop `applied`; not one line of an unboxing, no `hud:` line in the status or the console |

Played on 2026-10-04 on the dev node (image with T6's console lines, orchestrator at
`e067a28` and this task's rows). `unbox`: the drop reached the server 148 ms after the
round start reached the stream, which said 17 805 ms of freeze left; then the reel at
+2 009 ms, the prize at +8 034, put away at +12 049, so 5.7 s of the freeze were spare.
Inside the reel the reel stood for everybody with the prize in slot 33 and the winner's
name, side `side-ct`. After the freeze `unbox` keeps its tint, art and side for everybody
(only the difference is said for the next reel) and no slot holds anything. `unbox-short`:
"FreezeTime, 6417 ms left" (Rush's 13 s at the lane's timescale 2), the toast tinted
legendary. `unbox-off`: `applied`, and not one `hud:` line anywhere.

**The time scale is the lane's trap.** The first runs of `unbox` played at the lane's
timescale 2 and said `FreezeTime, 8847 ms left` 150 ms after the round start, and in the
lane's own 5 s freeze `2325 ms left`: the SDK reads a freeze in wall time
(`Hud.Scaled`), and at 2 a PUG's 18 s are 9, which no unboxing fits. That is not a delay
on the way: at timescale 1 the call said 17 805 ms left, so the whole trip (MatchZy's
`round_started` translated at the door, the stream, the drop back down the link) took
about 0.2 s of the freeze. So the unboxing rows that are
about a PUG's freeze play at timescale 1 and keep `live.cfg`'s freeze, as production does.

`hud-on` runs only when it is named, because the id is one value on the dev orchestrator
and every server it starts gets it. So the row is played inside a hold of the lane, with
the orchestrator restarted for it and back again before the hold ends:

1. Take the lane by hand (`takeLaneLock` from `scripts/cs2-lane-lock.mjs`, in a process
   that stays alive) and keep its token.
2. Restart the dev orchestrator with `EZPUG_IRON_HUD_ADDON=<the id in hud/workshop.json>`
   in its environment (the process environment wins over `.env`).
3. `EZPUG_CS2_LANE_TOKEN=<the token> EZPUG_CS2_TESTS=required EZPUG_CS2_CASES=hud-on pnpm --filter @ezpug/orchestrator exec vitest run src/cs2.extended.test.ts`.
   The token is how a row plays inside somebody's hold: it checks the lock on the box
   carries it, takes nothing and releases nothing (`iron-match --lock-token`).
4. Restart the dev orchestrator without the value, **then** release the lane, so no
   other loop's row ever lands on a server that has the id.

Played on 2026-10-02 (CS2 1.41.8.2, CounterStrikeSharp 1.0.376, MultiAddonManager
1.6.2), both green, and `retakes` and `mixed` after them on the same image. What they do
not say:

- **Nothing was drawn.** Every player was a puppet, and a bot has no screen, which the
  read-back shows as 64 of 64 slots holding nothing: the welcome leaves only its strings
  for everybody, and a moment only its row's tint. What one person's slot holds after a
  welcome and a card is the unit tests' (`WelcomeTests`, `MomentTests`) and the look
  list's.
- **There is no "after the release" on a node.** The orchestrator's `release` and the
  node's stop reach the container within the same second (`SIGTERM received while server
  was **not** hibernating` right behind `series_end`), so a server never says what was
  left: what remains is no container, which every row of the lane is held to. That
  `mm_remove_client_addon` empties the list and that removal by name takes the entities
  were measured on a live server in T2 and T3 (above), and `HudTests` holds the order.
- **A node's RCON answers since T9a.** Until then every line through the fleet's RCON
  route came back `""` on a node and the rows read Metamod's `[META] Loaded N plugin(s)`
  off the console. It was the orchestrator's client: CS2 tags its answer with the id of
  the newest packet it has read, and the client's end marker, written behind the command,
  arrived in the same frame (`docs/operations.md`, "The console and RCON"). So
  `mm_remove_client_addon <id>` typed into a live server is answered now, and
  `mm_client_extra_addons` after it shows the list it left.

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
scoreboard, the team intro, the win panel and the end of the match. Its transitions are
written as the `transition:` shorthand, which the client registers and the game's own
stylesheets never use (the moment's are the longhands): if the welcome appears without
sliding, that is the first thing to change.

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

### The moment

A `moment` (`docs/match-api.md`, "The HUD, from a client's side") is handled by
`EZPug.Sdk.Moments` (`Runtime.Moments`), and `plugins/EZPug.Sdk.Tests/MomentTests.cs`
holds every sentence of this section.

**The line, always.** When the moment is due, `inMs` after the command arrived, everybody
on the server reads its line in chat behind the match's prefix (`[EZPug]`, or the event's
name): each in the language of their roster entry, and the person it is about in the
words written for them. The prefix is the server's, so the client's words carry no brand
of their own. Prefix and line together are cut to one chat line of 127 code points. With
the HUD off that is all a moment is: no layout is touched and no sound plays.

**The toast**, with the HUD on: the same line as a slim strip for everybody, at the same
instant, tinted by tier. Three rows (`moment_toast_1` to `moment_toast_3`), six seconds
each. A fourth toast waits for the first row to come free, at most six wait, and one
beyond that is not drawn: its line was said. A gamemode's own toasts (`Gamemode.Toast`
and `ToastAll`, `docs/sdk.md`, "A mode's own words on the HUD") go through the same rows
and the same wait, untinted, and are a chat line first in the same way.

**The card**, for the person: it slides in face down, turns over one second later with
the sound, and is gone six seconds after it came. It is only ever shown while nobody is
playing:

| When the moment is due | The person gets |
| ---------------------- | --------------- |
| warmup, a pause standing in a freeze, halftime, the map over | the card, now |
| a freeze with at least six seconds left | the card, now |
| a decided round whose restart delay and next freeze add up to six seconds | the card, now |
| a round being played, a freeze with less than six seconds left, a mode whose freeze is too short | the toast now, and the card at the next stretch that fits: a round start, a round end, the map's end |
| before any round has started on the map | the card at the first round start |
| they are not on the server | nothing, and nothing waits for them |

A waiting card is dropped after three minutes (`Moments.CardWaitMs`, longer than a round
can run) and at a map change. A card on screen when the freeze ends is put away in that
instant; if it had not turned over yet it showed nothing and waits for the next stretch.
Two cards for one person queue, half a second apart, four at most. Somebody who leaves
takes their waiting cards with them. A person whose card plays at once gets no toast,
because the card says it.

Under Rush's 13 seconds of freeze a card has to start in the first seven; under
flying-scoutsman's five it always waits for the round to be decided; in `powerup-dm`,
which has no freeze and no round end, it waits for the map's end and is dropped long
before that. In those modes a moment is its line and its toast.

**The sound** is the game's own: `EndMatch.ItemRevealSingleLocalPlayer`, what CS2 plays at
the end of a match when the item that dropped is yours, at 0.4, 0.6, 0.8 and 1.0 of its
volume for the four tiers, to the person alone and at the card's turn. Nothing is
shipped for it. Decision 34 names the other events that were looked at.

**The names** the service sets and the layout carries (`hud/layout/ezpug_moment.xml`,
`hud/styles/ezpug_moment.css`):

| Panel or label | What is set on it |
| -------------- | ----------------- |
| `moment_toast_<n>` (1 to 3) | `shown`, per player; `tier-common`, `tier-uncommon`, `tier-rare`, `tier-legendary`, for everybody |
| `moment_toast_<n>_text` | `{s:text}`: the line, per player |
| `moment_card` | per player: `shown`, `turned`, one `tier-*`, and `art-<key>` for the picture (no class is the default picture, `empty`, and so is a key the addon has no rule for) |
| `moment_card_kind` | `{s:text}`: "Drop", "Perk", "Verlosung" / "Raffle", or the event's name for a kind the server has no word for |
| `moment_card_text` | `{s:text}`: the person's own line |

`shown` goes off and on again half a second apart, never in one frame, so a transition
started by the class always has something to start from.
`MomentTests.EveryPanelAndClassTheMomentNamesIsInTheLayout` reads every one of those
names out of the XML and the stylesheets, and another test holds each picture's class to
the generated `ezpug_art.css`.

**Where it sits.** Against the game's own HUD, read out of the game's stylesheets
(`hudradar.css`, `huddeathnotice.css`, `hudchat.css`, `hudwinpanel.css`) at 1080 lines:

| | Where | Clear of |
| - | ----- | -------- |
| the toasts | the right edge, three rows of 40 from 340 down, at most 480 wide | the kill feed (the right edge from 72 down), the welcome's mark (260 to 324), and on a 4:3 screen the win panel (400 wide, centred) |
| the card | the left edge, 460 × 180, from 400 to 580 | the radar (40 to 340), the chat (from about 610 down), the win panel |

Those stylesheets are the game's and stay out of the repo: they were decompiled with the
pinned ValveResourceFormat CLI out of the dev node's `pak01_dir.vpk` (read-only) into the
build volume, under `reference/`
(`Source2Viewer-CLI -i …/game/csgo/pak01_dir.vpk --vpk_filepath panorama/styles -d -o <the build volume>/reference`),
and go with it when it is deleted.

The toasts and the welcome's **card** (not its mark) share the right edge: somebody who
joined in the last eight seconds and is told a moment sees one on the other until the
welcome shrinks.

**What steps aside, and what does not.** The whole layout fades for the buy menu, the
scoreboard, the team intro and the end of the match, in CSS, without the server knowing.
It does **not** fade for the win panel: a decided round is where most cards play and the
win panel is up for most of it, so the card is placed clear of that panel instead. At the
end of the match the game moves its chat up into the card's place and brings its own
screen, so a card that is due then plays under it, unseen: the line was said.

**The card.** Face down it is charcoal with the cast's hello picture; face up it has the
picture on the left (150 × 150, the whole picture fitted in) and on the right the heading
and the person's line, cut with an ellipsis after about five lines. The four tiers are a
tint, on the edge of both faces and on the heading, and on a toast a bar at the row's
leading edge, in the platform's own colours for its drop card's materials:

| Tier | Tint |
| ---- | ---- |
| `common` | muted bone, `#8a8378` |
| `uncommon` | ivory, `#f0ece3` |
| `rare` | cobalt, `#86a6ff` |
| `legendary` | magenta, `#ff5ad0` |

**The turn is two transitions**, because `@keyframes` on a transform never play in a
custom HUD: the back narrows to an edge about the card's upright axis in 0.18 s and fades,
and the front widens from one in 0.22 s, delayed by those 0.18 s. Both faces are the same
size and lie on each other. They are written with the four `transition-*` longhands, the
only form the game's own stylesheets use (239 files, not one `transition:` shorthand).

**A spectator sees the watched player's moment.** The moment's entity is spawned with
the engine's `observable` key (the game's `csgo.fgd`: "Show each player's own version of
this UI to whoever is spectating them"); the welcome's is not, because "you play for…" is
said to one person. Measured on the dev node on 2026-10-02 (CS2 1.41.8.2,
CounterStrikeSharp 1.0.376, a throwaway console command on a server booted with the id):
the moment's entity read back `m_bObservable` true and the welcome's false, both with
their names, layout paths and 64 slot states. No client was connected, so what a spectator
is shown is the look list's. One thing to look for there: somebody who is dead and watching
a team-mate when their own card plays is presumably shown the team-mate's version (the
toast), not their card. What each state of the entity holds is in `ezpug_status`
("What the server holds", above).

**Put away at once** is the stylesheet's to keep, since all the server does is take
`shown` and `turned` off in the frame the freeze ends: the card's body fades in 0.12 s
whatever the slide and the faces are doing, and every transition has run back within the
half second before the next card or toast can come. `MomentTests` reads those durations
out of the stylesheet and holds them against `Moments.TurnMs`, `CardRestMs` and
`ToastRestMs`.

Nobody has seen a toast or a card, or heard the sound. The tests read the state the
entity would hold, the fake clock and the files; what it looks and sounds like, and
whether those places are as empty on a real screen as the game's stylesheets say, is the
look list's.

### The unboxing, drawn

A drop with a reel (`docs/match-api.md`, "An unboxing") is played for everybody, in a
freeze, by the last panel of the moment's layout: `#unbox` in `hud/layout/ezpug_moment.xml`,
styled by `hud/styles/ezpug_unbox.css`, whose header is the reference for every number
below. It is drawn and compiled (PRD-08 T3) and the SDK plays it ("The unboxing, played",
below). Three beats, each a class on `#unbox`, set for every person who was on the server
when it began:

| Beat | Classes | What is drawn |
| ---- | ------- | ------------- |
| the call | `shown` | a strip at the top: the cast's picture, the winner's name large and, under it, "hat einen Drop! Mal sehen…" / "got a drop! Let's see…"; below it the reel, standing still |
| the reel | `rolling` and one `land-1` … `land-4` | 36 slots slide past a marker at the window's centre, about 16 a second at first and slowing all the way, for 6 s (`cubic-bezier( 0.2, 0.65, 0.4, 1 )`, "The roll's curve" below), and stop with slot 33 under it, a little left or right of its centre |
| the reveal | `revealed`, `land-*` off | the reel settles to the centre and dims, the prize grows out of it (the game's own overshoot curve) over a burst in the tier's colour, bigger the rarer, and the line comes under it |

| Panel or label | What is set on it |
| -------------- | ----------------- |
| `unbox` | the beats above, per player; for everybody: one `tier-*` (the prize's edge and burst, drawn only once revealed); `art-<key>` for the prize's picture; `side-ct` or `side-t` for the winner's side (the name in the game's CT blue or T gold and that side's half of the cast's picture, neither being the whole picture) |
| `unbox_slot_<n>` (1 to 36) | for everybody: `art-<key>` and one `tier-*`: a decoy, and in slot 33 the prize |
| `unbox_name` | `{s:text}`, for everybody: the winner's name |
| `unbox_call` | `{s:text}`, per player: "hat einen Drop! Mal sehen…" in the reader's language |
| `unbox_line` | `{s:text}`, per player: the item's line, and the winner's own line for the winner |

The pictures are the moment's (`hud/art/`, `HUD_ART_KEYS`): `pnpm hud:keys` writes a rule
for each key on three boxes now, the card's, a slot's and the prize's, and an unknown key
is the empty sleeve in every one of them.

**Where it sits.** Top centre, 900 wide, from 140 to 448 at 1080 lines: under the team
counter (to about 120, `hudteamcounter.css`) and clear of the crosshair. At 4:3 the same
900 fit inside 1440. **It stays for the buy menu.** The game's buy menu
(`buymenu.xml`, `buymenu.css`, decompiled into the build volume's `reference/` like the
stylesheets above) fills the screen, and a custom HUD is drawn over it (cs2-ui-kit's
GOTCHAS: its panels lie on the open menu). The menu's own columns start at 180, 950 wide
and centred, and above them is only the team counter. So while the menu is open the call
and the line fade (both are said in chat) and the reel moves up and shrinks to 0.8, from
14 to 155, over the team counter's centre and clear of the columns: people keep buying and
still watch the reel stop. Nothing takes the mouse, so a click lands on the menu wherever
the reel lies. It steps aside for the scoreboard, the team intro and the end of the match,
as the moment does.

**Put away at once.** The plugin takes every class off in the frame the freeze ends; the
panel fades in 0.12 s whatever the reel is doing, and the strip jumps back to its start
0.2 s later, unseen. `hud/test/unbox.test.ts` holds the geometry (the stop slot under the
marker, a strip that covers the window standing and stopped, a landing that never leaves
the prize's picture), the one curve, its shape and the fade.

**The roll's curve.** The first playtest on a real client (production, a Dathost server,
2026-10-04, two unboxings in a freeze) found the call, the ticks and the reveal right and
the roll wrong: "sticky, laggy… mostly a stuck item, not animated", and smoother after the
reveal. The curve was `cubic-bezier( 0.08, 0.6, 0.12, 1 )`. Its starting speed is 7.5
times the average: 85 px a frame at 60 fps, more than half a slot, so the first half
second, which covers half the way, is a jump. Then it
crawls: from 1.75 s it is under four slots a second with five to go, from 3.7 s it is
inside the prize's slot, and from 4.8 s it moves less than a pixel a frame, which a screen
shows as a pixel step every few frames. For the last 3.5 s the prize stands in the window
and barely moves. The game's own case opening has the same shape, even steeper
(`popup_capability_decodable`: `cubic-bezier(0.075, 0.82, 0.165, 1)` over 6 s, 32 tiles of
340 px), but its tiles are 2.4 times ours on a full screen, so its crawl still reads as
motion. Ours is an 860 px strip at the top of a HUD. The reveal's motions (the landing
settling in 0.3 s, the prize's overshoot) are short and smooth, which is the "smoother
after".

The server was ruled out: from the instant `rolling` is set to the reveal it writes
nothing to any layout, only the ticks, even when the spawn's second telling falls on the
reel's first instant (`UnboxingTests.NothingTouchesTheLayoutWhileTheReelSlides_OnlyTheTicksAreHeard`).
Nothing in the stylesheet re-lays the strip out while it moves: it is one `transform`
transition on the strip and one on the landing, and the slots' widths, margins and
`flow-children` never change.

So the curve is `cubic-bezier( 0.2, 0.65, 0.4, 1 )`, still 6 s (the game's own reel is 6 s,
and the reveal at 8 s is the contract's), still slowing all the way to a soft stop:

| | Before | Now |
| - | ------ | --- |
| speed at the start | 85 px a frame, 36 slots a second | 37 px a frame, 16 slots a second (the game's fastest tick, so each slot gets one) |
| of the way after 0.5 s, 1 s, 2 s | 48 %, 68 %, 85 % | 25 %, 45 %, 72 % |
| under four slots a second | from 1.75 s, five slots to go | from 2.6 s, five slots to go |
| inside the prize's slot | from 3.7 s (2.3 s) | from 4.3 s (1.7 s) |
| under a pixel a frame | from 4.8 s (1.2 s) | from 5.3 s (0.7 s) |

`hud/test/unbox.test.ts` holds those properties, not just the numbers: a speed that never
rises, a start between 12 and 16 slots a second, less than half the way in the first
second, at least four slots still to pass once it is readable, less than two seconds in the
prize's slot and less than one under a pixel a frame.

The look-list's step 17 is how to tell whether that is enough. If the reel still looks
stuck at its start on a client that runs well, the next suspect is the first sight of 36
uncompressed pictures; compare the first unboxing of a session with the second.

### The unboxing, played

`EZPug.Sdk.Moments` plays it (`plugins/EZPug.Sdk/Hud/Unboxing.cs`, the other half of the
class), and `plugins/EZPug.Sdk.Tests/UnboxingTests.cs` holds every sentence of this
section on the fake clock. A moment is an unboxing when it is a `drop`, about somebody,
with a `reel`, the HUD is on, and the server has a name for the person: the player's on
the server (a puppet's seat counts) or the roster's.

| After the moment is due | Constant | What happens |
| ----------------------- | -------- | ------------ |
| 0 s | | the call: `shown` for everybody here, the reel laid out, "Ada hat einen Drop! Mal sehen…" in chat |
| 2 s | `Moments.CallMs` | the reel: `rolling` and the landing; a tick each time a slot passes the marker, 29 of them, the last between 6.4 and 7.2 s |
| 8 s | `Moments.RevealMs`, the contract's `MOMENT_UNBOXING_REVEAL_MS` | the reveal: `revealed`, the landing off, the tier's reveal sound for everybody watching, **and the line in chat** |
| 12 s | `Moments.UnboxMs` | every class off |

**The line waits for the reveal.** Chat is on every screen, and a line that names the
prize at second 0 would open the box before the reel stopped. So an unboxing that plays
says the call when it is due and the line at the reveal; a player without the addon reads
both. Everywhere the unboxing is not played, the line is said when the moment is due, as
every moment's is.

**Where it plays.** The layouts are in the world and nobody plays for the whole sequence
and a second and a half more (`UnboxMs + UnboxSpareMs`, 13.5 s):

| When the moment is due | What happens |
| ---------------------- | ------------ |
| a freeze with 13.5 s left (a PUG's 18 s with the platform's beat of 2.5 s spent has 15.5), warmup, a pause standing in a freeze, halftime, the map over | the unboxing, now, and no toast and no card |
| a freeze with less (Rush's 13 s and flying-scoutsman's 5 never fit), a round being played, before any round on the map | PRD-07's moment, now: the line, the toast, the card |
| a decided round | it waits for the round start, seconds away: the win panel is up now. That round start plays it, or, where the freeze is too short, shows PRD-07's moment |
| another unboxing is up or waiting | it waits, whole (no call, no line, no toast), for the next stretch that fits: in a freeze that is the next round's, in warmup half a second after the first (`UnboxRestMs`). At most four wait; one that waited three minutes (`CardWaitMs`) is shown as PRD-07's moment |
| the HUD is off | the line, as today |

**Put away at once.** The instant somebody is playing every class comes off. If the prize
had not shown, nobody knows what was won: the line, the toast and the person's card (at
the next stretch) follow in that instant. After the reveal nothing follows. A map change
takes the one on screen and the ones waiting and says each line that was not said yet; a
release takes everything silently.

**Who sees it.** Whoever was on the server when it began: the beats are per player, so
somebody who connects mid-sequence gets a clean slot and sees nothing (they read the line),
and a spectator sees what the player they watch sees, the layout being `observable`. The
winner need not be there. Their side (`side-ct`, `side-t`) is read off the server when
they are, and is nobody's when they are not.

**The same moment, the same reel.** The slots and the landing come from a seed over the
moment's kind, person, picture, tier and reel (not its correlation id or `inMs`), so a
redelivered command lays out the reel the first one did. The prize is in slot 33; the
other 35 are drawn from the decoys, never the same twice running where there are two.
The reel is everybody's state on the entity (a picture and a tier per slot) and only what
differs from the reel before is set.

**The sound** (PRD-08 T5) is the game's own case opening, read out of
`soundevents/game_sounds_ui.vsndevts` (decompiled from the dev node's `pak01_dir.vpk` into
the build volume's `reference/soundevents`, like the stylesheets), played through
`IGameWorld.PlaySound` to everybody watching. No sound ships in the addon.

| | Event | Its file | Its own volume | We send |
| - | ----- | -------- | -------------- | ------- |
| a tick | `UIPanorama.container_weapon_ticker` | `sounds/ui/csgo_ui_crate_item_scroll.vsnd` | 0.2 | 0.5 (`Moments.TickVolume`) |
| the reveal, common | `UIPanorama.ItemDropCommon` | `sounds/ui/panorama/case_awarded_0_common_01.vsnd` | 0.3 | 1.0 to the winner, 0.7 (`Moments.RevealVolume`) to everybody else |
| uncommon | `UIPanorama.ItemDropUncommon` | `…case_awarded_1_uncommon_01.vsnd` | 0.3 | the same |
| rare | `UIPanorama.ItemDropRare` | `…case_awarded_2_rare_01.vsnd` | 0.3 | the same |
| legendary | `UIPanorama.ItemDropLegendary` | `…case_awarded_4_legendary_01.vsnd` | 0.3 | the same |

The ticks are what the game's own case opening plays for every item its reel passes. The
server times them on the stylesheet's slide: the marker passes a slot's edge 29 times
between slot 4 and slot 33, at instants read off `cubic-bezier( 0.2, 0.65, 0.4, 1 )` for
the landing that was drawn (`Moments.TicksOf`; a test holds its resting slot, curve and
landings to `ezpug_unbox.css`). At its fastest the reel passes a slot every 64 ms, so every
one of the 29 is ticked: 29 ticks from 32 ms to 4.4–5.2 s (`land-1` 4,406, `land-2` 4,574,
`land-3` 4,887, `land-4` 5,194), each gap longer than the one before, and the last at least
0.8 s before the reveal. A tick closer than 60 ms (`TickGapMinMs`) to the last one would be
skipped, because the server schedules on its 64 Hz frames and the event plays one instance
at a time; the curve never comes that close. The game's own case opening ticks at most 16
times a second too, on a fixed list. Before the playtest of 2026-10-04 the curve was
`( 0.08, 0.6, 0.12, 1 )` and the schedule 21 or 22 ticks from 14 ms to 3.9–4.9 s, with 8 of
the first 20 slots unticked. **The schedule is the plugin's and the curve is also the
addon's**: they ship by different roads ("Shipping the roll", below).

The reveal is Valve's "awarded" sound for the rarity of the same name and colour. Our
four tiers are four of their six rarities; mythical and ancient are not ours.

**Whether the volume scales an event is still unknown**, so the tiers are four different
sounds and do not depend on volume. `PlaySound` hands its volume to CounterStrikeSharp's
`EmitSound`, which puts it in the engine's `EmitSound_t.m_flVolume` (1.0.376's
`entity_manager.cpp`; the same code says the pitch next to it does nothing). Whether a CS2
client multiplies the event's own volume by it, replaces it, or ignores it nobody has
heard. If it is ignored, the ticks play at 0.2 and the reveal at 0.3, the volumes the
game's own case opening uses in the main menu. Not chosen: `EndMatch.ItemRevealRarity*`,
the end-of-match drop (one per rarity, but the end-of-match screen's sound, not a case's);
`UI.CrateItemScroll`, the same file as the tick under an older name; the card's
`EndMatch.ItemRevealSingleLocalPlayer`, which stays the card's.

Played on the fake clock only: the dev node's row is PRD-08 T6, and the screen and the
speakers are the look list's.

**Shipping the roll.** The curve is in two places that reach a player by two roads: the
stylesheet in the Workshop addon (`pnpm hud:build`, `pnpm hud:publish`, live for a client
once Steam serves the revision and the client has restarted its game), and the tick
schedule in the plugin (`pnpm cs2:build`, then `pnpm dathost:image` for the Dathost
template, which the next match's server is cloned from). Neither can see the other, so a
change to one is a change to both, published the same day, and in between a player hears
ticks out of step with the picture. Nothing worse: the stop slot, the landings and the
reveal at 8 s are the same on both sides. `UnboxingTests` pins the schedule and its curve,
and a test there reads the curve back out of `ezpug_unbox.css`, so the two cannot differ in
one commit.

Shipped on 2026-10-05 (PRD-09 T1), both halves from the merge `72c248c` of `3dd4a6a` and
`ae9fdff`. **The addon:** `pnpm hud:build` gave `hud/dist/` back byte for byte as the fix
had committed it, and `pnpm hud:publish` uploaded it at 12:21 CEST. Its own check failed,
as it always does right after an upload, and `node hud/src/cli.ts check 3811574606`
fetched the new pack anonymously, byte for byte, the next time it ran, at 12:32. That is
11 minutes at most, against the 47 and 66 minutes of 2026-10-02. **The plugin:**
`pnpm cs2:build`, then `pnpm dathost:image`, which uploaded 9 files (the SDK, the core
plugin and the two disabled plugins built beside them), and `--check` green, then
`./scripts/deploy.sh all`. The lane's `unbox` row on the dev node, with the addon, timed
the same beats as PRD-08 T6: the call with 17,871 ms of freeze left, the reel 2 s later,
the prize at 8 s and the put-away at 12 s.

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

## The look list

Everything above that a machine could check has been checked: the compile, the pack, the
anonymous download, the entities and their state, the timing on a fake clock, the switches.
**Nobody has seen any of it on a screen or heard it.** These steps are for one person with
a real CS2 client, about an hour, and the HUD stays off in production until they are done.
Write down what you saw at each step, with a screenshot where it says so, and change the
code or the stylesheet for anything that is wrong before turning the HUD on.

### Setting it up

The look needs a server a client can reach from the internet with a GSLT, which the dev
node and the dev orchestrator do not have (a server without one takes LAN connections
only). So it is one Dathost match from production's orchestrator, which is the owner's
call to make:

1. Check `node hud/src/cli.ts check 3811574606` prints the "byte for byte" line, so the
   item serves what `hud/dist/` holds.
2. Put `EZPUG_IRON_HUD_ADDON=3811574606` in `.env.production` and run
   `./scripts/deploy.sh up`. The platform still sends no `branding.hud`, so its own
   matches stay without a HUD; their servers load MultiAddonManager and hand out nothing.
3. Create one match with an admin key (`pnpm iron matches create --file look.json
   --simulate`, "A puppet match, to show somebody" in `docs/operations.md`), a `pug` 2v2
   on `{ "provider": "dathost" }` with:
   - `branding: { "hud": true, "eventName": "…", "tagline": "…" }`;
   - your own SteamID on the roster with `"locale": "de"`, three made-up entries beside
     you, and `simulation.puppets` naming those three, so you are the one human;
   - `rules.warmup.autoReady: false`, so the warmup waits for your `.ready` and you have
     time to look around.
4. Join from the address `matches get` prints. Send the moments below with
   `pnpm iron matches command <matchId> moment --kind drop --tier rare --steam-id <yours>
   --art <key> --text '{"de":{"everyone":"…","you":"…"},"en":{"everyone":"…","you":"…"}}'`
   (leave out `--steam-id` and `you` for a moment about nobody).
5. When done: `force_end` the match, take `EZPUG_IRON_HUD_ADDON` out of `.env.production`,
   `./scripts/deploy.sh up` again, and check `pnpm iron servers list` holds nothing of it.

Restart your game before step 4 if it was running when the addon was last published.

### What to look at

1. **The first join.** Time it from "connect" to standing in the map, and do the same on a
   server without the HUD. Expected: a longer loading screen, a download of about 8 MB,
   and one reconnect, which everybody else sees as you leaving and joining ("left the
   game", because `mm_block_disconnect_messages` is `0`). Write down the seconds it adds
   and whether you were kicked with "Required Workshop addon download was not accepted in
   time" (30 s). This step also answers two questions no document settles: whether a
   retail client mounts Panorama from a **packed** Workshop VPK (`PanoramaLayout`'s retest
   notes report a "hard stop" for packed VPKs on 2026-08-26, cs2-ui-kit ships its addon
   packed on 2026-09-23), and whether it wants a signature section in the VPK. If nothing
   is drawn in the next step, these are the first suspects.
2. **The welcome, at 16:9.** Expected, two seconds after you are in: a card sliding in at
   the right edge below the kill feed, with the house banner (the two mascots and the
   chicken), "Willkommen bei" and the event's name, the tagline, your team line, what to do
   next and `ezpug.com`, in German. After eight seconds it shrinks into a small mark. No
   centre card at the same time. Screenshot both. If it appears **without sliding**, the
   `transition:` shorthand is the first thing to change to the longhands the moment uses.
3. **The welcome, at 4:3**, and in English: change the resolution, set the roster entry's
   `locale` to `en` on a second match (or reconnect after a `profile` command). Screenshot.
4. **The welcome steps aside.** Open the buy menu and the scoreboard while the card or the
   mark is up: the whole layout fades. Watch the team intro and the end of warmup: the mark
   is gone at the first live round start.
5. **The toasts.** Send four moments at once with `inMs` 0, one per tier (`common`,
   `uncommon`, `rare`, `legendary`), one with a line near 120 characters. Expected: three
   strips at the right edge under the kill feed, the fourth after the first goes (six
   seconds each), a tier bar in muted bone, ivory, cobalt and magenta. Screenshot. Then
   one during a round with kills: the strips must not cover the kill feed.
6. **A toast over the welcome.** Reconnect and send a moment within eight seconds of
   joining: a strip lies over the welcome's card until it shrinks. Decide whether that is
   acceptable.
7. **The card.** Send a moment about yourself (`steamId64` yours, `art: "category-skin"`
   or another key in `HUD_ART_KEYS`) during warmup. Expected: at the left edge between the
   radar and the chat, face down with the cast's picture, turning over after one second
   (two scale transitions) to the picture and your own line, gone after six seconds. Do it
   at 16:9 and 4:3, with a long `you` line (cut with an ellipsis after about five lines),
   and with an art key the addon does not have (the empty sleeve). Screenshot each.
8. **The sound.** At the turn you should hear the game's own item-reveal sound
   (`EndMatch.ItemRevealSingleLocalPlayer`), louder with the tier (0.4 to 1.0). Write down
   whether the four tiers sound different at all: whether the volume argument scales the
   event or replaces its own 0.2 is unknown.
9. **The card waits for a quiet stretch.** Send a moment about yourself with a round
   being played: you should get the strip now and the card at the round's end or the next
   freeze. Send one during a freeze with a few seconds left: the card must vanish the
   instant the freeze ends (a 0.12 s fade). Open the buy menu during a card: it fades.
10. **The card at the end of the match.** Send one due as the last round ends: the game's
    own end screen covers it, which is expected. Note whether anything of it shows.
11. **A spectator.** Die, and watch a team-mate while a moment about them plays: you
    should see their card (the moment's layout is `observable`). Then have a moment about
    *you* play while you are dead and watching somebody: write down whose version you see.
12. **The map change.** In a `pug`, MatchZy loads the match's map after the lobby. After
    the change the welcome's strings and a new moment must still draw (the layouts are
    made again on the new map, `Hud.OnMapStarted`).
13. **A second join, after the cache.** Disconnect and reconnect to the same server:
    expected, no download and no extra reconnect (`mm_cache_clients_with_addons 1`).
    Then join the next match's server with the addon already on disk: write down whether
    there is still a reconnect.
14. **The third switch.** With the match running, have somebody type
    `mm_client_extra_addons ""` from the platform's RCON panel (or
    `pnpm iron matches command <matchId> rcon --command 'mm_client_extra_addons ""'`), then
    reconnect: expected, no download handshake, and the HUD you already have keeps
    drawing.
15. **A demo and GOTV.** Watch the match on its GOTV relay and play its demo back: write
    down whether a toast or a card shows there, and whose.
16. **A mode's own toast.** No shipped mode calls `Gamemode.Toast` yet, so this waits for
    the first mode that does. It uses the moment's three rows, untinted.
17. **The unboxing.** Send a `drop` about yourself with a
    `reel` of a few decoys (`--reel`, `docs/match-api.md`) so that it is due at a
    `round_start` in a PUG (it needs 13.5 s of freeze left; in warmup it plays at once).
    In chat: the call at once, the line only when the prize shows. Expected, at the top centre under the team counter: the call
    with your name in your side's colour and that side's mascot, the reel sliding fast and
    slowing to a stop on the marker, then the prize growing over a burst in its tier's
    colour, your own line under it, all gone before the freeze ends. Look at, with a
    screenshot each: 16:9 and 4:3; German and English; **with the buy menu open** (the reel
    above the columns at 0.8, the call and the line gone, every column readable and every
    purchase working); a reel that seems to stop on one picture and reveals another (it
    must never); as somebody who connects while it runs (nothing, and the line in chat); cut
    by the freeze ending (gone at once, then the toast). Write down whether the side's half of the cast's picture reads as one
    mascot, and whether the reel's speed looks like a case opening: from its first frame
    the slots visibly run past (about 16 a second, no jump), by about 2.5 s each picture can
    be read as it passes, the last one or two slots creep in over the final second and a
    half, and it stands still a moment before the prize grows ("The roll's curve"). Watch
    the first unboxing after a game start and a second one: if only the first stutters, it
    is the pictures loading, not the curve. **Listen** too: a
    tick as each slot passes the marker, quick and then slower, in step with the picture
    (write down if they drift apart or rattle); the reveal, a different sound for each of
    the four tiers (send one of each); and whether ticks at 0.5 and the reveal at 0.7 sound
    any different from the winner's 1.0. If they do not, the volume argument does not scale an event
    (the open question of step 8). Neither should drown the footsteps and buying around you.

### Not for a client, but open

- **The Workshop item's page**, in a browser logged in as the account: set the preview to
  `hud/images/cast/hello.png` (SteamCMD cannot) and check visibility says *Unlisted*.
- **After every republish**, `node hud/src/cli.ts check 3811574606` until it prints the
  "byte for byte" line; Steam served the revision before for 47 minutes the last time.
- **The `hud-on` row is the drill after a CS2 update** ("The drill after a CS2 update").
- **The dev trace** (`.cache/trace/dev.ndjson`, about 1.5 GB) grows with every lane run
  and nothing rotates it.
