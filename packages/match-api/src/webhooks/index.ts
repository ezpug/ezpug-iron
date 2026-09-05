/**
 * `@ezpug/match-api/webhooks` — what a consumer of the orchestrator's
 * webhooks needs and nothing a server needs: the envelope and the facts it
 * carries, the signature scheme (sign and verify, so a contract test can
 * round-trip them) and the published retry policy. The higher-level
 * `verifyWebhook({ headers, body, secrets, clock })`, `parseEnvelope` and the
 * delivery deduper join here with the client (PRD-01 T7).
 */
export * from './envelope'
export * from './events'
export * from './retry'
export * from './signature'
