import type { MatchRequest, MatchRequestInput } from '@ezpug/match-api'
import { matchRequestSchema } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from '../http/testing'
import type { AuthenticatedKey } from '../keys/service'
import { createProbes, type ProbeReport } from './probes'
import type { GameServerProvider } from './provider'

/**
 * **Fleet facts and provider health** (PRD-02 T31). Three things are proved
 * here, and they are the three an operator's night depends on:
 *
 * - the probe loop keeps `GET /v1/fleet/providers` true without anybody
 *   asking anything of the provider first;
 * - an outage is **one** fact, not one per pass, and a second outage after a
 *   recovery is a second one;
 * - a key that registered a fleet webhook hears its `fleet.*` facts there
 *   and everything else on the match's own callback.
 *
 * The world is the test app's: the sim provider, swapped for a delegate
 * whose `probe` a test can break, so a "provider outage" costs nothing and
 * happens on the injected clock.
 */

const SECRET_ID = 'whsec-1'
const SECRET = 'a-test-secret-of-at-least-thirty-two-chars'
const FLEET_WEBHOOK_URL = 'https://platform.invalid/hooks/fleet'
const MATCH_WEBHOOK_URL = 'https://platform.invalid/hooks/match'

let requests = 0
function request(overrides: Partial<MatchRequestInput> = {}): MatchRequest {
  requests += 1
  return matchRequestSchema.parse({
    clientMatchId: `probe-${requests}`,
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'A', players: [{ steamId64: '76561198000000001', name: 'a' }] },
      teamB: { name: 'B', players: [{ steamId64: '76561198000000002', name: 'b' }] },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    callbacks: { webhookUrl: MATCH_WEBHOOK_URL, webhookSecretId: SECRET_ID },
    ttlMinutes: 60,
    ...overrides,
  })
}

interface Rig {
  app: TestApp
  key: AuthenticatedKey
  secret: string
  matchId: string
  /** Break (or mend) the provider's control plane. */
  outage: (failure: string | null) => void
  probes: ReturnType<typeof createProbes>
  reports: ProbeReport[]
}

/** The sim wearing a control plane whose probe a test can break. */
async function createRig(): Promise<Rig> {
  const app = createTestApp()
  let failure: string | null = null
  app.providers.unregister('sim')
  const delegate: GameServerProvider = {
    ...app.sim,
    probe: () => (failure === null ? Promise.resolve() : Promise.reject(new Error(failure))),
  }
  app.providers.register(delegate)
  const reports: ProbeReport[] = []
  const probes = createProbes({
    clock: app.clock,
    log: app.log,
    registry: app.providers,
    store: app.store,
    matches: app.matches,
    onReport: report => reports.push(report),
  })
  const minted = await app.keys.mint({
    name: 'operator',
    scopes: ['matches', 'fleet', 'admin'],
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [{ id: SECRET_ID, secret: SECRET }],
  })
  const key = (await app.keys.get(minted.key.id)) as AuthenticatedKey
  const { match } = await app.matches.create(key, request())
  await app.settle()
  return {
    app,
    key,
    secret: minted.secret,
    matchId: match.id,
    outage: next => {
      failure = next
    },
    probes,
    reports,
  }
}

async function factTypes(app: TestApp, matchId: string): Promise<string[]> {
  return (await app.store.listEvents(matchId, 0, 500)).map(event => event.type)
}

describe('the probe loop', () => {
  it('keeps provider health fresh and says one fleet.provider_unreachable per incident', async () => {
    const rig = await createRig()
    await rig.probes.probe()
    let health = (await rig.app.request('/v1/fleet/providers', { key: rig.secret })).body
    expect(health.providers[0]).toMatchObject({ id: 'sim', healthy: true, lastError: null })
    expect(health.providers[0].lastCheckedAt).toBe(rig.app.clock.date().toISOString())

    rig.outage('the control plane answered 503')
    await rig.app.advance(1_000)
    await rig.probes.probe()
    await rig.app.settle()
    health = (await rig.app.request('/v1/fleet/providers', { key: rig.secret })).body
    expect(health.providers[0]).toMatchObject({
      healthy: false,
      lastError: 'the control plane answered 503',
    })
    expect(await factTypes(rig.app, rig.matchId)).toContain('fleet.provider_unreachable')

    // Still down: the health surface repeats, the fact does not.
    await rig.app.advance(1_000)
    await rig.probes.probe()
    await rig.app.settle()
    const said = (await factTypes(rig.app, rig.matchId)).filter(
      type => type === 'fleet.provider_unreachable',
    )
    expect(said).toHaveLength(1)

    // Back, then down again: a new incident is worth a new fact, and it
    // carries the second outage's own `since`.
    rig.outage(null)
    await rig.app.advance(1_000)
    await rig.probes.probe()
    expect(
      (await rig.app.request('/v1/fleet/providers', { key: rig.secret })).body.providers[0].healthy,
    ).toBe(true)
    await rig.app.advance(60_000)
    rig.outage('gone again')
    await rig.probes.probe()
    await rig.app.settle()
    const facts = (await rig.app.store.listEvents(rig.matchId, 0, 500)).filter(
      event => event.type === 'fleet.provider_unreachable',
    )
    expect(facts).toHaveLength(2)
    expect(facts[1]?.payload).toMatchObject({
      provider: 'sim',
      since: rig.app.clock.date().toISOString(),
      lastError: 'gone again',
    })
    await rig.app.close()
  })

  it('calls a probe that never answers unreachable rather than waiting for it', async () => {
    const app = createTestApp()
    app.providers.unregister('sim')
    app.providers.register({ ...app.sim, probe: () => new Promise<void>(() => undefined) })
    const probes = createProbes({
      clock: app.clock,
      log: app.log,
      registry: app.providers,
      store: app.store,
      matches: app.matches,
      timeoutMs: 5_000,
    })
    const pass = probes.probe()
    await app.advance(5_000)
    const [report] = await pass
    expect(report).toMatchObject({ provider: 'sim', healthy: false })
    expect(report?.error).toContain('no answer within 5000 ms')
    await app.close()
  })

  it('probes on the clock once armed, and stops when the process drains', async () => {
    const rig = await createRig()
    rig.probes.start()
    await rig.app.advance(30_000)
    await rig.app.advance(30_000)
    expect(rig.reports.filter(report => report.provider === 'sim').length).toBeGreaterThanOrEqual(2)
    await rig.probes.stop()
    const after = rig.reports.length
    await rig.app.advance(60_000)
    expect(rig.reports).toHaveLength(after)
    await rig.app.close()
  })

  it('falls back to offerings for a provider with no probe of its own', async () => {
    const app = createTestApp()
    let asked = 0
    app.providers.unregister('sim')
    app.providers.register({
      ...app.sim,
      offerings: () => {
        asked += 1
        return app.sim.offerings()
      },
    })
    const probes = createProbes({
      clock: app.clock,
      log: app.log,
      registry: app.providers,
      store: app.store,
      matches: app.matches,
    })
    const [report] = await probes.probe()
    expect(asked).toBe(1)
    expect(report?.healthy).toBe(true)
    await app.close()
  })
})

describe("a key's fleet webhook", () => {
  it('takes the fleet facts, leaves the match facts on the match callback', async () => {
    const rig = await createRig()
    await rig.app.keys.setFleetWebhook(rig.key.key.id, {
      fleetWebhook: { url: FLEET_WEBHOOK_URL, secretId: SECRET_ID },
    })
    rig.outage('the control plane answered 503')
    await rig.probes.probe()
    await rig.app.settle()
    await rig.app.playOut()

    const posted = (url: string): string[] =>
      rig.app.posted
        .filter(post => post.url === url)
        .map(post => (JSON.parse(post.body) as { payload: { type: string } }).payload.type)
    expect(posted(FLEET_WEBHOOK_URL)).toEqual(['fleet.provider_unreachable'])
    expect(posted(MATCH_WEBHOOK_URL)).toContain('match.allocated')
    expect(posted(MATCH_WEBHOOK_URL)).not.toContain('fleet.provider_unreachable')
    // Same envelope, same seq, and the events route still has it.
    expect(await factTypes(rig.app, rig.matchId)).toContain('fleet.provider_unreachable')
    await rig.app.close()
  })

  it('refuses a secret the key never registered, and clears with null', async () => {
    const rig = await createRig()
    const refused = await rig.app.request(`/v1/keys/${rig.key.key.id}/fleet-webhook`, {
      method: 'PUT',
      key: rig.secret,
      json: { fleetWebhook: { url: FLEET_WEBHOOK_URL, secretId: 'whsec-nobody' } },
    })
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe('validation_failed')

    const set = await rig.app.request(`/v1/keys/${rig.key.key.id}/fleet-webhook`, {
      method: 'PUT',
      key: rig.secret,
      json: { fleetWebhook: { url: FLEET_WEBHOOK_URL, secretId: SECRET_ID } },
    })
    expect(set.body.fleetWebhook).toEqual({ url: FLEET_WEBHOOK_URL, secretId: SECRET_ID })

    const cleared = await rig.app.request(`/v1/keys/${rig.key.key.id}/fleet-webhook`, {
      method: 'PUT',
      key: rig.secret,
      json: { fleetWebhook: null },
    })
    expect(cleared.body.fleetWebhook).toBeNull()

    // Cleared: the fleet fact goes back to the match's callback.
    rig.outage('down')
    await rig.probes.probe()
    await rig.app.settle()
    expect(
      rig.app.posted
        .filter(post => post.url === MATCH_WEBHOOK_URL)
        .map(post => (JSON.parse(post.body) as { payload: { type: string } }).payload.type),
    ).toContain('fleet.provider_unreachable')
    await rig.app.close()
  })
})

describe('GET /v1/fleet/ledger?since=', () => {
  it('answers what tonight cost: open rows and rows closed inside the window', async () => {
    const rig = await createRig()
    const midnight = rig.app.clock.date().toISOString()
    const open = await rig.app.request(`/v1/fleet/ledger?since=${encodeURIComponent(midnight)}`, {
      key: rig.secret,
    })
    expect(open.body.items).toHaveLength(1)

    // The match ends; the row closes. It is still tonight's.
    await rig.app.playOut()
    const closed = await rig.app.request(`/v1/fleet/ledger?since=${encodeURIComponent(midnight)}`, {
      key: rig.secret,
    })
    expect(closed.body.items).toHaveLength(1)
    expect(closed.body.items[0].releasedAt).not.toBeNull()

    // Tomorrow night is a different bill.
    const later = new Date(rig.app.clock.now() + 60_000).toISOString()
    const tomorrow = await rig.app.request(`/v1/fleet/ledger?since=${encodeURIComponent(later)}`, {
      key: rig.secret,
    })
    expect(tomorrow.body.items).toEqual([])
    await rig.app.close()
  })
})
