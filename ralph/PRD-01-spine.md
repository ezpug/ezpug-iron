# PRD 01: The spine

EZPug has played eight rounds on a simulator that lives inside the platform. The owner
decided (`docs/decisions.md`, 2026-09-05) that everything touching a Counter-Strike server
moves into this repo behind one published contract, and that two loops then build in
parallel: this repo's iron (`PRD-02-iron.md`: orchestrator, SDK, plugins, gamemodes,
Dathost, nodes, image) and the platform's hookup (`/root/ezpug/ralph/PRD-09-iron-platform.md`:
collapse to one provider, the widget host, skins, the operator console). Neither can start
until what they expect from each other is written down, executable and released. This
round is that spine: `@ezpug/match-api` v0.1 on npm — the vocabulary, the Match API, the
webhooks, the stream, the manifest, a typed client, a webhook verifier, conformance
fixtures and an in-process fake orchestrator that plays real matches on the ported
simulator engine — plus the repo's tooling so both later rounds inherit a green `pnpm verify`
on their first iteration. It delivers decisions 3, 4, 6, 9, 14, 17 and 24.

**Branch:** `main`. **Surface:** the whole repo — it is empty. **Model:** `claude-opus-5`;
tasks tagged `(fable)` run on Fable 5.1. **Budgets:** no database, no HTTP server that
outlives a test, no Dathost, no CS2 — this round produces a package and a toolchain. The
one external act is T9's `npm publish`, once, of a `0.1.0` (the owner logs npm in
beforehand; if the login is missing, T9 writes `> blocked:` with the exact command and the
round still completes locally). **Freeze:** after T10 the package's schemas change only by
a release with a changelog line (decision 24).

## Findings

Traced 2026-09-05 in the platform checkout at `/root/ezpug` (read it directly; never
import from it). Trust the file over this note.

**The vocabulary to copy verbatim.**
- `packages/contracts/src/gameserver.ts` (668 lines): the union `:483-506`, the 22 names
  `:510-538` (`server_ready, heartbeat, player_connected, player_disconnected, going_live,
  round_start, round_end, side_swap, map_end, series_end, match_paused, match_unpaused,
  player_death, bomb_planted, bomb_defused, bomb_exploded, position_tick, backup_written,
  demo_available, chat_command, chat_message, plugin_event`), `gameserverSourceSchema
  {provider, serverId}` `:65-69`, `matchTeamSchema` / `teamSideSchema` / `serverSlotSchema`
  `:71-86`, `playerRoundSummarySchema` `:126`, `roundWinConditionSchema` `:107-114`,
  `parseServerChatLine` `:451` (the command-prefix rule, decided once), `demo_available`
  `:365`, `position_tick` ephemeral + `isEphemeralGameserverEvent` `:549-556`,
  `plugin_event` `:473`, `GAMESERVER_EVENT_CONTRACT_VERSION = 1` `:43`,
  `GAMESERVER_EVENT_BATCH_MAX = 200` `:583`, the submission/ack shapes `:590-650` (the ack
  vocabulary `accepted | duplicate | ephemeral` and `applied` are worth keeping for the
  plugin↔orchestrator protocol). The closed-set self-check at `:560-575` is the pattern
  for every enum this package publishes. Its imports: `steamId64Schema` from `identity.ts`
  (`:1-60` is the SteamID64 grammar), `gameserverEventTypeSchema` + `kebabNameSchema` from
  `naming.ts` (173 lines), `defineRoute` from `rpc.ts` (284 lines — the route-declaration
  helper the client generator reads; port it whole).
- Fixtures every copy must still parse: `packages/game/src/fixtures/*.json` (MatchZy and
  Get5 config goldens), `packages/game/src/simulator/*.test.ts` (union events in motion),
  `apps/api/src/match/ingestion.test.ts` (ack semantics).
- The platform's match request the Match API's create body derives from:
  `packages/contracts/src/match.ts:232-250` (`matchRequestSchema`: `context`, `game`,
  `teams` with SteamID-pinned rosters, `maps: mapPlanSchema[]`, `rules: matchRulesSchema`
  `:243` — knife round, overtime, warmup, series length — and integration flags);
  `gameSchema` is `cs2 | csgo`. Copy `matchRulesSchema` and `mapPlanSchema` as they are;
  add what a server needs and the platform does not know (callbacks, requirements,
  gamemode, profiles).

**The simulator engine to port (decision 9).**
- `packages/game/src/simulator/story.ts` (865 lines: a seeded, clock-driven match story —
  rounds, deaths, bomb, chat, positions from `MapRadar`), `assignment.ts` (149: the
  sidecar a simulated server reads), `record.ts` (164: `SIMULATED_MATCH_RECORD_CONTENT_TYPE`,
  the simulator's "demo" that the platform's artifact producer reads), `scenario.ts`
  (`SIMULATOR_SCENARIOS`, `findScenario`, `resolveScenario`, `listScenarios`), and the
  provider `provider.ts` (670: `createSimulatorProvider` `:239`, the per-server handles
  the console drives — `step`, `mode`, `speed`, `chaos`, `kill` — `status` reporting `gone`
  for a crash `:389,:572`, `fetchDemo` `:598`, `announce` `:625` echoing a `plugin_event`
  `chat_announced`). Tests beside them (`story.test.ts`, `provider.test.ts`,
  `record.test.ts`) come along. `history.ts` (894) and `history-fixture.ts` are the
  platform's seed and **stay there** — they drive whatever fake the platform holds.
- The contract half: `packages/contracts/src/simulator.ts` — states `:60-73`, `mode`
  `:79`, `chaos` `:87-92`, `timeScale` bounds `:100-108` (0.25 … 600, console 20),
  outcomes `:109`, the console commands `:247-257`. These become the `sim.*` command
  family of the Match API (allowed only on a `sim` server).
- What they lean on: `packages/core/src/clock.ts` (243: `Clock`, `Timer`, `systemClock`,
  `createFakeClock`), `prng.ts` (156: `createPrng`), `chaos.ts` (363: `ChaosController`,
  `ChaosDeliverer` — delay/duplicate/drop composed at delivery, never rolled inside the
  story), `testing/index.ts` (147: `eventually`, `EVENTUALLY_TIMEOUT_MS`). Port all four;
  keep `Clock` structurally identical so a platform clock satisfies the fake.
- `packages/game/src/provider.ts:203-258` is the provider interface the orchestrator
  will re-grow in PRD-02 (`offerings`, `allocate`, `configure`, `start`, `stop`, `status`,
  `deallocate`, `list`, `fetchDemo`, `announce`) — read it for the sim engine's seams, do
  not publish it: providers are the orchestrator's business.

**Tooling to mirror, not reinvent.** `/root/ezpug/{biome.jsonc,turbo.json,pnpm-workspace.yaml,
tsconfig.base.json}`, `package.json` scripts (`verify = turbo run typecheck lint test &&
turbo boundaries`), `scripts/lint/*.grit` + `guard-selftest.sh` (the determinism,
`vi.waitFor` and `flushdb` guards — copies already sit in this repo's `scripts/lint/`),
`apps/api/vitest.config.ts` (`testTimeout` above `EVENTUALLY_TIMEOUT_MS`). Versions in the
platform's catalog: typescript ~5.9.3, vitest ^4.1.11, zod ^4.4.3; hono ^4.13.3 and
drizzle-orm ^0.45.2 in the api. `dotnet` 8.0.416 is on the box; the `CounterStrikeSharp.API`
NuGet's latest stable is 1.0.373.

**Vendor shapes the manifest and the loadout must fit.** MatchZy
`/root/ezpug/references/MatchZy/documentation/docs/event_schema.yml` and `Events.cs:4-235`
(the eight remote-log events; `series_start`, `going_live`, `round_end`, `map_result`,
`series_end`, `map_picked`, `map_vetoed`, `side_picked`, `demo_upload_ended`);
`references/cs2-WeaponPaints/Utility.cs` (the `CREATE TABLE`s: `wp_player_skins`
(`weapon_defindex`, `weapon_paint_id`, `weapon_wear`, `weapon_seed`, `weapon_nametag`,
`weapon_stattrak`, `weapon_stattrak_count`, `weapon_sticker_0..4`, `weapon_keychain`,
per `weapon_team`), `wp_player_knife`, `wp_player_gloves`, `wp_player_agents`,
`wp_player_music`, `wp_player_pins`) — the loadout schema mirrors these fields so the
fork's data layer is a mapping, not an interpretation; cs2-retakes' `retakes_config.json`
(README on GitHub, release 3.1.0) for what a community plugin wants told; the platform's
`specs-and-more/specs/Skins.md` §2 for what a player can customize.

**The widget host's inputs** (decision 17): the platform's design tokens are CSS custom
properties in `/root/ezpug/packages/ui/app/assets/css/signal.css`, mirrored by
`packages/ui/src/tokens.ts` (`signalColors`: `primary`, `bg*`, `border*`, `text*`, `ct`,
`t`, `live`, `success`); the locale contract is `packages/contracts/src/locale.ts`
(`de | en`, German default). The manifest's widget block declares what it needs injected.

## Attitude

- **The contract is code, and the fake is the first implementation.** Every schema in
  `@ezpug/match-api` is exercised by the in-process fake in this round, so a shape nobody
  can serve never ships. The conformance suite is the seam test: it runs against the fake
  here and against the real orchestrator in PRD-02, and the platform runs it against the
  fake it pins. If the three ever disagree, the fixture decides.
- **Copy the vocabulary, do not improve it.** v1 of the event union is the platform's
  file, byte-compatible, so the platform's re-export is a one-line change and eight rounds
  of fixtures keep parsing. What a real server needs beyond it (sequence numbers, server
  tokens, assignments) lives in the *protocol* and the *envelope*, not in the events.
- **Orchestration facts are events too, but they are not gameserver events.** The webhook
  envelope carries either a gameserver event or an orchestration fact (`match.allocated`,
  `match.server_ready`, `match.recovering`, `match.recovered`, `match.failed`,
  `match.ended`, `demo.uploaded`, `player.joined`) under one discriminator, one sequence,
  one idempotency rule. A consumer that only wants the game reads one branch.
- **The platform owns people; the orchestrator owns servers.** No player registry here.
  A roster entry carries what the server must know about a person (SteamID64, display
  name, locale, rating, rank name, loadout); an open-join mode gets those pushed per
  connected player. Money, capacity and health are the orchestrator's; names and ratings
  are never its truth.
- **Two languages, one schema.** Zod is the source; JSON Schema is exported from it; C#
  types are generated from the JSON Schema and proven equal by round-tripping the same
  fixture files in xunit. Hand-written C# for a wire shape is a review reject.
- **Green on the first iteration of the next round.** This round leaves `pnpm verify`
  covering TS and C#, the extended tier scripted, CI running on GitHub, and a `0.1.0`
  the platform can pin. Nothing "will be wired later".

## Tasks

- [x] **T1 (fable): The repo, its toolchain and its core.** pnpm + Turborepo workspace
  (`apps/*`, `packages/*`, `plugins/*` for the C# wrapper, `gamemode-kit`), Biome with the
  platform's plugins (`scripts/lint/` — determinism, `waitfor-budget`, `test-isolation`;
  `guard-selftest.sh` on every lint), strict tsconfig, Vitest, `turbo boundaries` tags
  (`published` may depend on nothing internal but `core`; `app` never on `app`),
  `pnpm verify` = typecheck + lint + test + boundaries. `packages/core`: the port of the
  platform's clock, prng, chaos and `testing` (`eventually`, `EVENTUALLY_TIMEOUT_MS`),
  tests included, `Clock` structurally identical. The C# side: `plugins/EZPug.sln` with an
  empty `EZPug.Sdk` (net8.0, `CounterStrikeSharp.API` 1.0.373 pinned in one
  `Directory.Build.props` constant) and `EZPug.Sdk.Tests` (xunit), wrapped by
  `plugins/package.json` so `dotnet build -warnaserror` is `typecheck` and `dotnet test` is
  `test` under Turbo — no second verify command. `.env.example` with the ports CLAUDE.md
  decides. GitHub Actions: `verify` on push and PR (Node 22, pnpm, .NET 8; no CS2, no
  Dathost). `README.md` says how to run it. References: CLAUDE.md, the platform's tooling
  files named in Findings.

- [x] **T2 (fable): `@ezpug/match-api` — the vocabulary and the resources.**
  `packages/match-api` (`"name": "@ezpug/match-api"`, ESM, `exports` for `.`, `./client`,
  `./webhooks`, `./fake`, `./fixtures`, built with `tsdown` or `tsc` to `dist/` with
  types; `publishConfig.access: public`; `files` whitelist; zod as a peer + dep range the
  platform satisfies). Contents, each a Zod schema with a `GameServerEvent`-style type
  and a doc comment that says what it is for: (a) **the vocabulary** — `gameserver.ts`
  copied verbatim (minus the ingestion routes, which are the platform's door and stay
  there), plus `naming.ts`, the SteamID64 grammar and `rpc.ts`'s `defineRoute`, with a
  test that parses every event fixture copied from the platform. (b) **The Match API
  resources**: `MatchRequest` (`clientMatchId` as the idempotency key, `game`, `gamemode`,
  `teams` — rosters whose entries are `{steamId64, name, locale, rating?, rankName?,
  loadout?}` — `maps` and `rules` copied from the platform, `requirements` `{region?,
  lan?, simulated?, provider?}`, `callbacks` `{webhookUrl, webhookSecretId, demoUploadUrl?
  (presigned PUT), streamAllowedOrigins?}`, `warmupLines?`, `branding?` `{hostname?, eventName?}`, `ttlMinutes`); `Match` (state
  `pending | allocating | configuring | ready | live | recovering | ended | failed |
  cancelled`, the server's connect facts when ready — address, port, password, GOTV
  address/port/delay — `serverId`, `provider`, `gamemode`, timestamps, `endedReason?`);
  `MatchCommand` (discriminated: `pause`, `unpause`, `restart_round`, `force_end`, `kick`,
  `announce`, `rcon`, `restore`, `reroll`, `profile` (push a player's profile),
  and the `sim.*` family — `step`, `mode`, `speed`, `chaos`, `kill` — with a correlation
  id) and `MatchCommandResult`; `PlayerToken` mint/response (scoped to match + SteamID,
  short TTL); `Gamemode` (T8's manifest, read side); `Capacity` (providers, regions,
  available now, drained); the **fleet** family (`FleetServer` ledger row with states
  `allocated → configured → running → released | failed`, cost snapshot, node/provider
  badge, never a password; `Provider` health; `Node` with labels, last seen, drained,
  current match; `NodeEnrolment` (token shown once); `Budget` per key; `GsltPool` size);
  `ApiKey` (create → shown once, budgets). (c) **Routes** via `defineRoute` under `/v1`:
  `gamemodes`, `capacity`, `matches` (create/get/cancel/commands/player-tokens/events with
  cursor), `fleet/*` (servers, release, providers, drain/undrain, nodes, enrol, revoke,
  ledger, budget, gslt, console/rcon), `keys` (admin scope). Error shape once
  (`{code, message, details?}`; `no_capable_server`, `budget_exceeded`, `unknown_gamemode`,
  `game_unsupported`…). (d) **Scopes**: `matches`, `fleet`, `admin` on an API key.
  Everything closed-set self-checked like the platform's union. References: Findings
  (the vocabulary, the match request), `docs/decisions.md` 3–8, 14–18.

- [ ] **T3 (fable): Webhooks and the stream.** In the same package: the **webhook
  envelope** `{deliveryId, matchId, clientMatchId, seq, occurredAt, payload}` where
  `payload` is either a gameserver event or an orchestration fact (`match.allocated`,
  `match.server_ready`, `match.recovering`, `match.recovered`, `match.failed`,
  `match.ended`, `demo.uploaded {key?, size, sha256, contentType}`, `player.joined`,
  `player.left`, `fleet.provider_unreachable`, `fleet.node_disconnected`,
  `fleet.orphan_found`, `fleet.budget_threshold`) under one discriminator; the signature
  scheme (`X-EZPug-Signature: t=<unix>,v1=<hmac-sha256(secret, t + "." + body)>`, a 5-minute
  skew window, secret ids so a client can rotate); retry policy as published constants
  (schedule, give-up, the `410` that stops retries); `GET /v1/matches/:id/events?cursor=`
  as the replay of the same envelopes. The **stream**: `GET /v1/matches/:id/stream`
  upgrade, frames `{type: 'event' | 'tick' | 'command_result' | 'presence', …}` where
  `tick` carries `position_tick` batches and `event` mirrors every durable event
  best-effort (so a live page needs one socket), plus a `hello` with the current `seq`
  so a late subscriber knows what to replay via the events route. Bilingual nothing here.
  Tests: signature round-trip, skew refusal, envelope parses every fixture event, a
  stream frame per event type. `docs/match-api.md` starts here: resources, routes,
  webhooks, stream, errors — written as the reference the platform loop will read instead
  of this repo's code. References: decision 6, the platform's ingestion ack shapes
  (`gameserver.ts:590-650`) for the idempotency vocabulary.

- [ ] **T4 (fable): The gamemode manifest and the four manifests.** `GamemodeManifest`:
  `id` (kebab), `game`, `tier` (`config | plugin | sdk`), `title` + `description` (DE+EN
  objects), `slots` `{teamSize, teams, openJoin}`, `flow` (`matchzy | plugin | none`),
  `records` (`demo | events | none`), `ranked: false` always this round (the queue's
  `pug` is ranked on the platform's side; the manifest states what the *server* records,
  never what counts), `maps` (`catalog` ids and `workshop` ids allowed, or `any`),
  `plugins` (the plugin folder names to enable, in order), `cfg` (files to exec, in order),
  `cvars` (a bounded whitelist), `capabilities` (`positions`, `chat`, `playerCommands`,
  `widget`, `backups`, `scoreboardRating`), `commands` (the player-scoped verbs an sdk mode
  accepts: name, cooldown, charges, args schema), `widget?` `{entry, needs: ['tokens',
  'locale', 'playerToken']}`, `version`, `sdkVersion`. `gamemodes/{pug,flying-scoutsman,
  retakes,powerup-dm}/manifest.json` authored now as data (PRD-02 builds what they name),
  validated by a test and served by the fake as the catalog. `docs/gamemodes.md` starts:
  the tiers, what each field means, how the platform is expected to render one.
  References: decisions 14–17, the vendor shapes in Findings (retakes config, MatchZy).

- [ ] **T5 (fable): The simulator engine, ported.** `packages/sim`: `story.ts`,
  `assignment.ts`, `record.ts`, `scenario.ts` and their tests from the platform,
  decoupled from the platform's provider interface: a `SimulatedServer` handle (`assign`,
  `start`, `step`, `setMode`, `setSpeed`, `setChaos`, `kill`, `restore`, `announce`,
  `status`, an `events` subscription that yields union events with `seq`, a `record()`
  that yields the simulated record bytes) driven by an injected `Clock`, seeded, chaos via
  `core`. Radar comes in as data (`MapRadar` in the vocabulary; a fixture set for the
  active-duty maps under `packages/sim/fixtures/radar/`, copied from the platform's map
  catalog where it lives, so positions land on real overview coordinates). A `crash`
  scenario and a `restore` that resumes from a given round exist because PRD-02's recovery
  flow will drive them. Determinism test: same seed, same clock, byte-equal event log.
  References: Findings (the engine), `specs/Foundation.md` §5 in the platform.

- [ ] **T6 (fable): The fake orchestrator.** `@ezpug/match-api/fake`:
  `createFakeOrchestrator({clock, prng?, gamemodes?, providers?: {sim: {...}, faults?}})`
  implementing every route from T2 **in-process** (a typed function surface the client
  can call without HTTP) *and* mountable as a Hono app (`fake.handler`) for HTTP tests;
  matches run on T5's engine; webhooks are delivered to a handler or POSTed to the
  callback URL with real signatures and the published retry schedule on the injected
  clock; the stream is an in-process subscription and a `ws` upgrade when mounted; ledger
  rows, budgets and capacity are real enough to refuse (`budget_exceeded`,
  `no_capable_server` for `csgo`); the `sim.*` commands drive the engine; `demoUploadUrl`
  is honoured by PUTting the simulated record to it (a fetch the test injects). Fault
  knobs: allocation refused, a boot that never ends, a crash with a restorable backup,
  a crash without one, duplicate and out-of-order webhook delivery, a provider down for a
  minute, a webhook endpoint that fails N times. This is what the platform's tests and
  history seed will run on, so it must play a Bo1 in milliseconds under a fake clock.
  References: T2–T5, the platform's `simulator/provider.ts` as the shape of the handles.

- [ ] **T7: The client and the verifier.** `@ezpug/match-api/client`:
  `createMatchApiClient({baseUrl, apiKey, fetch?, clock?})` typed from the route table,
  idempotent create (`clientMatchId` + `Idempotency-Key`), retries with backoff for 5xx and
  429 on the clock, a `subscribeStream(matchId)` helper over `ws`/`WebSocket`, typed
  errors. `@ezpug/match-api/webhooks`: `verifyWebhook({headers, body, secrets, clock})`,
  `parseEnvelope`, a `createDeliveryDeduper(store)` helper keyed on `deliveryId` and
  `(matchId, seq)`. Both tested against T6 mounted over HTTP: create → ready → live →
  ended with every webhook verified and replayed via the events route; a 429 storm; a
  stale signature refused. No `Date.now()` anywhere in it.

- [ ] **T8: The conformance suite and the recorded fixtures.** `@ezpug/match-api/fixtures`:
  `runMatchApiConformance({client, webhooks: (handler) => unsubscribe, clock?})` — a
  Vitest-free runner (returns results; a thin Vitest wrapper exists) that drives any
  implementation through the flows: happy Bo1 on `pug`, `flying-scoutsman` config-only,
  `retakes` open-join with `player.joined`, `powerup-dm` with a player token and a player
  command round-tripping to a `plugin_event`, a cancel in `allocating`, a crash with
  restore, a crash without, a `csgo` refusal, a budget refusal, webhook replay from a
  cursor, stream `hello.seq` agreeing with the events route. Every exchange the fake
  produces for those flows is **recorded** into `fixtures/recorded/*.json` (requests,
  responses, envelopes, frames; deterministic under the seed) and a test asserts the fake
  still produces them byte-for-byte — the contract's golden files, the ones the C#
  generation in PRD-02 round-trips and the platform's translator is proven against.

- [ ] **T9: Release 0.1.0.** `pnpm changeset`-style or a plain `scripts/release.mjs`:
  version, CHANGELOG entry, build, `npm publish --access public --provenance` from CI on
  a tag (`NPM_TOKEN` secret) with a local fallback (`npm publish` by the owner's login),
  `npm view @ezpug/match-api version` as the smoke. Package hygiene: `README.md` inside the
  package (install, the three entry points, a ten-line example), `sideEffects: false`,
  `engines.node >= 22`, types resolve under `moduleResolution: bundler` and `node16` (a
  test with `arethetypeswrong` or `publint`). Tag `match-api@0.1.0`. If npm is not logged
  in on this box and CI has no token: `> blocked:` with the exact commands and finish the
  round — the platform loop cannot start until this lands, so the closing note shouts it.

- [ ] **T10: Docs, pins and the handoff.** `docs/match-api.md` complete and checked
  against the route table by a test (every route has a section); `docs/gamemodes.md`
  complete for the manifest; `docs/pins.md` (CounterStrikeSharp 1.0.373, .NET SDK 10.0.400 —
  net10.0 since CounterStrikeSharp 1.0.369, decided in T1 —
  MatchZy 0.8.15, Metamod 2.0 git1411, cs2-retakes 3.1.0, cs2-WeaponPaints at the
  platform's recorded commit `fa8936f3` — PRD-02 updates as it vendors); `README.md`
  status line; `CLAUDE.md` amended where a task decided differently, and the progress line
  says so. The closing note lists: the published version, what PRD-02 consumes (engine,
  protocol seams, manifests, conformance), what the platform's PRD-09 consumes (the
  package, the fake, the fixtures, `docs/match-api.md`), and every schema field that was
  invented here without a platform counterpart (the platform loop reads that list first).

## Working rules

- **`pnpm verify` green before every commit**, TS and C# both, from T1 on. Extended tier
  this round = the conformance suite against the fake over HTTP (T8) plus the determinism
  test (T5); scripted as `pnpm verify:extended` even while it is small.
- **Contracts are copied, then frozen.** T2's vocabulary is byte-compatible with the
  platform's file at `/root/ezpug/packages/contracts/src/gameserver.ts` on 2026-09-05 — a
  test parses the platform's fixtures. Every schema the round invents is in
  `docs/match-api.md` the same commit.
- **Determinism**: injected clock, seeded PRNG, `eventually()` never `vi.waitFor`; the
  fake plays a Bo1 in milliseconds under a fake clock and the same seed yields the same
  recorded fixtures.
- **Nothing in this package knows a provider**: no `dathost`, no `node`, no MatchZy
  config in `@ezpug/match-api` beyond `provider` as a badge string and `sim.*` commands.
  `grep -rn -i "dathost\|matchzy" packages/match-api/src` returns doc comments at most.
- **Secrets**: the fake's API keys and webhook secrets are obviously fake strings and a
  test greps recorded fixtures for them; nothing real exists yet.
- **Hard don'ts:** no HTTP server that outlives a test; no database; no Vue or browser
  code (the `gamemode-kit` is PRD-02's); no hand-written C# wire types; no publish of a
  `0.x` that the conformance suite has not passed.

## When the PRD is complete

- `pnpm verify` and `pnpm verify:extended` green twice in a row; CI green on `main`.
- `@ezpug/match-api@0.1.0` on npm (or the exact blocked command in the note).
- `docs/match-api.md`, `docs/gamemodes.md`, `docs/pins.md`, `README.md`, `CLAUDE.md`
  true to what shipped.
- The closing progress note carries the handoff lists T10 names, and the two commands
  that start the parallel rounds: `./ralph/afk-ralph.sh ralph/PRD-02-iron.md 45` here and
  `./ralph/afk-ralph.sh ralph/PRD-09-iron-platform.md 40` in `/root/ezpug`.
