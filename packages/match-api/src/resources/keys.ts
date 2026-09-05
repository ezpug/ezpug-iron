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

export const apiKeySchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(64),
  /** The first characters of the key, so an operator can tell keys apart. */
  prefix: z.string().min(4).max(12),
  scopes: matchApiScopesSchema,
  budget: budgetLimitsSchema,
  /** The ids of the registered webhook secrets, never the secrets. */
  webhookSecretIds: z.array(z.string().min(1)),
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
})
export type ApiKeyCreateRequest = z.infer<typeof apiKeyCreateRequestSchema>

/** The mint: the key row and the secret, shown here and never again. */
export const apiKeyCreatedSchema = z.object({
  key: apiKeySchema,
  secret: z.string().min(32),
})
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>
