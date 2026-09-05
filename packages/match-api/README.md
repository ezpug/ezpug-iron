# @ezpug/match-api

The contract between [EZPug](https://ezpug.com) and its gameserver side,
[EZPug Iron](https://github.com/ezpug/ezpug-iron): the gameserver event vocabulary, the
Match API's resources and routes, a typed client, and — as the spine round completes —
the webhook envelope and verifier, the stream frames, the gamemode manifest, conformance
fixtures and an in-process fake orchestrator.

```sh
pnpm add @ezpug/match-api zod
```

Five entry points:

- `@ezpug/match-api` — every schema and type: `gameserverEventSchema`,
  `matchRequestSchema`, `matchSchema`, `matchCommandSchema`, the fleet shapes, the
  webhook envelope and the stream frames, the route table `matchApiRoutes`, the error
  vocabulary, the scopes.
- `@ezpug/match-api/client` — `createMatchApiClient({ baseUrl, apiKey, fetch?, clock? })`,
  typed from the route table, with an `Idempotency-Key` on the calls that have one,
  retries with backoff for `429` and `5xx` on the injected clock, and
  `subscribeStream({ matchId, onFrame })` for the live socket.
- `@ezpug/match-api/webhooks` — the envelope, the orchestration facts, `verifyWebhook`
  (and `signWebhook`, so a test can round-trip), `parseEnvelope`,
  `createDeliveryDeduper`, the retry policy as constants.
- `@ezpug/match-api/fixtures` — one valid event and one valid fact per type, and the
  recorded conformance fixtures once they exist.
- `@ezpug/match-api/fake` — `createFakeOrchestrator({ clock, ... })`: every route in-process
  (`fake.client(apiKey)`) and as a Hono app (`fake.handler`, `fake.listen()`), matches played
  by the simulator engine on your clock, real webhook signatures and retries, the stream,
  fault knobs. What your tests run against.

```ts
import { createMatchApiClient } from '@ezpug/match-api/client'

const client = createMatchApiClient({ baseUrl: 'https://gs.ezpug.com', apiKey })
const match = await client.matches.create({
  body: {
    clientMatchId: platformMatchId,
    game: 'cs2',
    gamemode: 'pug',
    teams: { teamA, teamB },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    rules,
    callbacks: { webhookUrl, webhookSecretId: 'whsec-2026-09' },
    ttlMinutes: 180,
  },
})
await client.matches.command({
  params: { matchId: match.id },
  body: { type: 'announce', correlationId: crypto.randomUUID(), text: 'glhf' },
})
```

```ts
import { createDeliveryDeduper, verifyWebhook } from '@ezpug/match-api/webhooks'

const deduper = createDeliveryDeduper(store)

// `body` is the bytes as received — the signature is over those, not over a re-serialisation.
const body = await request.text()
const result = await verifyWebhook({ headers: request.headers, body, secrets, clock })
if (!result.ok) return new Response(null, { status: result.status })
if ((await deduper.check(result.envelope)) === null) await handle(result.envelope)
return new Response(null, { status: 200 })
```

The reference is [`docs/match-api.md`](https://github.com/ezpug/ezpug-iron/blob/main/docs/match-api.md)
in the repo. A change to a schema is a semver release with a changelog line, never a
silent edit.

```ts
import { createFakeClock } from '@ezpug/core'
import { createFakeOrchestrator } from '@ezpug/match-api/fake'

const clock = createFakeClock()
const fake = createFakeOrchestrator({ clock, webhooks: { deliver: () => 200 } })
const { secret } = fake.mintKey({ name: 'test', scopes: ['matches'], budget, webhookSecrets })
const match = await fake.client(secret).matches.create({ body: request })
await fake.playOut() // a whole Bo1 in milliseconds
```

`hono` is a peer dependency (the fake is a Hono app); `ws` and `@hono/node-server` are
optional and only loaded by `fake.listen()`.
