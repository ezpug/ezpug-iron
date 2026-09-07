import type { RconAuditEntry } from '../db/schema/servers'
import { DEFAULT_DEPLOYMENT } from '../deployment'
import type {
  BackupRow,
  CommandRow,
  DeliveryRow,
  GsltTokenRow,
  MatchEventRow,
  MatchRow,
  MatchStore,
  NodeEnrolmentRow,
  NodeRow,
  Page,
  PlayerTokenRow,
  ServerRow,
  ServerTokenRow,
} from './store'
import { RCON_AUDIT_KEEP } from './store'

/**
 * The in-memory {@link MatchStore}: the same contract as the Postgres one,
 * for every test of the machine, the walk, the reaper, the webhook worker
 * and the stream that has nothing to prove about a database. Rows are
 * copied on the way in and out so a test cannot mutate the store's truth by
 * accident, which is what a database would also refuse.
 *
 * `deployment` is the same stamp the Postgres store carries (T21c): whose
 * ledger rows these are. One store is one deployment, so nothing here can
 * see a neighbour's rows anyway — it is kept so the two implementations
 * answer `listOpenServers` identically and `store.contract.test.ts` can hold
 * them to it.
 */
export function createMemoryMatchStore(options: { deployment?: string } = {}): MatchStore & {
  /** The whole state, for a test's assertions. */
  readonly rows: {
    matches: MatchRow[]
    events: MatchEventRow[]
    deliveries: DeliveryRow[]
    commands: CommandRow[]
    servers: ServerRow[]
    serverTokens: ServerTokenRow[]
    backups: BackupRow[]
    playerTokens: PlayerTokenRow[]
    nodes: NodeRow[]
    nodeEnrolments: NodeEnrolmentRow[]
    gsltTokens: GsltTokenRow[]
  }
} {
  const matches: MatchRow[] = []
  const events: MatchEventRow[] = []
  const deliveries: DeliveryRow[] = []
  const commands: CommandRow[] = []
  const servers: ServerRow[] = []
  const serverTokens: ServerTokenRow[] = []
  /** The ledger's audit column, by row — off the row itself so a page read never carries it. */
  const rconAudits = new Map<string, RconAuditEntry[]>()
  const backups: BackupRow[] = []
  const playerTokens: PlayerTokenRow[] = []
  const nodes: NodeRow[] = []
  const nodeEnrolments: NodeEnrolmentRow[] = []
  const gsltTokens: GsltTokenRow[] = []
  const deployment = options.deployment ?? DEFAULT_DEPLOYMENT

  const copy = <T>(value: T): T => structuredClone(value)
  const byId = (id: string): MatchRow | undefined => matches.find(row => row.id === id)
  const page = <T>(all: T[], offset: number, limit: number): Page<T> => {
    const items = all.slice(offset, offset + limit).map(copy)
    const next = offset + items.length
    return { items, nextOffset: next < all.length ? next : null }
  }
  const newestFirst = <T extends { allocatedAt?: Date; createdAt?: Date }>(rows: T[]): T[] =>
    [...rows].sort(
      (a, b) =>
        (b.allocatedAt ?? b.createdAt ?? new Date(0)).getTime() -
          (a.allocatedAt ?? a.createdAt ?? new Date(0)).getTime() ||
        rows.indexOf(b) - rows.indexOf(a),
    )

  return {
    deployment,

    rows: {
      matches,
      events,
      deliveries,
      commands,
      servers,
      serverTokens,
      backups,
      playerTokens,
      nodes,
      nodeEnrolments,
      gsltTokens,
    },

    insertMatch: row => {
      if (byId(row.id)) throw new Error(`match ${row.id} exists`)
      matches.push(copy({ ...row, deployment }))
      return Promise.resolve()
    },
    findMatch: id => Promise.resolve(copy(byId(id))),
    findMatchByClientId: (keyId, clientMatchId) =>
      Promise.resolve(
        copy(matches.find(row => row.keyId === keyId && row.clientMatchId === clientMatchId)),
      ),
    listMatches: (keyId, filter, offset, limit) =>
      Promise.resolve(
        page(
          newestFirst(matches.filter(row => row.keyId === keyId))
            .filter(row => filter.state === undefined || row.state === filter.state)
            .filter(
              row =>
                filter.clientMatchId === undefined || row.clientMatchId === filter.clientMatchId,
            ),
          offset,
          limit,
        ),
      ),
    updateMatch: (id, patch) => {
      const row = byId(id)
      if (!row) throw new Error(`no match ${id}`)
      Object.assign(row, copy(patch))
      return Promise.resolve()
    },
    listOpenMatches: keyId =>
      Promise.resolve(
        matches
          .filter(row => row.deployment === deployment)
          .filter(row => !['ended', 'failed', 'cancelled'].includes(row.state))
          .filter(row => keyId === undefined || row.keyId === keyId)
          .map(copy),
      ),

    appendEvent: (matchId, event, updatedAt, patch) => {
      const row = byId(matchId)
      if (!row) throw new Error(`no match ${matchId}`)
      if (patch) Object.assign(row, copy(patch))
      row.seq += 1
      row.updatedAt = updatedAt
      const stored: MatchEventRow = { matchId, seq: row.seq, ...copy(event) }
      events.push(stored)
      return Promise.resolve(copy(stored))
    },
    listEvents: (matchId, afterSeq, limit) =>
      Promise.resolve(
        events
          .filter(row => row.matchId === matchId && row.seq > afterSeq)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit)
          .map(copy),
      ),

    insertDelivery: row => {
      deliveries.push(copy(row))
      return Promise.resolve()
    },
    findDelivery: deliveryId =>
      Promise.resolve(copy(deliveries.find(row => row.deliveryId === deliveryId))),
    // A delivery is its match's deployment's (T21c).
    listDueDeliveries: (now, limit) =>
      Promise.resolve(
        deliveries
          .filter(row => byId(row.matchId)?.deployment === deployment)
          .filter(
            row =>
              row.status === 'pending' && row.nextAttemptAt !== null && row.nextAttemptAt <= now,
          )
          .sort((a, b) => a.matchId.localeCompare(b.matchId) || a.seq - b.seq)
          .slice(0, limit)
          .map(copy),
      ),
    updateDelivery: (deliveryId, patch) => {
      const row = deliveries.find(candidate => candidate.deliveryId === deliveryId)
      if (!row) throw new Error(`no delivery ${deliveryId}`)
      Object.assign(row, copy(patch))
      return Promise.resolve()
    },
    listDeliveries: matchId =>
      Promise.resolve(
        deliveries
          .filter(row => row.matchId === matchId)
          .sort((a, b) => a.seq - b.seq)
          .map(copy),
      ),

    findCommand: (matchId, correlationId) =>
      Promise.resolve(
        copy(commands.find(row => row.matchId === matchId && row.correlationId === correlationId)),
      ),
    insertCommand: row => {
      commands.push(copy(row))
      return Promise.resolve()
    },
    setCommandResult: (matchId, correlationId, result, updatedAt) => {
      const row = commands.find(c => c.matchId === matchId && c.correlationId === correlationId)
      if (!row) throw new Error(`no command ${correlationId}`)
      row.resultJson = copy(result)
      row.updatedAt = updatedAt
      return Promise.resolve()
    },

    insertServer: row => {
      servers.push(copy({ ...row, deployment }))
      return Promise.resolve()
    },
    findServer: id => Promise.resolve(copy(servers.find(row => row.id === id))),
    findServerByHandle: (provider, serverId) =>
      Promise.resolve(
        copy(
          newestFirst(servers).find(row => row.provider === provider && row.serverId === serverId),
        ),
      ),
    updateServer: (id, patch) => {
      const row = servers.find(candidate => candidate.id === id)
      if (!row) throw new Error(`no server ${id}`)
      Object.assign(row, copy(patch))
      return Promise.resolve()
    },
    listOpenServers: provider =>
      Promise.resolve(
        newestFirst(servers)
          .filter(row => row.deployment === deployment)
          .filter(row => row.releasedAt === null)
          .filter(row => provider === undefined || row.provider === provider)
          .map(copy),
      ),
    listLedger: (filter, offset, limit) =>
      Promise.resolve(
        page(
          newestFirst(servers)
            .filter(row => filter.state === undefined || row.state === filter.state)
            .filter(row => filter.provider === undefined || row.provider === filter.provider)
            .filter(row => filter.matchId === undefined || row.matchId === filter.matchId),
          offset,
          limit,
        ),
      ),

    listKeyLedgerSince: (keyId, since) =>
      Promise.resolve(
        newestFirst(servers)
          .filter(row => row.keyId === keyId)
          .filter(row => row.releasedAt === null || row.releasedAt >= since)
          .map(copy),
      ),

    insertServerToken: row => {
      serverTokens.push(copy(row))
      return Promise.resolve()
    },
    findServerTokenByHash: tokenHash =>
      Promise.resolve(copy(serverTokens.find(row => row.tokenHash === tokenHash))),
    touchServerToken: (id, at) => {
      const row = serverTokens.find(candidate => candidate.id === id)
      if (!row) throw new Error(`no server token ${id}`)
      row.lastUsedAt = at
      return Promise.resolve()
    },

    findLiveServerToken: fleetServerId =>
      Promise.resolve(
        copy(
          [...serverTokens]
            .filter(row => row.fleetServerId === fleetServerId && row.revokedAt === null)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0],
        ),
      ),

    appendRconAudit: (fleetServerId, entry) => {
      const trail = [...(rconAudits.get(fleetServerId) ?? []), entry]
      rconAudits.set(fleetServerId, trail.slice(-RCON_AUDIT_KEEP))
      return Promise.resolve()
    },
    rconAudit: fleetServerId => Promise.resolve(copy(rconAudits.get(fleetServerId) ?? [])),

    upsertBackup: (row, keep) => {
      const existing = backups.findIndex(
        b =>
          b.matchId === row.matchId &&
          b.mapNumber === row.mapNumber &&
          b.roundNumber === row.roundNumber,
      )
      if (existing >= 0) backups.splice(existing, 1)
      backups.push(copy(row))
      const survivors = new Set(
        backups
          .filter(b => b.matchId === row.matchId)
          .sort((a, b) => b.mapNumber - a.mapNumber || b.roundNumber - a.roundNumber)
          .slice(0, keep)
          .map(b => b.id),
      )
      for (let i = backups.length - 1; i >= 0; i -= 1) {
        const candidate = backups[i]
        if (candidate && candidate.matchId === row.matchId && !survivors.has(candidate.id))
          backups.splice(i, 1)
      }
      return Promise.resolve()
    },
    listBackups: matchId =>
      Promise.resolve(
        backups
          .filter(row => row.matchId === matchId)
          .sort((a, b) => b.mapNumber - a.mapNumber || b.roundNumber - a.roundNumber)
          .map(copy),
      ),
    latestBackup: matchId =>
      Promise.resolve(
        copy(
          [...backups]
            .filter(row => row.matchId === matchId)
            .sort((a, b) => b.mapNumber - a.mapNumber || b.roundNumber - a.roundNumber)[0],
        ),
      ),
    insertPlayerToken: row => {
      playerTokens.push(copy(row))
      return Promise.resolve()
    },
    findPlayerTokenByHash: tokenHash =>
      Promise.resolve(copy(playerTokens.find(row => row.tokenHash === tokenHash))),
    reassignServerToken: (id, fleetServerId) => {
      const row = serverTokens.find(candidate => candidate.id === id)
      if (!row) throw new Error(`no server token ${id}`)
      row.fleetServerId = fleetServerId
      return Promise.resolve()
    },

    insertGsltToken: row => {
      gsltTokens.push(copy(row))
      return Promise.resolve()
    },
    listGsltTokens: () =>
      Promise.resolve(gsltTokens.filter(row => row.deletedAt === null).map(copy)),
    findGsltTokenBySteamId: steamId =>
      Promise.resolve(copy(gsltTokens.find(row => row.steamId === steamId))),
    findGsltTokenByLease: fleetServerId =>
      Promise.resolve(
        copy(
          gsltTokens.find(row => row.deletedAt === null && row.leasedByServerId === fleetServerId),
        ),
      ),
    updateGsltToken: (id, patch) => {
      const row = gsltTokens.find(candidate => candidate.id === id)
      if (!row) throw new Error(`no gslt token ${id}`)
      Object.assign(row, copy(patch))
      return Promise.resolve()
    },
    claimFreeGsltToken: (fleetServerId, at) => {
      // The longest-idle free account, so a token that was just released has
      // the most time to be forgotten by whatever was logged in with it.
      const free = gsltTokens
        .filter(row => row.deletedAt === null && row.leasedByServerId === null)
        .sort((a, b) => (a.leasedAt?.getTime() ?? 0) - (b.leasedAt?.getTime() ?? 0))
      const row = free[0]
      if (!row) return Promise.resolve(undefined)
      row.leasedByServerId = fleetServerId
      row.leasedAt = at
      return Promise.resolve(copy(row))
    },
    listLeakedGsltLeases: () =>
      Promise.resolve(
        gsltTokens
          .filter(row => row.deletedAt === null && row.leasedByServerId !== null)
          .filter(row => {
            const server = servers.find(candidate => candidate.id === row.leasedByServerId)
            return !server || server.releasedAt !== null
          })
          .map(copy),
      ),

    insertNode: row => {
      nodes.push(copy(row))
      return Promise.resolve()
    },
    findNode: id => Promise.resolve(copy(nodes.find(row => row.id === id))),
    findNodeByTokenHash: tokenHash =>
      Promise.resolve(
        copy(nodes.find(row => row.tokenHash !== null && row.tokenHash === tokenHash)),
      ),
    listNodes: () =>
      Promise.resolve(
        nodes
          .filter(row => row.revokedAt === null)
          .sort((a, b) => a.enrolledAt.getTime() - b.enrolledAt.getTime())
          .map(copy),
      ),
    updateNode: (id, patch) => {
      const row = nodes.find(candidate => candidate.id === id)
      if (!row) throw new Error(`no node ${id}`)
      Object.assign(row, copy(patch))
      return Promise.resolve()
    },
    insertNodeEnrolment: row => {
      nodeEnrolments.push(copy(row))
      return Promise.resolve()
    },
    findNodeEnrolmentByHash: tokenHash =>
      Promise.resolve(copy(nodeEnrolments.find(row => row.tokenHash === tokenHash))),
    useNodeEnrolment: (id, at) => {
      const row = nodeEnrolments.find(candidate => candidate.id === id)
      if (!row) throw new Error(`no node enrolment ${id}`)
      row.usedAt = at
      return Promise.resolve()
    },
  }
}
