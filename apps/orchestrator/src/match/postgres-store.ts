import type { MatchState } from '@ezpug/match-api'
import type { LinkServerState } from '@ezpug/protocol'
import { and, asc, desc, eq, gte, isNull, lte, notInArray, or, sql } from 'drizzle-orm'
import type { DatabaseExecutor } from '../db/client'
import {
  backups,
  matchCommands,
  matchEvents,
  matches,
  nodeEnrolments,
  nodes,
  playerTokens,
  servers,
  serverTokens,
  webhookDeliveries,
} from '../db/schema'
import type {
  DeliveryRow,
  DeliveryStatus,
  MatchEventRow,
  MatchRow,
  MatchStore,
  NodeRow,
  Page,
  ServerRow,
} from './store'

/**
 * The Postgres {@link MatchStore}, over the T2 schema. Takes a
 * `DatabaseExecutor`, not a connection: pass a transaction and a test rolls
 * the whole thing back. Rows go in and out as the schema types them; the
 * one shape the schema leaves loose (`state` as text) is narrowed here.
 */
type MatchDb = typeof matches.$inferSelect
type ServerDb = typeof servers.$inferSelect
type DeliveryDb = typeof webhookDeliveries.$inferSelect
type EventDb = typeof matchEvents.$inferSelect

const TERMINAL: MatchState[] = ['ended', 'failed', 'cancelled']

function toMatch(row: MatchDb): MatchRow {
  return { ...row, state: row.state as MatchState, game: row.game as MatchRow['game'] }
}

function toServer(row: ServerDb): ServerRow {
  return {
    id: row.id,
    provider: row.provider,
    serverId: row.serverId,
    nodeId: row.nodeId,
    matchId: row.matchId,
    keyId: row.keyId,
    state: row.state as ServerRow['state'],
    game: row.game as ServerRow['game'],
    region: row.region,
    lan: row.lan,
    address: row.address,
    tv: row.tv,
    costHourlyCents: row.costHourlyCents,
    providerMeta: row.providerMeta,
    versions: row.versions,
    hostname: row.hostname,
    currentMap: row.currentMap,
    linkState: row.linkState as LinkServerState | null,
    linkAckedSeq: row.linkAckedSeq,
    lastSeenAt: row.lastSeenAt,
    lastError: row.lastError,
    releasedReason: row.releasedReason,
    allocatedAt: row.allocatedAt,
    releasedAt: row.releasedAt,
    expiresAt: row.expiresAt,
  }
}

function toDelivery(row: DeliveryDb): DeliveryRow {
  return { ...row, status: row.status as DeliveryStatus }
}

function toEvent(row: EventDb): MatchEventRow {
  return row
}

function page<T>(items: T[], offset: number, limit: number): Page<T> {
  // One more than asked, so the page knows whether a next one exists.
  const more = items.length > limit
  return { items: more ? items.slice(0, limit) : items, nextOffset: more ? offset + limit : null }
}

/** The first row, mapped, or undefined — one shape for every `find`. */
async function first<T, R>(rows: Promise<T[]>, map: (row: T) => R): Promise<R | undefined> {
  const [row] = await rows
  return row === undefined ? undefined : map(row)
}

export function createPostgresMatchStore(executor: DatabaseExecutor): MatchStore {
  const one = <T>(rows: Promise<T[]>): Promise<T | undefined> => first(rows, row => row)

  return {
    insertMatch: async row => {
      await executor.insert(matches).values(row)
    },
    findMatch: id => first(executor.select().from(matches).where(eq(matches.id, id)), toMatch),
    findMatchByClientId: (keyId, clientMatchId) =>
      first(
        executor
          .select()
          .from(matches)
          .where(and(eq(matches.keyId, keyId), eq(matches.clientMatchId, clientMatchId))),
        toMatch,
      ),
    listMatches: async (keyId, filter, offset, limit) => {
      const rows = await executor
        .select()
        .from(matches)
        .where(
          and(
            eq(matches.keyId, keyId),
            filter.state === undefined ? undefined : eq(matches.state, filter.state),
            filter.clientMatchId === undefined
              ? undefined
              : eq(matches.clientMatchId, filter.clientMatchId),
          ),
        )
        .orderBy(desc(matches.createdAt), desc(matches.id))
        .offset(offset)
        .limit(limit + 1)
      return page(rows.map(toMatch), offset, limit)
    },
    updateMatch: async (id, patch) => {
      await executor.update(matches).set(patch).where(eq(matches.id, id))
    },
    listOpenMatches: async keyId =>
      (
        await executor
          .select()
          .from(matches)
          .where(
            and(
              notInArray(matches.state, TERMINAL),
              keyId === undefined ? undefined : eq(matches.keyId, keyId),
            ),
          )
          .orderBy(asc(matches.createdAt))
      ).map(toMatch),

    appendEvent: async (matchId, event, updatedAt, patch) =>
      executor.transaction(async tx => {
        const [bumped] = await tx
          .update(matches)
          .set({ ...patch, seq: sql`${matches.seq} + 1`, updatedAt })
          .where(eq(matches.id, matchId))
          .returning({ seq: matches.seq })
        if (!bumped) throw new Error(`no match ${matchId}`)
        const row: MatchEventRow = { matchId, seq: bumped.seq, ...event }
        await tx.insert(matchEvents).values(row)
        return row
      }),
    listEvents: async (matchId, afterSeq, limit) =>
      (
        await executor
          .select()
          .from(matchEvents)
          .where(and(eq(matchEvents.matchId, matchId), sql`${matchEvents.seq} > ${afterSeq}`))
          .orderBy(asc(matchEvents.seq))
          .limit(limit)
      ).map(toEvent),

    insertDelivery: async row => {
      await executor.insert(webhookDeliveries).values(row)
    },
    findDelivery: deliveryId =>
      first(
        executor
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.deliveryId, deliveryId)),
        toDelivery,
      ),
    listDueDeliveries: async (now, limit) =>
      (
        await executor
          .select()
          .from(webhookDeliveries)
          .where(
            and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now)),
          )
          .orderBy(asc(webhookDeliveries.matchId), asc(webhookDeliveries.seq))
          .limit(limit)
      ).map(toDelivery),
    updateDelivery: async (deliveryId, patch) => {
      await executor
        .update(webhookDeliveries)
        .set(patch)
        .where(eq(webhookDeliveries.deliveryId, deliveryId))
    },
    listDeliveries: async matchId =>
      (
        await executor
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.matchId, matchId))
          .orderBy(asc(webhookDeliveries.seq))
      ).map(toDelivery),

    findCommand: (matchId, correlationId) =>
      one(
        executor
          .select()
          .from(matchCommands)
          .where(
            and(eq(matchCommands.matchId, matchId), eq(matchCommands.correlationId, correlationId)),
          ),
      ),
    insertCommand: async row => {
      await executor.insert(matchCommands).values(row)
    },
    setCommandResult: async (matchId, correlationId, result, updatedAt) => {
      await executor
        .update(matchCommands)
        .set({ resultJson: result, updatedAt })
        .where(
          and(eq(matchCommands.matchId, matchId), eq(matchCommands.correlationId, correlationId)),
        )
    },

    insertServer: async row => {
      await executor.insert(servers).values(row)
    },
    findServer: id => first(executor.select().from(servers).where(eq(servers.id, id)), toServer),
    findServerByHandle: (provider, serverId) =>
      first(
        executor
          .select()
          .from(servers)
          .where(and(eq(servers.provider, provider), eq(servers.serverId, serverId)))
          .orderBy(desc(servers.allocatedAt))
          .limit(1),
        toServer,
      ),
    updateServer: async (id, patch) => {
      await executor.update(servers).set(patch).where(eq(servers.id, id))
    },
    listOpenServers: async provider =>
      (
        await executor
          .select()
          .from(servers)
          .where(
            and(
              isNull(servers.releasedAt),
              provider === undefined ? undefined : eq(servers.provider, provider),
            ),
          )
          .orderBy(desc(servers.allocatedAt), desc(servers.id))
      ).map(toServer),
    listLedger: async (filter, offset, limit) => {
      const rows = await executor
        .select()
        .from(servers)
        .where(
          and(
            filter.state === undefined ? undefined : eq(servers.state, filter.state),
            filter.provider === undefined ? undefined : eq(servers.provider, filter.provider),
            filter.matchId === undefined ? undefined : eq(servers.matchId, filter.matchId),
          ),
        )
        .orderBy(desc(servers.allocatedAt), desc(servers.id))
        .offset(offset)
        .limit(limit + 1)
      return page(rows.map(toServer), offset, limit)
    },
    listKeyLedgerSince: async (keyId, since) =>
      (
        await executor
          .select()
          .from(servers)
          .where(
            and(
              eq(servers.keyId, keyId),
              or(isNull(servers.releasedAt), gte(servers.releasedAt, since)),
            ),
          )
          .orderBy(desc(servers.allocatedAt), desc(servers.id))
      ).map(toServer),

    insertServerToken: async row => {
      await executor.insert(serverTokens).values(row)
    },
    findServerTokenByHash: tokenHash =>
      one(executor.select().from(serverTokens).where(eq(serverTokens.tokenHash, tokenHash))),
    touchServerToken: async (id, at) => {
      await executor.update(serverTokens).set({ lastUsedAt: at }).where(eq(serverTokens.id, id))
    },

    findLiveServerToken: fleetServerId =>
      one(
        executor
          .select()
          .from(serverTokens)
          .where(and(eq(serverTokens.fleetServerId, fleetServerId), isNull(serverTokens.revokedAt)))
          .orderBy(desc(serverTokens.createdAt))
          .limit(1),
      ),

    upsertBackup: async (row, keep) => {
      await executor
        .insert(backups)
        .values(row)
        .onConflictDoUpdate({
          target: [backups.matchId, backups.mapNumber, backups.roundNumber],
          set: {
            fleetServerId: row.fleetServerId,
            filename: row.filename,
            content: row.content,
            createdAt: row.createdAt,
          },
        })
      const survivors = executor
        .select({ id: backups.id })
        .from(backups)
        .where(eq(backups.matchId, row.matchId))
        .orderBy(desc(backups.mapNumber), desc(backups.roundNumber))
        .limit(keep)
      await executor
        .delete(backups)
        .where(and(eq(backups.matchId, row.matchId), notInArray(backups.id, survivors)))
    },
    listBackups: async matchId =>
      executor
        .select()
        .from(backups)
        .where(eq(backups.matchId, matchId))
        .orderBy(desc(backups.mapNumber), desc(backups.roundNumber)),
    latestBackup: matchId =>
      one(
        executor
          .select()
          .from(backups)
          .where(eq(backups.matchId, matchId))
          .orderBy(desc(backups.mapNumber), desc(backups.roundNumber))
          .limit(1),
      ),
    findPlayerTokenByHash: tokenHash =>
      one(executor.select().from(playerTokens).where(eq(playerTokens.tokenHash, tokenHash))),
    reassignServerToken: async (id, fleetServerId) => {
      await executor.update(serverTokens).set({ fleetServerId }).where(eq(serverTokens.id, id))
    },

    insertNode: async row => {
      await executor.insert(nodes).values(row)
    },
    findNode: id => one<NodeRow>(executor.select().from(nodes).where(eq(nodes.id, id))),
    findNodeByTokenHash: tokenHash =>
      one<NodeRow>(executor.select().from(nodes).where(eq(nodes.tokenHash, tokenHash))),
    listNodes: async () =>
      executor.select().from(nodes).where(isNull(nodes.revokedAt)).orderBy(asc(nodes.enrolledAt)),
    updateNode: async (id, patch) => {
      await executor.update(nodes).set(patch).where(eq(nodes.id, id))
    },
    insertNodeEnrolment: async row => {
      await executor.insert(nodeEnrolments).values(row)
    },
    findNodeEnrolmentByHash: tokenHash =>
      one(executor.select().from(nodeEnrolments).where(eq(nodeEnrolments.tokenHash, tokenHash))),
    useNodeEnrolment: async (id, at) => {
      await executor.update(nodeEnrolments).set({ usedAt: at }).where(eq(nodeEnrolments.id, id))
    },
  }
}
