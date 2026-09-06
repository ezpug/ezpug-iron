# @ezpug/match-api

A change to a schema is a release with a line here (decisions 3, 24).

## Unreleased

_Nothing yet._

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
