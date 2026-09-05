/**
 * `@ezpug/protocol` — the wire protocols inside EZPug Iron (decision 2):
 *
 * - **The server link** (`server-link.ts`): the one outbound WebSocket every
 *   server's plugin opens to the orchestrator, both directions.
 * - **The node link** (`node-link.ts`): the one an `ezpug-node` agent opens.
 * - **The constants** (`constants.ts`): version, paths, limits, close codes.
 * - **The JSON Schema export** (`schema.ts`): the documents
 *   `scripts/protocol-schema.mjs` writes under `schema/` and
 *   `scripts/protocol-codegen.mjs` turns into `plugins/EZPug.Sdk/Generated/`.
 *
 * Internal to this repo: it may change freely, but the C# is regenerated in
 * the same commit and the fixtures under `fixtures/` are the arbiter of every
 * shape disagreement between the two languages (PRD-02 working rules).
 */
export * from './constants'
export * from './node-link'
export * from './schema'
export * from './server-link'
