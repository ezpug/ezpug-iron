# @ezpug/match-api

A change to a schema is a release with a line here (decisions 3, 24).

## Unreleased

_Nothing yet._

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
