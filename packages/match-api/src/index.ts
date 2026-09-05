/**
 * `@ezpug/match-api` — the contract between EZPug (the platform) and EZPug
 * Iron (the orchestrator, the servers, the plugins). Decision 3: one published
 * package, the only thing that crosses the repo boundary.
 *
 * - **The vocabulary** (`vocabulary/`): the gameserver event union every
 *   server speaks, v1 of the platform's own, byte-compatible; the SteamID64
 *   grammar; games; locales; radar geometry.
 * - **The resources** (`resources/`): what a match request is, what a match
 *   looks like, the commands, player tokens, the gamemode catalog, capacity,
 *   the fleet and its money, API keys.
 * - **The routes** (`routes.ts`): the table the orchestrator serves and the
 *   client is generated from; `rpc.ts` is the declaration helper.
 * - **Scopes and errors**: what a key may do, and the one error shape.
 * - **The registry** (`schemas.ts`): every wire shape by its generated name,
 *   and the JSON Schema export the C# side reads.
 *
 * The client lives at `@ezpug/match-api/client`, the conformance fixtures at
 * `@ezpug/match-api/fixtures`; the webhook verifier and the fake orchestrator
 * join under their own entry points with the tasks that build them.
 */
export * from './closed-set'
export * from './errors'
export * from './resources'
export * from './routes'
export * from './rpc'
export * from './schemas'
export * from './scopes'
export * from './vocabulary'
