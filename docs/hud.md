# The HUD

EZPug's in-game HUD is a CS2 `custom_hud_layout`: Panorama panels whose layout lives
on the player's machine and whose state (a class on a panel, a string variable) the
server sets. The layout reaches a client as a **Workshop addon**, so the HUD has a
client half, and this repo builds and publishes it. `ralph/PRD-07-hud.md` is the round
that made it; its Findings are the reading list.

This page covers the client half: where the sources are, how they become the addon, and
how the addon reaches Steam. The server half and the three switches come with the round's
later tasks.

## The sources

`hud/` (`@ezpug/hud`) is laid out for the people who edit it. `hud/src/addon.ts` maps it
onto the addon:

| In `hud/` | In the addon |
| --------- | ------------ |
| `addoninfo.txt` | `addoninfo.txt` |
| `layout/ezpug_<name>.xml` | `panorama/layout/custom_game/ezpug_<name>.xml` |
| `styles/ezpug_<name>.css` | `panorama/styles/custom_game/ezpug_<name>.css` |
| `images/<path>.png` | `panorama/images/custom_game/ezpug/<path>.png`, plus a generated `.vtex` (BGRA8888) beside it |

The server names a layout by its **source** path with the extension
(`panorama/layout/custom_game/ezpug_hello.xml`). A layout includes its stylesheet by the
**compiled** name (`s2r://…/ezpug_hello.vcss_c`), and a stylesheet references a picture
the same way (`s2r://…/hello.vtex`). Every name is `ezpug_`-prefixed or under `ezpug/`,
because a client mounts other servers' addons into the same `custom_game` folders.

`hud/test/addon.test.ts` turns the authoring rules into tests. A client breaks every one
of them silently, so a test is the only place anyone will see it fail:

- the root panel has no `id`;
- there is no inline `style`, no `<Image>` (pictures are backgrounds), no script, and
  nothing with `hittest="true"`;
- `@keyframes` names are quoted, and no keyframes animate `transform`.

Biome skips `hud/styles/`, because Panorama CSS is Valve's dialect and the compiler is
the authority on it.

## Building: `pnpm hud:build`

```
pnpm hud:build            compile hud/ into hud/dist/, pack, verify, read back
pnpm hud:build --tools    fetch or update the Windows depots first
pnpm hud:verify           is hud/dist/ honest? (no compiler, no network)
```

Valve's `resourcecompiler.exe` exists only for Windows. It runs here under Wine 10.0,
headless under Xvfb, inside a build image of its own (`docker/hud/Dockerfile`,
`ezpug-iron/hud-build:dev`, Debian trixie). The box itself gains no packages. A compile
of the hello panel (a layout, a stylesheet and a texture) takes about ten seconds.

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
names (title, a description in German and English, `unlisted`). The preview picture is
`hud/images/cast/hello.png`.

- **Only what is committed.** A dirty tree (`git status --porcelain`, untracked files
  included) is refused, and so is a `hud/dist/` that fails `verifyDist`. The change note
  is the commit's short sha and subject.
- **The first run creates the item.** It writes the new id into `hud/workshop.json`,
  which then needs a commit, and uploads again under the name a client mounts:
  `<id>.vpk`. MultiAddonManager looks for `<id>/<id>_dir.vpk`, then `<id>/<id>.vpk`
  (`src/multiaddonmanager.cpp:425`). Later runs only update the content. A title,
  description or visibility edited on the item's page is left alone.
- **Then it checks.** It asks the Steam Web API (`GetPublishedFileDetails`, no key) what
  Steam says about the item. Then it downloads the item **anonymously** with SteamCMD,
  the way a server or a stranger's client would, and compares the bytes with
  `hud/dist/ezpug_hud.vpk`.

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
