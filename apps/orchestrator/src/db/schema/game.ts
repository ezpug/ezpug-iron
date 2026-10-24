import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { DEFAULT_DEPLOYMENT } from '../../deployment'
import { createdAt, timestamptz, uuidPk } from '../columns'
import type { GameCanary, GameFact } from './types'

/**
 * **The game's build, as facts** (PRD-10 T2, decision 37). Three tables, all
 * additive, all stamped with the deployment the way the ledger is (T21c):
 * the facts the build watcher writes once each, the builds it has seen with
 * the GitHub issue that follows each, and the current picture per provider
 * that `GET /v1/fleet/providers` serves as `game`.
 *
 * Nothing here is a secret: a build id, a version, a sentence, an issue
 * number. The GitHub token that files the issue is process environment
 * and is written nowhere.
 */

/** Append-only: one row per fact, never updated, never deleted. */
export const gameFacts = pgTable(
  'game_facts',
  {
    id: uuidPk(),
    deployment: text().notNull().default(DEFAULT_DEPLOYMENT),
    /** The fact's `type` (`game.build_moved`, `game.upstream_released`), indexed for the per-type reads. */
    type: text().notNull(),
    /** The build the fact is about: `to` for a move, the current build for a release. */
    build: text(),
    /** When it was observed — the clock's, and the fact's own `observedAt`. */
    at: timestamptz('at').notNull(),
    /** The whole fact, the contract's shape (`gameFactSchema`). */
    payload: jsonb().$type<GameFact>().notNull(),
    createdAt: createdAt(),
  },
  table => [
    index('game_facts_deployment_at_idx').on(table.deployment, table.at),
    index('game_facts_deployment_type_idx').on(table.deployment, table.type),
  ],
)

/** One row per build this deployment has seen, with the issue that follows it. */
export const gameBuilds = pgTable(
  'game_builds',
  {
    id: uuidPk(),
    deployment: text().notNull().default(DEFAULT_DEPLOYMENT),
    /** The game's `PatchVersion` — the id every surface of the contract uses. */
    build: text().notNull(),
    /** Steam's `buildid` for the same build, when it was read. */
    steamBuildId: text('steam_build_id'),
    /** The engine's source revision for the same build, when a server was asked. */
    sourceRevision: text('source_revision'),
    observedAt: timestamptz('observed_at').notNull(),
    /** The GitHub issue that follows this build; null until filed, or when no token files one. */
    issueNumber: integer('issue_number'),
    issueUrl: text('issue_url'),
    createdAt: createdAt(),
  },
  table => [uniqueIndex('game_builds_deployment_build_key').on(table.deployment, table.build)],
)

/** The current picture per provider — what `ProviderHealth.game` reads. One row, rewritten. */
export const gameProviderStates = pgTable(
  'game_provider_states',
  {
    id: uuidPk(),
    deployment: text().notNull().default(DEFAULT_DEPLOYMENT),
    provider: text().notNull(),
    /** The build this provider's servers run; null before the first reading. */
    build: text(),
    buildSince: timestamptz('build_since'),
    /** One opaque revision of the stack the provider runs. */
    stack: text(),
    canary: jsonb().$type<GameCanary>().notNull(),
    hud: jsonb().$type<GameCanary>().notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  table => [
    uniqueIndex('game_provider_states_deployment_provider_key').on(
      table.deployment,
      table.provider,
    ),
  ],
)
