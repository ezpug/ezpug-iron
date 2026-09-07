# The plugins

The C# side of EZPug Iron: `EZPug.Sdk` (what a gamemode is written over), `EZPug.Core`
(the plugin every server runs), the gamemode plugins that follow, and the tests for each.
`docs/sdk.md` is how to write a mode; this file is how the pieces land on a server and
how to install them by hand. `docs/decisions.md` 5, 16 and 19 are the why.

## What is here

| Project | What it is |
| ------- | ---------- |
| `EZPug.Sdk` | the seams (`IGameWorld`, `IPlatformLink`, `IClock`), the `Gamemode` base and runtime, the event model, player commands, i18n, the link client, and `EZPug.Sdk.Hosting` — the door a gamemode plugin uses to reach the runtime |
| `EZPug.Sdk.Testing` | `FakeClock`, `FakeGameWorld`, `FakePlatformLink`, `GamemodeTestHost`: a mode under xunit without CS2 |
| `EZPug.Core` | the CounterStrikeSharp shell: the world and the game-thread clock over the engine, the sidecar, the link, the gamemode loader, the console commands |
| `EZPug.PowerupDm` | the shipped SDK gamemode (PRD-02 T26): `powerup-dm`'s class, its CounterStrikeSharp shell and its resx pair. Installed under `plugins/disabled/`, hot-loaded for the match whose manifest names it |
| `vendor/WeaponPaints` | the data-layer fork of cs2-WeaponPaints (PRD-02 T28, decision 20): upstream's plugin with `ILoadoutSource` where MySQL was, every patch in `vendor/WeaponPaints/PATCHES.md`. The one vendored tree in `EZPug.sln` |
| `EZPug.Sdk.Tests`, `EZPug.Core.Tests`, `EZPug.PowerupDm.Tests`, `WeaponPaints.Tests` | xunit; run by `pnpm verify` (`dotnet build -warnaserror` + `dotnet test` over `EZPug.sln`) |

Everything builds against the CounterStrikeSharp.API version pinned in
`Directory.Build.props` (`docs/pins.md` has the row); the .NET SDK is `global.json`'s.

## How a server is laid out

CounterStrikeSharp auto-loads every folder directly under `plugins/` at boot and skips
`plugins/disabled/`. EZPug uses exactly that: the core plugin sits at the top and runs
always; every plugin a gamemode manifest can name — MatchZy, the retakes plugin, the SDK
modes, the skins layer — sits under `disabled/` and is hot-loaded by the core's loader for
the match that names it, unloaded when the match ends (decision 16). The SDK is installed
**once**, in CounterStrikeSharp's `shared/` folder, and never beside a plugin: the host
capability that connects a gamemode plugin to the runtime is keyed by a type in the SDK,
and two copies of the SDK would be two types.

```
game/csgo/
├── ezpug.json                                  ← the sidecar the provider plants (or the env, below)
├── cfg/ezpug/*.cfg                             ← the gamemodes' cfg files (gamemodes/<id>/cfg, PRD-02 T10)
└── addons/counterstrikesharp/
    ├── shared/EZPug.Sdk/EZPug.Sdk.dll          ← one copy, for every EZPug plugin
    └── plugins/
        ├── EZPug.Core/EZPug.Core.dll (+ .deps.json, .pdb, build.json)
        └── disabled/
            ├── MatchZy/MatchZy.dll             ← vendored at docs/pins.md's version, untouched
            ├── RetakesPlugin/…                  ← + its lang/ and map_config/ spawn set
            ├── RetakesAllocator/…               ← the weapon allocator that runs beside it
            ├── WeaponPaints/…                  ← the data-layer fork (T28): dll, lang/, data/, its own Newtonsoft.Json.dll, no EZPug.Sdk.dll
            └── EZPug.PowerupDm/…               ← the SDK mode (T26): its dll, deps.json and pdb, no EZPug.Sdk.dll beside it
```

`plugins/publish.sh` (`pnpm plugins:publish`) builds the tree above under `plugins/dist/`
with exactly the files a plugin folder should hold — the plugin's dll, `deps.json` and
`pdb`. `CounterStrikeSharp.API.dll` and the `Microsoft.Extensions.*` assemblies that a
`dotnet publish` would also emit are the runtime's own and are left out on purpose: a copy
beside a plugin would shadow the host's. The server image (T10) and the Dathost template
script (T18) both take this tree.

## Installing by hand

On a CS2 dedicated server with Metamod and CounterStrikeSharp at the pinned versions:

1. `pnpm plugins:publish` on a machine with the .NET SDK, then copy `plugins/dist/addons`
   over the server's `game/csgo/addons` (it only adds `shared/EZPug.Sdk` and
   `plugins/EZPug.Core`).
2. Put the vendored plugins under `plugins/disabled/<Name>/` — the folder name is what a
   manifest's `plugins` lists (`MatchZy`, `RetakesPlugin`, `RetakesAllocator`,
   `WeaponPaints`). MatchZy and the allocator are release zips; cs2-retakes and the
   WeaponPaints fork are source under `plugins/vendor/`, and `plugins/vendor/build.sh`
   writes the same tree for both (retakes' `shared/RetakesPluginShared` goes beside
   `shared/EZPug.Sdk`; the allocator's `gamedata/panoramamanager.json` and the fork's
   `gamedata/weaponpaints.json` beside the plugins folder).
3. Copy each `gamemodes/<id>/cfg/` tree into `game/csgo/cfg/` (the manifests name their
   files as `ezpug/<id>.cfg`, so `gamemodes/pug/cfg/ezpug/pug.cfg` lands at
   `game/csgo/cfg/ezpug/pug.cfg`). The image's entrypoint does exactly this at every boot.
4. Tell the plugin where home is — **either** in the environment of the server process:

   ```
   EZPUG_IRON_URL=https://gs.ezpug.com        # the orchestrator; wss://…/link is derived
   EZPUG_SERVER_TOKEN=…                        # the per-server token the orchestrator minted
   EZPUG_LINK_BUFFER_DIR=/path                 # optional; default: plugins/EZPug.Core/link-buffer
   EZPUG_LOBBY_MAP=de_dust2                    # optional; default: the map the server booted with
   ```

   **or** as `game/csgo/ezpug.json`, which is what the Dathost provider uploads (T16):

   ```json
   { "url": "https://gs.ezpug.com", "token": "…", "bufferDir": "…" }
   ```

   The environment wins when both exist. Without either, the plugin loads **unlinked**:
   the console commands work, every event is dropped, and `ezpug_status` says so.
5. Start the server. The console shows `EZPug.Core 0.1.0 on EZPug.Sdk 0.1.0`, the plugin
   folders it found, and the link dialling; `ezpug_status` from the console or RCON shows
   the rest. A node (T11) sets the environment per container; nobody edits a file.

The token is a secret: it is never logged, never in a `state` or `console` frame, and
`ezpug_status` prints the orchestrator's host, never the URL's query or the token.

## What the core plugin does

- **Boot → sidecar → link → `hello`.** One outbound WebSocket to `/link` (decision 5),
  the token from the sidecar, versions (its own, the SDK's, CounterStrikeSharp's as the
  loaded assembly declares it, MatchZy's read off its dll), the capabilities this build
  honours (`positions`, `chat`, `playerCommands`, `widget`, `backups`; `scoreboardRating`
  comes with T27), the plugin folders in the image, the
  hostname and map. Reconnects with capped backoff; events are buffered on disk until the
  orchestrator acks them (`docs/sdk.md`, "The link").
- **`assign` → the loader.** Hostname from `branding.hostname` or `EZPug · <mode> · <Map>`;
  each of `assign.pluginConfigs` written to
  `addons/counterstrikesharp/configs/plugins/<Name>/<Name>.json` **before** anything is
  loaded, because CounterStrikeSharp reads a plugin's config once, on the way into its
  `Load` (`docs/gamemodes.md`, "A vendored plugin's own config file"); then
  `css_plugins load plugins/disabled/<Name>/<Name>.dll` for each plugin the assignment
  names, in order; `changelevel` (or `host_workshop_map` for a workshop id) to the first
  map. That second is announced first (`Runtime.ExpectMapChange`, `docs/sdk.md`): on a
  container that has only just booted the `assign` lands inside the beat the world holds
  the boot map's news for, and a map the engine started before the loader asked for the
  change is the server's, not the match's — it is dropped with a log line instead of
  becoming a `server_ready` nobody asked for (PRD-02 T22c). When the map is up — one second
  after the engine's `OnMapStart`, because the engine execs its own gamemode cfgs right
  after that listener and a cfg exec'd earlier is undone — the mode's cfg files are exec'd
  in order. A second after *that*, in a console frame of
  its own — because the engine reconciles a cvar's effects once at the end of a frame, so a
  value the cfg sets and the request sets back is not two changes but none
  (`GamemodeLoader.CvarSettleMs`, PRD-02 T22a) — the flat cvars are set, and for a
  `matchzy` flow the match config is written to `cfg/ezpug/match.json` (the orchestrator's document plus
  `matchzy_hostname_format`, so MatchZy keeps the hostname), `matchzy_loadmatch`'d once
  per assignment, and MatchZy's remote log is pointed at the orchestrator's
  `POST /matchzy/log` with this server's token in the `x-ezpug-server-token` header — as
  console commands after the load, never in the file, because MatchZy serialises the file
  into every round backup. Then `server_ready` is emitted and the mode's `OnStart` runs.
  State: `assigned`.
- **The engine's hooks → the vocabulary**, emitted once by the SDK's runtime:
  `server_ready`, `player_connected` / `player_disconnected` (humans; bots are tracked but
  nobody's event), `player_death` with assists, weapon, headshot and the flags, `bomb_*`,
  `chat_message` / `chat_command` by the vocabulary's prefix rule, position ticks every
  100 ms while linked, heartbeats on the interval `welcome` gave. Match-flow events are
  the flow owner's: MatchZy's remote log for `flow: matchzy`, translated by the
  orchestrator (T9), the SDK's generic emitter for `flow: plugin | none` (`GenericFlow`,
  T22) — `going_live` at the first round outside warmup, `round_start` / `round_end` /
  `side_swap` off the gamerules, `map_end` on the win panel and `series_end` with it when
  the last map planned is over. It is in every server because the runtime owns one, which
  is what lets a `config` mode with no plugin at all tell a whole match.
- **What MatchZy cannot say, observed** (`MatchZyFlow`, `flow: matchzy` only): MatchZy
  0.8.15 sends no pause, side-swap or backup event, so the core reads the engine —
  `match_paused` / `match_unpaused` off `cs_gamerules` every 250 ms (a tactical timeout
  names its team, a technical one its kind, a pause the orchestrator asked for is an admin
  pause; a pause is reported when requested, as MatchZy's own chat line is), `side_swap` at
  a round start outside warmup when the rostered team A stands on the other side (a knife
  winner's `.switch`, halftime) or, with nobody rostered, when the engine flagged the swap,
  and 1.5 s after each live round start the newest `MatchZyDataBackup/matchzy_<matchid>_<map>_round<NN>.json`
  as a `backup` frame (restores to round `NN + 1`) plus `backup_written`, the remote-log
  header value scrubbed out of MatchZy's serialised config first.
- **The demo, and its upload** (`DemoFlow`, `records: demo` only, T21). MatchZy records its
  own flow's demo into `game/csgo/MatchZy/` and stops a GOTV delay after the last round;
  for any other flow the core runs `tv_record` at the map and `tv_stoprecord` one `tv_delay`
  after the win panel (`cs_win_panel_match`, the one end-of-map signal every flow shares).
  **The upload is always the core's** — MatchZy's own uploader POSTs a multipart form and a
  presigned PUT will not take one (decision 10). Nothing says when a `.dem` is finished, so
  from the win panel on the newest one is watched until its length has stood still for
  fifteen seconds, then hashed, streamed at the assignment's `demoUploadUrl` (four attempts
  on the clock) and announced as `demo_available` with its size and hash — the hash is what
  the orchestrator relays as `demo.uploaded`. No upload URL, or a storage that refuses:
  the demo is still announced, hashless, and stays on the server. One demo per match,
  because the request carries one URL.
- **A restore** (T14). An assignment whose match resumes here after its server was lost
  carries `restore`: the loader goes to the backup's map (not the plan's first), and after
  `matchzy_loadmatch` writes the backup into `MatchZyDataBackup/` with this server's remote
  log put back inside it (`MatchZyBackups.WithRemoteLog`, the inverse of the scrub — MatchZy
  deserialises its config from that file, twice) and runs `matchzy_loadbackup <file>`, then
  points the remote log once more. MatchZy in warmup marks the restore pending and applies
  it when the match starts (`mp_backup_restore_load_file`, then its own pause both teams
  lift with `.unpause`); players reconnect, ready up, and find their round. The plugin says
  `backup_restored` as a `plugin_event` (the simulator's word too); `going_live` stays
  MatchZy's, and is what closes the orchestrator's recovery window. The runtime's context
  starts at the backup's map and round. A file name that is not a bare `.json` name is
  refused; a non-`matchzy` flow warns that it has no round backups and starts over.
- **Bots on the wire.** The vocabulary names a player by a 17-digit SteamID64 and a bot
  has none, so a bot is `90000000000000000 + slot` (`BotIdentity` in the SDK): stable for
  its connection, obviously synthetic, and a bot's death is a real event in a match bots
  play.
- **`release` → unload.** The plugins it enabled are unloaded in reverse, the match config
  and every plugin config it wrote removed — so a server started by hand between matches
  never runs a vendored plugin on the last match's settings — the server goes back to the
  lobby map, state `idle`.
- **Commands over the link.** `announce`, `kick`, `rcon` and `profile` are answered by the
  runtime; for a `matchzy` flow `pause` and `unpause` are MatchZy's `css_forcepause` /
  `css_forceunpause`; `restart_round`, `force_end` and `reroll` are the flow owner's (the
  mode) and `command_unsupported` until then. `restore` never reaches a server: the
  orchestrator restores onto a *new* server through the assignment (above).
- **A gamemode plugin attaches through the host capability.** `EZPug.Sdk.Hosting.GamemodeHost`
  is a CounterStrikeSharp `PluginCapability` the core publishes; a mode's plugin derives
  from `GamemodePlugin`, which finds the host on load and attaches the mode. A mode
  attached after the assignment hears `OnAssigned` at once.

## Console commands

Server console or RCON only (`CommandUsage.SERVER_ONLY`):

| Command | What it does |
| ------- | ------------ |
| `ezpug_status` | versions; the link (unlinked / connecting / connected to `<host>` as `<provider>/<serverId>`); the buffer's `lastSeq` and unacked count; state, map, player count; the match, mode and round; the plugins enabled and installed |
| `ezpug_announce <text>` | says the line to everybody, as the `announce` command over the link would; logged to the console tail |
| `ezpug_restore <file> <round>` | loads an engine round backup already on disk under `game/csgo` by file name (`mp_backup_restore_load_file`) — the operator's hand door. The recovery flow itself (the backup arriving in the assignment, `MatchZyDataBackup/`, `matchzy_loadbackup`) needs no console: see *A restore* above |

The console tail the fleet console reads over the link (T20) holds what the plugin itself
logged, the announcements and the restores; CounterStrikeSharp offers no hook on the
engine's own console output.

## Threads, in one paragraph

The engine has one game thread and CounterStrikeSharp allows nothing else to touch it.
Every SDK hook fires there; a mode's timers run on `GameThreadClock`, which fires them
from the engine's tick. The link's socket runs on the thread pool and its heartbeat on
`SystemClock`; inbound frames queue until the runtime pumps them on the next tick. The
heartbeat's map name and player count are snapshots the world keeps, so nothing reads the
engine off the game thread.

## Writing a gamemode plugin

The mode is a `Gamemode` (`docs/sdk.md`); its plugin is five lines. `EZPug.PowerupDm` is
the one that ships and the one to copy:

```csharp
public sealed class PowerupDmPlugin : GamemodePlugin
{
    public override string ModuleName => "EZPug.PowerupDm";
    public override string ModuleVersion => "0.1.0";
    protected override Gamemode CreateMode() => new PowerupDm();
}
```

Build it against `EZPug.Sdk` (a project reference with `Private="false"`, so no copy of
the SDK lands in its `bin/`), ship the plugin's dll, `deps.json` and `pdb` under
`plugins/disabled/<Name>/` — and not `EZPug.Sdk.dll`, which the host resolves from
`shared/`. Name the folder what the manifest's `plugins` says, add the project to
`EZPug.sln`, to the `for mode in …` line of `publish.sh` and to the csproj list in
`docker/cs2/Dockerfile`, and the image carries it.

## What is not here yet

The server image (PRD-02 T10, `docker/cs2/Dockerfile`) is what installs all of the above
without a human: `pnpm cs2:build && pnpm cs2:install && pnpm cs2:up` gives a CS2 server on
this box with Metamod, CounterStrikeSharp, MatchZy and this tree already in place
(`docs/operations.md`, "The CS2 server image"). T10 **loaded this tree on a real CS2 server
for the first time**: Metamod takes `libserver.so`, CounterStrikeSharp starts its .NET
runtime and logs `Loading plugin EZPug.Core`, and the plugin answers with its own line —
`EZPug.Core 0.1.0 on EZPug.Sdk 0.1.0; … installed plugins: EZPug.Core, MatchZy; unlinked` —
then the map loads and the server stays up. What is still unproven on real hardware is
everything that needs a *link*: no server token exists until a provider allocates one
(T12's node), so `hello`, `assign`, the gamemode loader and the console commands have only
ever run on the SDK harness. The first linked run, and the first match, are T13's.
`backup` frames (T9/T14), the scoreboard rating (T27), the skins hand-off (T28) and
branding beyond the hostname (T29) are the tasks that name them; the first three have since
run on the dev node.
