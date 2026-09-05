# @ezpug/match-api

The contract between [EZPug](https://ezpug.com) and its gameserver side,
[EZPug Iron](https://github.com/ezpug/ezpug-iron): the gameserver event vocabulary, the
Match API's resources and routes, a typed client, and — as the spine round completes —
the webhook envelope and verifier, the stream frames, the gamemode manifest, conformance
fixtures and an in-process fake orchestrator.

```sh
pnpm add @ezpug/match-api zod
```

Four entry points:

- `@ezpug/match-api` — every schema and type: `gameserverEventSchema`,
  `matchRequestSchema`, `matchSchema`, `matchCommandSchema`, the fleet shapes, the
  webhook envelope and the stream frames, the route table `matchApiRoutes`, the error
  vocabulary, the scopes.
- `@ezpug/match-api/client` — `createMatchApiClient({ baseUrl, apiKey, fetch? })`, typed
  from the route table.
- `@ezpug/match-api/webhooks` — the envelope, the orchestration facts,
  `verifyWebhookSignature` (and `signWebhook`, so a test can round-trip), the retry
  policy as constants.
- `@ezpug/match-api/fixtures` — one valid event and one valid fact per type, and the
  recorded conformance fixtures once they exist.

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
import { verifyWebhookSignature, webhookEnvelopeSchema } from '@ezpug/match-api/webhooks'

const verdict = await verifyWebhookSignature({
  header: request.headers.get('x-ezpug-signature'),
  body: rawBody,
  secrets: { 'whsec-2026-09': process.env.EZPUG_WEBHOOK_SECRET },
  clock,
})
if (!verdict.ok) return new Response(null, { status: 401 })
const envelope = webhookEnvelopeSchema.parse(JSON.parse(rawBody))
```

The reference is [`docs/match-api.md`](https://github.com/ezpug/ezpug-iron/blob/main/docs/match-api.md)
in the repo. A change to a schema is a semver release with a changelog line, never a
silent edit.
