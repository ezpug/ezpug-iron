# @ezpug/match-api

The contract between [EZPug](https://ezpug.com) and its gameserver side,
[EZPug Iron](https://github.com/ezpug/ezpug-iron): the gameserver event vocabulary, the
Match API's resources and routes, a typed client, and — as the spine round completes —
the webhook envelope and verifier, the stream frames, the gamemode manifest, conformance
fixtures and an in-process fake orchestrator.

```sh
pnpm add @ezpug/match-api zod
```

Three entry points:

- `@ezpug/match-api` — every schema and type: `gameserverEventSchema`,
  `matchRequestSchema`, `matchSchema`, `matchCommandSchema`, the fleet shapes, the route
  table `matchApiRoutes`, the error vocabulary, the scopes.
- `@ezpug/match-api/client` — `createMatchApiClient({ baseUrl, apiKey, fetch? })`, typed
  from the route table.
- `@ezpug/match-api/fixtures` — one valid event per type, and the recorded conformance
  fixtures once they exist.

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

The reference is [`docs/match-api.md`](https://github.com/ezpug/ezpug-iron/blob/main/docs/match-api.md)
in the repo. A change to a schema is a semver release with a changelog line, never a
silent edit.
