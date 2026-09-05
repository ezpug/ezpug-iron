import { z } from 'zod'
import { errorEnvelopeSchema, matchApiErrorCodeSchema } from './errors'
import {
  apiKeyCreatedSchema,
  apiKeyCreateRequestSchema,
  apiKeySchema,
  budgetSchema,
  fleetServerSchema,
  gamemodeSummarySchema,
  gsltPoolSchema,
  loadoutSchema,
  matchRequestSchema,
  matchSchema,
  matchStateSchema,
  nodeEnrolmentSchema,
  nodeEnrolRequestSchema,
  nodeSchema,
  playerTokenRequestSchema,
  playerTokenSchema,
  providerHealthSchema,
  rosterEntrySchema,
  simStatusSchema,
  webhookSecretsRequestSchema,
} from './resources'
import { capacitySchema } from './resources/capacity'
import { matchCommandResultSchema, matchCommandSchema } from './resources/commands'
import { matchApiScopeSchema } from './scopes'
import { gameserverEventSchema } from './vocabulary/gameserver'
import { mapRadarSchema } from './vocabulary/radar'

/**
 * **Every wire shape, by the name its generated twin carries.** Zod is the
 * source; JSON Schema is exported from it (`matchApiJsonSchemas`); C# types
 * are generated from the JSON Schema and proven equal by round-tripping the
 * same fixture files (PRD-02). A shape that is not in this registry has no C#
 * twin and no section in the docs — so a new resource is added here the same
 * commit it is invented. Keys are the type names the generator will use.
 */
export const matchApiSchemas = {
  GameserverEvent: gameserverEventSchema,
  MapRadar: mapRadarSchema,
  MatchApiError: errorEnvelopeSchema,
  MatchApiErrorCode: matchApiErrorCodeSchema,
  MatchApiScope: matchApiScopeSchema,
  Loadout: loadoutSchema,
  RosterEntry: rosterEntrySchema,
  MatchRequest: matchRequestSchema,
  MatchState: matchStateSchema,
  Match: matchSchema,
  SimStatus: simStatusSchema,
  MatchCommand: matchCommandSchema,
  MatchCommandResult: matchCommandResultSchema,
  PlayerTokenRequest: playerTokenRequestSchema,
  PlayerToken: playerTokenSchema,
  GamemodeSummary: gamemodeSummarySchema,
  Capacity: capacitySchema,
  FleetServer: fleetServerSchema,
  ProviderHealth: providerHealthSchema,
  Node: nodeSchema,
  NodeEnrolRequest: nodeEnrolRequestSchema,
  NodeEnrolment: nodeEnrolmentSchema,
  Budget: budgetSchema,
  GsltPool: gsltPoolSchema,
  ApiKey: apiKeySchema,
  ApiKeyCreateRequest: apiKeyCreateRequestSchema,
  ApiKeyCreated: apiKeyCreatedSchema,
  WebhookSecretsRequest: webhookSecretsRequestSchema,
} as const
export type MatchApiSchemaName = keyof typeof matchApiSchemas

/**
 * The registry as JSON Schema (draft 2020-12), one document per name — what
 * the C# generator reads. Input shapes (`io: 'input'`) so a default a client
 * may omit stays optional in the generated type, exactly as it is on the wire.
 */
export function matchApiJsonSchemas(): Record<MatchApiSchemaName, Record<string, unknown>> {
  const out: Partial<Record<MatchApiSchemaName, Record<string, unknown>>> = {}
  for (const [name, schema] of Object.entries(matchApiSchemas)) {
    out[name as MatchApiSchemaName] = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'throw',
    })
  }
  return out as Record<MatchApiSchemaName, Record<string, unknown>>
}
