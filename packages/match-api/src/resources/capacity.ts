import { z } from 'zod'
import { gameSchema } from '../vocabulary/game'
import { kebabNameSchema } from '../vocabulary/naming'
import { timestampSchema } from './common'

/**
 * **What could be allocated right now** (`GET /v1/capacity`): the answer to
 * "can I ask for this" before asking. Per provider, per region: the games it
 * plays, whether it is a LAN node, how many servers it could start now, and
 * whether an operator drained it. A drained provider is listed with what it
 * holds and `available: 0`.
 */

export const capacityRegionSchema = z.object({
  region: kebabNameSchema,
  games: z.array(gameSchema).min(1),
  /** A self-hosted node's region: capacity at a venue (decision 23). */
  lan: z.boolean(),
  /** Servers that could be allocated now; null where the provider cannot say. */
  available: z.number().int().nonnegative().nullable(),
})
export type CapacityRegion = z.infer<typeof capacityRegionSchema>

export const capacityProviderSchema = z.object({
  id: kebabNameSchema,
  healthy: z.boolean(),
  drained: z.boolean(),
  regions: z.array(capacityRegionSchema),
})
export type CapacityProvider = z.infer<typeof capacityProviderSchema>

export const capacitySchema = z.object({
  providers: z.array(capacityProviderSchema),
  /** When this picture was taken. */
  asOf: timestampSchema,
})
export type Capacity = z.infer<typeof capacitySchema>
