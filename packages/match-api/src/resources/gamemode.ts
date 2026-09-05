import { z } from 'zod'
import { gameSchema } from '../vocabulary/game'
import { localizedTextSchema } from '../vocabulary/locale'
import { kebabNameSchema } from '../vocabulary/naming'

/**
 * **A gamemode as the catalog lists it** (`GET /v1/gamemodes`, decision 14).
 * The orchestrator serves the manifests it ships; the platform caches the
 * catalog and shows it. This is the manifest's *read side*: the identity and
 * the facts a client needs to build a request and render a card. The full
 * manifest — plugins, cfg, cvars, capabilities, player commands, the widget
 * block — is `GamemodeManifest` (PRD-01 T4), which extends this with what the
 * server side reads; the catalog serves the whole manifest, and a client that
 * only wants this much reads this much.
 */

/** The three tiers (decision 15): stock cfg, a community plugin, a mode on the SDK. */
export const GAMEMODE_TIERS = ['config', 'plugin', 'sdk'] as const
export const gamemodeTierSchema = z.enum(GAMEMODE_TIERS)
export type GamemodeTier = z.infer<typeof gamemodeTierSchema>

/** Who owns match flow on the server. */
export const gamemodeFlowSchema = z.enum(['matchzy', 'plugin', 'none'])
export type GamemodeFlow = z.infer<typeof gamemodeFlowSchema>

/** What the server records for a match of this mode. */
export const gamemodeRecordsSchema = z.enum(['demo', 'events', 'none'])
export type GamemodeRecords = z.infer<typeof gamemodeRecordsSchema>

/** How many people, in what shape. */
export const gamemodeSlotsSchema = z.object({
  teamSize: z.number().int().positive().max(32),
  teams: z.number().int().positive().max(2),
  /** Players may join without being rostered; profiles are pushed as they arrive. */
  openJoin: z.boolean(),
})
export type GamemodeSlots = z.infer<typeof gamemodeSlotsSchema>

export const gamemodeSummarySchema = z.object({
  id: kebabNameSchema,
  game: gameSchema,
  tier: gamemodeTierSchema,
  title: localizedTextSchema,
  description: localizedTextSchema,
  slots: gamemodeSlotsSchema,
  flow: gamemodeFlowSchema,
  records: gamemodeRecordsSchema,
  /** Always false this round: the manifest states what the server records, never what counts. */
  ranked: z.literal(false),
  /** The manifest's own version, semver. */
  version: z.string().min(1),
})
export type GamemodeSummary = z.infer<typeof gamemodeSummarySchema>
