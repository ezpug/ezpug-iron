import type {
  BackupRow,
  CommandRow,
  DeliveryRow,
  MatchEventRow,
  MatchRow,
  MatchStore,
  Page,
  PlayerTokenRow,
  ServerRow,
  ServerTokenRow,
} from './store'

/**
 * The in-memory {@link MatchStore}: the same contract as the Postgres one,
 * for every test of the machine, the walk, the reaper, the webhook worker
 * and the stream that has nothing to prove about a database. Rows are
 * copied on the way in and out so a test cannot mutate the store's truth by
 * accident, which is what a database would also refuse.
 */
export function createMemoryMatchStore(): MatchStore & {
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
  }
} {
  const matches: MatchRow[] = []
  const events: MatchEventRow[] = []
  const deliveries: DeliveryRow[] = []
  const commands: CommandRow[] = []
  const servers: ServerRow[] = []
  const serverTokens: ServerTokenRow[] = []
  const backups: BackupRow[] = []
  const playerTokens: PlayerTokenRow[] = []

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
    rows: { matches, events, deliveries, commands, servers, serverTokens, backups, playerTokens },

    insertMatch: row => {
      if (byId(row.id)) throw new Error(`match ${row.id} exists`)
      matches.push(copy(row))
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
    listDueDeliveries: (now, limit) =>
      Promise.resolve(
        deliveries
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
      servers.push(copy(row))
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

    insertServerToken: row => {
      serverTokens.push(copy(row))
      return Promise.resolve()
    },

    latestBackup: matchId =>
      Promise.resolve(
        copy(
          [...backups]
            .filter(row => row.matchId === matchId)
            .sort((a, b) => b.mapNumber - a.mapNumber || b.roundNumber - a.roundNumber)[0],
        ),
      ),
    findPlayerTokenByHash: tokenHash =>
      Promise.resolve(copy(playerTokens.find(row => row.tokenHash === tokenHash))),
  }
}
