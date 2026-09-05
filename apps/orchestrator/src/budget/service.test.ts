import {
  ApiError,
  type MatchRequest,
  type MatchRequestInput,
  matchRequestSchema,
} from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from '../http/testing'
import type { AuthenticatedKey } from '../keys/service'

/**
 * **Budgets on a fake clock** (PRD-02 T5): the three ceilings refused
 * against the ledger, the month's spend accruing on live rows and starting
 * over at midnight on the first, the warnings said once per crossing and
 * not again after a restart, and the two `admin` doors — rotation and the
 * budget patch.
 *
 * The sim is free, so every test that is about money registers a *priced*
 * provider beside it, the way the fake Dathost (T15) will: a price per hour
 * is all the ledger ever knows about a provider.
 */

const SECRET_ID = 'whsec-1'
const SECRET = 'a-test-secret-of-at-least-thirty-two-chars'

/** €0.60 an hour — the fake Dathost's shape, small enough to reason about in cents. */
const HOURLY_CENTS = 60

interface Minted {
  secret: string
  key: AuthenticatedKey
}

async function mint(
  app: TestApp,
  budget: { maxConcurrentServers: number; maxServerLifetimeMinutes: number; monthlyCents: number },
  name = 'platform',
): Promise<Minted> {
  const minted = await app.keys.mint({
    name,
    scopes: ['matches', 'fleet', 'admin'],
    budget,
    webhookSecrets: [{ id: SECRET_ID, secret: SECRET }],
  })
  return { secret: minted.secret, key: (await app.keys.get(minted.key.id)) as AuthenticatedKey }
}

let requests = 0
function request(overrides: Partial<MatchRequestInput> = {}): MatchRequest {
  requests += 1
  return matchRequestSchema.parse({
    clientMatchId: `budget-${requests}`,
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'A', players: [{ steamId64: '76561198000000001', name: 'a' }] },
      teamB: { name: 'B', players: [{ steamId64: '76561198000000002', name: 'b' }] },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: SECRET_ID },
    ttlMinutes: 120,
    ...overrides,
  })
}

async function refused(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('expected an ApiError')
}

/**
 * A world whose one provider charges and whose server never finishes
 * booting, with the deadlines pushed out of the way: what money needs is a
 * ledger row that stays open while the clock runs, not a match that plays.
 */
function pricedApp(): TestApp {
  const day = 24 * 3_600_000
  return createTestApp({
    simHourlyCents: HOURLY_CENTS,
    sim: { scenario: 'never-ready', positionTickIntervalMs: null },
    deadlines: { bootMs: day, joinMs: day, heartbeatTimeoutMs: day, recoveryMs: day },
  })
}

const thresholds = (app: TestApp) =>
  app.store.rows.events
    .filter(e => e.payload.type === 'fleet.budget_threshold')
    .map(e => (e.payload.type === 'fleet.budget_threshold' ? e.payload : null))

describe('the ceilings', () => {
  it('refuses a second server when the key may hold one, and lets go when the row closes', async () => {
    const app = pricedApp()
    const { key } = await mint(app, {
      maxConcurrentServers: 1,
      maxServerLifetimeMinutes: 240,
      monthlyCents: 100_000,
    })
    const { match } = await app.matches.create(key, request())
    await app.settle()
    const refusal = await refused(app.matches.create(key, request()))
    expect(refusal.code).toBe('budget_exceeded')
    expect(refusal.status).toBe(402)
    expect(refusal.details).toMatchObject({ limit: 'maxConcurrentServers', concurrentServers: 1 })
    // Nothing was written for the refused request: no match, no row.
    expect(app.store.rows.matches).toHaveLength(1)
    expect(app.store.rows.servers).toHaveLength(1)

    await app.matches.cancel(key, match.id)
    await app.settle()
    const second = await app.matches.create(key, request())
    expect(second.match.state).toBe('pending')
    await app.close()
  })

  it('refuses a ttl above the lifetime ceiling before it costs anything', async () => {
    const app = pricedApp()
    const { key } = await mint(app, {
      maxConcurrentServers: 4,
      maxServerLifetimeMinutes: 60,
      monthlyCents: 100_000,
    })
    const refusal = await refused(app.matches.create(key, request({ ttlMinutes: 61 })))
    expect(refusal.code).toBe('budget_exceeded')
    expect(refusal.details).toMatchObject({
      limit: 'maxServerLifetimeMinutes',
      ttlMinutes: 61,
      maxServerLifetimeMinutes: 60,
    })
    expect(app.store.rows.servers).toHaveLength(0)
    await app.close()
  })

  it('prices the match against the provider and refuses what would cross the month', async () => {
    const app = pricedApp()
    // Two hours at 60 cents is 120 cents; the ceiling is one cent short.
    const { key } = await mint(app, {
      maxConcurrentServers: 4,
      maxServerLifetimeMinutes: 240,
      monthlyCents: 119,
    })
    const refusal = await refused(app.matches.create(key, request({ ttlMinutes: 120 })))
    expect(refusal.code).toBe('budget_exceeded')
    expect(refusal.details).toMatchObject({
      limit: 'monthlyCents',
      projectedCents: 120,
      monthCents: 0,
      monthlyCents: 119,
    })
    // One minute less fits.
    const ok = await app.matches.create(key, request({ ttlMinutes: 119 }))
    expect(ok.match.state).toBe('pending')
    await app.close()
  })

  it('spends nothing on a free provider, so a ceiling of zero still allows the match', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    const { key } = await mint(app, {
      maxConcurrentServers: 4,
      maxServerLifetimeMinutes: 240,
      monthlyCents: 0,
    })
    const { match } = await app.matches.create(key, request())
    await app.playOut()
    expect((await app.matches.get(key, match.id)).state).toBe('ended')
    expect((await app.budgets.usage(key.key.id)).monthCents).toBe(0)
    await app.close()
  })
})

describe('the month', () => {
  it('accrues a live row by the hour and keeps a closed one until the month turns', async () => {
    const app = pricedApp()
    const { key } = await mint(app, {
      maxConcurrentServers: 4,
      maxServerLifetimeMinutes: 240,
      monthlyCents: 100_000,
    })
    const { match } = await app.matches.create(key, request())
    await app.settle()
    expect((await app.budgets.usage(key.key.id)).monthCents).toBe(0)
    // Half an hour on a live row: half the hourly price, floored to a cent.
    await app.advance(30 * 60_000)
    expect(await app.budgets.usage(key.key.id)).toMatchObject({
      concurrentServers: 1,
      monthCents: 30,
      monthStartedAt: '2026-09-01T00:00:00.000Z',
    })
    await app.matches.cancel(key, match.id)
    await app.settle()
    const closed = await app.budgets.usage(key.key.id)
    expect(closed).toMatchObject({ concurrentServers: 0, monthCents: 30 })
    // A closed row stops accruing.
    await app.advance(60 * 60_000)
    expect((await app.budgets.usage(key.key.id)).monthCents).toBe(30)

    // Midnight on the first: the month starts over and the row falls out of it.
    await app.advance(new Date('2026-10-01T00:00:00.000Z').getTime() - app.clock.now())
    expect(await app.budgets.usage(key.key.id)).toEqual({
      concurrentServers: 0,
      monthCents: 0,
      monthStartedAt: '2026-10-01T00:00:00.000Z',
    })
    await app.close()
  })

  it('answers GET /v1/fleet/budget for the calling key with its own ceilings', async () => {
    const app = pricedApp()
    const { secret, key } = await mint(app, {
      maxConcurrentServers: 2,
      maxServerLifetimeMinutes: 240,
      monthlyCents: 5_000,
    })
    await app.matches.create(key, request())
    await app.settle()
    await app.advance(60 * 60_000)
    const response = await app.request('/v1/fleet/budget', { key: secret })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      keyId: key.key.id,
      limits: { maxConcurrentServers: 2, maxServerLifetimeMinutes: 240, monthlyCents: 5_000 },
      usage: {
        concurrentServers: 1,
        monthCents: HOURLY_CENTS,
        monthStartedAt: '2026-09-01T00:00:00.000Z',
      },
    })
    await app.close()
  })
})

describe('the warnings', () => {
  it('says a threshold once per crossing, into every open match, and not again after a restart', async () => {
    const app = pricedApp()
    const { key } = await mint(app, {
      maxConcurrentServers: 4,
      // 100 cents: an hour of one server is 60 %, and by 80 minutes it is 80 %.
      maxServerLifetimeMinutes: 240,
      monthlyCents: 100,
    })
    const { match } = await app.matches.create(key, request({ ttlMinutes: 100 }))
    await app.settle()
    expect(thresholds(app)).toHaveLength(0)

    await app.advance(80 * 60_000)
    await app.budgets.sweep()
    await app.settle()
    expect(thresholds(app).map(t => t?.fraction)).toEqual([0.8])
    expect(thresholds(app)[0]).toMatchObject({
      limit: 'monthlyCents',
      usage: { monthCents: 80 },
      limits: { monthlyCents: 100 },
    })
    expect(app.store.rows.events.filter(e => e.matchId === match.id).at(-1)?.payload.type).toBe(
      'fleet.budget_threshold',
    )

    // A second sweep at the same ratio says nothing; the mark is a row.
    await app.budgets.sweep()
    await app.settle()
    expect(thresholds(app)).toHaveLength(1)

    await app.advance(15 * 60_000)
    await app.budgets.sweep()
    await app.settle()
    expect(thresholds(app).map(t => t?.fraction)).toEqual([0.8, 0.95])
    await app.close()
  })

  it('warns on concurrency too, and starts over when the ceiling moves', async () => {
    const app = pricedApp()
    const { key } = await mint(app, {
      maxConcurrentServers: 1,
      maxServerLifetimeMinutes: 240,
      monthlyCents: 100_000,
    })
    await app.matches.create(key, request())
    await app.settle()
    // One of one is past both fractions, and the row that opened announced it.
    expect(thresholds(app).map(t => t?.fraction)).toEqual([0.8, 0.95])
    expect(thresholds(app)[0]?.limit).toBe('maxConcurrentServers')

    await app.keys.setBudget(key.key.id, { maxConcurrentServers: 4 })
    await app.budgets.announce(key.key.id)
    await app.settle()
    // A quarter of four crosses nothing — but the marks are gone, so the
    // next crossing will be said again.
    expect(thresholds(app)).toHaveLength(2)
    await app.keys.setBudget(key.key.id, { maxConcurrentServers: 1 })
    await app.budgets.announce(key.key.id)
    await app.settle()
    expect(thresholds(app).map(t => t?.fraction)).toEqual([0.8, 0.95, 0.8, 0.95])
    await app.close()
  })

  it('sweeps on the clock without anybody asking', async () => {
    const app = createTestApp({
      simHourlyCents: HOURLY_CENTS,
      sim: { scenario: 'never-ready', positionTickIntervalMs: null },
      deadlines: { bootMs: 24 * 3_600_000, joinMs: 24 * 3_600_000 },
      budgetSweepIntervalMs: 60_000,
    })
    const { key } = await mint(app, {
      maxConcurrentServers: 4,
      maxServerLifetimeMinutes: 240,
      monthlyCents: 100,
    })
    await app.matches.create(key, request({ ttlMinutes: 100 }))
    await app.settle()
    app.budgets.start()
    await app.advance(90 * 60_000)
    expect(thresholds(app).map(t => t?.fraction)).toEqual([0.8])
    await app.close()
  })
})

describe('the keys’ own doors', () => {
  it('rotates a secret, refuses the old one, and refuses a revoked key', async () => {
    const app = createTestApp()
    const { secret, key } = await mint(app, {
      maxConcurrentServers: 4,
      maxServerLifetimeMinutes: 240,
      monthlyCents: 0,
    })
    const rotated = await app.request(`/v1/keys/${key.key.id}/rotate`, {
      method: 'POST',
      key: secret,
    })
    expect(rotated.status).toBe(200)
    expect(rotated.body.key.id).toBe(key.key.id)
    expect(rotated.body.secret).not.toBe(secret)
    expect(rotated.body.key.prefix).toBe(rotated.body.secret.slice(0, 12))
    expect((await app.request('/v1/gamemodes', { key: secret })).status).toBe(401)
    expect((await app.request('/v1/gamemodes', { key: rotated.body.secret })).status).toBe(200)

    await app.keys.revoke(key.key.id)
    const dead = await refused(app.keys.rotate(key.key.id))
    expect(dead.code).toBe('invalid_state')
    const stranger = await refused(app.keys.rotate('00000000-0000-4000-8000-000000000000'))
    expect(stranger.code).toBe('not_found')
    await app.close()
  })

  it('patches one ceiling and leaves the others alone', async () => {
    const app = createTestApp()
    const { secret, key } = await mint(app, {
      maxConcurrentServers: 4,
      maxServerLifetimeMinutes: 240,
      monthlyCents: 0,
    })
    const patched = await app.request(`/v1/keys/${key.key.id}/budget`, {
      method: 'PATCH',
      key: secret,
      json: { monthlyCents: 25_000 },
    })
    expect(patched.status).toBe(200)
    expect(patched.body.budget).toEqual({
      maxConcurrentServers: 4,
      maxServerLifetimeMinutes: 240,
      monthlyCents: 25_000,
    })
    const empty = await app.request(`/v1/keys/${key.key.id}/budget`, {
      method: 'PATCH',
      key: secret,
      json: {},
    })
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe('validation_failed')
    await app.close()
  })
})
