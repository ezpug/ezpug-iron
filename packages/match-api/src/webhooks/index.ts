/**
 * `@ezpug/match-api/webhooks` — what a consumer of the orchestrator's
 * webhooks needs and nothing a server needs: the envelope and the facts it
 * carries, the signature scheme (sign and verify, so a contract test can
 * round-trip them), the published retry policy, and the two calls a handler
 * is written around — `verifyWebhook({ headers, body, secrets, clock })` and
 * `createDeliveryDeduper(store)`.
 */
export * from './deduper'
export * from './envelope'
export * from './events'
export * from './retry'
export * from './signature'
export * from './verify'
