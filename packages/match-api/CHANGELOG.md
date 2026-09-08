# @ezpug/match-api

A change to a schema is a release with a line here (decisions 3, 24).

## Unreleased

_Nothing yet._

## 0.11.0 — 2026-09-08

The **fifth hardware recording**, `fixtures/recorded/real-powerup-dm-bo1.json` (PRD-02
T40): a whole `powerup-dm` — the round's original SDK mode — played by eight bots on the
dev node on this box and driven, like every other one, through nothing but the Match API.
It is the recording the round's fourth gamemode never had: `pug`, `flying-scoutsman` and
`retakes` were recorded when they landed, and `powerup-dm` was proved on hardware three
times in T26 without any of those runs being written down.

It is the longest of the five and honestly so — a ten-minute deathmatch is 346 deaths, so
355 envelopes and 355 verified deliveries against `pug`'s 47 — and it is the only recording
whose match ends on `mp_timelimit` rather than on a round count. The 5 741 position ticks
its stream carried are **not** in the file and never were: ticks are ephemeral, stream
only, never stored (`docs/decisions.md` 6), which is exactly the rule a recording of a mode
this chatty is worth having as proof of.

No schema, no route and no default moved: `0.10.1`'s shapes are this release's. Like the
four beside it, the file is never regenerated from code, and every payload in it must still
parse against this package's schemas — the day one stops, the vocabulary moved under a
server that already spoke it.

**And one conformance flow gets the margin 0.10.1 gave its neighbour.** `prefer-lan` ends
by giving its box back with `cancel`, and a cancel is refused the moment the match is live;
at the twenty times real time an extended target plays at, `ready → live` is a second or
two, so the poll that saw the connect facts and the cancel that followed it were racing the
story — green against the fake and against a quiet orchestrator, and red on a loaded box
with `cannot cancel a live match; use force_end`. The flow now asks for `sim.timeScale: 2`
like `reprovision-before-live` does, which makes the window tens of seconds; a target with
no simulator ignores it, and the flow ends at the cancel, so nothing costs more.
`fixtures/recorded/prefer-lan.json` is re-recorded to match.

## 0.10.1 — 2026-09-08

Fixtures only: no schema, no route, no default. The `reprovision-before-live` conformance
flow is the one flow that has to catch a match **in the act** — every other flow waits for
a state a match keeps, and this one needs the window between the first box being allocated
and the first round starting, because that is the only time a match can be moved. On a
target that plays a real story on real timers that window is a second or two wide, and one
starved poll cycle falls straight through it: the flow then waits out its whole budget on a
match that is already playing, and reports it as a box that never came (PRD-02 T39b). Three
changes, all inside the flow:

- The request asks for the story at **`timeScale: 2`** instead of the target's own, which
  makes the window tens of seconds — a margin that holds rather than one that is lucky —
  and a `sim.speed` back to 20 once the replacement is standing keeps the play-out at the
  speed it always ran at. A target with no simulator ignores both, which is the right
  thing to do with either.
- The waits are for the **provider's own server id**, not for the transient `ready` state
  and not for the ledger row: a row is written before the walk asks anyone for a box, so a
  reprovision keyed on `fleetServerId` would cancel an allocation that had not happened
  yet.
- A match that is already `live` or `ended` when the flow looks fails **in one poll**,
  saying the poll missed the window, instead of after the wait's whole budget saying
  nothing.

`fixtures/recorded/reprovision-before-live.json` is re-recorded to match.

## 0.10.0 — 2026-09-08

The round's last additive change is not a schema: it is a **fourth hardware recording**,
`fixtures/recorded/dathost-pug-bo1.json` (PRD-02 T36). The three `real-*.json` beside it
are matches played on the dev node on this box; this one is a match on a box **rented in a
datacentre** (Dathost, Düsseldorf) driven through the deployed orchestrator at
`gs.ezpug.com` over the public internet — 117 calls, 48 webhook envelopes and their
verified deliveries, 53 stream frames, a real demo PUT into the platform's bucket. Same
shape as every other recording (`flow`, `calls`, `envelopes`, `deliveries`, `frames`),
same rule: it is never regenerated from code, and **every payload in it must still parse**
against this package's schemas. That is what makes a recording a contract test rather than
a souvenir — the day one stops parsing, the vocabulary moved under a server that already
spoke it.

No schema, no route and no default moved in this release; `0.9.0`'s shapes are `0.10.0`'s.

## 0.9.0 — 2026-09-08

Four contract gaps the platform's own console found and wrote down instead of editing a
schema (decision 24). Each entry names the note it answers in
`ezpug/ralph/PRD-09-iron-platform.md`. Additive throughout; a client that pinned `0.8.0`
sees every shape it knew unchanged, and every one of these is optional.

- **`MatchRequirements.preferLan`** (answers **T3's note**): "the venue's hardware first,
  a rented box otherwise". Every other field of `requirements` narrows — `lan: true` means
  a self-hosted node *or nothing*, so a LAN night held before a node is enrolled refused
  every match — and this one only **ranks**: nodes first, then cheapest, and nothing
  filtered out. `lan` and `preferLan` in the same request is `validation_failed`: they are
  two different sentences about the same wish.
- **`GET /v1/sim/scenarios`** (answers **T4's note**): `{ scenarios, default }`, the
  scripted shapes this build's simulator can play, each with its knobs spelled out
  (`neverReady`, `absentPlayers`, `crashAfterRound`, `pauses`, `overtimes`, `comeback`).
  A console offering a dropdown reads it here instead of keeping a second list that agrees
  with the orchestrator's by ancestry alone; an added scenario used to be discovered as a
  `validation_failed` on a match somebody meant to demo. Served whether or not the `sim`
  provider is registered — it is what the build knows how to play, and `GET /v1/capacity`
  is what says whether it could.
- **`MatchCallbacks.demoUploadUrls`** (answers **T5's note**): one presigned PUT per map,
  `{ mapNumber, url }[]`, so a Bo3 keeps every map's demo instead of overwriting map 1's
  bytes with map 2's. **Not** a `{mapNumber}` template: a presigned URL's signature covers
  the object key it was drawn for, so a template could not be signed — the list is the only
  honest shape. The entry whose `mapNumber` matches wins, `demoUploadUrl` is the fallback
  for every map without one (exactly what a Bo1 always did), and `demoUploadUrlFor()` is
  the rule as a function, which the orchestrator, the fake and the plugin all call. With
  only the single URL the plugin still refuses the second PUT and says so in its log.
- **The `reprovision` command** (answers **T14's note**): the same match, another box.
  Before the match is live the current server is released and the placement walk runs again
  for the same `clientMatchId` — the thing a second create could never do, because that id
  is the idempotency key and a repeat replays the match it already made. From `live` it is
  the recovery a lost server starts by itself, started by hand: `match.recovering`, a
  replacement handed the newest round backup, `match.recovered`. `no_backup` from `live`
  with nothing to resume from, `invalid_state` while a replacement is already on its way.
  The ledger and the events replay tell the whole story — two rows, two `match.allocated`.
  It is the first command the orchestrator answers **by itself and never relays**
  (`ORCHESTRATOR_COMMAND_TYPES`, beside `SIM_COMMAND_TYPES`).

Four conformance flows travel with them — `sim-scenarios`, `prefer-lan`,
`reprovision-before-live` and `demo-per-map` — and pass against the fake, the fake over
HTTP and the real orchestrator.

## 0.8.0 — 2026-09-07

Fleet facts and provider health (PRD-02 T31): a key can name one endpoint for everything
that is about its capacity rather than about a match, and the ledger can be asked what a
night cost. Additive; a client that pinned `0.7.1` sees every shape it knew unchanged.

- **`ledgerFilterSchema.since`** (`GET /v1/fleet/ledger?since=`): every row that was open
  at or after that instant — still open now, or released at or after it. It is the window
  a **bill** is asked over, not the window a row was born in, so a server allocated before
  midnight and still running is part of tonight's; `GET /v1/fleet/budget` is the same read
  with the first of the month. A request without it pages the whole ledger as before.
- **`fleetWebhookSchema`** (`{ url, secretId }`) and **`ApiKey.fleetWebhook`**: where the
  key's four `fleet.*` facts are POSTed. A console tile that watches the fleet is one
  endpoint now, instead of a subscription to every open match. The envelope does not
  change — same `matchId`, same `seq`, same signature scheme, same events route — only its
  destination; `secretId` names one of the key's registered webhook secrets, so the
  verifier on the other side is the one it already runs. A key with none hears its fleet
  facts on each match's own callback, exactly as before.
- **`PUT /v1/keys/:keyId/fleet-webhook`** (`admin`, body `{ fleetWebhook }`, `null` to
  clear) and **`ApiKeyCreateRequest.fleetWebhook`** to register one at the mint. A
  `secretId` the key never registered is `validation_failed`: an endpoint whose envelopes
  carry a `kid` nothing can verify fails silently at three in the morning, which is worse
  than not having one.

## 0.7.1 — 2026-09-07

The fake says what a server says while it waits. No schema moved: `warmupLines` has been
on the request since `0.1.0`, and this is the fake finally honouring it. Serves PRD-02 T30.

- **The fake's simulated server prints a request's `warmupLines`** one every eight seconds
  from `server_ready` until the map goes live, cycling in order — as a
  `plugin_event` named `chat_announced` with `{ line }`, the same event an `announce`
  already deals, and the same rule, pace and sanitizing the core plugin's own printer
  follows on a real server. A request without warmup lines plays exactly the match it
  played before, down to the seed.

## 0.7.0 — 2026-09-07

The push: a gamemode may put one moment on one player's phone (decision 17). Serves
PRD-02 T26, `powerup-dm`'s `radar_peek` — five seconds of the enemy positions on the
phone that asked for them, and nowhere else. Additive; a client that pinned `0.6.0` sees
every shape it knew unchanged. Only a **widget** parses the frames this adds, and a
widget is served by the orchestrator that sends them, so the two never disagree about the
union.

- **`WidgetPushFrame`** (`{ type: 'push', name, data }`), a fourth member of
  `WidgetServerFrame` and a fourth entry in `WIDGET_SERVER_FRAME_TYPES`: something the
  gamemode wants *this* phone to see now. `name` is the mode's own snake_case word for
  it, `data` its own shape — this contract does not read it, because the plugin that
  sends it and the widget that draws it ship together in `gamemodes/<id>/`. A widget that
  does not recognise a `name` ignores the frame.
- **`WIDGET_PUSH_DATA_MAX`** (16 KiB of serialized JSON): the ceiling the orchestrator
  enforces where a push enters it. A mode that wants to send more than that wants an event.
- **A push is ephemeral by contract**: relayed to the open widgets of the one SteamID64
  it names, never logged, never written to the match's event log, never replayed to a
  widget that reconnects. The position-tick firehose still never crosses the socket — a
  push is a picture a mode chose to give one player, not a feed.
- **`FakeOrchestrator.widgetPush(matchId, steamId64, push)`**: the door a test or a widget
  harness opens by hand, since the fake's simulated server runs a stand-in mode with no
  opinion about when a push is due. Returns how many phones got it.
- **The shipped `powerup-dm` manifest is `0.2.0`**: the `powerup` verb's `kind` enum is
  now `speed`, `armor`, `radar_peek` (was `haste`, `armor`, `heal`), and its description
  says so in both languages. The verb, its one charge per life and its cooldown are
  unchanged.

## 0.6.0 — 2026-09-07

The widget's address: the catalog names where a gamemode's widget is served (decision 17).
Serves PRD-02 T25, the `gamemode-kit` that builds a widget and the orchestrator route that
serves it. Additive; a client that pinned `0.5.0` sees every shape it knew unchanged and
strips the one new field.

- **`widget.url`** on the served manifest (`GamemodeWidget`, optional): the absolute,
  immutable, content-hashed URL of the HTML document the platform mounts in its sandboxed
  frame — `<orchestrator>/gamemodes/<id>/widget/<sha256[0..16]>/index.html`, whose
  script is `./widget.js` beside it. The orchestrator adds it to the manifests it serves
  when it has the mode's bundle; an authored `manifest.json` never carries it, and the
  fake's catalog never does (the fake serves no bundle — the platform's dev twin stands
  in). A `capabilities.widget` mode without a `url` is one this orchestrator cannot mount
  yet; a host mounts nothing rather than a blank frame.
- **`widget.entry`** of the shipped `powerup-dm` (manifest `0.1.1`) is now `dist/widget.js`,
  the path relative to the mode's directory that `ezpug-widget build` produces.

## 0.5.0 — 2026-09-07

The widget socket: a gamemode's widget opens its own socket to the orchestrator with a
player token and taps the mode's declared commands (decision 17). Serves PRD-02 T24, which
mints the tokens, relays the taps to the plugin's SDK and teaches the simulated server to
answer them so the platform can test its host without CS2. Additive; a client that pinned
`0.4.3` sees every shape it knew unchanged.

- **`GET /v1/widget`**, a second WebSocket upgrade beside the stream (`matchApiRoutes.widget`,
  `WIDGET_SOCKET_PATH`), and its frames in `widget/socket.ts`: up `hello { protocol: 1,
  token }` — the token travels in the first frame, never in the URL — and `command {
  correlationId, command, args? }`; down `hello { matchId, steamId64, gamemode, state,
  locale?, commands: WidgetCommandState[] }` (the manifest's specs plus `chargesLeft` and
  `readyInMs` as last learned), `event { envelope }` (every durable fact, the webhook's
  envelope) and `command_result { correlationId, command, status, code?, message?,
  cooldownMs?, chargesLeft? }`. `WIDGET_COMMAND_REFUSALS` is the SDK's seven plus
  `rate_limited`, `not_live`, `unavailable`; `WIDGET_CLOSE_CODES` mirrors the stream's
  (`4000` the match ended, `4001` unauthorized, `4002` protocol, `4003` malformed, `4005`
  origin, `4008` slow consumer, `4009` no hello); `WIDGET_COMMAND_RATE_LIMIT` (ten taps,
  two a second per token) and `WIDGET_HELLO_TIMEOUT_MS` (ten seconds) are published so a
  widget can say why it was refused. `WidgetClientFrame` and `WidgetServerFrame` join the
  schema registry.
- **`validatePlayerCommandArgs(schema, args)`**: the corner of JSON Schema a manifest's
  `commands[].args` uses, checked in TypeScript with the SDK's `ArgsValidator`'s sentences —
  one document, the same verdict on the phone, the simulated server and the plugin.
- **The fake enforces the manifest now.** `fake.playerCommand()` runs the tap through the
  simulated server's stand-in mode (`@ezpug/sim`'s command table): cooldowns and charges
  per period, args against the schema, `not_in_match` off the roster unless the mode is
  open join; a refusal is an `ApiError` (`command_unsupported`, `validation_failed`,
  `player_not_in_match`, `rate_limited`, `invalid_state`) whose `details.code` is the
  socket's refusal code. `fake.widget(token, onFrame, onClose)` is the socket in-process
  and `fake.listen()` performs the `/v1/widget` upgrade. The stand-in mode's
  `plugin_event` is dealt through the engine, so it carries the server's `seq` like every
  other event — the recorded `player-command` flow was re-recorded for the shifted `seq`s
  and nothing else.
- `POST /v1/matches/:matchId/player-tokens` is documented as the orchestrator serves it: a
  rostered player, a player the server has seen join, or anyone on an open-join mode;
  `invalid_state` once the match is over.

## 0.4.3 — 2026-09-07

Catalog only: `retakes` is a mode a server can actually play. Serves PRD-02 T23, which
vendored cs2-retakes 3.1.0 and a weapon allocator into the server image and taught the
loader to write a vendored plugin's own config file before it enables it.

- The `retakes` manifest the fake serves (and the orchestrator ships) is at `0.2.0`:
  `plugins` names the allocator beside the plugin (`RetakesPlugin`, `RetakesAllocator`,
  in load order — the allocator resolves the retakes capability a tenth of a second after
  its own load), `maps.catalog` gains `de_train` and is now exactly the maps the pinned
  release ships spawn configs for, and `cvars` carries the two the mode needs to land
  after cs2-retakes' own cfg (`bot_quota_mode`, `bot_join_after_player`). The description
  says who hands out the guns.
- No schema, route, event, error code or state changed. cs2-retakes' own settings —
  `MaxPlayers`, `ShouldAutoJoinGame` — are not in the manifest and are not cvars: the
  orchestrator derives them from `slots` into the plugin's config file, over the link.
  A client that pinned `0.4.2` sees the same shapes; a client rendering the catalog sees
  a corrected card and one more map.

## 0.4.2 — 2026-09-07

Catalog only: `flying-scoutsman` grew a story and says so. Serves PRD-02 T22, which gave
the SDK a generic flow emitter — `going_live`, `round_start`, `round_end`, `side_swap`,
`map_end`, `series_end` read off the engine — so a `flow: plugin | none` mode with no
match plugin anywhere still tells a complete match.

- The `flying-scoutsman` manifest the fake serves (and the orchestrator ships) is at
  `0.2.0`: `slots.openJoin` is `true` (a scout duel is open to whoever walks in), and the
  description no longer says the mode has no match flow, because it now has one. The two
  recorded flows that read the catalog — `config-only`, `happy-bo1` — carry the new text.
- No schema, route, event, error code or state changed. A client that pinned `0.4.1` sees
  the same shapes; a client rendering the catalog sees a corrected card.

## 0.4.1 — 2026-09-06

Fixtures only: a conformance flow that finds its match already over says **why**. Serves
PRD-02 T21c, where `happy-bo1` failed a whole `pnpm verify` on `the match failed before it
was ready` and the reason lived only in a row `afterAll` was about to sweep.

- The three flows that wait for a match to become ready or to go live now print the
  `endedReason` beside the state — `failed: provider_error — server lost before going
  live: sim no longer lists server sim-1` instead of `failed`. No schema, route, event or
  recorded fixture changed; a red run in somebody else's CI is now readable from its log
  alone.

## 0.4.0 — 2026-09-06

Additive: the demo pipe says what landed and what did not. Serves PRD-02 T21 (the core
plugin owns the upload, the orchestrator relays the fact) and the platform's demo
handling in `PRD-09`, which otherwise cannot tell "no demo yet" from "there was never
going to be one".

- `demo_available` gains `sha256` (lowercase hex) and `contentType`, present together and
  only once the server has already PUT the file where `callbacks.demoUploadUrl` said. That
  pair is what the orchestrator relays as `demo.uploaded`; a `demo_available` without them
  announces a demo that exists on the server and nowhere else.
- `match.ended` gains `demo`: `uploaded`, the number of maps whose demo reached the
  client's storage, and `skipped`, why there were not more — `no_upload_url`,
  `not_recorded`, `no_demo` or `upload_failed` (`DEMO_SKIP_REASONS`). `matchDemoOutcome()`
  is the one rule every producer answers it by, so the fake and a real orchestrator cannot
  drift. Absent only from a producer older than the field.
- No route, no state and no error code changed. A match that records a demo now stays
  `live` past its own `series_end` until the demo is announced or the orchestrator's demo
  window runs out: GOTV records the *delayed* broadcast, so a `.dem` is finished a
  `tv_delay` after the last round and the server it is on is released the moment the match
  ends. The conformance suite checks the ordering (`demo_available` before
  `demo.uploaded`, both before `match.ended`).

## 0.3.0 — 2026-09-06

Additive: the recovery flow's second `match.server_ready` says that it is one. Serves
PRD-02 T14 (a server that dies comes back) and the platform's `PRD-09` handling of
`match.recovering` / `match.recovered`, which otherwise cannot tell a replacement
server's connect facts from a first boot without consulting `Match.state`.

- `match.server_ready` gains two optional fields, present together and only on the
  replacement server's announcement while the match is `recovering`: `restored: true`
  and `round`, the round play resumes from (the same number `match.recovered` then
  carries as `resumedFromRound`). A first boot's fact is byte-for-byte what it was.
- The fake says both on its recovery path; the `crash-restore` recording carries them.

## 0.2.0 — 2026-09-05

Additive: two `admin` routes the operator half of decision 7 was missing. Serves the
platform's key administration (`PRD-09` T2's console) and PRD-02 T5's budget enforcement,
which is otherwise unreachable — a ceiling nobody can move is a ceiling nobody sets.

- `POST /v1/keys/:keyId/rotate` — draw the key a new secret, kill the old one on the
  spot, answer `{ key, secret }` like a mint. Same id, scopes, budget and webhook
  secrets; `invalid_state` for a revoked key.
- `PATCH /v1/keys/:keyId/budget` — move one or more of the three ceilings
  (`BudgetPatchRequest`, at least one named); the rest keep their values, and the key's
  `fleet.budget_threshold` warnings start over.
- The fake serves both; `GET /v1/fleet/budget`, the `budget_exceeded` refusals and the
  threshold facts are unchanged — this release only adds the door to them.

## 0.1.0 — 2026-09-05

The first release: the whole contract, exercised end to end by the fake orchestrator and
the conformance suite before it left the repo. ESM only, Node 22+, `zod` and `hono` as
peers, `@ezpug/core`, `@ezpug/gamemodes` and `@ezpug/sim` bundled into `dist` so a
consumer never sees them.

- The vocabulary: the platform's gameserver event union (22 types, contract version 1)
  copied verbatim, the SteamID64 grammar, `game`, `locale`, `mapRadar`.
- The Match API resources — `MatchRequest`, `Match`, `MatchCommand`,
  `MatchCommandResult`, `PlayerToken`, `Gamemode` (read side), `Capacity`, the fleet
  family, `ApiKey` — the `/v1` route table, the three scopes and the error vocabulary.
- Webhooks: the envelope `{ deliveryId, matchId, clientMatchId, seq, occurredAt, payload }`,
  thirteen orchestration facts beside the durable gameserver events under one
  discriminator, the `X-EZPug-Signature` scheme (`t`, `kid`, `v1`; five-minute window), the
  retry schedule and the `410` stop, `GET /v1/matches/:matchId/events` with a `seq` cursor.
- The stream: `GET /v1/matches/:matchId/stream` (an upgrade) and its frames `hello`,
  `event`, `tick`, `command_result`, `presence`; close codes.
- `@ezpug/match-api/client`: the table-driven typed client —
  `createMatchApiClient({ baseUrl, apiKey, fetch?, clock?, retry?, WebSocket? })` with the
  `Idempotency-Key` header on a create and a command, retries with backoff for `429`, `5xx`
  and a dead connection on the injected clock (`CLIENT_RETRY_DELAYS_MS`, `Retry-After`
  honoured and capped), `TransportError`, and `subscribeStream({ matchId, onFrame })` over
  `ws`/`WebSocket`.
- `@ezpug/match-api/webhooks`: `signWebhook`, `verifyWebhookSignature`, the envelope, the
  facts and the retry constants, plus the consumer's half —
  `verifyWebhook({ headers, body, secrets, clock })`, `parseEnvelope` and
  `createDeliveryDeduper(store)` keyed on `deliveryId` and `(matchId, seq)`.
- `@ezpug/match-api/fixtures`: one valid event per type, one valid fact per type,
  `envelopeFixture`, and the conformance suite — `runMatchApiConformance({ target, flows? })`
  over eleven flows (`happy-bo1`, `config-only`, `open-join`, `player-command`,
  `cancel-allocating`, `crash-restore`, `crash-lost`, `csgo-refused`, `budget-refused`,
  `webhook-replay`, `stream-hello`), `formatConformanceReport`, `assertConformance`, and the
  recorded golden exchanges at `@ezpug/match-api/fixtures/recorded/<flow>.json`.
- `@ezpug/match-api/fake`: `createFakeOrchestrator({ clock, prng?, gamemodes?, providers?,
  webhooks?, fetch? })` — every route in-process (`fake.client`) and as a Hono app
  (`fake.handler`, `fake.listen()` with the stream as a `ws` upgrade), matches played by the
  simulator engine, signed webhooks on the published retry schedule, the stream, ledger and
  budgets that refuse, `sim.*` commands, the fault knobs, `playerCommand` for the widget
  round trip, and `createFakeConformanceTarget()` — the fake wired as a conformance target.
  `hono` becomes a peer dependency; `ws` and `@hono/node-server` optional.
