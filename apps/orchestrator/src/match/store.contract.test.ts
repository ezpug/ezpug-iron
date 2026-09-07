import { randomUUID } from 'node:crypto'
import { matchRequestSchema } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { useTestDatabase } from '../db/testing'
import { createPostgresKeyStore } from '../keys/postgres-store'
import { hashToken, mintToken } from '../tokens'
import { requestHash } from './machine'
import { createMemoryMatchStore } from './memory-store'
import { createPostgresMatchStore } from './postgres-store'
import type { MatchInsert, MatchStore, ServerInsert } from './store'
import { RCON_AUDIT_KEEP } from './store'

/**
 * **The store contract, run against both implementations** (PRD-02 T3):
 * every operation the machine relies on, with the same expectations, over
 * the memory store (always) and over Postgres inside a rolled-back
 * transaction (when the dev world is up; required in the extended tier).
 * Where the two ever disagree, the machine's tests over memory have been
 * proving the wrong thing — which is what this file exists to catch.
 */

const database = useTestDatabase()
const at = (offsetMs = 0) => new Date(Date.parse('2026-09-05T18:00:00.000Z') + offsetMs)

const request = matchRequestSchema.parse({
  clientMatchId: 'c-1',
  game: 'cs2',
  gamemode: 'pug',
  teams: { teamA: { name: 'A', players: [] }, teamB: { name: 'B', players: [] } },
  maps: [{ map: 'de_mirage', sides: 'ct' }],
  callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: 'whsec' },
  ttlMinutes: 60,
})

function matchRow(keyId: string, clientMatchId = 'c-1', createdAt = at()): MatchInsert {
  return {
    id: randomUUID(),
    keyId,
    clientMatchId,
    state: 'pending',
    stateChangedAt: createdAt,
    game: 'cs2',
    gamemode: 'pug',
    provider: null,
    serverId: null,
    fleetServerId: null,
    connect: null,
    tv: null,
    seq: 0,
    requestJson: { ...request, clientMatchId },
    requestHash: requestHash({ ...request, clientMatchId }),
    endedReason: null,
    sim: null,
    expiresAt: at(60 * 60_000),
    readyAt: null,
    liveAt: null,
    endedAt: null,
    webhooksStoppedAt: null,
    createdAt,
    updatedAt: createdAt,
  }
}

function serverRow(keyId: string, matchId: string, allocatedAt = at()): ServerInsert {
  return {
    id: randomUUID(),
    provider: 'sim',
    serverId: null,
    nodeId: null,
    matchId,
    keyId,
    state: 'allocated',
    game: 'cs2',
    region: 'sim',
    lan: false,
    address: null,
    tv: null,
    costHourlyCents: 0,
    gsltTokenId: null,
    providerMeta: null,
    versions: null,
    hostname: null,
    currentMap: null,
    linkState: null,
    linkAckedSeq: 0,
    lastSeenAt: null,
    lastError: null,
    releasedReason: null,
    allocatedAt,
    releasedAt: null,
    expiresAt: at(60 * 60_000),
  }
}

/** The same assertions for every store; `keyId` must exist for the Postgres foreign keys. */
async function contract(store: MatchStore, keyId: string): Promise<void> {
  // matches
  const a = matchRow(keyId, 'a', at(0))
  const b = matchRow(keyId, 'b', at(1_000))
  await store.insertMatch(a)
  await store.insertMatch(b)
  expect((await store.findMatch(a.id))?.clientMatchId).toBe('a')
  expect(await store.findMatch(randomUUID())).toBeUndefined()
  expect((await store.findMatchByClientId(keyId, 'b'))?.id).toBe(b.id)
  const listed = await store.listMatches(keyId, {}, 0, 1)
  expect(listed.items.map(m => m.clientMatchId)).toEqual(['b'])
  expect(listed.nextOffset).toBe(1)
  const rest = await store.listMatches(keyId, {}, 1, 1)
  expect(rest.items.map(m => m.clientMatchId)).toEqual(['a'])
  expect(rest.nextOffset).toBeNull()
  expect((await store.listMatches(keyId, { clientMatchId: 'a' }, 0, 50)).items).toHaveLength(1)
  await store.updateMatch(a.id, {
    state: 'ended',
    endedReason: { kind: 'completed' },
    updatedAt: at(2_000),
  })
  expect((await store.findMatch(a.id))?.endedReason).toEqual({ kind: 'completed' })
  expect((await store.listMatches(keyId, { state: 'ended' }, 0, 50)).items.map(m => m.id)).toEqual([
    a.id,
  ])
  expect((await store.listOpenMatches(keyId)).map(m => m.id)).toEqual([b.id])

  // the durable log: seq is per match, gap-free, and bumps the match
  const e1 = await store.appendEvent(
    b.id,
    {
      deliveryId: randomUUID(),
      type: 'match.allocated',
      occurredAt: at(3_000),
      payload: {
        type: 'match.allocated',
        provider: 'sim',
        serverId: 'sim-1',
        fleetServerId: randomUUID(),
        region: 'sim',
      },
    },
    at(3_000),
  )
  const e2 = await store.appendEvent(
    b.id,
    {
      deliveryId: randomUUID(),
      type: 'heartbeat',
      occurredAt: at(4_000),
      payload: { type: 'heartbeat', matchId: b.id, source: { provider: 'sim', serverId: 'sim-1' } },
    },
    at(4_000),
  )
  expect([e1.seq, e2.seq]).toEqual([1, 2])
  expect((await store.findMatch(b.id))?.seq).toBe(2)
  expect((await store.listEvents(b.id, 1, 10)).map(e => e.seq)).toEqual([2])
  expect((await store.listEvents(b.id, 0, 1)).map(e => e.seq)).toEqual([1])

  // deliveries: due rows, ordered, patched
  for (const event of [e2, e1]) {
    await store.insertDelivery({
      deliveryId: event.deliveryId,
      matchId: b.id,
      seq: event.seq,
      url: 'https://platform.invalid/hooks',
      secretId: 'whsec',
      status: 'pending',
      attempt: 0,
      nextAttemptAt: event.occurredAt,
      lastStatus: null,
      lastError: null,
      deliveredAt: null,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    })
  }
  expect((await store.listDueDeliveries(at(3_500), 10)).map(d => d.seq)).toEqual([1])
  expect((await store.listDueDeliveries(at(5_000), 10)).map(d => d.seq)).toEqual([1, 2])
  await store.updateDelivery(e1.deliveryId, {
    status: 'delivered',
    attempt: 1,
    deliveredAt: at(5_000),
  })
  expect((await store.listDueDeliveries(at(5_000), 10)).map(d => d.seq)).toEqual([2])
  expect((await store.findDelivery(e1.deliveryId))?.status).toBe('delivered')
  expect((await store.listDeliveries(b.id)).map(d => d.seq)).toEqual([1, 2])

  // commands
  await store.insertCommand({
    matchId: b.id,
    correlationId: 'x',
    commandJson: { type: 'pause', correlationId: 'x' },
    resultJson: null,
    createdAt: at(),
    updatedAt: at(),
  })
  expect((await store.findCommand(b.id, 'x'))?.resultJson).toBeNull()
  await store.setCommandResult(
    b.id,
    'x',
    { correlationId: 'x', type: 'pause', status: 'applied' },
    at(),
  )
  expect((await store.findCommand(b.id, 'x'))?.resultJson?.status).toBe('applied')
  expect(await store.findCommand(b.id, 'y')).toBeUndefined()

  // the ledger. Over Postgres the suite runs inside a transaction but still sees
  // rows other suites committed (the extended conformance's sim servers, in the
  // same test database, at the same time), so the handle is this run's own and
  // every unfiltered listing is read through this run's key.
  const handle = `contract-${randomUUID().slice(0, 8)}`
  const mine = (rows: { id: string; keyId: string }[]) =>
    rows.filter(s => s.keyId === keyId).map(s => s.id)
  const s1 = serverRow(keyId, b.id, at(0))
  const s2 = serverRow(keyId, b.id, at(1_000))
  await store.insertServer(s1)
  await store.insertServer(s2)
  await store.updateServer(s1.id, { serverId: handle, state: 'configured' })
  await store.updateServer(s2.id, { serverId: handle })
  expect((await store.findServerByHandle('sim', handle))?.id).toBe(s2.id)
  expect(mine(await store.listOpenServers())).toEqual([s2.id, s1.id])
  await store.updateServer(s2.id, {
    state: 'released',
    releasedAt: at(2_000),
    releasedReason: 'test',
  })
  expect(mine(await store.listOpenServers('sim'))).toEqual([s1.id])
  expect(mine(await store.listOpenServers('dathost'))).toEqual([])
  // Whoever wrote a row, wrote its deployment (T21c): the store stamps it,
  // never the caller, and the open listing is that deployment's alone.
  expect(new Set((await store.listOpenServers()).map(row => row.deployment)).size).toBe(1)
  expect(mine((await store.listLedger({ state: 'released' }, 0, 50)).items)).toEqual([s2.id])
  expect((await store.listLedger({ matchId: b.id }, 0, 1)).nextOffset).toBe(1)
  // The link's facts (T6): what hello said, the acked seq, the token's use.
  await store.updateServer(s1.id, {
    versions: { plugin: '0.1.0', sdk: '0.1.0', counterStrikeSharp: '1.0.373' },
    hostname: 'EZPug dev server',
    currentMap: 'de_mirage',
    linkState: 'assigned',
    linkAckedSeq: 7,
    lastSeenAt: at(4_000),
  })
  expect(await store.findServer(s1.id)).toMatchObject({
    versions: { plugin: '0.1.0' },
    hostname: 'EZPug dev server',
    currentMap: 'de_mirage',
    linkState: 'assigned',
    linkAckedSeq: 7,
  })
  const serverToken = mintToken('server')
  const tokenId = randomUUID()
  await store.insertServerToken({
    id: tokenId,
    fleetServerId: s1.id,
    tokenHash: hashToken(serverToken),
    createdAt: at(),
    lastUsedAt: null,
    revokedAt: null,
  })
  expect((await store.findServerTokenByHash(hashToken(serverToken)))?.fleetServerId).toBe(s1.id)
  expect(await store.findServerTokenByHash(hashToken(mintToken('server')))).toBeUndefined()
  await store.touchServerToken(tokenId, at(5_000))
  expect((await store.findServerTokenByHash(hashToken(serverToken)))?.lastUsedAt).toEqual(at(5_000))
  // A player token (T24): hashed, scoped to a match and a SteamID64, with an expiry.
  const playerToken = mintToken('player')
  await store.insertPlayerToken({
    id: randomUUID(),
    matchId: a.id,
    keyId,
    steamId64: '76561198279375306',
    tokenHash: hashToken(playerToken),
    expiresAt: at(900_000),
    createdAt: at(),
    revokedAt: null,
  })
  const found = await store.findPlayerTokenByHash(hashToken(playerToken))
  expect(found).toMatchObject({ matchId: a.id, steamId64: '76561198279375306' })
  expect(found?.expiresAt).toEqual(at(900_000))
  expect(await store.findPlayerTokenByHash(hashToken(mintToken('player')))).toBeUndefined()
  // The budget's one read (T5): open rows always, closed ones only while
  // they belong to the month being counted.
  expect((await store.listKeyLedgerSince(keyId, at(0))).map(s => s.id)).toEqual([s2.id, s1.id])
  expect((await store.listKeyLedgerSince(keyId, at(3_000))).map(s => s.id)).toEqual([s1.id])
  expect(await store.listKeyLedgerSince(randomUUID(), at(0))).toEqual([])

  // The RCON audit (T20): appended in order, bounded, and its own per row.
  expect(await store.rconAudit(s1.id)).toEqual([])
  for (let line = 0; line < RCON_AUDIT_KEEP + 3; line += 1)
    await store.appendRconAudit(s1.id, {
      at: at(line).toISOString(),
      keyId,
      command: `status ${line}`,
      output: 'ok',
    })
  const audit = await store.rconAudit(s1.id)
  expect(audit).toHaveLength(RCON_AUDIT_KEEP)
  expect(audit[0]?.command).toBe('status 3')
  expect(audit.at(-1)?.command).toBe(`status ${RCON_AUDIT_KEEP + 2}`)
  expect(await store.rconAudit(s2.id)).toEqual([])

  // backups (T6): the same round replaces, only the newest `keep` survive
  expect(await store.latestBackup(b.id)).toBeUndefined()
  const backup = (roundNumber: number, content = `round ${roundNumber}`) => ({
    id: randomUUID(),
    matchId: b.id,
    fleetServerId: s1.id,
    mapNumber: 1,
    roundNumber,
    filename: `matchzy_1_map1_round${roundNumber}.cfg`,
    content,
    createdAt: at(roundNumber * 1_000),
  })
  for (const round of [1, 2, 3, 4]) await store.upsertBackup(backup(round), 3)
  await store.upsertBackup(backup(4, 'round 4 again'), 3)
  expect((await store.listBackups(b.id)).map(row => [row.roundNumber, row.content])).toEqual([
    [4, 'round 4 again'],
    [3, 'round 3'],
    [2, 'round 2'],
  ])
  expect((await store.latestBackup(b.id))?.roundNumber).toBe(4)
  expect(await store.listBackups(a.id)).toEqual([])
  // the GSLT pool (T17): the claim is one write, the free lease is the
  // longest-idle one, and a lease whose ledger row closed is leaked
  const gslt = (steamId: string, createdAt: Date) => ({
    id: randomUUID(),
    steamId,
    appId: 730,
    loginToken: `fake-gslt-${steamId}`,
    memo: 'ezpug-iron test',
    leasedByServerId: null,
    leasedAt: null,
    lastResetAt: null,
    createdAt,
    deletedAt: null,
  })
  expect(await store.listGsltTokens()).toEqual([])
  expect(await store.claimFreeGsltToken(s1.id, at(6_000))).toBeUndefined()
  const g1 = gslt('90000000000000001', at(0))
  const g2 = gslt('90000000000000002', at(1_000))
  await store.insertGsltToken(g1)
  await store.insertGsltToken(g2)
  expect((await store.listGsltTokens()).map(row => row.steamId)).toEqual([g1.steamId, g2.steamId])
  expect((await store.findGsltTokenBySteamId(g2.steamId))?.id).toBe(g2.id)
  expect(await store.findGsltTokenBySteamId('90000000000000009')).toBeUndefined()

  // Never leased beats leased-and-freed; among the freed, longest idle first.
  await store.updateGsltToken(g1.id, { leasedAt: at(7_000) })
  const claimed = await store.claimFreeGsltToken(s1.id, at(8_000))
  expect(claimed?.id).toBe(g2.id)
  expect(claimed?.leasedByServerId).toBe(s1.id)
  expect((await store.findGsltTokenByLease(s1.id))?.id).toBe(g2.id)
  expect(await store.findGsltTokenByLease(s2.id)).toBeUndefined()
  // s1 is the open row, s2 the closed one: only a lease on a closed (or
  // absent) row leaks.
  expect(await store.listLeakedGsltLeases()).toEqual([])
  await store.updateGsltToken(g1.id, { leasedByServerId: s2.id, leasedAt: at(8_000) })
  expect((await store.listLeakedGsltLeases()).map(row => row.id)).toEqual([g1.id])
  await store.updateGsltToken(g1.id, { leasedByServerId: null, deletedAt: at(9_000) })
  expect((await store.listGsltTokens()).map(row => row.id)).toEqual([g2.id])
  expect(await store.listLeakedGsltLeases()).toEqual([])

  // nothing written by later tasks yet
  expect(await store.findPlayerTokenByHash(hashToken(mintToken('player')))).toBeUndefined()
}

describe('the match store contract', () => {
  it('holds over memory', async () => {
    await contract(createMemoryMatchStore(), randomUUID())
  })

  it('holds over Postgres', async () => {
    await database.rollback(async tx => {
      const secret = mintToken('apiKey')
      const key = await createPostgresKeyStore(tx).insert({
        id: randomUUID(),
        name: `${database.namespace}-store`,
        prefix: secret.slice(0, 12),
        secretHash: hashToken(secret),
        scopes: ['matches'],
        budget: { maxConcurrentServers: 1, maxServerLifetimeMinutes: 60, monthlyCents: 0 },
        webhookSecrets: [],
        createdAt: at(),
      })
      // This run's own deployment (T21c): the rollback hides this suite's
      // writes from its neighbours, and the stamp hides theirs from it.
      await contract(createPostgresMatchStore(tx, { deployment: database.namespace }), key.key.id)
    })
  })
})
