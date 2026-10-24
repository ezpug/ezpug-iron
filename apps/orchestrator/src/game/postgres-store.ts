import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { DatabaseExecutor } from '../db/client'
import { gameBuilds, gameFacts, gameProviderStates } from '../db/schema'
import { DEFAULT_DEPLOYMENT } from '../deployment'
import type { GameBuildRow, GameProviderStateRow, GameStore } from './store'

type BuildRow = typeof gameBuilds.$inferSelect
type StateRow = typeof gameProviderStates.$inferSelect

function toBuild(row: BuildRow): GameBuildRow {
  return {
    build: row.build,
    steamBuildId: row.steamBuildId,
    sourceRevision: row.sourceRevision,
    observedAt: row.observedAt,
    issueNumber: row.issueNumber,
    issueUrl: row.issueUrl,
  }
}

function toState(row: StateRow): GameProviderStateRow {
  return {
    provider: row.provider,
    build: row.build,
    buildSince: row.buildSince,
    stack: row.stack,
    canary: row.canary,
    hud: row.hud,
    updatedAt: row.updatedAt,
  }
}

/**
 * The Postgres {@link GameStore}, over `game_facts`, `game_builds` and
 * `game_provider_states`, scoped to one deployment (T21c) — two
 * orchestrators on one database keep their own pictures.
 */
export function createPostgresGameStore(
  executor: DatabaseExecutor,
  options: { deployment?: string } = {},
): GameStore {
  const deployment = options.deployment ?? DEFAULT_DEPLOYMENT
  return {
    appendFact: async row => {
      await executor.insert(gameFacts).values({
        id: row.id,
        deployment,
        type: row.fact.type,
        build: row.build,
        at: row.at,
        payload: row.fact,
        createdAt: row.at,
      })
    },
    listFacts: async (limit, type) => {
      const rows = await executor
        .select()
        .from(gameFacts)
        .where(
          type === undefined
            ? eq(gameFacts.deployment, deployment)
            : and(eq(gameFacts.deployment, deployment), eq(gameFacts.type, type)),
        )
        .orderBy(desc(gameFacts.at), desc(gameFacts.createdAt))
        .limit(limit)
      return rows.map(row => ({ id: row.id, at: row.at, build: row.build, fact: row.payload }))
    },
    latestBuild: async () => {
      const rows = await executor
        .select()
        .from(gameBuilds)
        .where(eq(gameBuilds.deployment, deployment))
        .orderBy(desc(gameBuilds.observedAt), desc(gameBuilds.createdAt))
        .limit(1)
      return rows[0] ? toBuild(rows[0]) : undefined
    },
    findBuild: async build => {
      const rows = await executor
        .select()
        .from(gameBuilds)
        .where(and(eq(gameBuilds.deployment, deployment), eq(gameBuilds.build, build)))
        .limit(1)
      return rows[0] ? toBuild(rows[0]) : undefined
    },
    insertBuild: async row => {
      await executor
        .insert(gameBuilds)
        .values({
          id: randomUUID(),
          deployment,
          build: row.build,
          steamBuildId: row.steamBuildId,
          sourceRevision: row.sourceRevision,
          observedAt: row.observedAt,
          issueNumber: row.issueNumber,
          issueUrl: row.issueUrl,
          createdAt: row.observedAt,
        })
        .onConflictDoNothing()
    },
    updateBuild: async (build, patch) => {
      if (Object.keys(patch).length === 0) return
      await executor
        .update(gameBuilds)
        .set(patch)
        .where(and(eq(gameBuilds.deployment, deployment), eq(gameBuilds.build, build)))
    },
    listProviderStates: async () => {
      const rows = await executor
        .select()
        .from(gameProviderStates)
        .where(eq(gameProviderStates.deployment, deployment))
        .orderBy(gameProviderStates.provider)
      return rows.map(toState)
    },
    upsertProviderState: async row => {
      const values = {
        build: row.build,
        buildSince: row.buildSince,
        stack: row.stack,
        canary: row.canary,
        hud: row.hud,
        updatedAt: row.updatedAt,
      }
      await executor
        .insert(gameProviderStates)
        .values({ id: randomUUID(), deployment, provider: row.provider, ...values })
        .onConflictDoUpdate({
          target: [gameProviderStates.deployment, gameProviderStates.provider],
          set: values,
        })
    },
  }
}
