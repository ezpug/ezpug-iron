/**
 * `@ezpug/match-api` — the contract between EZPug (the platform) and EZPug
 * Iron (the orchestrator, the servers, the plugins). Decision 3: one published
 * package, the only thing that crosses the repo boundary.
 *
 * - **The vocabulary** (`vocabulary/`): the gameserver event union every
 *   server speaks, v1 of the platform's own, byte-compatible; the SteamID64
 *   grammar; games; locales; radar geometry.
 * - **The resources** (`resources/`): what a match request is, what a match
 *   looks like, the commands, player tokens, the gamemode manifest and the
 *   widget host contract, capacity, the fleet and its money, API keys.
 * - **The gamemodes** (`gamemodes/`): the four manifests this round ships,
 *   read from `gamemodes/<id>/manifest.json` at the repo root and bundled.
 * - **The routes** (`routes.ts`): the table the orchestrator serves and the
 *   client is generated from; `rpc.ts` is the declaration helper.
 * - **Scopes and errors**: what a key may do, and the one error shape.
 * - **The webhooks** (`webhooks/`): the envelope, the orchestration facts,
 *   the events replay's page, the signature scheme and the retry policy.
 * - **The stream** (`stream/`): the frames one socket per match carries.
 * - **The registry** (`schemas.ts`): every wire shape by its generated name,
 *   and the JSON Schema export the C# side reads.
 *
 * The client lives at `@ezpug/match-api/client`, the webhook consumer's half
 * at `@ezpug/match-api/webhooks`, the conformance fixtures at
 * `@ezpug/match-api/fixtures`; the fake orchestrator joins under its own
 * entry point with the task that builds it.
 */
export * from './closed-set'
export * from './errors'
export * from './gamemodes'
export * from './resources'
export * from './routes'
export * from './rpc'
export * from './schemas'
export * from './scopes'
export * from './stream/frames'
export * from './vocabulary'
export * from './webhooks/envelope'
export * from './webhooks/events'
export * from './webhooks/retry'
export * from './webhooks/signature'
