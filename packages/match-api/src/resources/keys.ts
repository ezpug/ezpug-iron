import { z } from 'zod'
import {
  MATCH_API_SCOPES,
  type MatchApiScope,
  matchApiScopeSchema,
  matchApiScopesSchema,
} from '../scopes'
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

/**
 * Body of `PATCH /v1/keys/:keyId/scopes` (PRD-04 T3): the scopes to grant
 * and the scopes to take away, at least one of them. A patch and not a put,
 * for the reason the budget is one — an operator granting `simulation` on a
 * Monday evening should not have to restate the key's other scopes from
 * memory and risk taking one away by accident.
 *
 * Both lists are idempotent: `add` a scope the key already holds, or
 * `remove` one it never had, and the answer is the key as it was. A scope on
 * **both** lists is refused here rather than resolved by an order the caller
 * cannot see — there is no reading of "add `fleet`, remove `fleet`" that is
 * not a mistake somewhere upstream.
 */
export const scopesPatchRequestSchema = z
  .object({
    add: z.array(matchApiScopeSchema).max(MATCH_API_SCOPES.length).optional(),
    remove: z.array(matchApiScopeSchema).max(MATCH_API_SCOPES.length).optional(),
  })
  .refine(
    patch => (patch.add?.length ?? 0) + (patch.remove?.length ?? 0) > 0,
    'name at least one scope to add or remove',
  )
  .refine(
    patch => !(patch.add ?? []).some(scope => (patch.remove ?? []).includes(scope)),
    'a scope is both added and removed',
  )
export type ScopesPatchRequest = z.infer<typeof scopesPatchRequestSchema>

/**
 * **The one place a scope patch is applied**, so the fake, the orchestrator
 * and the CLI's preview all answer the same key for the same body. The order
 * is add-then-remove and it cannot matter: the schema already refused a scope
 * that appears on both lists. Duplicates collapse, the order of
 * {@link MATCH_API_SCOPES} is what comes back — a key's scopes are a set, and
 * a stable order is what makes two `GET /v1/keys` diffable.
 *
 * An empty result is *returned*, not refused: what to do about a key left
 * with no scopes belongs to the caller, which answers `validation_failed` and
 * points at `DELETE /v1/keys/:keyId`.
 */
export function applyScopesPatch(
  held: readonly MatchApiScope[],
  patch: { add?: readonly MatchApiScope[]; remove?: readonly MatchApiScope[] },
): MatchApiScope[] {
  const next = new Set([...held, ...(patch.add ?? [])])
  for (const scope of patch.remove ?? []) next.delete(scope)
  return MATCH_API_SCOPES.filter(scope => next.has(scope))
}
