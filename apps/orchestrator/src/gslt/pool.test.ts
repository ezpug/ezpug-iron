import { randomUUID } from 'node:crypto'
import type { FakeClock } from '@ezpug/core'
import { createFakeClock } from '@ezpug/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, keyRequest } from '../http/testing'
import { createMemoryLog } from '../log'
import { createMemoryMatchStore } from '../match/memory-store'
import type { ServerRow } from '../match/store'
import type { FakeSteam } from './fake-steam'
import { createFakeSteam } from './fake-steam'
import { createGsltPool, type GsltPool } from './pool'
import { createSteamGameServers } from './steam'

/**
 * **The GSLT pool** (PRD-02 T17). A CS2 server without a login token takes
 * LAN connections only, so this is what stands between a rented server and
 * a match nobody can join — and what stands between a bug and a Steam
 * account nobody knows exists.
 *
 * What the file is really about: one token is on one running server at a
 * time (Valve evicts the first login otherwise), the ceiling is never
 * crossed, a dry pool is a warning and not a refusal, a lost server's token
 * is reset before anybody else gets it, and nothing a crash leaves behind
 * survives a sweep.
 */

const API_KEY = 'fake-steam-key'
const KEY_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'

let clock: FakeClock
let fake: FakeSteam
let store: ReturnType<typeof createMemoryMatchStore>
let log: ReturnType<typeof createMemoryLog>

const at = (offsetMs = 0) => new Date(Date.parse('2026-09-06T12:00:00.000Z') + offsetMs)

/** A ledger row for a lease to hang off; the pool writes the lease onto it. */
function serverRow(overrides: Partial<ServerRow> = {}): ServerRow {
  return {
    id: randomUUID(),
    provider: 'dathost',
    serverId: 'clone-1',
    nodeId: null,
    matchId: null,
    keyId: KEY_ID,
    state: 'allocated',
    game: 'cs2',
    region: 'frankfurt',
    lan: false,
    address: null,
    tv: null,
    costHourlyCents: 24,
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
    allocatedAt: at(),
    releasedAt: null,
    expiresAt: at(60 * 60_000),
    ...overrides,
  }
}

async function openRow(overrides: Partial<ServerRow> = {}): Promise<string> {
  const row = serverRow(overrides)
  await store.insertServer(row)
  return row.id
}

function pool(overrides: Partial<Parameters<typeof createGsltPool>[0]> = {}): GsltPool {
  return createGsltPool({
    clock,
    log,
    store,
    steam: createSteamGameServers({
      clock,
      apiKey: API_KEY,
      fetch: fake.fetch,
      baseUrl: 'http://steam.test',
    }),
    deployment: 'gs.test',
    ...overrides,
  })
}

beforeEach(() => {
  clock = createFakeClock({ start: '2026-09-06T12:00:00.000Z' })
  fake = createFakeSteam({ clock, apiKey: API_KEY })
  store = createMemoryMatchStore()
  log = createMemoryLog()
})

describe('leasing', () => {
  it('mints an account the first time a row asks, and writes the lease on the row', async () => {
    const rowId = await openRow()
    const token = await pool().lease(rowId)

    expect(token).toBe(fake.accounts()[0]?.loginToken)
    expect(fake.accounts()[0]?.memo).toBe('ezpug-iron gs.test')
    const [held] = await store.listGsltTokens()
    expect(held?.leasedByServerId).toBe(rowId)
    expect((await store.findServer(rowId))?.gsltTokenId).toBe(held?.id)
  })

  it('gives the same row the same token twice — a lease is idempotent', async () => {
    const rowId = await openRow()
    const gslt = pool()
    expect(await gslt.lease(rowId)).toBe(await gslt.lease(rowId))
    expect(fake.accounts()).toHaveLength(1)
  })

  it('never lends one token to two rows at once', async () => {
    const gslt = pool()
    const first = await openRow()
    const second = await openRow()
    const [a, b] = await Promise.all([gslt.lease(first), gslt.lease(second)])
    expect(a).not.toBe(b)
    expect(fake.accounts()).toHaveLength(2)
    expect(await gslt.stats()).toEqual({ total: 2, inUse: 2 })
  })

  it('re-uses a freed account instead of minting a second one', async () => {
    const gslt = pool()
    const first = await openRow()
    const token = await gslt.lease(first)
    await gslt.release(first)

    const second = await openRow()
    expect(await gslt.lease(second)).toBe(token)
    expect(fake.accounts()).toHaveLength(1)
  })

  it('hands out the longest-idle account, so a token has time to be forgotten', async () => {
    const gslt = pool()
    const first = await openRow()
    const second = await openRow()
    const oldest = await gslt.lease(first)
    await clock.advance(1_000)
    await gslt.lease(second)
    // Freed newest-first; the next lease still gets the one released longest ago.
    await gslt.release(second)
    await clock.advance(1_000)
    await gslt.release(first)

    const third = await openRow()
    expect(await gslt.lease(third)).toBe(oldest)
  })

  it('stops at the ceiling and says the next server is LAN only, once', async () => {
    const gslt = pool({ max: 1 })
    expect(await gslt.lease(await openRow())).not.toBeNull()
    expect(await gslt.lease(await openRow())).toBeNull()
    expect(await gslt.lease(await openRow())).toBeNull()

    expect(fake.accounts()).toHaveLength(1)
    expect(log.lines.filter(line => line.includes('at its ceiling'))).toHaveLength(1)
  })

  it('leases nothing and mints nothing without a Steam door, and says why once', async () => {
    const gslt = createGsltPool({ clock, log, store })
    expect(await gslt.lease(await openRow())).toBeNull()
    expect(await gslt.lease(await openRow())).toBeNull()
    expect(log.lines.filter(line => line.includes('STEAM_WEB_API_KEY'))).toHaveLength(1)
    expect(await gslt.stats()).toEqual({ total: 0, inUse: 0 })
  })

  it('leases the rows it holds even with no Steam door — the key can be lost, the pool is not', async () => {
    const rowId = await openRow()
    const token = await pool().lease(rowId)
    await pool().release(rowId)

    const keyless = createGsltPool({ clock, log, store })
    expect(await keyless.lease(await openRow())).toBe(token)
  })
})

describe('releasing', () => {
  it('frees the account and clears the ledger row', async () => {
    const gslt = pool()
    const rowId = await openRow()
    await gslt.lease(rowId)
    await gslt.release(rowId)

    expect(await gslt.stats()).toEqual({ total: 1, inUse: 0 })
    expect((await store.findServer(rowId))?.gsltTokenId).toBeNull()
  })

  it('is idempotent — a row with no lease releases successfully', async () => {
    const gslt = pool()
    await expect(gslt.release(await openRow())).resolves.toBeUndefined()
    await expect(gslt.release('not-a-row-at-all')).resolves.toBeUndefined()
  })

  it('resets a lost server’s token at Steam before lending it out again', async () => {
    const gslt = pool()
    const rowId = await openRow()
    const token = await gslt.lease(rowId)
    await clock.advance(1_000)
    await gslt.release(rowId, { lost: true })

    const [held] = await store.listGsltTokens()
    expect(held?.loginToken).not.toBe(token)
    expect(held?.loginToken).toBe(fake.accounts()[0]?.loginToken)
    expect(held?.lastResetAt).toEqual(clock.date())
    expect(await gslt.lease(await openRow())).toBe(held?.loginToken)
  })

  it('keeps the account when the reset fails — the old token still works', async () => {
    const gslt = pool()
    const rowId = await openRow()
    const token = await gslt.lease(rowId)
    fake.setFaults({ status: { code: 500, times: 9, only: 'ResetLoginToken' } })

    // The backoff sleeps on the clock; nothing here is waiting on real time.
    const releasing = gslt.release(rowId, { lost: true })
    for (let round = 0; round < 20; round += 1) {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (clock.pending() > 0) await clock.next()
    }
    await releasing

    expect(await gslt.stats()).toEqual({ total: 1, inUse: 0 })
    expect((await store.listGsltTokens())[0]?.loginToken).toBe(token)
    expect(log.lines.some(line => line.includes('resetting the login token'))).toBe(true)
  })
})

describe('the sweep', () => {
  it('frees a lease whose ledger row has closed, and resets it', async () => {
    const gslt = pool()
    const rowId = await openRow()
    const token = await gslt.lease(rowId)
    // A process that died between `deallocate` and `release`: the row is
    // closed, the lease is not.
    await store.updateServer(rowId, { releasedAt: at(1_000), state: 'released' })

    await gslt.sweep()

    expect(await gslt.stats()).toEqual({ total: 1, inUse: 0 })
    expect((await store.listGsltTokens())[0]?.loginToken).not.toBe(token)
  })

  it('frees a lease whose ledger row is not there at all', async () => {
    const gslt = pool()
    await gslt.lease('99999999-0000-4000-8000-999999999999')
    await gslt.sweep()
    expect(await gslt.stats()).toEqual({ total: 1, inUse: 0 })
  })

  it('leaves a live lease alone', async () => {
    const gslt = pool()
    const rowId = await openRow()
    const token = await gslt.lease(rowId)
    await gslt.sweep()
    expect(await gslt.stats()).toEqual({ total: 1, inUse: 1 })
    expect((await store.listGsltTokens())[0]?.loginToken).toBe(token)
  })

  it('adopts an account carrying this deployment’s memo', async () => {
    const gslt = pool()
    // What a restored database, or a mint whose insert never landed, leaves
    // at Steam: an account nobody would otherwise count against the ceiling.
    const client = createSteamGameServers({
      clock,
      apiKey: API_KEY,
      fetch: fake.fetch,
      baseUrl: 'http://steam.test',
    })
    const orphan = await client.createAccount('ezpug-iron gs.test')
    const other = await client.createAccount('ezpug-iron somebody-else.test')

    await gslt.sweep()

    const held = await store.listGsltTokens()
    expect(held.map(row => row.steamId)).toEqual([orphan.steamId])
    expect(held[0]?.loginToken).toBe(orphan.loginToken)
    expect(other.steamId).not.toBe(orphan.steamId)
  })

  it('drops an account Steam no longer knows', async () => {
    const gslt = pool()
    const rowId = await openRow()
    await gslt.lease(rowId)
    await gslt.release(rowId)
    const [steamId] = fake.accounts().map(account => account.steamId)
    await createSteamGameServers({
      clock,
      apiKey: API_KEY,
      fetch: fake.fetch,
      baseUrl: 'http://steam.test',
    }).deleteAccount(String(steamId))

    await gslt.sweep()

    expect(await gslt.stats()).toEqual({ total: 0, inUse: 0 })
    expect(log.lines.some(line => line.includes('gone from Steam'))).toBe(true)
  })

  it('resets an account Steam let expire', async () => {
    const gslt = pool()
    const rowId = await openRow()
    const token = await gslt.lease(rowId)
    await gslt.release(rowId)
    fake.expire(String(fake.accounts()[0]?.steamId))

    await gslt.sweep()

    expect((await store.listGsltTokens())[0]?.loginToken).not.toBe(token)
    expect(fake.accounts()[0]?.expired).toBe(false)
  })

  it('takes Steam’s word about a token that was reset elsewhere', async () => {
    const gslt = pool()
    const rowId = await openRow()
    await gslt.lease(rowId)
    await gslt.release(rowId)
    const steamId = String(fake.accounts()[0]?.steamId)
    const elsewhere = await createSteamGameServers({
      clock,
      apiKey: API_KEY,
      fetch: fake.fetch,
      baseUrl: 'http://steam.test',
    }).resetLoginToken(steamId)

    await gslt.sweep()

    expect((await store.listGsltTokens())[0]?.loginToken).toBe(elsewhere)
  })

  it('survives a Steam that is down, and frees the leaked leases anyway', async () => {
    const gslt = pool()
    const rowId = await openRow()
    await gslt.lease(rowId)
    await store.updateServer(rowId, { releasedAt: at(1_000), state: 'released' })
    fake.setFaults({ status: { code: 500, times: 99 } })

    const sweeping = gslt.sweep()
    for (let round = 0; round < 40; round += 1) {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (clock.pending() > 0) await clock.next()
    }
    await sweeping

    expect(await gslt.stats()).toEqual({ total: 1, inUse: 0 })
    expect(log.lines.some(line => line.includes('Steam account list failed'))).toBe(true)
  })

  it('arms itself on the clock and disarms on stop', async () => {
    const gslt = pool({ sweepIntervalMs: 60_000 })
    const rowId = await openRow()
    await gslt.lease(rowId)
    await store.updateServer(rowId, { releasedAt: at(1_000), state: 'released' })

    gslt.start()
    await clock.advance(60_000)
    for (let round = 0; round < 20; round += 1)
      await new Promise<void>(resolve => setImmediate(resolve))
    expect(await gslt.stats()).toEqual({ total: 1, inUse: 0 })

    await gslt.stop()
    expect(clock.pending()).toBe(0)
  })
})

describe('GET /v1/fleet/gslt', () => {
  it('counts the pool and never shows a token', async () => {
    const app = createTestApp()
    const secret = (await app.keys.mint(keyRequest('ops', ['matches', 'fleet']))).secret

    const empty = await app.request('/v1/fleet/gslt', { key: secret })
    expect(empty.status).toBe(200)
    expect(empty.body).toEqual({ total: 0, inUse: 0 })

    const row = serverRow()
    await app.store.insertServer({ ...row, keyId: (await app.keys.list())[0]?.id ?? row.keyId })
    const token = await app.gslt.lease(row.id)

    const held = await app.request('/v1/fleet/gslt', { key: secret })
    expect(held.body).toEqual({ total: 1, inUse: 1 })
    expect(JSON.stringify(held.body)).not.toContain(String(token))
    await app.close()
  })

  it('is behind the fleet scope', async () => {
    const app = createTestApp()
    const secret = (await app.keys.mint(keyRequest('platform'))).secret
    expect((await app.request('/v1/fleet/gslt', { key: secret })).status).toBe(403)
    await app.close()
  })
})

describe('secrets', () => {
  it('never writes a login token into a log line', async () => {
    const gslt = pool()
    const rowId = await openRow()
    const token = await gslt.lease(rowId)
    await gslt.release(rowId, { lost: true })
    await gslt.sweep()

    expect(token).toBeTruthy()
    expect(log.lines.join('\n')).not.toContain(token)
    expect(log.lines.some(line => line.includes('minted account'))).toBe(true)
  })
})
