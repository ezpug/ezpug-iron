# References

Reference material for EZPug Iron planning and Ralph loops. Never imported by code.

## Committed here (our own material)

- `dathost.md` — digested Dathost raw-server API (the endpoints the adapter uses, the
  multipart create, duplicate's sync-files caveat, GSLTs, billing) and our posture;
  `dathost/` holds the vendored page markdown, their index and `openapi.merged.json`
  (every embedded OpenAPI fragment merged — the fake Dathost's schema truth).

## Upstream clones (gitignored — restore locally when needed)

Plain `git clone`s of external repos, kept out of this repo by `.gitignore`. Pin what the
image and the plugins build against in `docs/pins.md` (PRD-02 writes it); cloning latest
is fine for reading.

| Folder | Repo | Notes |
|---|---|---|
| `CounterStrikeSharp/` | https://github.com/roflmuffin/CounterStrikeSharp | docs under `docfx/docs/`; the generated schema classes under `managed/CounterStrikeSharp.API/Generated/` |
| `MatchZy/` | https://github.com/shobhit-pathak/MatchZy | `Events.cs`, `RemoteLogConfig.cs`, `BackupManagement.cs`, `documentation/docs/{event_schema.yml,events_and_forwards.md,developers.md,match_setup.md,gotv.md}` |
| `MatchZy-Enhanced/` | https://github.com/sivert-io/MatchZy-Enhanced | **what the image ships** since PRD-03 T2, at the tag `docs/pins.md` names (`git clone --branch v<pin> --depth 1`). `src/SimulationMode.cs`, `src/ReadySystem.cs`, `src/Utility.cs` (`AreAllConfiguredPlayersConnectedAndOnCorrectTeams`), `src/PublishEvents.cs` (the retry queue), `src/ConfigConvars.cs`. `MatchZy/` beside it stays at 0.8.15 as the thing to read it against. Its own tests run on this box's toolchain: `dotnet test tests/MatchZy.Tests` |
| `cs2-WeaponPaints/` | https://github.com/Nereziel/cs2-WeaponPaints | `WeaponSynchronization.cs` is the data layer the fork replaces |
| `cs2-retakes/` | https://github.com/B3none/cs2-retakes | release 3.1.0 at planning time |
| `legacy/ezpug-game-server/` | git@github.com:ezpug/ezpug-game-server.git (private; also checked out at `/root/counter-strike-pug/ezpug-game-server`) | the 5stack-fork plugin and server image — porting references, never imports |
| `legacy/arena-plugin/` | git@github.com:ezpug/arena-plugin.git (private) | an earlier custom gamemode in C# |

On this box the platform's own clones sit at `/root/ezpug/references/` and can be read
directly.
