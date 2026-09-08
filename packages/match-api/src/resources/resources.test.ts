import { describe, expect, it } from 'vitest'
import {
  isOrchestratorCommand,
  isSimCommand,
  MATCH_COMMAND_TYPES,
  MATCH_COMMANDS_REQUIRING_ADMIN,
  matchCommandResultSchema,
  matchCommandSchema,
  ORCHESTRATOR_COMMAND_TYPES,
  SIM_COMMAND_TYPES,
} from './commands'
import { pageQuerySchema } from './common'
import { fleetServerSchema, nodeEnrolRequestSchema } from './fleet'
import { apiKeyCreateRequestSchema, webhookSecretsRequestSchema } from './keys'
import { LOADOUT_SIDE_TEAM_NUMBER, loadoutSchema, STICKER_SLOTS } from './loadout'
import { isTerminalMatchState, MATCH_STATES, matchSchema, TERMINAL_MATCH_STATES } from './match'
import {
  DEMO_UPLOAD_URLS_MAX,
  demoUploadUrlFor,
  hasDemoUploadUrl,
  MATCH_TTL_MINUTES_MAX,
  type MatchRequestInput,
  matchRequestSchema,
  rosterEntrySchema,
} from './match-request'
import { playerTokenRequestSchema } from './player-token'

const player = (n: number) => ({
  steamId64: String(76_561_197_960_265_728n + BigInt(n)),
  name: `Player ${n}`,
})

function pugRequest(overrides: Partial<MatchRequestInput> = {}): MatchRequestInput {
  return {
    clientMatchId: '4c1a2c7e-9f3d-4f0a-9c11-2b7b1a4d5e60',
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'Team hunzR', players: [1, 2, 3, 4, 5].map(player) },
      teamB: { name: 'Team Bommelmann', players: [6, 7, 8, 9, 10].map(player) },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    rules: {
      regulationRounds: 24,
      overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
      warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
    },
    callbacks: {
      webhookUrl: 'https://api.ezpug.example/iron/webhooks',
      webhookSecretId: 'whsec-2026-09',
    },
    ttlMinutes: 180,
    ...overrides,
  }
}

describe('MatchRequest', () => {
  it('parses a decided pug request and fills the defaults', () => {
    const parsed = matchRequestSchema.parse(pugRequest())
    expect(parsed.requirements).toEqual({})
    expect(parsed.rules?.cvars).toEqual({})
    expect(parsed.teams.teamA.players[0]?.locale).toBe('de')
  })

  it('rejects a player rostered twice, across teams', () => {
    const request = pugRequest()
    request.teams.teamB.players[0] = player(1)
    expect(() => matchRequestSchema.parse(request)).toThrow(/rostered twice/)
  })

  it('lets an open-join mode start with empty rosters and no rules', () => {
    const parsed = matchRequestSchema.parse(
      pugRequest({
        gamemode: 'retakes',
        teams: { teamA: { name: 'CT', players: [] }, teamB: { name: 'T', players: [] } },
        rules: undefined,
      }),
    )
    expect(parsed.rules).toBeUndefined()
    expect(parsed.teams.teamA.players).toEqual([])
  })

  it('keeps the platform’s rules shape: even round counts, a preset’s cvars under ours', () => {
    expect(() =>
      matchRequestSchema.parse(
        pugRequest({
          rules: {
            regulationRounds: 25,
            overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
            warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
          },
        }),
      ),
    ).toThrow()
  })

  it('needs at least one map, a webhook and a ttl within the ceiling', () => {
    expect(() => matchRequestSchema.parse(pugRequest({ maps: [] }))).toThrow()
    expect(() =>
      matchRequestSchema.parse(pugRequest({ ttlMinutes: MATCH_TTL_MINUTES_MAX + 1 })),
    ).toThrow()
    const { callbacks: _dropped, ...withoutCallbacks } = pugRequest()
    expect(() => matchRequestSchema.parse(withoutCallbacks)).toThrow()
    expect(() =>
      matchRequestSchema.parse(
        pugRequest({ callbacks: { webhookUrl: 'not a url', webhookSecretId: 'x' } }),
      ),
    ).toThrow()
  })

  it('takes preferLan as a ranking and refuses it beside lan, which is a narrowing', () => {
    const preferred = matchRequestSchema.parse(pugRequest({ requirements: { preferLan: true } }))
    expect(preferred.requirements).toEqual({ preferLan: true })
    expect(() =>
      matchRequestSchema.parse(pugRequest({ requirements: { lan: true, preferLan: true } })),
    ).toThrow(/different things/)
  })

  it('takes one demo upload url per map, and reads the single one as every map’s', () => {
    const callbacks = {
      webhookUrl: 'https://api.ezpug.example/iron/webhooks',
      webhookSecretId: 'whsec-2026-09',
      demoUploadUrls: [
        { mapNumber: 1, url: 'https://bucket.example/m/1.dem?sig=a' },
        { mapNumber: 2, url: 'https://bucket.example/m/2.dem?sig=b' },
      ],
    }
    const parsed = matchRequestSchema.parse(pugRequest({ callbacks }))
    expect(demoUploadUrlFor(parsed.callbacks, 2)).toBe('https://bucket.example/m/2.dem?sig=b')
    // Map 3 was not given one and there is no single url to fall back to.
    expect(demoUploadUrlFor(parsed.callbacks, 3)).toBeUndefined()
    expect(hasDemoUploadUrl(parsed.callbacks)).toBe(true)

    const single = matchRequestSchema.parse(
      pugRequest({
        callbacks: {
          webhookUrl: 'https://api.ezpug.example/iron/webhooks',
          webhookSecretId: 'whsec-2026-09',
          demoUploadUrl: 'https://bucket.example/m/all.dem?sig=c',
        },
      }),
    )
    // What a Bo1 always did, and what a series without a per-map url still does.
    expect(demoUploadUrlFor(single.callbacks, 1)).toBe('https://bucket.example/m/all.dem?sig=c')
    expect(demoUploadUrlFor(single.callbacks, 3)).toBe('https://bucket.example/m/all.dem?sig=c')
    expect(hasDemoUploadUrl({})).toBe(false)

    expect(() =>
      matchRequestSchema.parse(
        pugRequest({
          callbacks: {
            ...callbacks,
            demoUploadUrls: [
              { mapNumber: 1, url: 'https://bucket.example/m/1.dem?sig=a' },
              { mapNumber: 1, url: 'https://bucket.example/m/1b.dem?sig=b' },
            ],
          },
        }),
      ),
    ).toThrow(/two upload urls/)
    expect(() =>
      matchRequestSchema.parse(
        pugRequest({
          callbacks: {
            ...callbacks,
            demoUploadUrls: [
              { mapNumber: DEMO_UPLOAD_URLS_MAX + 1, url: 'https://bucket.example/m/x.dem' },
            ],
          },
        }),
      ),
    ).toThrow()
  })

  it('refuses csgo nowhere in the schema — the refusal is the orchestrator’s, at runtime', () => {
    expect(matchRequestSchema.parse(pugRequest({ game: 'csgo' })).game).toBe('csgo')
  })

  it('carries what the server shows about a person and nothing the platform owns', () => {
    const entry = rosterEntrySchema.parse({
      steamId64: '76561198279375306',
      name: 'tk',
      locale: 'en',
      rating: 1875,
      rankName: 'Diamant',
    })
    expect(entry.rating).toBe(1875)
    expect(() => rosterEntrySchema.parse({ steamId64: '1', name: 'tk' })).toThrow()
    expect(() => rosterEntrySchema.parse({ ...entry, locale: 'fr' })).toThrow()
  })
})

describe('Loadout', () => {
  it('mirrors the WeaponPaints tables: sides, five sticker slots, a 32-char name tag', () => {
    const loadout = loadoutSchema.parse({
      t: {
        weapons: [
          {
            defindex: 7,
            paintId: 490,
            wear: 0.12,
            seed: 661,
            nametag: 'blue gem',
            stattrak: true,
            stickers: [{ id: 5032 }, { id: 5033, x: 0.1 }],
            keychain: { id: 20 },
          },
        ],
        knife: 'weapon_knife_karambit',
        gloves: 5027,
        agent: 'customplayer_tm_leet_variantb',
        music: 3,
        pin: 874,
      },
    })
    expect(loadout.t?.weapons[0]?.stickers).toHaveLength(2)
    expect(loadout.t?.weapons[0]?.stickers[0]).toEqual({
      id: 5032,
      schema: 0,
      x: 0,
      y: 0,
      wear: 0,
      scale: 1,
      rotation: 0,
    })
    expect(loadout.t?.weapons[0]?.keychain).toEqual({ id: 20, x: 0, y: 0, z: 0, seed: 0 })
    expect(loadout.ct).toBeUndefined()
    expect(STICKER_SLOTS).toBe(5)
    expect(LOADOUT_SIDE_TEAM_NUMBER).toEqual({ t: 2, ct: 3 })
  })

  it('refuses a sixth sticker, a long name tag and a weapon listed twice on a side', () => {
    const weapon = { defindex: 7, paintId: 490 }
    expect(() =>
      loadoutSchema.parse({
        ct: { weapons: [{ ...weapon, stickers: Array.from({ length: 6 }, () => ({ id: 1 })) }] },
      }),
    ).toThrow()
    expect(() =>
      loadoutSchema.parse({ ct: { weapons: [{ ...weapon, nametag: 'x'.repeat(33) }] } }),
    ).toThrow()
    expect(() => loadoutSchema.parse({ ct: { weapons: [weapon, weapon] } })).toThrow()
  })
})

describe('Match', () => {
  it('lists the lifecycle in order with three terminal states', () => {
    expect(MATCH_STATES[0]).toBe('pending')
    expect(TERMINAL_MATCH_STATES).toEqual(['ended', 'failed', 'cancelled'])
    expect(isTerminalMatchState('live')).toBe(false)
    expect(isTerminalMatchState('failed')).toBe(true)
  })

  it('parses a ready match with its connect facts and a sim block', () => {
    const match = matchSchema.parse({
      id: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
      clientMatchId: 'platform-match-1',
      state: 'ready',
      game: 'cs2',
      gamemode: 'pug',
      provider: 'sim',
      serverId: 'sim-1',
      fleetServerId: '7f3a1c22-2b64-4a5f-9c31-0d5e6f8a1b20',
      connect: { host: '10.0.0.7', port: 27015, password: 'apfel' },
      tv: { host: '10.0.0.7', port: 27020, delaySeconds: 105 },
      seq: 3,
      createdAt: '2026-09-05T18:00:00.000Z',
      updatedAt: '2026-09-05T18:01:00.000Z',
      readyAt: '2026-09-05T18:01:00.000Z',
      liveAt: null,
      endedAt: null,
      expiresAt: '2026-09-05T21:00:00.000Z',
      endedReason: null,
      sim: {
        scenario: 'happy-path',
        seed: 'seed-1',
        mode: 'auto',
        timeScale: 20,
        remainingBeats: 140,
        finished: false,
        outcome: null,
        chaos: null,
      },
    })
    expect(match.connect?.password).toBe('apfel')
    expect(match.sim?.remainingBeats).toBe(140)
  })
})

describe('MatchCommand', () => {
  it('is a closed set with the sim family at the end', () => {
    expect(MATCH_COMMAND_TYPES).toHaveLength(16)
    expect(SIM_COMMAND_TYPES.every(isSimCommand)).toBe(true)
    expect(isSimCommand('pause')).toBe(false)
    expect(ORCHESTRATOR_COMMAND_TYPES.every(isOrchestratorCommand)).toBe(true)
    expect(isOrchestratorCommand('restore')).toBe(false)
    expect(MATCH_COMMANDS_REQUIRING_ADMIN).toEqual(['rcon'])
  })

  it('carries a correlation id on every command', () => {
    expect(() => matchCommandSchema.parse({ type: 'pause' })).toThrow()
    expect(
      matchCommandSchema.parse({ type: 'sim.chaos', correlationId: 'c1', chaos: { delay: 0.5 } }),
    ).toMatchObject({ type: 'sim.chaos' })
    expect(() =>
      matchCommandSchema.parse({ type: 'sim.speed', correlationId: 'c1', timeScale: 601 }),
    ).toThrow()
    expect(() => matchCommandSchema.parse({ type: 'sim.reboot', correlationId: 'c1' })).toThrow()
  })

  it('answers with the vocabulary’s codes when rejected', () => {
    const result = matchCommandResultSchema.parse({
      correlationId: 'c1',
      type: 'sim.step',
      status: 'rejected',
      code: 'command_unsupported',
      message: 'not a sim',
    })
    expect(result.code).toBe('command_unsupported')
    expect(() => matchCommandResultSchema.parse({ ...result, code: 'because' })).toThrow()
  })
})

describe('the small shapes', () => {
  it('defaults and bounds the page query', () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(pageQuerySchema.parse({ limit: '10', cursor: 'abc' })).toEqual({
      limit: 10,
      cursor: 'abc',
    })
    expect(() => pageQuerySchema.parse({ limit: 201 })).toThrow()
  })

  it('bounds a player token’s life', () => {
    expect(playerTokenRequestSchema.parse({ steamId64: '76561198279375306' }).ttlSeconds).toBe(900)
    expect(() =>
      playerTokenRequestSchema.parse({ steamId64: '76561198279375306', ttlSeconds: 3601 }),
    ).toThrow()
  })

  it('keeps a password off a fleet row', () => {
    expect(fleetServerSchema.shape.address.unwrap().shape).not.toHaveProperty('password')
  })

  it('enrols a node by kebab name and mints a key with a budget', () => {
    expect(nodeEnrolRequestSchema.parse({ id: 'lan-1', region: 'saarlan' }).labels).toEqual({})
    expect(() => nodeEnrolRequestSchema.parse({ id: 'LAN 1', region: 'saarlan' })).toThrow()
    const key = apiKeyCreateRequestSchema.parse({
      name: 'platform',
      scopes: ['matches'],
      budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 20_000 },
    })
    expect(key.webhookSecrets).toEqual([])
    expect(() =>
      webhookSecretsRequestSchema.parse({
        secrets: [
          { id: 'a', secret: 'x'.repeat(32) },
          { id: 'a', secret: 'y'.repeat(32) },
        ],
      }),
    ).toThrow()
  })
})
