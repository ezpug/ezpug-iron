# The EZPug fork of cs2-WeaponPaints — every patch

Upstream: [Nereziel/cs2-WeaponPaints](https://github.com/Nereziel/cs2-WeaponPaints) at
commit `fa8936f3` (tag `build-459`, `ModuleVersion` 3.3a), GPL-3.0 (`LICENSE`, kept
verbatim). `docs/pins.md` and `plugins/vendor/vendored.json` hold the pin.

This is the one vendored plugin this repo patches (`docs/decisions.md` 20, CLAUDE.md), and
this file is the whole diff in words. **The rule:** the data layer changes — where a loadout
comes from — and what could only exist because of the old data layer goes. What the plugin
does with a loadout once it has one (`WeaponAction.cs`, the give/refresh/attribute code,
the item catalogue, the translations) is upstream's, untouched. A bump is: re-clone at the
new commit, re-apply this list top to bottom, re-read `Utility.cs` for a schema change (a
moved column is a `@ezpug/match-api` release, decision 24), rebuild, run the recorded lane.

## Why

Upstream reads a player's cosmetics out of six MySQL tables on connect and on `!wp`, and
writes menu choices back. EZPug's platform owns loadouts and already speaks to every server
over one outbound link; a MySQL server reachable from every cloud gameserver would have
been a second door into the platform's data. So the loadout travels **in the match
request's roster** (and in a `profile` push for somebody who joined open), the core plugin
holds it, and this fork asks the core plugin — `EZPug.Sdk.Hosting.ILoadoutSource`, a
CounterStrikeSharp shared-plugin capability — instead of a database. No MySQL in the
image, none on the internet, and a LAN with no uplink still has skins. The platform's
`Skins.md` §4 records the same decision from its side.

## The data layer

| File | Patch |
| ---- | ----- |
| `WeaponSynchronization.cs` | Rewritten. The constructor takes an `ILoadoutSource?` instead of a `Database`. `GetPlayerData` is synchronous, on the game thread: it asks the source for the player's `Loadout`, maps it with `LoadoutMapper`, and **replaces** the slot's rows (a refreshed profile that dropped a side drops it here too; upstream only ever added). The six `Get*FromDatabase` readers are gone. The seven `Sync*ToDatabase` writers are kept as no-ops with their signatures, so the disconnect hook's StatTrak flush compiles unchanged — nothing on a server writes a loadout; a StatTrak count the plugin bumps in-game is the platform's to persist |
| `EZPug/LoadoutMapper.cs` | **New.** The mapping from `Loadout` to the plugin's rows, pure, so it is tested under xunit (`plugins/WeaponPaints.Tests`). The table below is the schema it mirrors |
| `Database.cs` | Deleted |
| `Utility.cs` | `CheckDatabaseTables` (the `CREATE TABLE`s) deleted with the database; `CreateMenu` deleted with the menus; `CheckVersion` deleted — it fetched upstream's `VERSION` from GitHub at every load, and nothing in this image reaches the network at boot (decision 16). `using Dapper`, `MenuManager`, `Modules.Menu`, `Core.Translations` dropped |
| `Variables.cs` | `Database`, `MenuApi`, `MenuCapability` and `_playerWeaponImage` removed; an `ILoadoutSource? _loadouts` field added; `using MenuManager` → `using EZPug.Sdk.Hosting` |
| `WeaponPaints.cs` | `Load`: finds the source (`LoadoutSource.Find()`, null-safe — without EZPug.Core every player keeps default items and the plugin says so once), subscribes to `LoadoutChanged`, builds `WeaponSync` at once rather than waiting for the next map, and re-reads every connected player on **every** load, not only a hot reload — the core's loader hot-loads this plugin when a match is assigned, sometimes with players standing. `Unload` unsubscribes. `OnConfigParsed`: the database-credentials check, the connection-string builder, `CheckDatabaseTables` and `CheckVersion` are gone; `_localizer` and the banner stay; the gamedata check stays but finds `addons/counterstrikesharp` by name (`CounterStrikeSharpRoot()`) — upstream looked two levels up, which is wrong for a plugin under `plugins/disabled/` and logged a false "upload weaponpaints.json" error on every boot of the dev node while CounterStrikeSharp had already loaded the file. `OnAllPluginsLoaded`: looks for the source once more if the core came later, then `RegisterCommands()` — the six `Setup*Menu` calls are gone. **New** `OnLoadoutChanged`: a `profile` reached the core for a connected, non-bot player → re-read their rows; nothing is forced on them mid-round (the platform's page says "applies on your next connect, or type `!wp`", and that stays true). `ModuleAuthor`/`ModuleDescription` say what this build is |
| `Events.cs` | `OnClientFullConnect` no longer requires a `Database` and calls `GetPlayerData` synchronously instead of `Task.Run`; `OnMapStart` builds `WeaponSync` over the source instead of over the database; `OnTick` and its `ShowSkinImage` registration deleted — the image it drew came only from a menu selection |
| `Commands.cs` | Kept: `!wp` (`OnCommandRefresh`, now a synchronous read so the re-apply that follows sees what was just read — upstream's `Task.Run` never guaranteed that), the console `wp_refresh <steamid64|all>` (`OnCommandSkinRefresh`, same change), the upstream `!kill`. Deleted: the six `Setup*Menu` methods (knife, skins, gloves, agents, music, pins) and their command registrations, `!ws` (`OnCommandWS`: it printed a placeholder website and advertised the menus), `!st` (`OnCommandStattrak`: a toggle nothing would persist) |
| `Config.cs` | `DatabaseHost/Port/User/Password/Name`, `Website`, `MenuType`, `ShowSkinImage` and the menu command lists (`CommandKnife`, `CommandMusic`, `CommandPin`, `CommandGlove`, `CommandAgent`, `CommandStattrak`, `CommandSkin`, `CommandSkinSelection`) removed, so the config CounterStrikeSharp writes advertises nothing that does not exist. **`CommandKillEnabled` defaults to `false`**: upstream's suicide command existed so a knife picked from a menu could be re-rendered, and a competitive server hands nobody a free death. A gamemode that wants it turns it on through its plugin config (`pluginConfigs`, `docs/gamemodes.md`) |
| `WeaponPaints.csproj` | Imports `plugins/Directory.Build.props` explicitly (the vendor shield keeps it off every other vendored tree): `net10.0`, the pinned CounterStrikeSharp.API, `TreatWarningsAsErrors` — upstream's `net8.0` / 1.0.367 could not reference `EZPug.Sdk`. `Dapper`, `MySqlConnector` and the `MenuManagerApi.dll` reference removed; `EZPug.Sdk` added with `Private=false` (one copy, in `shared/`). `data\*.*` copied to the output |
| `data/` | **New in the tree:** `skins_en.json`, `gloves_en.json`, `agents_en.json`, `music_en.json`, `collectibles_en.json` — the item catalogue upstream's release workflow copies out of `website/data/` at publish time (`.github/workflows/build.yml`). The `legacy_model` flag per paint decides a weapon's body group, so a build without them renders older finishes wrong; `Load` reads them and throws without two of them |
| not vendored | `website/` (the PHP site over the same MySQL — 85 MB of catalogue in 28 languages and a Steam login; the platform's skins page is that site), `3rd_party/MenuManagerApi.dll`, `.github/`, the `.sln` and its `.DotSettings.user`. Everything else — `WeaponAction.cs`, `WeaponInfo.cs`, `PlayerInfo.cs`, `PlayerExtensions.cs`, `Patches/`, `gamedata/`, `lang/`, `README.md`, `VERSION`, `LICENSE` — is byte-identical to the commit |

`README.md` is upstream's and describes upstream: MySQL, the website, the menus. It is
kept because it is theirs; this file is ours.

## The schema, as `LoadoutMapper` mirrors it

The pinned commit's `Utility.cs` created these tables; `Loadout` in `@ezpug/match-api`
(`packages/match-api/src/resources/loadout.ts`) is a mapping of them, and the mapper puts
each field back where the reader put each column.

| Table (`Utility.cs`) | Column | `Loadout` field | The plugin's row |
| -------------------- | ------ | --------------- | ---------------- |
| every table | `weapon_team` `2` / `3` | the `t` / `ct` block | `CsTeam.Terrorist` / `CsTeam.CounterTerrorist` (`LOADOUT_SIDE_TEAM_NUMBER` in the Match API; upstream copied a `0` row to both sides — the Match API has no such row) |
| `wp_player_skins` | `weapon_defindex` | `weapons[].defindex` | the key in `GPlayerWeaponsInfo[slot][team]` |
| | `weapon_paint_id`, `weapon_wear`, `weapon_seed`, `weapon_nametag`, `weapon_stattrak`, `weapon_stattrak_count` | `paintId`, `wear`, `seed`, `nametag`, `stattrak`, `stattrakCount` | `WeaponInfo.Paint/Wear/Seed/Nametag/StatTrak/StatTrakCount` |
| | `weapon_sticker_0..4` = `id;schema;x;y;wear;scale;rotation` | `stickers[]` (occupied slots, in order, ≤5) | `WeaponInfo.Stickers` |
| | `weapon_keychain` = `id;x;y;z;seed` (default `0;0;0;0;0`) | `keychain?` | `WeaponInfo.KeyChain` — zeros when absent, as the reader produced from the default |
| `wp_player_knife` | `knife` | `knife` | `GPlayersKnife[slot][team]` |
| `wp_player_gloves` | `weapon_defindex` | `gloves` | `GPlayersGlove[slot][team]` (`ushort`) |
| `wp_player_agents` | `agent_ct`, `agent_t` (one row per player) | `ct.agent`, `t.agent` | `GPlayersAgent[slot] = (CT, T)` |
| `wp_player_music` | `music_id` | `music` | `GPlayersMusic[slot][team]` (`ushort`) |
| `wp_player_pins` | `id` | `pin` | `GPlayersPin[slot][team]` (`ushort`) |

The feature flags (`KnifeEnabled`, `GloveEnabled`, `AgentEnabled`, `MusicEnabled`,
`SkinEnabled`, `PinsEnabled`) gate each row as they gated each query. A value the plugin
holds narrower than the wire is clamped, never thrown on — skins may never touch match flow.

## `FollowCS2ServerGuidelines: false`

Upstream's README asks for it and this fork still needs it: CounterStrikeSharp refuses to
touch the inventory and attribute fields the plugin writes while the flag is on. The image
already turns it off for the scoreboard rating (PRD-02 T27), so nothing changes for skins —
but the risk is the same and it is written down once, in `docs/operations.md`: a server
that flouts Valve's guidelines can be refused a GSLT, which would cost the Dathost half of
the fleet its public listing. We accept it knowingly, on a private league's servers, and
the flag is the kill switch if that calculus changes (the platform's `Skins.md` §4).

## What is deliberately not here

- **No writer.** A loadout is the platform's; nothing on a server persists one.
- **No per-match config from the orchestrator yet.** The fork runs on the defaults above;
  `pluginConfigs` is the door if a mode ever needs one (`docs/gamemodes.md`).
- **Bots keep default items**, exactly as upstream: every apply path checks `IsBot`, and
  this repo does not patch what the plugin does with a loadout. A bots run therefore proves
  the hand-off (the core's `skins:` console lines) and not the pixels.
