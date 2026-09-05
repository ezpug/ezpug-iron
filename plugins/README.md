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
| `EZPug.Sdk.Tests`, `EZPug.Core.Tests` | xunit; run by `pnpm verify` (`dotnet build -warnaserror` + `dotnet test` over `EZPug.sln`) |

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
            ├── RetakesPlugin/…
            ├── WeaponPaints/…                  ← the data-layer fork (T28)
            └── EZPug.PowerupDm/…               ← an SDK mode (T26): its dll, no EZPug.Sdk.dll beside it
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
   manifest's `plugins` lists (`MatchZy`, `RetakesPlugin`, `WeaponPaints`).
3. Copy `gamemodes/*/cfg/*.cfg` to `game/csgo/cfg/ezpug/` (the manifests name them as
   `ezpug/<id>.cfg`).
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
  `css_plugins load plugins/disabled/<Name>/<Name>.dll` for each plugin the assignment
  names, in order; `changelevel` (or `host_workshop_map` for a workshop id) to the first
  map. When the map is up — one second after the engine's `OnMapStart`, because the engine
  execs its own gamemode cfgs right after that listener and a cfg exec'd earlier is undone
  — the mode's cfg files are exec'd in order, the flat cvars set, and for a `matchzy` flow
  the match config is written to `cfg/ezpug/match.json` (the orchestrator's document plus
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
  orchestrator (T9), the SDK's generic emitter for `flow: plugin | none` (T22).
- **What MatchZy cannot say, observed** (`MatchZyFlow`, `flow: matchzy` only): MatchZy
  0.8.15 sends no pause, side-swap or backup event, so the core reads the engine —
  `match_paused` / `match_unpaused` off `cs_gamerules` every 250 ms (a tactical timeout
  names its team, a technical one its kind, a pause the orchestrator asked for is an admin
  pause; a pause is reported when requested, as MatchZy's own chat line is), `side_swap` at
  a round start outside warmup when the rostered team A stands on the other side (a knife
  winner's `.switch`, halftime) or, with nobody rostered, when the engine flagged the swap,
  and 1.5 s after each live round start the newest `MatchZyDataBackup/matchzy_<matchid>_<map>_round<NN>.json`
  as a `backup` frame (restores to round `NN + 1`) plus `backup_written`, the remote-log
  header value scrubbed out of MatchZy's serialised config first. A restore re-points the
  remote log after loading the file (T14).
- **Bots on the wire.** The vocabulary names a player by a 17-digit SteamID64 and a bot
  has none, so a bot is `90000000000000000 + slot` (`BotIdentity` in the SDK): stable for
  its connection, obviously synthetic, and a bot's death is a real event in a match bots
  play.
- **`release` → unload.** The plugins it enabled are unloaded in reverse, the match config
  removed, the server goes back to the lobby map, state `idle`.
- **Commands over the link.** `announce`, `kick`, `rcon` and `profile` are answered by the
  runtime; for a `matchzy` flow `pause` and `unpause` are MatchZy's `css_forcepause` /
  `css_forceunpause`; `restart_round`, `force_end`, `restore` and `reroll` are the flow
  owner's (the mode, or T14 for `restore`) and `command_unsupported` until then.
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
| `ezpug_restore <file> <round>` | loads a round backup already on disk under `game/csgo` by file name (`mp_backup_restore_load_file`). The whole recovery flow — the backup arriving in the assignment, written here, `server_ready` re-announced with the round — is T14 and builds on this |

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

The mode is a `Gamemode` (`docs/sdk.md`); its plugin is five lines:

```csharp
public sealed class PowerupDmPlugin : GamemodePlugin
{
    public override string ModuleName => "EZPug.PowerupDm";
    public override string ModuleVersion => "0.1.0";
    protected override Gamemode CreateMode() => new PowerupDm();
}
```

Build it against `EZPug.Sdk` (a project reference), ship the plugin's dll, `deps.json`
and `pdb` under `plugins/disabled/EZPug.PowerupDm/` — and not `EZPug.Sdk.dll`, which the
host resolves from `shared/`. Name the folder what the manifest's `plugins` says.

## What is not here yet

No dev CS2 container exists before PRD-02 T10, so `CounterStrikeWorld` and `CorePlugin`
(the two files that call CounterStrikeSharp) are checked by compiling against the pinned
API and by the harness tests of everything behind them; the first real-server run is
T13's. `backup` frames (T9/T14), the demo upload (T21), the scoreboard rating (T27), the
skins hand-off (T28) and branding beyond the hostname (T29) are the tasks that name them.
