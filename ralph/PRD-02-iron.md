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

- [x] **T5: Budgets and keys.** Per-key `maxConcurrentServers`, `maxServerMinutes`,
  `monthlyCentsCeiling` with the month's spend from the ledger (cost snapshot × uptime,
  live rows included), `budget_exceeded` refusals, `fleet.budget_threshold` at 50/80/100 %,
  the `keys` routes (create → key shown once, rotate, revoke, budgets patch; `admin`
  scope), a `GET /v1/fleet/budget` a health tile can draw. Tests on the fake Dathost's
  prices and a fake clock crossing a month boundary.

- [x] **T6 (fable): The link.** `/link` on the orchestrator: a raw `ws` upgrade beside
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

- [x] **T7 (fable): `EZPug.Sdk`.** The seams: `IGameWorld` (players with SteamID64, slot,
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

- [x] **T8 (fable): `EZPug.Core` — the plugin every server runs.** The thin CounterStrikeSharp
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

- [x] **T9 (fable): `pug` — MatchZy, translated once, and the config builders.** Port the
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

- [x] **T10: The server image.** `docker/cs2/Dockerfile` from the legacy image: steamrt
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

- [x] **T10a (P1, fable): the conformance suite races the sim's story under load.**
  Found in T10, pre-existing, not caused by it: on a loaded box `conformance.test.ts`'s
  `happy-bo1` fails `a pause is accepted — invalid_state` (sometimes the `announce` before
  it, sometimes `every durable envelope was delivered by webhook`), and `config-only` /
  `open-join` / `webhook-replay` fail the same delivery check. Reproduced **2 of 3** and
  **2 of 4** full-suite runs with six busy CPU loops beside them
  (`cd apps/orchestrator && pnpm vitest run` with the box loaded); **0 of 10** for
  `conformance.test.ts` alone under the same load, and green on an idle box — which is why
  it has been passing. Mechanism, as far as T10 traced it: the runner polls with
  `CONFORMANCE_POLL_INTERVAL_MS` = 10 s of *fake* time
  (`packages/match-api/src/fixtures/conformance/runner.ts:29`), one `advance` deals many of
  the sim's beats (`packages/sim/src/server.ts:364-374`, `scheduleNext` → `void
  emitted.done`), and those ingests are deliberately **not awaited** (the sim channel's
  `say`, `providers/sim/channel.ts:51`, because the command that caused the event holds the
  match's chain — T3's note). `createTestApp`'s `settle()`
  (`apps/orchestrator/src/http/testing.ts:200-209`) therefore returns while a story is
  still draining, the flow observes `live`, and the rest of the match lands before its
  `pause` does — `machine.ts:1040` refuses `pause only while live`. Tracking the ingest
  promise in the machine's existing `inflight`/`track` set was tried in T10 and **did not
  fix it** (2 of 4 after, indistinguishable from 2 of 3 before) — it made the drain more
  complete and moved the failure earlier onto the `announce`, so a second real-time source
  is still escaping the barrier; that change was reverted rather than shipped inside T10.
  Fix the barrier so a fake-clock match cannot advance between a client's calls, keep
  `settle()`'s promise ("every chain and in-flight step has settled", `machine.ts:180`)
  true, and prove it by the loaded reproduction above run ten times green. Never retried
  into green (working rules).

- [x] **T11 (fable): `ezpug-node`.** `apps/node`: one process (and a container image) on
  any docker host — enrol once with a one-time token (`ezpug-node enrol <token>`), then
  `hello` with labels (`region`, `lan: true`, tickrate, cores), capacity (`maxInstances`),
  the image digest it holds; on `start` it runs a server container from the image with
  the spec's ports, env and server token, on `stop` it removes it; a **warm pool** of N
  idle instances (`EZPUG_NODE_WARM`) already dialled in so a `lan` request is ready in
  seconds; `instances` reports every container's state; drain finishes live matches and
  starts nothing; reconnect with backoff; a `dockerode` port with a **fake docker** for
  tests. A node that dies mid-match is a server that dies mid-match (T14). `docs/nodes.md`:
  install on a venue box in five commands. References: decision 23, T1's node link.

- [x] **T12: The node provider and enrolment.** In the orchestrator: `nodes` as a provider
  (`offerings()` = one offering per connected, undrained node with free capacity, cost 0,
  `lan: true`, region from labels; a disconnected node advertises 0 and never disappears),
  `allocate` = pick a warm instance or `start` one, `deallocate` = `stop`, the enrolment
  routes (`POST /v1/fleet/nodes` → token **shown once**, `DELETE` revokes and closes the
  socket, `drain`/`undrain`), `fleet.node_disconnected` (critical while it holds a live
  match). Tests on the fake node. The dev world: `pnpm dev:up` now also starts
  `ezpug-node` on this box (host network, the dev image) enrolled against the dev
  orchestrator, so **the dev CS2 server is a real node in a real pool**.

- [x] **T13: Bots play a real match — the recorded fixtures.** `scripts/iron-match.mjs`
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
  > left to T21: `demo.uploaded`. Nothing uploads a demo yet — the core plugin owning the
  > upload and the orchestrator relaying `demo_available` → `demo.uploaded` **is** T21, and
  > building half of it here would have been bundling. The script already mints the
  > presigned PUT and passes it as `callbacks.demoUploadUrl`, so T21 is a plugin and a
  > relay and nothing else; it also owns adding the `demo.uploaded` assertion to the
  > `EZPUG_CS2_TESTS` lane (`apps/orchestrator/src/cs2.extended.test.ts`).

- [x] **T14 (fable): A server that dies comes back.** `backup` frames persisted per round;
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

- [x] **T15: The fake Dathost.** `apps/orchestrator/src/providers/dathost/fake.ts` — an
  in-process HTTP server speaking the vendored subset of `references/dathost/openapi.merged.json`:
  `GET/POST /game-servers`, `GET/PUT/DELETE /game-servers/:id`, `duplicate` (the
  sync-files caveat modelled: a clone copies the *last synced* files), `sync-files`, `start`
  (reboots if on), `stop`, `console` (GET backlog + POST line), `files` list/download/upload
  (multipart, the 100 MB refusal), `metrics`, `account`. Basic auth checked, `booting` →
  `on` on the injected clock, faults: 429, 500, a boot that never ends, a server that
  vanishes, a console that times out. Every response validated against the merged OpenAPI
  schemas in a test. References: `references/dathost.md`.

- [x] **T16: The Dathost provider.** `createDathostProvider({email, password,
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

- [x] **T17: The GSLT pool.** A CS2 server without a Steam Game Server Login Token takes
  LAN connections only. `gslt_tokens`: lease on allocate, release on deallocate, mint via
  the Steam Web API `IGameServersService` (`CreateAccount` app 730, `DeleteAccount`,
  `ResetLoginToken` on a lost server, `GetAccountList` to reconcile) with
  `STEAM_WEB_API_KEY` when short of `EZPUG_GSLT_POOL_MAX` (default 16); a fake Steam
  endpoint for dev; pool size on `GET /v1/fleet/gslt`; the Dathost provider puts the lease
  in `cs2_settings.steam_game_server_login_token`. Nodes need none. Tokens never leave the
  process except into the provider call. References: `references/dathost/pages/api-added-cs2-game-server-login-tokens.md`.

- [x] **T18: The template image script.** `scripts/dathost-image.mjs`: idempotently builds
  or refreshes the template server — create `cs2` in `dusseldorf` with `deletion_protection`,
  `autostop` off, `enable_metamod` off, GOTV on; upload Metamod, CounterStrikeSharp,
  MatchZy, retakes + allocator, the WeaponPaints fork and our plugins **from the same
  artifacts T10's image uses** (one build, two destinations), our `cfg/`; `sync-files`;
  print the id for `EZPUG_DATHOST_TEMPLATE_SERVER_ID`; `--check` verifies versions against
  `docs/pins.md`; `--dry-run` against T15 is the test; refuses to touch a server that is
  not the template. `docs/operations.md` documents it.

- [x] **T19: The Dathost live smoke.** Behind `EZPUG_DATHOST_TESTS=required` (skipped with
  a printed reason otherwise): `GET /account`, T18 `--check`, allocate **one** server
  through the real provider, wait for the link's `hello`, `ezpug_status` through the link,
  read the connect facts and the GOTV relay, deallocate, assert the ledger row closed and
  the account lists no tagged server — all inside `finally`, bounded to one server-hour.
  Joins `verify:extended` when demanded.

**Around the match**

- [x] **T20: RCON and the console.** A Source RCON client in `apps/orchestrator/src/rcon/`
  (`rcon-client` or a hundred lines of our own — decide by reading it; timeouts on the
  clock) used only as the fallback behind the provider `rcon` verb when a server has an
  address and no link; `GET /v1/fleet/servers/:id/console` streams the plugin's relayed
  tail (and the Dathost console backlog before the link); `POST …/rcon` behind the
  `fleet` scope, every line and its output in the ledger's audit column. Never a password
  in a response.

- [x] **T20a (P1): the SDK's link-client tests wait on the wall clock, not the injected
  one.** Found in T20's `pnpm verify:extended`, pre-existing, not caused by it:
  `EZPug.Sdk.Tests.LinkClientTests.TheLoopReconnectsWithDoublingBackoffOnTheClockAndResetsItOnWelcome`
  failed once, on a box that was also running turbo's TS suites in parallel *and* the
  platform's own e2e round beside them; it then passed 3 of 3 alone and 4 of 4 as the whole
  plugin suite once the box quietened, which is why it has been green. Mechanism: the test's
  own timeline is the injected `IClock` (`rig.Clock.Advance`), but three of the harness's
  waits are bounded by a **5 s wall clock** — `ScriptedLinkSocket.NextSentAsync`
  (`plugins/EZPug.Sdk.Testing/ScriptedLinkSocket.cs:28`), `Rig.LoggedAsync`
  (`plugins/EZPug.Sdk.Tests/LinkClientTests.cs:60`, whose own comment calls the bound "the
  safety net, not the mechanism") and `Rig.WaitProcessedAsync` (`:116`). On a saturated box
  the safety net becomes the mechanism and a slow scheduler reads as a broken backoff.
  Make the harness's waits independent of wall-clock pressure (the same posture
  `eventually()` has on the TS side: a generous budget that a loaded box cannot exhaust, or
  a signal the rig already owns), leave the assertions exactly as they are, and prove it by
  running the whole plugin suite ten times green with the box deliberately loaded. Never
  retried into green (working rules).

- [x] **T21: Demos over the link's shoulder** (and the half of T13's lane that waited on
  it: `demo.uploaded` in `cs2.extended.test.ts`). For `records: demo` the core plugin owns
  recording where MatchZy does not (`tv_record` on `going_live`/`OnStart`, `tv_stoprecord`
  on end) and **always owns the upload**: PUT the file to the request's `demoUploadUrl`
  (streamed, retried, checksummed), emit `demo_available {size, sha256}` → the orchestrator
  relays `demo.uploaded`; the sim PUTs its record with its content type. A missing
  `demoUploadUrl` means no upload and an honest `demo.skipped` reason in the ended fact.
  Verified on the dev node against the platform's dev MinIO. References: legacy
  `GameDemos.cs`, decision 10.

- [x] **T21a (P1): GOTV does not survive a match on the dev image, so nothing records a
  demo.** Found in T21, pre-existing, not caused by it: on the dev node the engine counts
  the SourceTV client as a bot, so the first `bot_quota 0` after the map is up kicks it
  (`SourceTV kicked by Console (NETWORK_DISCONNECT_KICKED)`, right after `execing
  ezpug/pug.cfg` in the container log) and CS2 does not bring SourceTV back without a
  level change — `tv_enable 0` then `tv_enable 1` in one cfg is one frame and no change at
  all, and the same pair spaced three seconds apart over the fleet RCON door did not bring
  it back either. MatchZy's own `warmup.cfg` and `live.cfg` both run `bot_quota 0`, so
  moving our cfg's bot lines above its GOTV block (done in T21) keeps *us* out of it and
  does not fix it. The consequence: `matchzy_demo_recording_enabled` is on, MatchZy runs
  `tv_record` and `tv_stoprecord` on its own schedule, and **no `.dem` is ever written** —
  a whole T21 run ended, correctly and honestly, with `demo.skipped: no_demo` six minutes
  after `series_end` (`no demo appeared in …/MatchZy within 240000 ms of the win panel`,
  the plugin; `no demo within 360000 ms of series_end; ending without it`, the machine).
  Everything either side of the missing file is proven — the watcher, the marker, both
  windows, the ended fact — so this is one thing: make GOTV survive the bot purge (a
  reserved slot, `tv_enable` before the players, a `bot_kick` that spares it, or the
  plugin restoring GOTV once with a level change), then turn the `EZPUG_CS2_TESTS` lane's
  demo branch from "either outcome" back into "the demo landed" and record the real
  `demo_available`/`demo.uploaded` pair into the fixtures. Never retried into green
  (working rules).

- [x] **T21b: `pnpm dev:node up` starts a second agent on top of the first, and the two
  never settle.** Found in T21a, pre-existing, not caused by it: `scripts/dev-node.sh down`
  kills the one pid in `.ezpug-node/agent.pid` and `up` overwrites that file, so an `up`
  while an agent is already running orphans the first — and two agents holding the same
  node identity fight over `/node` forever (`the node link closed 4005 (replaced by a
  newer socket)` on one side, a fresh `hello` on the other, a loop with no end). It is
  silent: `dev-node.sh status` reads the *winning* socket and looks healthy. It cost two
  T21a runs — one carried `fleet.node_disconnected` × 1910 and the next `POST /v1/matches`
  answered `503 no_capable_server` against a node with nothing running. Make `up` refuse
  (or adopt) when an agent is alive, make `down` end every `src/main.ts run` this checkout
  owns rather than one pid, and make the orchestrator debounce a node identity that
  re-`hello`s in a loop instead of billing a `fleet.node_disconnected` per flap.

- [x] **T21c (P1): the extended conformance suite's `happy-bo1` fails a match before it is
  ready, under a whole-verify load.** Found in T21b, pre-existing, not caused by it:
  `apps/orchestrator/src/conformance.extended.test.ts` failed
  `happy-bo1` 7/8 on `the flow ran to its end — the match failed before it was ready`
  (`packages/match-api/src/fixtures/conformance/flows.ts:198`, so the match reached
  `failed` or `cancelled` between `create` and its connect facts) inside a full
  `pnpm verify` — turbo running every TS suite plus `dotnet build`/`dotnet test` beside it —
  on a box that was also running the dev orchestrator, the dev node agent and the
  platform's own loop. It then passed **1 of 1 alone** on an idle box and **3 of 3** with
  six busy CPU loops beside it, which is why it has been green: the spin-loop posture T10a
  used does **not** reproduce this one, and the reproduction is the whole verify.
  Untraced beyond that, because the two things that would say *why* were both out of
  reach: this tier is on the **system clock** (the file's own note says so), so any of the
  machine's deadlines — allocate, boot — can expire on a starved process, and the flow's
  error prints the state without the reason. The match row that would carry the reason is
  swept by `afterAll` (`:192, :241`), so a failing run leaves nothing behind to read.
  Start by making that error name the failure reason (a fixtures-only change, but it is
  still a `@ezpug/match-api` release), then reproduce under a real `pnpm verify` rather
  than a synthetic load, and fix the deadline that a starved process blows — or make the
  tier's deadlines as generous as `SIM_TIME_SCALE` already made its story. Never retried
  into green (working rules); the verify this was found in was re-run for the commit gate
  and the progress line says which runs were which.

- [x] **T21d (P1): `machine.test.ts`'s ttl deadline loses a race with the sim's own
  ending, under a whole-verify load.** Found in T21c, pre-existing, not caused by it:
  `deadlines > ends ttl_expired when the request's lifetime runs out, whatever the server
  says` (`apps/orchestrator/src/match/machine.test.ts:226`) failed once inside
  `pnpm verify:extended` with `expected 'completed' to be 'ttl_expired'` — the match
  reached its own end inside the ten fake minutes the ttl was supposed to close first. It
  then passed **8 of 8** alone, and the whole orchestrator suite and two full `pnpm verify`
  runs were green either side of it, which is why it has been green. Not traced further.
  Two things are worth the next author's first hour: the test is a **fake-clock** one
  (`createTestApp`, `advance(10 * 60_000)`), so a wall-clock-dependent outcome means
  something is escaping the barrier — the sim's un-awaited ingest that T10a named
  (`providers/sim/channel.ts:51`, `void emitted.done`) is the obvious suspect, and this
  would be its third appearance; and the story the sim plays is seeded on
  `${root}#${matchId}` with a **`randomUUID()` match id**
  (`providers/sim/provider.ts`, `simAssignmentFor`), so its length is not the same twice —
  a test whose margin is one story-length away from a deadline is a coin toss nobody can
  reproduce. Fix whichever of the two it is (a seed the test pins would make the margin
  legible even if the barrier is the real fault), and prove it under a real
  `pnpm verify:extended`. Nothing this task changed is in the path — the three reads it
  narrowed are per-deployment filters that a single in-memory store satisfies
  tautologically — but the run that found it is the run T21c was verified with, and the
  progress line says which runs were which. Never retried into green (working rules).

- [x] **T22: `flying-scoutsman` and the generic flow.** The SDK's generic flow emitter
  for `flow: plugin | none` modes: `round_start`/`round_end` from game events (winner,
  reason, score from the game rules), `map_end` on the win panel, `series_end` when the
  manifest's `rounds`/`timeLimit` is reached, `going_live` after warmup — so a mode with no
  match plugin still tells a complete story. `flying-scoutsman`: manifest + cfg
  (`game_type 0 game_mode 0` with the scoutsman cvars, low gravity, the normal maps),
  `records: events`, `openJoin: true`, no plugin at all — proven on the dev node with
  bots, recorded into the fixtures.

- [x] **T22a (P1): the loader's flat cvars land in the same console frame as the mode's
  cfg, so the two net out.** Found in T22, pre-existing, not caused by it:
  `GamemodeLoader.OnMapLoaded` execs the manifest's cfg files and then sets the
  assignment's flat cvars, all through `Server.ExecuteCommand`, so the whole lot reaches
  the engine's console in **one frame** — and the engine reconciles a cvar's *effects*
  once at the end of it, against the value it had before. A value the cfg sets and the
  request then sets back is therefore not two changes but none. Measured on the dev node
  with `flying-scoutsman` (CS2 1.41.7.8): the cfg's `bot_kick; bot_quota 0` and the
  request's `rules.cvars.bot_quota 10` produced an **empty** server — ten bots kicked at
  1.2 s, `going_live` at 21 s, no player for the twenty minutes that followed — and one
  `bot_quota 10` over RCON, a frame of its own, filled it inside a second. Dropping
  `bot_kick` did not fix it: a `bot_quota_mode` switch evicts the standing bots on its
  own, and the same-frame raise still cannot bring them back. T22 worked around it in
  `scripts/iron-match.mjs` (the bots are asked for over the fleet RCON door at `ready`,
  for every non-`matchzy` flow) rather than reordering the loader inside a task that had
  no other business there — but a **client** cannot do that, and must not have to: a
  request's `rules.cvars` is documented as merged under the mode's, which is a promise
  the console frame is currently breaking for any cvar with a population or eviction
  side effect. Fix the loader — a beat between the cfg and the cvars, whatever the flows
  need — keep the `matchzy` ordering the pug lane proved (cvars, then the match config,
  then `matchzy_loadmatch`, then the remote log), put `bot_quota` back into
  `iron-match.mjs`'s `rules.cvars` for every flow, and re-prove **both** lanes with
  `EZPUG_CS2_TESTS=required`.

- [ ] **T22b (P1): `pnpm verify` is red while `pnpm cs2:up` is running.** Found in T22,
  pre-existing, not caused by it: `apps/orchestrator/src/nodes/nodes.test.ts`'s `is an
  honest 503 with an audit line when the container is not listening` says in its own
  comment "the provider dials 27415 on the node; nothing in this test is there" — and
  `pnpm cs2:up`, the documented dev CS2 lane, puts a real CS2 server on exactly 27415.
  The test then reaches a server that answers, the RCON audit reads `<failed:
  auth_failed>` instead of `<failed: unreachable>`, and the whole verify is red.
  Deterministic in both directions and confirmed both ways in T22 (red with the container
  up, green the moment `pnpm cs2:down` returned). It is not flake: it is a unit test
  dialling a real port on a box whose own README tells the reader to occupy it. Give the
  fake node's instances a port nothing on this box uses, or point the test at a closed
  port it owns, so the two lanes stop sharing a number.

- [ ] **T22c (P1): the runtime says `server_ready` for the map the server was already on,
  so a match sometimes reports two.** Found in T22's `EZPUG_CS2_TESTS` lane, pre-existing,
  not caused by it: `cs2.extended.test.ts`'s `plays a pug end to end and closes its ledger
  row` failed on `the plugin never said it was ready: expected 2 to be 1`, and **nothing
  else in that match was wrong** — `going_live`, eight `round_end`s, two `side_swap`s,
  `map_end`, `series_end`, `demo_available` + `demo.uploaded`, `match.ended: completed`,
  one ledger row closed. Mechanism, from the recording's own clock: the two `server_ready`
  envelopes are **1.34 s apart**, and `CounterStrikeWorld.MapReadyDelayMs` is 1 s. The
  container boots on the image's start map, the engine's `OnMapStart` arms that one-second
  timer, the `assign` lands inside it, and by the time the timer fires `Assignment` is no
  longer null — so `GamemodeRuntime.OnMapStarted` emits a `server_ready` for the **boot**
  map, and the loader's own `changelevel` emits the real one a second later. It is a race
  on container boot timing, in code T22 did not touch (the generic emitter is inert for a
  `matchzy` flow: `_armed` is false, no timer is armed), and it flips with anything that
  moves the boot by a second — the committed `real-pug-bo1.json` has one `server_ready`,
  today's rebuilt image gave two, twice. The consequence is small but real: a client's
  durable log holds a `server_ready` for a map that was never the match's, and the lane
  is red. Fix it where the two halves meet — the loader knows it asked for a level change,
  the runtime does not, and a map start that predates that request is not the match's map
  (a token the loader raises and the runtime waits for, or a map-start time the seam
  carries). Do **not** loosen the assertion. Re-prove with `EZPUG_CS2_TESTS=required` and
  re-record `real-pug-bo1.json` if the shape changes. Never retried into green.

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

- [ ] **T38a (fable): What the platform's console found missing — the additive 0.2.0.**
  The platform loop (`/root/ezpug/ralph/PRD-09-iron-platform.md`, its `> blocked:` notes
  under T2, T4, T5, T14 and its T34) hit four contract gaps and, per decision 24, wrote
  them down instead of editing a schema. Grow `@ezpug/match-api` **additively** for all
  four, serve them in the orchestrator, exercise them in the fake and the conformance
  suite, and release: (1) **prefer a venue, do not require one** — `requirements.lan`
  narrows to nodes-or-nothing; add `requirements.preferLan` (or an ordering hint) so a
  LAN night before a node is enrolled still gets a Dathost box; (2) **a scenario catalog
  for the sim** — `GET /v1/sim/scenarios` (or the list on `Capacity` under the `sim`
  provider) so a console offering a name knows it exists; (3) **one demo upload URL per
  map** — `callbacks.demoUploadUrls` (per `mapNumber`) or a `{mapNumber}` template
  beside the single `demoUploadUrl`, so a Bo3 does not overwrite map 1; (4) **a re-roll
  that is a different box** — a `reroll` variant (or a `reprovision` command) that
  releases the current server and walks again for the same `clientMatchId` before `live`,
  and an admin-started recovery on a live match that reuses T14's restore path; the
  ledger and the events route tell the story. Then publish `0.2.0`: `scripts/release.mjs`
  learns a `--registry <url>` (or honours `npm_config_registry`) because npmjs is not
  logged in on this box — the platform reads the box's Verdaccio at
  `http://172.17.0.1:4873/` (the user token is in `~/.npmrc`; `npm whoami --registry
  http://172.17.0.1:4873` answers `ezpug-box`); publish there now and to npmjs the day
  the owner logs in. The changelog names which platform note each change answers.
  Before starting, grep the platform's PRD and progress file for "contract gap" once more
  and take anything newer than these four. References: decision 24, the four notes
  named above, `packages/match-api`, `docs/match-api.md`.

- [ ] **T39: Release.** `@ezpug/match-api` bumped to the round's additive changes (the
  changelog says which platform task each serves), images and plugin zip tagged, the
  platform's pin named in the closing note; `docs/decisions.md` amended where a task
  decided differently, and the progress line says so.

- [ ] **T40: The sweep.** Everything in "When the PRD is complete", with the closing note.

## Working rules

- **Never wait on a background task.** In the loop the run ends the moment you stop
  talking: a command started in the background, or a turn that ends with "I'll report
  when it lands", loses the iteration and leaves the task half-done (this round already
  lost two that way). Long commands run in the foreground with an explicit timeout;
  if a tier takes twenty minutes, wait twenty minutes.
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
