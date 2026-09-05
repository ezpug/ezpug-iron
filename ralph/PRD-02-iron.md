# PRD 02: The iron

The spine published `@ezpug/match-api`: a contract, a fake that honours it, fixtures that
pin it. This round makes it true on real hardware. The **orchestrator** behind
`gs.ezpug.com` takes a match request and ends it on a running CS2 server — cloned on
**Dathost** from a template this repo builds, or started by an **`ezpug-node`** agent on a
box at the venue — with the **EZPug core plugin** dialling home over one outbound link,
speaking the vocabulary natively, loading whatever the **gamemode manifest** names:
stock **MatchZy** for `pug`, a cfg for `flying-scoutsman`, the community **retakes**
plugin, or **`powerup-dm`**, an original mode written on the new **`EZPug.Sdk`** whose
players pick a power-up on their phone through a widget built with the **gamemode-kit**.
Demos land in the platform's bucket, a server that dies comes back from its backup on the
next candidate, every server is a ledger row that closes inside a budget, EZ Rating shows
on the scoreboard, skins arrive over the link with no database in the open, and a CLI
gives an operator every lever. The round's proofs are bots playing a real match on Dathost
through `gs.ezpug.com`, and a node on this box taking a `lan` request. Runs in parallel
with the platform's `PRD-09-iron-platform.md`, which consumes the package this round
serves. Delivers decisions 2, 5, 7, 10–13, 15, 16, 18–23.

**Branch:** `main`. **Surface:** the whole repo. **Model:** `claude-opus-5`; tasks tagged
`(fable)` run on Fable 5.1. **Budgets:** **one additive migration per task that needs one,
designed in T2 so most never do**; the Dathost account has a hard spending cap set by
the owner and every live task allocates at most one server, deallocates in `finally`, and
is bounded to one server-hour — a server left running is a P1 written in the progress
file before the next task; `EZPUG_CS2_TESTS=required` demands the dev-server lane and
`EZPUG_DATHOST_TESTS=required` the live smoke, both skipped with a printed reason when
their world is absent. **Contract:** `@ezpug/match-api` changes only additively, each
change a release with a changelog line; the platform loop learns by bumping its pin.

## Findings

Traced 2026-09-05. Trust the file over this note; the platform checkout is at `/root/ezpug`
(read, never import), the legacy 5stack fork at `/root/counter-strike-pug`.

**What the spine leaves ready** (see its closing note first): `packages/match-api` (routes,
envelope, stream frames, manifest, the fake, `fixtures/recorded/*.json`, the conformance
runner), `packages/sim` (the engine with `crash`/`restore`), `packages/core` (clock, prng,
chaos, `eventually`), `plugins/EZPug.sln` with an empty SDK and the verify wrapper,
`docs/match-api.md`, `docs/gamemodes.md`, `docs/pins.md`, `gamemodes/*/manifest.json`.

**What moves here from the platform** (ports, then the platform deletes its copies):
- The provider interface and its rules: `/root/ezpug/packages/game/src/provider.ts:203-258`
  (`offerings`, `allocate`, `configure`, `start`, `stop`, `status`, `deallocate`
  idempotent, `list`, `fetchDemo`, `announce`; `offeringMatches` `:248`), the registry
  `registry.ts:10-33`, selection `selection.ts:26-94` (`selectCandidates`,
  `cheapestSuitable` `:29`, `lanFirst` `:33`), the reaper `reaper.ts` (orphans after a
  grace window, lost servers surfaced), the provisioning walk
  `/root/ezpug/apps/api/src/match/provisioning.ts:87-181` (`tryCandidate` per candidate,
  `deallocateQuietly`, exhaustion → `allocation_failed`), the recovery window and probe
  `apps/api/src/match/machine.ts:64-73,229-247,351-374` and `ingestion.ts:330-380`.
- The config builders, pure and golden-tested: `packages/game/src/match-config.ts`
  (`buildMatchZyConfig` `:346-381` writes the remote-log and header cvars `:354-356`,
  `buildGet5Config` `:423-450`, `buildMatchConfig` `:460`), fixtures
  `packages/game/src/fixtures/{matchzy-ranked-bo1,matchzy-knife-bo3,get5-ranked-bo1}.json`.
- The demo pipeline's expectations: `apps/api/src/match/demos.ts` (provider `fetchDemo`
  first, the event's `url` second; `demoObjectKey()` in `packages/storage/src/keys.ts:62-70`),
  the simulated record's content type `packages/game/src/simulator/record.ts`.

**What the plugin can copy** (porting references, never imports):
- `/root/counter-strike-pug/ezpug-game-server/src/FiveStack.Events/*.cs` — every hook the
  live tier needs (`PlayerKills.cs` `EventPlayerDeath`, `Bomb.cs`, `RoundStart/End.cs`,
  `PlayerConnected/Disconnected.cs`, `PlayerChat.cs`, `PlayerDamage.cs`);
  `FiveStack.Services/MatchEvents.cs` (an outbound `ClientWebSocket` with reconnect and a
  queued publish: `PublishGameEvent` `:74`, the envelope `:98`, `Connect` `:185`, the
  reconnect loop `:137-170`); `GameBackUpRounds.cs` (`RestoreRound` `:278-330`: write the
  backup, `mp_restartgame 1; mp_pause_match`, `mp_backup_restore_load_file`);
  `GameDemos.cs` (`tv_record` `:79`, `tv_stoprecord` `:95`, `UploadDemo` `:130`);
  `FiveStackServiceCollection.cs` (DI in a CounterStrikeSharp plugin);
  `ezpug-game-server/Dockerfile` (steamrt `sniper` base, .NET 8 SDK build stage, steamcmd
  app 730 into a data volume, Metamod + CounterStrikeSharp pinned by URL, the launch line
  `-dedicated -usercon +rcon_password … +tv_port …`) with `scripts/server.sh` and
  `scripts/setup.sh`; `ezpug-game-server-node-connector/src/rcon/rcon.service.ts` (Source
  RCON from Node with `rcon-client`).
- `references/CounterStrikeSharp/` (clone; `docfx/docs/features/{game-events,
  global-listeners,console-commands,console-variables,shared-plugin-api}.md`,
  `guides/{hello-world-plugin,dependency-injection,referencing-players}.md`;
  `managed/CounterStrikeSharp.API/Generated/Schema/Classes/CCSPlayerController.g.cs`
  carries `CompetitiveRanking` and `CompetitiveRankType` — decision 21's scoreboard door;
  `css_plugins load|unload|reload` are the hot-load commands). NuGet 1.0.373; the legacy
  plugin pinned 1.0.367 and compiled under `sniper`.
- `references/MatchZy/` (0.8.15): `Events.cs:4-235` (the remote-log events),
  `documentation/docs/events_and_forwards.md` + `developers.md` (**in-process forwards** —
  decision 19 prefers them over the HTTP remote log where they cover an event),
  `RemoteLogConfig.cs:9-42`, `ConfigConvars.cs:137-146` (`matchzy_demo_upload_url` posts a
  form with headers — which is why the core plugin owns the upload, decision 10),
  `BackupManagement.cs`, `documentation/docs/{commands,configuration,gotv,match_setup}.md`.
- `references/cs2-retakes/` (3.1.0): `retakes_config.json` (GameSettings, QueueSettings,
  `ShouldAutoJoinGame`), per-map spawn configs in the release zip, allocator plugins the
  README lists (one is chosen and vendored), `@css/vip` flags.
- `references/cs2-WeaponPaints/`: `WeaponSynchronization.cs` (629 lines) is the data
  layer — `GetPlayerData` `:20` fans out to `GetKnifeFromDatabase` `:46`,
  `GetGloveFromDatabase` `:91`, `GetAgentFromDatabase` `:135`, `GetWeaponPaintsFromDatabase`
  `:163`, `GetMusicFromDatabase` `:298`, `GetPinsFromDatabase` `:343`, and the
  `Sync*ToDatabase` writers `:388-565` (unused once in-game menus are off);
  `Database.cs` (22 lines) is the connection; `Utility.cs` the schema; `README.md`
  (`FollowCS2ServerGuidelines`, the `!wp` refresh, the MenuManager dependency chain the
  platform's Skins.md §3 switches off).
- `references/dathost.md` + `references/dathost/openapi.merged.json` (the fake's schema
  truth): Basic auth, multipart create with `cs2_settings.*`, `duplicate` needs
  `sync-files` first, `start` reboots, `GET` refreshes `booting` while list does not,
  files 100 MB limit, console `line`, Frankfurt = location `dusseldorf`, one GSLT per
  running server, `user_data` for our tag.
- The legacy org repos `ezpug/ezpug-gamemode` and `ezpug/arena-plugin` (private, C#,
  `gh repo clone` into `references/legacy/`) — earlier custom modes worth a read before
  the SDK's lifecycle is fixed.

**The box.** Ports decided in `.env.example` (orchestrator 3430 dev / 3431 prod bind,
Postgres 5443, Redis 6383, CS2 27415 + GOTV 27420 — nothing listens on UDP 27000–27999
today); 211 GB free; no steamrt image or CS2 install exists yet (~35–40 GB, one download
into the `cs2-data` volume); Traefik file provider over `/opt/traefik/routes/`,
`*.ezpug.com` is a wildcard A record, the platform's `docker/traefik/ezpug.yml` is the
pattern (routers, `letsencrypt` resolver, a per-project redirect middleware name); the
platform's `scripts/deploy.sh` (830 lines: preflight → build → migrate → up → routes →
smoke, `:previous` images, rollback, backup) is the shape ours copies at a fifth of the
size. The platform's dev MinIO presigns PUTs at `127.0.0.1:9400` — the demo target for
every offline proof here.

## Attitude

- **One link, everything on it.** A server's only relationship with the world is its
  outbound WebSocket to the orchestrator: assignment in, events and heartbeats out,
  commands in, results out, profiles in, player commands in. A Dathost server and a node
  server are indistinguishable once connected; providers only differ in how a server gets
  *started* and *stopped*. RCON and the Dathost console are for a human and for the
  moment before the link is up.
- **The SDK is the product; a gamemode is a class and a manifest.** Anything two modes
  would both write lives in `EZPug.Sdk` behind the `IGameWorld` seam; a gamemode never
  touches a CounterStrikeSharp type directly and is tested by the harness without CS2.
  When a mode needs a hook the seam lacks, the seam grows once, with a fake, with a test.
- **Stock vendors, pinned, hot-loaded.** MatchZy, retakes and the allocator run as they
  ship; the WeaponPaints fork changes exactly one layer. `docs/pins.md` is the one place a
  version lives, the image and the template script both read it, and upgrading is a
  commit that re-runs the recorded lanes.
- **The ledger is the truth and the budget is a wall.** Allocation writes a row before the
  provider returns; the reaper reconciles provider truth against rows; an API key cannot
  exceed its concurrency, lifetime or monthly ceiling whatever the client says. "What is
  running" and "what did tonight cost" are one query each, and green on the platform's
  health tile is that query returning empty.
- **Recovery is a flow, proved on the simulator first.** Backups cross the link as they
  are written; a lost server's match resumes on the next candidate with the backup;
  a crash without one ends honestly with what was recorded. Both paths run in the
  fault-injection suite every extended tier, long before a real box dies.
- **The dev box is a real self-hosted deployment.** The dev CS2 container runs under the
  same `ezpug-node` agent a venue will run, enrolled with the same token flow against the
  dev orchestrator; bots play real matches there and record the fixtures that pin every
  shape. The loop can see everything but the pixels, and it says when a check was visual.
- **Written for strangers.** Public repo: doc comments explain why, secrets never exist
  in the tree, the README installs on a fresh machine, and `ezpug-iron --help` is enough
  for an operator who has never read the code.

## Tasks

**Rails**

- [x] **T1 (fable): The wire protocols, in two languages.** `packages/protocol` (internal,
  not published): the **server link** — server → orchestrator `hello` (server token,
  plugin/SDK/MatchZy/CSS versions, capabilities, hostname, current map), `heartbeat`,
  `state` (`booting | idle | assigned | live | ending | draining`), `events` (a batch of
  union events with per-server `seq`), `command_result`, `backup` (name, round, content),
  `console` (a bounded tail of lines, on demand), `player_command_result`; orchestrator →
  server `welcome` (server id, heartbeat interval, protocol version), `assign` (match id,
  gamemode manifest resolved, the plugin set to enable, cfg, cvars, the MatchZy config
  JSON when `flow: matchzy`, roster with profiles and loadouts, warmup lines, branding,
  demo upload URL, `restore?` with a backup), `command`, `player_command` (from a widget),
  `profile` (one player's profile, for open-join), `release`, `drain`, `ack` (per event
  `accepted | duplicate`). The **node link** — node → orchestrator `hello` (enrolment or
  node token, labels, capacity, image digest), `heartbeat`, `instances` (state of each
  container); orchestrator → node `start` (instance spec: image, ports, server token,
  env), `stop`, `drain`, `welcome`. Versioned constants, discriminated unions, every
  frame a Zod schema; `scripts/protocol-schema.mjs` exports JSON Schema; `dotnet` codegen
  (NJsonSchema or quicktype, decided by reading both) into
  `plugins/EZPug.Sdk/Generated/*.g.cs` on `pnpm build`, committed, with a check that a
  regenerate is a no-op; xunit round-trips the spine's recorded union events and a new
  `packages/protocol/fixtures/*.json` set byte-for-byte. References: decision 5, the
  legacy `MatchEvents.cs` envelope, the platform's ack vocabulary in
  `@ezpug/match-api`.

- [x] **T2 (fable): The orchestrator, standing.** `apps/orchestrator`: Hono on 3430,
  Drizzle over Postgres 5443, Redis 6383, `compose.yaml` + `scripts/dev-env.sh`
  (`pnpm dev:up|down|logs|status`), a shutdown that drains in the order it opened things,
  health at `/healthz` (db, redis, providers). **The schema, designed once** (the round's
  first additive migration; later tasks add tables only when this note names none):
  `api_keys` (hash, scopes, budgets, fleet webhook URL + secret, created/revoked),
  `matches` (the Match API resource + `clientMatchId` unique per key + provider handle +
  `requestJson`), `match_events` (per-match log, `seq` unique per match, the envelope
  payload, `deliveryId`), `webhook_deliveries` (attempt, next try, status),
  `servers` (the ledger: provider, serverId, matchId, state, connect facts, cost/hour
  snapshot, gslt id, tokens' hashes, timestamps), `server_tokens`, `nodes`,
  `node_enrolments`, `gslt_tokens`, `backups` (match, round, name, content — small text,
  latest N per match), `player_tokens`. API-key auth with scopes, per-key rate limits,
  request logging without secrets, the migration lint guard from the platform's
  `packages/db` posture (expand → migrate → contract). `docs/operations.md` starts.
  References: `/root/ezpug/apps/api/src/{shutdown-steps.ts,origins.ts}`,
  `/root/ezpug/packages/db/README.md`, the spine's `docs/match-api.md`.

- [x] **T3 (fable): Providers, the match machine, webhooks and the stream.** The provider
  interface (ported from the platform, grown: `rcon`, `restore`, `console`), the
  registry, selection (capability match on `game`, `region`, `workshopMaps`, `lan`;
  ordering `lan` requested → nodes first, else cheapest; `simulated` → sim only; **the
  sim is never chosen unless asked when any real provider is registered**, and is the
  honest fallback when none is), the **match machine** (`pending → allocating →
  configuring → ready → live → ended | failed | cancelled`, `recovering` from `live`;
  deadlines on the clock: allocate, boot, join, recovery window), the provisioning walk
  (row before provider, next candidate on failure, exhaustion → `failed:
  no_capable_server`), the reaper (rows vs provider `list()`, lifetime ceilings, grace),
  the **webhook worker** (the spine's retry schedule, signatures, `410` stops, per-key
  fleet webhooks), `GET /v1/matches/:id/events?cursor=`, the **stream hub**
  (`/v1/matches/:id/stream`, `hello.seq`, ticks best-effort, one hub per process with
  Redis fan-out so two replicas would still work). Every Match API route from the spine
  served; the **conformance suite passes against the real service** with the sim
  provider — the round's first extended-tier gate. References: the platform files in
  Findings (walk, machine, reaper, probe), `packages/match-api`.

- [x] **T4: The sim provider and the dev image.** `packages/sim` behind the provider
  interface (`sim.*` commands allowed only on its servers; `timeScale`, `step`, `chaos`,
  `kill`, `restore`), registered when `EZPUG_IRON_PROVIDERS` includes `sim` (dev default).
  `docker/orchestrator/Dockerfile` (multi-stage, non-root, healthcheck) and the **dev
  contract the platform's compose relies on**: image
  `ghcr.io/ezpug/ezpug-iron/orchestrator:<tag>`, env `EZPUG_IRON_PROVIDERS=sim`,
  `EZPUG_IRON_BOOTSTRAP_API_KEY` (a dev-only key created at boot when set — refused in
  production), `EZPUG_IRON_PUBLIC_URL`, database/redis URLs; documented in
  `docs/operations.md` under "running it inside another project's dev world". A local
  build tag (`:dev`) works before any publish.

- [ ] **T5: Budgets and keys.** Per-key `maxConcurrentServers`, `maxServerMinutes`,
  `monthlyCentsCeiling` with the month's spend from the ledger (cost snapshot × uptime,
  live rows included), `budget_exceeded` refusals, `fleet.budget_threshold` at 50/80/100 %,
  the `keys` routes (create → key shown once, rotate, revoke, budgets patch; `admin`
  scope), a `GET /v1/fleet/budget` a health tile can draw. Tests on the fake Dathost's
  prices and a fake clock crossing a month boundary.

- [ ] **T6 (fable): The link.** `/link` on the orchestrator: a raw `ws` upgrade beside
  Hono (attach listeners before awaiting anything — the Socket.IO lesson the platform
  learned), server-token auth, T1's protocol, per-server `seq` dedup, ack per event,
  batches applied in order, heartbeat → `servers.lastSeenAt`, silence past two intervals
  → provider `status` → `recovering` or `failed`; `assign` composed from the match, the
  manifest and the request; commands and player commands relayed by correlation id with
  deadlines; `backup` frames persisted; `console` tail cached for the fleet console route.
  **The fake server** `packages/protocol/src/fake-server.ts` speaks the protocol from
  TypeScript and is what every orchestrator test connects; its exchanges are recorded
  under `packages/protocol/fixtures/link/*.json` and are the same files the C# client is
  proven against. References: decision 5, `/root/ezpug/packages/realtime/src/sync.test.ts`
  (the listener regression), legacy `MatchEvents.cs`.

**The SDK and the core plugin**

- [ ] **T7 (fable): `EZPug.Sdk`.** The seams: `IGameWorld` (players with SteamID64, slot,
  team, alive, position; say/print/center/HUD; give/strip; respawn; timers on `IClock`;
  exec cfg; cvar get/set; changelevel and workshop map; entity minimum for a power-up),
  `IPlatformLink` (emit union event, receive assignment/command/player command/profile,
  report state), `Gamemode` base (`OnAssigned(Assignment)`, `OnStart`, `OnPlayerJoined`,
  `OnPlayerLeft`, `OnRoundStart/End`, `OnPlayerCommand(player, command, args)`, `OnTick`,
  `OnEnd`, `Emit(...)`), `PlayerState<T>` keyed by SteamID64, `Commands` declared from the
  manifest (cooldowns and charges enforced in the SDK, never trusted to the phone),
  `Localizer` (DE/EN resx, the player's locale from the profile, German default), the
  **link client** (`ClientWebSocket`, reconnect with capped backoff, an on-disk buffer of
  unacked events with `seq`, at-least-once delivery, T1's generated types), the sidecar
  reader (`ezpug.json` or env). **The harness**: `FakeGameWorld` + `GamemodeTestHost` run a
  mode under xunit on a fake clock with scripted players; `FakePlatformLink` asserts the
  exact events emitted. Generated types from T1 round-trip the link fixtures. `docs/sdk.md`
  starts: how to write a mode in fifty lines. References: decision 5 and the "SDK is the
  product" attitude, CounterStrikeSharp docs in Findings, the legacy `FiveStack.Events`.

- [ ] **T8 (fable): `EZPug.Core` — the plugin every server runs.** The thin CounterStrikeSharp
  shell over the SDK: boot → read sidecar → link → `hello`; `assign` → **the gamemode
  loader** (enable the manifest's plugins with `css_plugins load`, exec its cfg, set its
  cvars, `changelevel`/`host_workshop_map`, write the MatchZy config and `matchzy_loadmatch`
  when `flow: matchzy`, hostname from branding) → `state: assigned`; hooks →
  union events (`player_connected` with slot, `player_disconnected`, `player_death` with
  assists/weapon/headshot/flags, `bomb_*`, `chat_message`/`chat_command` by the vocabulary's
  prefix rule, `server_ready` on map start with connect facts, `heartbeat` on the interval
  `welcome` gave); console commands `ezpug_status`, `ezpug_announce <text>`,
  `ezpug_restore <name> <round>`; `release` → unload the mode's plugins, `changelevel` to
  the lobby map, `state: idle`. Match-flow events are **not** emitted here for `flow:
  matchzy` (T9) and **are** for `flow: plugin | none` (T22's generic emitter lives in the
  SDK). Unit tests over the SDK harness; compiles at the pinned CSS; `plugins/README.md`
  says how to install by hand. References: T7, legacy `FiveStackPlugin.cs`,
  `FiveStack.Events/*.cs`.

- [ ] **T9 (fable): `pug` — MatchZy, translated once, and the config builders.** Port the
  platform's `buildMatchZyConfig`/`buildGet5Config` and their goldens into
  `apps/orchestrator/src/match-config/` (input: the Match API request; output: the JSON
  MatchZy loads; the remote-log cvars now point at the orchestrator's `/matchzy/:serverToken`
  door only where forwards do not cover an event). Decide by reading
  `events_and_forwards.md` + `developers.md`: subscribe to MatchZy's **in-process
  forwards** from the core plugin for `going_live`, `round_end`, `map_end` (`map_result`),
  `series_end`, `match_paused/unpaused`, `side_swap`, `backup_written`, translating to the
  union inside the plugin with the vocabulary's rules (1-based rounds, `team_a/team_b`,
  reason codes); fall back to the HTTP remote log translated in the orchestrator for
  anything the forwards lack; the three veto events are dropped (veto is the platform's).
  Golden fixtures from `event_schema.yml` marked `"source": "schema"`, replaced by T13's
  recordings; a test fails if a `schema`-sourced fixture survives past T13. The `pug`
  manifest gains what it needs (`plugins: [MatchZy]`, `flow: matchzy`, `records: demo`).
  References: decision 19, `references/MatchZy/`, the platform's `match-config.ts`.

**The dev iron: image, node, real matches**

- [ ] **T10: The server image.** `docker/cs2/Dockerfile` from the legacy image: steamrt
  `sniper` runtime, steamcmd installs app 730 into the named volume `cs2-data` (one time,
  ~35 GB, gitignored, with a progress line and an honest size warning), Metamod +
  CounterStrikeSharp + MatchZy + retakes + the allocator + the WeaponPaints fork (T28
  fills the slot; a placeholder stage until then) at `docs/pins.md`'s versions, the SDK +
  core plugin + gamemode plugins from `dotnet publish`, the `cfg/` set (`gamemodes/*/cfg`
  mounted by name), an entrypoint that reads `EZPUG_IRON_URL` + `EZPUG_SERVER_TOKEN` (or
  `ezpug.json`) and the launch line (`-dedicated -usercon +tv_port … +sv_hibernate_when_empty 0`),
  bots allowed, no GSLT (LAN). `compose.cs2.yaml` (ports 27415/27420 decided in
  `.env.example`), `pnpm cs2:install|build|up|down|logs|console`. The image is also what
  ghcr publishes for nodes (T34) and what T18 uploads the plugin set from. References:
  legacy `Dockerfile`, `scripts/server.sh`, `scripts/setup.sh`.

- [ ] **T11 (fable): `ezpug-node`.** `apps/node`: one process (and a container image) on
  any docker host — enrol once with a one-time token (`ezpug-node enrol <token>`), then
  `hello` with labels (`region`, `lan: true`, tickrate, cores), capacity (`maxInstances`),
  the image digest it holds; on `start` it runs a server container from the image with
  the spec's ports, env and server token, on `stop` it removes it; a **warm pool** of N
  idle instances (`EZPUG_NODE_WARM`) already dialled in so a `lan` request is ready in
  seconds; `instances` reports every container's state; drain finishes live matches and
  starts nothing; reconnect with backoff; a `dockerode` port with a **fake docker** for
  tests. A node that dies mid-match is a server that dies mid-match (T14). `docs/nodes.md`:
  install on a venue box in five commands. References: decision 23, T1's node link.

- [ ] **T12: The node provider and enrolment.** In the orchestrator: `nodes` as a provider
  (`offerings()` = one offering per connected, undrained node with free capacity, cost 0,
  `lan: true`, region from labels; a disconnected node advertises 0 and never disappears),
  `allocate` = pick a warm instance or `start` one, `deallocate` = `stop`, the enrolment
  routes (`POST /v1/fleet/nodes` → token **shown once**, `DELETE` revokes and closes the
  socket, `drain`/`undrain`), `fleet.node_disconnected` (critical while it holds a live
  match). Tests on the fake node. The dev world: `pnpm dev:up` now also starts
  `ezpug-node` on this box (host network, the dev image) enrolled against the dev
  orchestrator, so **the dev CS2 server is a real node in a real pool**.

- [ ] **T13: Bots play a real match — the recorded fixtures.** `scripts/iron-match.mjs`
  (through the Match API with the dev key): a `pug` request with `requirements.lan`,
  `mp_maxrounds 4`, no overtime, `bot_quota 10`, MatchZy in unrostered mode
  (`matchzy_minimum_ready_required 0`), `.start` by command — and **record everything**:
  every link frame, every MatchZy forward/remote-log payload, every union event, every
  webhook and stream frame, scrubbed (tokens, passwords, addresses; timestamps relative)
  into `packages/protocol/fixtures/recorded/*.json` and `packages/match-api`'s recorded set
  as `real-*` files. T9's schema goldens flip to `recorded`; a `match-api` test asserts
  every recorded event still parses; the **`EZPUG_CS2_TESTS` lane**: bring the match up
  through the node, wait for `match.ended` and `demo.uploaded` (to the platform's dev
  MinIO via a presigned PUT the script mints), assert the ledger row closed — the round's
  offline proof that plugin, MatchZy, orchestrator and contract agree. References:
  `references/MatchZy/documentation/docs/match_setup.md`, `commands.md`.

- [ ] **T14 (fable): A server that dies comes back.** `backup` frames persisted per round;
  on `recovering` the walk resumes from the next candidate with `assign.restore` (the
  backup content and round) → the core plugin writes the file and runs MatchZy's restore
  (`mp_backup_restore_load_file`, legacy `RestoreRound`), players get the same connect
  facts re-announced through `match.server_ready` (with `restored: true, round: N`), the
  join deadline re-arms, `match.recovered` closes the window; no backup or the window
  expires → `match.failed: server_lost` with everything recorded kept; the reaper
  deallocates the corpse. The sim's `crash`/`restore` run the whole flow offline; the
  node's "container vanished" and the fake Dathost's "server vanished" run it too.
  Extended tier; T32 hammers it. References: the platform's machine/probe lines in
  Findings, `references/MatchZy/BackupManagement.cs`.

**Dathost**

- [ ] **T15: The fake Dathost.** `apps/orchestrator/src/providers/dathost/fake.ts` — an
  in-process HTTP server speaking the vendored subset of `references/dathost/openapi.merged.json`:
  `GET/POST /game-servers`, `GET/PUT/DELETE /game-servers/:id`, `duplicate` (the
  sync-files caveat modelled: a clone copies the *last synced* files), `sync-files`, `start`
  (reboots if on), `stop`, `console` (GET backlog + POST line), `files` list/download/upload
  (multipart, the 100 MB refusal), `metrics`, `account`. Basic auth checked, `booting` →
  `on` on the injected clock, faults: 429, 500, a boot that never ends, a server that
  vanishes, a console that times out. Every response validated against the merged OpenAPI
  schemas in a test. References: `references/dathost.md`.

- [ ] **T16: The Dathost provider.** `createDathostProvider({email, password,
  templateServerId, location, clock, fetch})`: `offerings()` (cs2, `frankfurt` behind
  `dusseldorf`, `workshopMaps`, cost from the template's `cost_per_hour`); `allocate` =
  `sync-files` when stale → `duplicate` with our tag in `user_data` and a readable name →
  GSLT lease (T17) + fresh RCON and join passwords → **upload `ezpug.json` (orchestrator
  URL, server token)** → `start`; the server dials in and the link takes over;
  `status` from the single GET (`gone` on 404); `stop`/`deallocate` = stop + delete,
  idempotent; `list` = servers carrying our tag; `rcon`/`console` over the console
  endpoint for the moment before the link; `tv` from `enable_gotv` + `tv_delay`. Backoff
  on 429/5xx on the clock; the auth header built once and never logged; registered iff
  `EZPUG_DATHOST_EMAIL`, `EZPUG_DATHOST_PASSWORD`, `EZPUG_DATHOST_TEMPLATE_SERVER_ID` are
  present (`EZPUG_DATHOST_LOCATION` defaults to `dusseldorf`). Tests against T15 including
  every fault and "deallocate after allocate failed half-way leaves nothing behind".

- [ ] **T17: The GSLT pool.** A CS2 server without a Steam Game Server Login Token takes
  LAN connections only. `gslt_tokens`: lease on allocate, release on deallocate, mint via
  the Steam Web API `IGameServersService` (`CreateAccount` app 730, `DeleteAccount`,
  `ResetLoginToken` on a lost server, `GetAccountList` to reconcile) with
  `STEAM_WEB_API_KEY` when short of `EZPUG_GSLT_POOL_MAX` (default 16); a fake Steam
  endpoint for dev; pool size on `GET /v1/fleet/gslt`; the Dathost provider puts the lease
  in `cs2_settings.steam_game_server_login_token`. Nodes need none. Tokens never leave the
  process except into the provider call. References: `references/dathost/pages/api-added-cs2-game-server-login-tokens.md`.

- [ ] **T18: The template image script.** `scripts/dathost-image.mjs`: idempotently builds
  or refreshes the template server — create `cs2` in `dusseldorf` with `deletion_protection`,
  `autostop` off, `enable_metamod` off, GOTV on; upload Metamod, CounterStrikeSharp,
  MatchZy, retakes + allocator, the WeaponPaints fork and our plugins **from the same
  artifacts T10's image uses** (one build, two destinations), our `cfg/`; `sync-files`;
  print the id for `EZPUG_DATHOST_TEMPLATE_SERVER_ID`; `--check` verifies versions against
  `docs/pins.md`; `--dry-run` against T15 is the test; refuses to touch a server that is
  not the template. `docs/operations.md` documents it.

- [ ] **T19: The Dathost live smoke.** Behind `EZPUG_DATHOST_TESTS=required` (skipped with
  a printed reason otherwise): `GET /account`, T18 `--check`, allocate **one** server
  through the real provider, wait for the link's `hello`, `ezpug_status` through the link,
  read the connect facts and the GOTV relay, deallocate, assert the ledger row closed and
  the account lists no tagged server — all inside `finally`, bounded to one server-hour.
  Joins `verify:extended` when demanded.

**Around the match**

- [ ] **T20: RCON and the console.** A Source RCON client in `apps/orchestrator/src/rcon/`
  (`rcon-client` or a hundred lines of our own — decide by reading it; timeouts on the
  clock) used only as the fallback behind the provider `rcon` verb when a server has an
  address and no link; `GET /v1/fleet/servers/:id/console` streams the plugin's relayed
  tail (and the Dathost console backlog before the link); `POST …/rcon` behind the
  `fleet` scope, every line and its output in the ledger's audit column. Never a password
  in a response.

- [ ] **T21: Demos over the link's shoulder.** For `records: demo` the core plugin owns
  recording where MatchZy does not (`tv_record` on `going_live`/`OnStart`, `tv_stoprecord`
  on end) and **always owns the upload**: PUT the file to the request's `demoUploadUrl`
  (streamed, retried, checksummed), emit `demo_available {size, sha256}` → the orchestrator
  relays `demo.uploaded`; the sim PUTs its record with its content type. A missing
  `demoUploadUrl` means no upload and an honest `demo.skipped` reason in the ended fact.
  Verified on the dev node against the platform's dev MinIO. References: legacy
  `GameDemos.cs`, decision 10.

- [ ] **T22: `flying-scoutsman` and the generic flow.** The SDK's generic flow emitter
  for `flow: plugin | none` modes: `round_start`/`round_end` from game events (winner,
  reason, score from the game rules), `map_end` on the win panel, `series_end` when the
  manifest's `rounds`/`timeLimit` is reached, `going_live` after warmup — so a mode with no
  match plugin still tells a complete story. `flying-scoutsman`: manifest + cfg
  (`game_type 0 game_mode 0` with the scoutsman cvars, low gravity, the normal maps),
  `records: events`, `openJoin: true`, no plugin at all — proven on the dev node with
  bots, recorded into the fixtures.

- [ ] **T23: `retakes`.** Vendor cs2-retakes 3.1.0 and one allocator at their pins
  (`plugins/vendor/`, `docs/pins.md`), the manifest (`tier: plugin`, `flow: plugin`,
  `records: events`, `openJoin`, its map list with the release's spawn configs, `cvars`
  for `MaxPlayers` and `ShouldAutoJoinGame: true` via its `retakes_config.json` rendered
  by the loader), the generic flow emitter covering its rounds, `player.joined` pushes
  profiles so scoreboard rating and skins work for open join. Proven on the dev node with
  bots; recorded. References: `references/cs2-retakes/`.

- [ ] **T24 (fable): Player commands, player tokens and the widget socket.**
  `POST /v1/matches/:id/player-tokens` (spine) mints a short-lived token scoped to (match,
  SteamID64) for a rostered or joined player; `/v1/widget` is the upgrade a widget opens
  with it — `hello` (the mode's declared commands with cooldown/charges state), `command`
  → relayed as `player_command` over the link → SDK `OnPlayerCommand` enforcing cooldowns
  and charges → `player_command_result` back to the phone and a `plugin_event` into the
  match's durable log; rate limits per token; a token dies with the match. The sim's
  `powerup-dm` twin answers commands so the platform can test its host without CS2.
  References: decision 17, T6, T7.

- [ ] **T25 (fable): `gamemode-kit`.** `gamemode-kit/`: a Vite library preset that builds
  a gamemode's `widget/` (Vue 3 `defineCustomElement`, one file, no runtime fetch beyond
  its socket) into `gamemodes/<id>/dist/widget.js`, the **host contract** the platform
  implements (`<ezpug-widget orchestrator-url player-token locale>`; design tokens as CSS
  custom properties on the element's host — the list of variable names mirrors the
  platform's `signal.css` and is published in `docs/gamemodes.md` with fallbacks, so a
  widget renders acceptably with nothing injected), a `useWidgetLink()` composable over
  T24's socket, a dev harness page against the fake with a fake token, and the
  orchestrator serving `/gamemodes/:id/widget.js` from the manifest with an immutable
  content-hash URL that `GET /v1/gamemodes` advertises. Bilingual by a `locale` prop and a
  tiny `t()`. References: decision 17, `/root/ezpug/packages/ui/app/assets/css/signal.css`,
  `packages/ui/src/tokens.ts`.

- [ ] **T26: `powerup-dm`.** The original mode on the SDK: deathmatch by cfg, every life a
  player may claim **one** power-up from the phone (`speed`, `armor`, `radar_peek` — five
  seconds of the enemy positions pushed as a widget frame — decided in the manifest's
  `commands`), per-player state, charges reset on spawn, a chat/HUD line in the player's
  language when it lands; the widget (three buttons, cooldown rings, the peek canvas)
  built with T25. Tests: the SDK harness plays a full round with scripted players; the
  widget's link is exercised against the fake; a real run on the dev node with bots and a
  phone, recorded, with the loop saying plainly which part was visual.

- [ ] **T27: EZ Rating on the scoreboard, and the connect line.** From the assignment's
  or `profile`'s rating: `CompetitiveRanking`/`CompetitiveRankType` set on connect and on
  profile push (the Premier-style number), refreshed after a `profile` command; a
  bilingual connect line (rating, rank name, streak if the profile carries it). No clan
  tag, no HUD card. Verified on the dev node by reading the scoreboard values back
  through the SDK's world, and visually once. References: decision 21,
  `CCSPlayerController.g.cs`.

- [ ] **T28 (fable): Skins over the link — the WeaponPaints fork.** Vendor cs2-WeaponPaints
  at its pin as a fork under `plugins/vendor/WeaponPaints/` with `PATCHES.md`; replace the
  data layer (`WeaponSynchronization.cs`'s `Get*FromDatabase`, `Database.cs`) with an
  `ILoadoutSource` the core plugin provides through CounterStrikeSharp's shared plugin
  API: loadouts arrive in the assignment's roster (or a `profile` push) as the Match API's
  `Loadout` (mirroring `wp_player_*` fields per `weapon_team`), no MySQL anywhere in the
  image, `Sync*ToDatabase` writers become no-ops, in-game menus off, `!wp` refresh kept,
  `FollowCS2ServerGuidelines: false` documented with its risk. Tests: the fork's data
  layer under xunit with a fixture loadout; on the dev node a bot's loadout applied and
  read back through the world where possible, visual once. References: decision 20,
  `references/cs2-WeaponPaints/WeaponSynchronization.cs`, `Utility.cs`, the platform's
  `specs-and-more/specs/Skins.md` §2/§4.

- [ ] **T29: Branding and the connect card.** Hostname from `branding.hostname` or a
  default per gamemode (`EZPug · pug · Mirage`), event name where given, coloured chat
  prefix and team names through the SDK, a bilingual center card on connect (gamemode,
  what to do, the platform URL). Workshop textures are a later round (decision 22).

- [ ] **T30: The chat bridge and the warmup lines.** `chat_message` and `chat_command`
  flow up (the platform's play room is the other window); `announce` commands print in
  chat; `warmupLines` from the assignment are printed one every few seconds during warmup
  in the roster's majority locale (the platform renders them, the plugin prints); the
  sim prints the same. References: the platform's `server-chat.ts` and Match.md §4.

- [ ] **T31: Fleet facts and provider health.** Probes on the clock (Dathost `account`,
  node heartbeats, sim always up) → `GET /v1/fleet/providers` health with last error;
  `fleet.provider_unreachable` (debounced — one per incident), `fleet.orphan_found` (the
  reaper), `fleet.node_disconnected`, `fleet.budget_threshold` delivered to each key's
  fleet webhook; `GET /v1/fleet/ledger?since=` for "what did tonight cost".

**Proving, operating, closing**

- [ ] **T32: Fifty matches with fault injection.** A Vitest suite (extended tier, seeded
  PRNG, virtual clock): fifty matches across sim, the fake Dathost and the fake node with
  injected faults — allocation refused, a boot that never ends, a crash with a restorable
  backup, a crash without, duplicate and out-of-order link frames, a node that disconnects
  mid-match, a provider API down for a minute, a webhook endpoint failing ten times, a key
  at its budget — asserting after the run: every ledger row closed, every provider
  `list()` empty of our tags, every match `ended | failed | cancelled` with a reason, the
  events route replaying every delivered webhook in order, no GSLT leased, spend equal to
  the sum of closed rows. One deterministic seed in the test, a `--seed` door for
  reproduction.

- [ ] **T33: `ezpug-iron`, the CLI.** `apps/cli` (published later as a bin in the
  orchestrator image and runnable with `pnpm iron`): `keys create|list|revoke`,
  `gamemodes list`, `matches create|get|watch|cancel|command`, `servers list|kill|console
  <id>`, `nodes enrol-token|list|drain`, `budget`, `dathost image --check|--build`
  (wrapping T18). Typed from `@ezpug/match-api/client`; `--json` on everything; secrets
  shown once and never echoed back.

- [ ] **T34: CI and the release pipeline.** GitHub Actions: `verify` on every push and PR
  (TS + C#, no CS2, no Dathost); on a tag `orchestrator@x.y.z` / `node@x.y.z` /
  `cs2@x.y.z` build and push `ghcr.io/ezpug/ezpug-iron/{orchestrator,node,cs2}` (multi-arch
  where cheap, the cs2 image linux/amd64 only), on `plugins@x.y.z` attach the plugin zip;
  `match-api@x.y.z` publishes to npm with provenance. Image tags recorded in
  `docs/pins.md`; the platform's compose pins one.

- [ ] **T35: Deploy.** `compose.prod.yaml` (orchestrator published on `172.17.0.1:3431`
  only, its own Postgres and Redis on named volumes, no CS2 on this box in production —
  nodes are elsewhere), `docker/traefik/ezpug-iron.yml` (`gs.ezpug.com`, `letsencrypt`,
  a project-named redirect middleware), `.env.production.example` (Dathost trio,
  `STEAM_WEB_API_KEY`, `EZPUG_IRON_PUBLIC_URL=https://gs.ezpug.com`, database, redis,
  `EZPUG_IRON_PROVIDERS=dathost,nodes`), `scripts/deploy.sh` (preflight → build → migrate
  with a backup first → up → routes → smoke; `rollback`; `backup`; idempotent), the smoke
  = `GET /healthz` and `GET /v1/capacity` with a key minted by the CLI, `ralph/DEPLOY.md`.
  Deploy from a clean tree; the owner puts the Dathost credentials in `.env.production`
  before this task runs (a missing trio is `> blocked:` with the exact lines, and the
  deploy still goes out with `sim,nodes`).

- [ ] **T36: The first real match through `gs.ezpug.com`.** With T35 deployed and
  credentials in place: `pnpm iron matches create --gamemode pug --lan=false --bots` against
  production — bots play four rounds on a real Dathost server in Frankfurt, the link
  crosses the real internet, the demo lands by presigned PUT in the platform's dev MinIO
  on this box (the platform's production bucket is the platform's task), `match.ended`
  arrives at a webhook the CLI hosts for the run. Recorded as the `dathost-*` fixtures.
  The closing note carries the ledger line (cost), the account listing no tagged server
  afterwards, and the CLI transcript. The server is deleted in `finally` whatever happens.

- [ ] **T37: The LAN rehearsal.** `ezpug-node` on this box enrolled against the
  **production** orchestrator with the ghcr image; a `requirements.lan` request lands on
  it; drain; a `docker kill` mid-match → recovery to the next candidate (Dathost if
  credentials are present, else `failed: server_lost` honestly); un-enrol. The venue
  runbook in `docs/nodes.md` is corrected by what actually happened.

- [ ] **T38: Docs for strangers.** `README.md` (install, run, first match in ten minutes),
  `docs/sdk.md` (write a gamemode), `docs/gamemodes.md` (manifest, tiers, the widget host
  contract), `docs/nodes.md`, `docs/operations.md` (deploy, budgets, Dathost image, GSLT,
  what to do when a provider dies on a Saturday, rolling back a plugin), `docs/pins.md`,
  `CHANGELOG.md`; every doc checked by a test where it names a route, a command or a
  version.

- [ ] **T39: Release.** `@ezpug/match-api` bumped to the round's additive changes (the
  changelog says which platform task each serves), images and plugin zip tagged, the
  platform's pin named in the closing note; `docs/decisions.md` amended where a task
  decided differently, and the progress line says so.

- [ ] **T40: The sweep.** Everything in "When the PRD is complete", with the closing note.

## Working rules

- **`pnpm verify` green before every commit**, TS and C# both; `pnpm verify:extended`
  for T3, T6, T9, T12–T14, T16, T21–T24, T26–T28, T32, T35–T37 and any task touching a
  flow; the `EZPUG_CS2_TESTS` lane whenever the dev node is up and the iteration says
  which happened. A flaky test is a P1 against the spine and is fixed before the next
  task, never retried into green.
- **Money is a budget, not a hope.** No task allocates a real server except T19, T36 and
  T37 (T37 only if credentials exist), each at most one, each in `finally`, each bounded
  to one server-hour; the reaper runs in every test that allocates anything;
  `EZPUG_DATHOST_TESTS` is never set in `verify:extended` by default.
- **Contract discipline.** `@ezpug/match-api` changes are additive, released, changelogged,
  and never needed by a task that could do without; `packages/protocol` may change freely
  but regenerates the C# in the same commit; recorded fixtures are the arbiter of every
  shape disagreement.
- **Secrets stay in the process** (CLAUDE.md); recorded fixtures are scrubbed and a test
  greps them; nothing real in a doc, a log line, a widget bundle or a progress note.
- **Determinism everywhere**: fakes and backoff on the injected clock, heartbeat ages from
  the clock, `eventually()` never `vi.waitFor`, C# on `IClock`, the fault suite on a seed.
- **Bilingual where a human reads it**: manifests, in-game lines, the connect card, widget
  copy — DE + EN, the player's locale, German default.
- **Visual honesty.** A check that needed eyes (a skin on a weapon, a scoreboard number,
  a widget on a phone) is written as visual in the progress line; nothing is claimed
  verified that a test did not see.
- **Hard don'ts:** no Dathost *match API*; no inbound port on a server; no player
  registry in the orchestrator; no UI beyond widgets; no fork of MatchZy or retakes; no
  MySQL in the image; no CS:GO provider; no cron (probes and the reaper are the clock's);
  no `Date.now()`; no hand-written wire types in C#; no gameserver on this box in
  production; no second permission mechanism beside API-key scopes.

## When the PRD is complete

- `pnpm verify:extended` green **twice in a row**, including the conformance suite against
  the real orchestrator, the fault-injection suite, the `EZPUG_CS2_TESTS` lane with the dev
  node up (a recorded real `pug`, `flying-scoutsman`, `retakes` and `powerup-dm`), and the
  Dathost smoke when demanded.
- `./scripts/deploy.sh` end to end **from a clean tree**, smoke green; T36's real match
  and T37's rehearsal in the closing note with the ledger lines; the Dathost account
  listing no tagged server afterwards.
- `docs/{match-api,gamemodes,sdk,nodes,operations,pins,decisions}.md`, `README.md`,
  `CHANGELOG.md`, `ralph/DEPLOY.md`, `.env.example`, `.env.production.example` and
  `CLAUDE.md` true to what shipped; the platform's pin for `@ezpug/match-api` and the
  orchestrator image named.
- The closing note names what this round left for the next author: CS:GO (Get5 +
  SourceMod), workshop-addon branding, gamemode bundles fetched at boot, a second region,
  multi-replica orchestrator (the Redis fan-out exists, nothing runs two), arena 1v1 and
  wingman manifests, the auto-caster's node, in-game voting through the widget.
