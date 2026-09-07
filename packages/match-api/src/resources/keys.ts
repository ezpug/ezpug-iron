import { z } from 'zod'
import { matchApiScopesSchema } from '../scopes'
import { timestampSchema } from './common'
import { budgetLimitsSchema } from './fleet'

/**
 * **API keys** (`/v1/keys`, `admin` scope). A key is minted with its scopes and
 * its budget, shown once, stored hashed. Webhook secrets are registered on the
 * key by id so a match request can name one (`callbacks.webhookSecretId`) and
 * a client can rotate without a gap: register the new id, switch new requests
 * to it, remove the old.
 */

/** One webhook secret a key registers. The secret is never echoed. */
export const webhookSecretRegistrationSchema = z.object({
  id: z.string().min(1).max(64),
  secret: z.string().min(32).max(256),
})
export type WebhookSecretRegistration = z.infer<typeof webhookSecretRegistrationSchema>

export const webhookSecretsRequestSchema = z.object({
  secrets: z
    .array(webhookSecretRegistrationSchema)
    .min(1)
    .max(8)
    .refine(secrets => new Set(secrets.map(s => s.id)).size === secrets.length, 'an id repeats'),
})
export type WebhookSecretsRequest = z.infer<typeof webhookSecretsRequestSchema>

/**
 * **Where a key's fleet facts go** (PRD-02 T31). The four `fleet.*` facts —
 * a provider that stopped answering, a node that dropped, an orphan the
 * reaper found, a budget threshold crossed — are about the key's *capacity*,
 * not about the match they happen to be numbered in. A key that registers a
 * fleet webhook has them POSTed here instead of to the match's own callback,
 * so the console tile that watches the fleet is one endpoint and not a
 * subscription to every match.
 *
 * `secretId` names one of the key's registered webhook secrets — the same
 * signature, the same verifier, the same `kid`. A key with no fleet webhook
 * hears its fleet facts on each match's callback, exactly as before.
 */
export const fleetWebhookSchema = z.object({
  url: z.url().max(2048),
  secretId: z.string().min(1).max(64),
})
export type FleetWebhook = z.infer<typeof fleetWebhookSchema>

/** Body of `PUT /v1/keys/:keyId/fleet-webhook`; `null` unregisters it. */
export const fleetWebhookRequestSchema = z.object({
  fleetWebhook: fleetWebhookSchema.nullable(),
})
export type FleetWebhookRequest = z.infer<typeof fleetWebhookRequestSchema>

export const apiKeySchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(64),
  /** The first characters of the key, so an operator can tell keys apart. */
  prefix: z.string().min(4).max(12),
  scopes: matchApiScopesSchema,
  budget: budgetLimitsSchema,
  /** The ids of the registered webhook secrets, never the secrets. */
  webhookSecretIds: z.array(z.string().min(1)),
  /** Where the key's `fleet.*` facts are POSTed, or null for "with the match's". */
  fleetWebhook: fleetWebhookSchema.nullable(),
  createdAt: timestampSchema,
  lastUsedAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
})
export type ApiKey = z.infer<typeof apiKeySchema>

export const apiKeyCreateRequestSchema = z.object({
  name: z.string().min(1).max(64),
  scopes: matchApiScopesSchema,
  budget: budgetLimitsSchema,
  webhookSecrets: z.array(webhookSecretRegistrationSchema).max(8).default([]),
  /** Registered at the mint; `PUT /v1/keys/:keyId/fleet-webhook` moves it later. */
  fleetWebhook: fleetWebhookSchema.nullish(),
})
export type ApiKeyCreateRequest = z.infer<typeof apiKeyCreateRequestSchema>

/** The mint: the key row and the secret, shown here and never again. */
export const apiKeyCreatedSchema = z.object({
  key: apiKeySchema,
  secret: z.string().min(32),
})
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>

/**
 * Body of `PATCH /v1/keys/:keyId/budget`: the ceilings to move, at least
 * one of them. A patch and not a put, because an operator raising the
 * monthly ceiling on a Saturday should not have to restate the other two
 * from memory and risk widening them by accident.
 */
export const budgetPatchRequestSchema = budgetLimitsSchema
  .partial()
  .refine(patch => Object.keys(patch).length > 0, 'name at least one ceiling')
export type BudgetPatchRequest = z.infer<typeof budgetPatchRequestSchema>
