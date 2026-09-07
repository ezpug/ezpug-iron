# @ezpug/match-api

A change to a schema is a release with a line here (decisions 3, 24).

## Unreleased

_Nothing yet._

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
