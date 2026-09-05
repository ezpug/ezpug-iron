# @ezpug/match-api

The contract between [EZPug](https://ezpug.com) and its gameserver side,
[EZPug Iron](https://github.com/ezpug/ezpug-iron): the gameserver event vocabulary, the
Match API's resources and routes, the webhook envelope and its verifier, the stream
frames, the gamemode manifest, a typed client, a conformance suite with recorded golden
exchanges, and an in-process fake orchestrator that plays real matches on a simulator
engine under your own clock.

Everything a client needs to create a match, watch it and be told how it went. Nothing
about *how* a server is acquired: providers, nodes and plugins stay behind the door.

```sh
pnpm add @ezpug/match-api zod
```

ESM only, Node 22 or newer. `zod` is a peer dependency (the schemas run on yours); `hono`
is one too, but only `@ezpug/match-api/fake` touches it, and `ws` plus `@hono/node-server`
are optional and loaded on demand by `fake.listen()`.

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
- `@ezpug/match-api/fixtures` — one valid event and one valid fact per type, plus the
  conformance suite: `runMatchApiConformance({ target })` drives any implementation of the
  Match API through the eleven flows a client actually performs and hands back a report,
  and `fixtures/recorded/<flow>.json` holds what the fake produced for each of them
  (`@ezpug/match-api/fixtures/recorded/happy-bo1.json`).
- `@ezpug/match-api/fake` — `createFakeOrchestrator({ clock, ... })`: every route in-process
  (`fake.client(apiKey)`) and as a Hono app (`fake.handler`, `fake.listen()`), matches played
  by the simulator engine on your clock, real webhook signatures and retries, the stream,
  fault knobs. What your tests run against — and `createFakeConformanceTarget()` points the
  conformance suite at it in one line.

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

## Versioning

The package *is* the contract, so a change to a schema is a release with a
[CHANGELOG](./CHANGELOG.md) line, never a silent edit. A new optional field, route, event
or error code is a minor; a field becoming required, a rename or a narrowed enum is a
major. While this is `0.x`, pin it exactly — a minor is the breaking bump.

`GAMESERVER_EVENT_CONTRACT_VERSION` is a separate number: it moves only when the
gameserver event union changes shape, and it is what a server and an orchestrator check
against each other.

MIT. Issues and the full reference live in
[the repo](https://github.com/ezpug/ezpug-iron).
