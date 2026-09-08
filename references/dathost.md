# Dathost — the raw server API, as EZPug uses it

Digest of the Dathost API pages vendored under `references/dathost/pages/` (fetched
2026-09-05 from `https://dathost.readme.io/<page>.md`; `references/dathost/index.txt` is
their index and `references/dathost/openapi.merged.json` merges every embedded OpenAPI
fragment into one document the fake Dathost validates its responses against). Match.md §3
decided the **raw server API, not the match API**: we orchestrate MatchZy ourselves so a
Dathost server and a LAN node behave identically and our plugin runs on both. The
`cs2-matches` pages are kept for the record only.

## Facts

- **Base URL** `https://dathost.net/api/0.1`. **Auth** is HTTP Basic with the account's
  login email and password on every request (`EZPUG_DATHOST_EMAIL` / `EZPUG_DATHOST_PASSWORD`,
  process env only — never a log line, never a fixture). Rate limits are not documented;
  the adapter backs off on 429 and 5xx and never hammers `GET` in a tight loop.
- **Location** for Frankfurt is the id `dusseldorf` (`server-locations-mapping.md`). Region
  is a label on the offering; Match.md fixes one region.
- **Create** (`POST /game-servers`) is **multipart form data**, not JSON. Fields we care
  about: `game=cs2`, `location`, `name`, `user_data` (free text Dathost ignores — where
  the platform match id rides so `list` can attribute a server), `autostop` (off: the
  reaper is ours), `reboot_on_crash` (off: a crash is a `server_lost` we want to see),
  `deletion_protection` (on for the template, off for clones), `max_disk_usage_gb`,
  `cs2_settings.*`: `rcon`, `password`, `slots`, `enable_gotv`, `enable_metamod` (their
  managed Metamod — we ship our own Metamod + CounterStrikeSharp in the image and leave this
  off unless the image script finds otherwise), `game_mode=competitive`, `insecure`,
  `maps_source` / `mapgroup` / `workshop_*` (workshop maps: `api-added-cs2-workshop-support.md`),
  `steam_game_server_login_token` (GSLT — see below).
- **Duplicate** (`POST /game-servers/{id}/duplicate`) copies settings *and files* from the
  API's local cache of the source — call `POST …/sync-files` on the template after every
  image change and before cloning, or the clone runs yesterday's plugin. Optional
  `location`; optional destination id wipes an existing server instead of creating one.
  Returns the new server object. This is `allocate`.
- **Start** (`POST …/start`) reboots a server that is already on. **Stop**, **Delete**
  (refused while `deletion_protection` is set — clones never set it). `deallocate` = stop +
  delete, idempotent on 404.
- **Get** (`GET /game-servers/{id}`) refreshes `booting` before answering; **List**
  (`GET /game-servers`) does not — a listed server may show `booting: true` after it
  finished. `status()` therefore reads the single item. Fields the adapter reads: `id`,
  `ip`, `raw_ip`, `ports` (game + GOTV — confirm the exact shape against a live GET in
  the smoke), `on`, `booting`, `server_error`, `players_online`, `cost_per_hour`,
  `user_data`, `match_id` (their match API — must stay empty for us), `cs2_settings.rcon`,
  `cs2_settings.password`, `cs2_settings.enable_gotv`, `duplicate_source_server`.
  **A cs2 `POST /game-servers` needs `cs2_settings.rcon`**, and a create the vendor
  refuses comes back as a **200 with a plain-text sentence** (`cs2_settings.rcon needs to
  be set`, seen 2026-09-08) and no server — a 2xx is a server only once the body is JSON
  with an `id`.
- **Files**: `GET …/files` lists, `GET …/files/{path}` downloads (a directory comes back as
  a zip), `POST …/files/{path}` uploads one file (multipart `file`, **100 MB limit**, a
  trailing `/` creates a directory), `PUT …/files/{path}` moves. Paths are relative to the
  game root as the control panel shows them (`cfg/server.cfg`, `addons/…`).
- **Console**: `POST …/console` with `line` sends one console line (this is how the
  platform reaches the plugin's `ezpug_*` commands and MatchZy's `matchzy_*` cvars on a
  Dathost server without opening RCON); `GET …/console` returns the last backlog lines.
- **Metrics** (`GET …/metrics`), **Account** (`GET /account`): balance and identity, read
  by the health tile and the live smoke's preflight.
- **Billing**: pay-as-you-go servers carry `cost_per_hour` while on; a stopped-but-undeleted
  server is still a server on the account. The reaper's definition of "deallocated" is
  *deleted*, and every allocation row in the ledger snapshots `cost_per_hour` at allocate.
- **GSLT**: since Valve's October 2023 change a CS2 server without a
  `steam_game_server_login_token` accepts **LAN connections only**
  (`api-added-cs2-game-server-login-tokens.md`). One token per running server — a token in
  use on two servers at once evicts the first. Tokens are minted per app 730 through the
  Steam Web API `IGameServersService` (`CreateAccount`, `DeleteAccount`, `ResetLoginToken`,
  `GetAccountList`) with the same `STEAM_WEB_API_KEY` the login already holds; the platform
  keeps a small pool and leases one per allocation.

## EZPug posture

- The **template server** is built once by `scripts/dathost-image.*` (Metamod, CounterStrikeSharp,
  MatchZy at its pinned release, the EZPug plugin, our cfgs) and named in
  `EZPUG_DATHOST_TEMPLATE_SERVER_ID`. Allocation is `duplicate` + `start`; teardown is
  `stop` + `delete`. The template is never started for a match and never deleted by code.
- Nothing downstream of `packages/game/src/dathost/` knows Dathost exists; the match core,
  channels and pages see `source.provider` as a badge and nothing else.
- Live tests run only behind `EZPUG_DATHOST_TESTS=required`, allocate at most one server,
  and deallocate in `finally`. A live task that leaves a server running is a P1.
