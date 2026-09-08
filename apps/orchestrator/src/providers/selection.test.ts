import { matchRequestSchema } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import type { GameServerProvider, ServerOffering } from './provider'
import { offeringMatches } from './provider'
import { createProviderRegistry } from './registry'
import { eligibleProviders, requirementsOf, selectCandidates } from './selection'

function offering(
  overrides: Partial<ServerOffering['capabilities']> & { cents?: number; available?: number },
) {
  const { cents, available, ...capabilities } = overrides
  return {
    capabilities: {
      games: ['cs2'] as const,
      region: 'dusseldorf',
      tickrate: 128,
      lan: false,
      workshopMaps: true,
      ...capabilities,
    },
    hourlyCents: cents ?? 0,
    ...(available !== undefined && { available }),
  } satisfies ServerOffering
}

function provider(id: string, offerings: ServerOffering[] | (() => Promise<ServerOffering[]>)) {
  const stub = {
    id,
    offerings: typeof offerings === 'function' ? offerings : () => Promise.resolve(offerings),
  } as Pick<GameServerProvider, 'id' | 'offerings'>
  return stub as GameServerProvider
}

function request(overrides: Record<string, unknown> = {}) {
  return matchRequestSchema.parse({
    clientMatchId: 'c-1',
    game: 'cs2',
    gamemode: 'pug',
    teams: { teamA: { name: 'A', players: [] }, teamB: { name: 'B', players: [] } },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: 'whsec' },
    ttlMinutes: 60,
    ...overrides,
  })
}

describe('offeringMatches', () => {
  it('filters on game, region, lan, workshop maps and capacity', () => {
    const cloud = offering({})
    expect(offeringMatches(cloud, { game: 'cs2' })).toBe(true)
    expect(offeringMatches(cloud, { game: 'csgo' })).toBe(false)
    expect(offeringMatches(cloud, { game: 'cs2', region: 'saarland' })).toBe(false)
    expect(offeringMatches(cloud, { game: 'cs2', lan: true })).toBe(false)
    expect(
      offeringMatches(offering({ workshopMaps: false }), { game: 'cs2', workshopMaps: true }),
    ).toBe(false)
    expect(offeringMatches(offering({ available: 0 }), { game: 'cs2' })).toBe(false)
  })
})

describe('requirementsOf', () => {
  it('derives the filter from the request, naming only what narrows', () => {
    expect(requirementsOf(request())).toEqual({ game: 'cs2' })
    expect(
      requirementsOf(
        request({
          requirements: { region: 'saarland', lan: true },
          maps: [{ map: 'workshop/3070284539/de_cache', sides: 'knife' }],
        }),
      ),
    ).toEqual({ game: 'cs2', region: 'saarland', lan: true, workshopMaps: true })
  })

  it('never turns preferLan into a filter — it is the one field that only ranks', () => {
    expect(requirementsOf(request({ requirements: { preferLan: true } }))).toEqual({ game: 'cs2' })
  })
})

describe('eligibleProviders', () => {
  it('never picks the sim while a real provider is registered, and falls back to it alone', () => {
    const registry = createProviderRegistry()
    registry.register(provider('sim', [offering({ region: 'sim' })]))
    expect(eligibleProviders(registry, request()).map(p => p.id)).toEqual(['sim'])
    registry.register(provider('dathost', [offering({ cents: 120 })]))
    expect(eligibleProviders(registry, request()).map(p => p.id)).toEqual(['dathost'])
    expect(
      eligibleProviders(registry, request({ requirements: { simulated: true } })).map(p => p.id),
    ).toEqual(['sim'])
    expect(
      eligibleProviders(registry, request({ requirements: { provider: 'sim' } })).map(p => p.id),
    ).toEqual(['sim'])
    registry.setDrained('dathost', true)
    expect(eligibleProviders(registry, request()).map(p => p.id)).toEqual(['sim'])
  })
})

describe('selectCandidates', () => {
  it('orders cheapest first, nodes first when lan is asked, and only nodes then', async () => {
    const registry = createProviderRegistry()
    registry.register(provider('dathost', [offering({ cents: 120 }), offering({ cents: 90 })]))
    registry.register(provider('nodes', [offering({ region: 'saarland', lan: true, cents: 0 })]))
    const plain = await selectCandidates(registry, request())
    expect(plain.candidates.map(c => `${c.provider.id}:${c.offering.hourlyCents}`)).toEqual([
      'nodes:0',
      'dathost:90',
      'dathost:120',
    ])
    const lan = await selectCandidates(registry, request({ requirements: { lan: true } }))
    expect(lan.candidates.map(c => c.provider.id)).toEqual(['nodes'])
    expect(lan.asked).toBe(2)
  })

  it('puts the venue first for preferLan and still rents a box when no node is enrolled', async () => {
    const registry = createProviderRegistry()
    registry.register(provider('dathost', [offering({ cents: 90 })]))
    // A venue box that is *dearer* than the rented one, so cheapest-first and
    // lan-first disagree and the ordering is the only thing under test.
    registry.register(provider('nodes', [offering({ region: 'saarland', lan: true, cents: 200 })]))
    const preferred = await selectCandidates(
      registry,
      request({ requirements: { preferLan: true } }),
    )
    expect(preferred.candidates.map(c => c.provider.id)).toEqual(['nodes', 'dathost'])
    const plain = await selectCandidates(registry, request())
    expect(plain.candidates.map(c => c.provider.id)).toEqual(['dathost', 'nodes'])

    // The whole point of the field: a LAN night before a node is enrolled.
    const nodeless = createProviderRegistry()
    nodeless.register(provider('dathost', [offering({ cents: 90 })]))
    const softly = await selectCandidates(nodeless, request({ requirements: { preferLan: true } }))
    expect(softly.candidates.map(c => c.provider.id)).toEqual(['dathost'])
    const strictly = await selectCandidates(nodeless, request({ requirements: { lan: true } }))
    expect(strictly.candidates).toEqual([])
  })

  it('reports a provider that cannot answer and keeps the rest, observing both', async () => {
    const registry = createProviderRegistry()
    registry.register(provider('dathost', () => Promise.reject(new Error('502 from dathost'))))
    registry.register(provider('nodes', [offering({ lan: true })]))
    const result = await selectCandidates(registry, request(), {
      now: () => '2026-09-05T18:00:00.000Z',
    })
    expect(result.candidates.map(c => c.provider.id)).toEqual(['nodes'])
    expect(result.failures).toEqual([{ provider: 'dathost', error: expect.any(Error) }])
    expect(registry.health('dathost', 0)).toMatchObject({
      healthy: false,
      lastError: '502 from dathost',
      lastCheckedAt: '2026-09-05T18:00:00.000Z',
    })
    expect(registry.health('nodes', 0).healthy).toBe(true)
  })

  it('refuses a duplicate or misnamed provider id at registration', () => {
    const registry = createProviderRegistry()
    registry.register(provider('sim', []))
    expect(() => registry.register(provider('sim', []))).toThrow(/duplicate/)
    expect(() => registry.register(provider('Not Kebab', []))).toThrow()
    expect(() => registry.require('dathost')).toThrow(/no provider dathost/)
  })
})
