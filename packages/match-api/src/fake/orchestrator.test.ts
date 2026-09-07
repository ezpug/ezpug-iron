import { createFakeClock } from '@ezpug/core'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from '../errors'
import type { Match, WebhookEnvelope } from '../index'
import {
  verifyWebhookSignature,
  WEBHOOK_ATTEMPT_HEADER,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_SIGNATURE_HEADER,
  webhookEnvelopeSchema,
} from '../webhooks'
import { FAKE_PLAYER_COMMAND_EVENT, FAKE_SECRET_PREFIXES } from './core'
import {
  createHarness,
  DEMO_UPLOAD_URL,
  type Harness,
  pugRequest,
  rosterOf,
  T0,
  WEBHOOK_SECRET,
  WEBHOOK_SECRET_ID,
  WEBHOOK_URL,
} from './testing'

let harness: Harness | undefined
afterEach(() => {
  harness?.fake.close()
  harness = undefined
})

function setup(...args: Parameters<typeof createHarness>): Harness {
  harness = createHarness(...args)
  return harness
}

function types(envelopes: readonly WebhookEnvelope[]): string[] {
  return envelopes.map(e => e.payload.type)
}

async function allEvents(h: Harness, matchId: string): Promise<WebhookEnvelope[]> {
  const client = h.fake.client(h.platform.secret)
  const out: WebhookEnvelope[] = []
  let cursor = '0'
  for (;;) {
    const page = await client.matches.events({ params: { matchId }, query: { cursor, limit: 200 } })
    out.push(...page.items)
    if (page.nextCursor === null || page.items.length === 0) return out
    cursor = page.nextCursor
  }
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('expected an ApiError')
}

describe('a Bo1 on the fake', () => {
  it('plays create → allocated → ready → live → ended in milliseconds under a fake clock', async () => {
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    const started = performance.now()
    const created = await client.matches.create({ body: pugRequest() })
    expect(created.state).toBe('allocating')
    expect(created.fleetServerId).not.toBeNull()
    expect(created.provider).toBeNull()
    expect(created.expiresAt).toBe(new Date(T0 + 180 * 60_000).toISOString())

    await h.fake.playOut()
    expect(performance.now() - started).toBeLessThan(5_000)

    const match = await client.matches.get({ params: { matchId: created.id } })
    expect(match.state).toBe('ended')
    expect(match.endedReason).toEqual({ kind: 'completed' })
    expect(match.provider).toBe('sim')
    expect(match.serverId).toBe('sim-1')
    expect(match.connect?.host).toBe('sim-1.sim.invalid')
    expect(match.connect?.password?.startsWith(FAKE_SECRET_PREFIXES.serverPassword)).toBe(true)
    expect(match.tv).toEqual({ host: 'sim-1.sim.invalid', port: 27_020, delaySeconds: 90 })
    expect(match.readyAt).not.toBeNull()
    expect(match.liveAt).not.toBeNull()
    expect(match.sim?.finished).toBe(true)
    expect(match.sim?.outcome).toBe('completed')

    const envelopes = await allEvents(h, match.id)
    expect(envelopes).toHaveLength(match.seq)
    expect(envelopes.map(e => e.seq)).toEqual(envelopes.map((_, i) => i + 1))
    const order = types(envelopes)
    expect(order[0]).toBe('match.allocated')
    expect(order.indexOf('server_ready') + 1).toBe(order.indexOf('match.server_ready'))
    expect(order.filter(t => t === 'player.joined')).toHaveLength(10)
    expect(order.indexOf('going_live')).toBeGreaterThan(order.indexOf('match.server_ready'))
    expect(order.indexOf('demo_available') + 1).toBe(order.indexOf('demo.uploaded'))
    expect(order.indexOf('series_end')).toBeGreaterThan(order.indexOf('demo.uploaded'))
    expect(order.at(-1)).toBe('match.ended')
    expect(order).not.toContain('position_tick')
    expect(h.errors).toEqual([])

    // The demo went straight to the presigned URL; the fact carries its real size and hash.
    expect(h.uploads).toHaveLength(1)
    expect(h.uploads[0]?.url).toBe(DEMO_UPLOAD_URL)
    const uploaded = envelopes.find(e => e.payload.type === 'demo.uploaded')?.payload
    if (uploaded?.type !== 'demo.uploaded') throw new Error('unreachable')
    expect(uploaded.size).toBe(h.uploads[0]?.bytes.byteLength)
    expect(uploaded.key).toBe('demos/platform-match-1/map-1.dem')
    expect(uploaded.sha256).toMatch(/^[0-9a-f]{64}$/)

    // Every envelope was POSTed once, in seq order, and every signature verifies.
    expect(h.posted.map(p => p.envelope.seq)).toEqual(envelopes.map(e => e.seq))
    for (const post of h.posted) {
      expect(webhookEnvelopeSchema.parse(JSON.parse(post.body))).toEqual(post.envelope)
      const verdict = await verifyWebhookSignature({
        header: post.headers[WEBHOOK_SIGNATURE_HEADER],
        body: post.body,
        secrets: { [WEBHOOK_SECRET_ID]: WEBHOOK_SECRET },
        clock: createFakeClock({ start: Date.parse(post.envelope.occurredAt) }),
      })
      expect(verdict.ok, post.envelope.payload.type).toBe(true)
      expect(post.headers[WEBHOOK_ATTEMPT_HEADER]).toBe('1')
    }

    // The ledger closed its row; the budget is free again.
    const admin = h.fake.client(h.fake.admin.secret)
    const { items } = await admin.fleet.ledger({ query: {} })
    expect(items).toHaveLength(1)
    expect(items[0]?.state).toBe('released')
    expect(items[0]?.matchId).toBe(match.id)
    expect(items[0]).not.toHaveProperty('password')
    const { servers } = await admin.fleet.servers.list()
    expect(servers).toEqual([])
  })

  it('is deterministic: same seed, same clock, same envelopes and deliveries', async () => {
    const a = setup()
    const clientA = a.fake.client(a.platform.secret)
    const matchA = await clientA.matches.create({ body: pugRequest() })
    await a.fake.playOut()
    const logA = JSON.stringify(await allEvents(a, matchA.id))
    const postsA = JSON.stringify(a.posted)
    a.fake.close()

    const b = setup()
    const clientB = b.fake.client(b.platform.secret)
    const matchB = await clientB.matches.create({ body: pugRequest() })
    await b.fake.playOut()
    expect(matchB.id).toBe(matchA.id)
    expect(JSON.stringify(await allEvents(b, matchB.id))).toBe(logA)
    expect(JSON.stringify(b.posted)).toBe(postsA)
  })

  it('is idempotent on clientMatchId and refuses the same id with a different body', async () => {
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    const first = await client.matches.create({ body: pugRequest() })
    const again = await client.matches.create({ body: pugRequest() })
    expect(again.id).toBe(first.id)
    const { status } = await h.fake.dispatch(
      { key: 'matches.create', route: (await import('../routes')).matchApiRoutes.matches.create },
      h.platform.secret,
      { body: pugRequest() },
    )
    expect(status).toBe(200)
    const error = await refusal(client.matches.create({ body: pugRequest({ ttlMinutes: 60 }) }))
    expect(error.code).toBe('conflict')
    expect(error.status).toBe(409)
  })

  it('ends a match the reaper way when its ttl runs out', async () => {
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest({ ttlMinutes: 1 }) })
    await h.fake.playOut()
    const ended = await client.matches.get({ params: { matchId: match.id } })
    expect(ended.state).toBe('ended')
    expect(ended.endedReason?.kind).toBe('ttl_expired')
    expect(ended.endedAt).toBe(new Date(T0 + 60_000).toISOString())
  })
})

describe('the door', () => {
  it('refuses what it cannot serve with the published codes', async () => {
    const h = setup({
      budget: { maxConcurrentServers: 1, maxServerLifetimeMinutes: 120, monthlyCents: 0 },
    })
    const client = h.fake.client(h.platform.secret)
    const cases: [string, Parameters<typeof pugRequest>[0], string, number][] = [
      ['unknown gamemode', { gamemode: 'wingman' }, 'unknown_gamemode', 422],
      ['csgo', { game: 'csgo' }, 'no_capable_server', 503],
      [
        'map outside the allow-list',
        { gamemode: 'retakes', maps: [{ map: 'de_cache', sides: 'ct' }] },
        'map_not_allowed',
        422,
      ],
      ['a LAN node', { requirements: { lan: true } }, 'no_capable_server', 503],
      ['another provider', { requirements: { provider: 'other-cloud' } }, 'no_capable_server', 503],
      ['another region', { requirements: { region: 'eu-central' } }, 'no_capable_server', 503],
      ['ttl above the lifetime ceiling', { ttlMinutes: 121 }, 'budget_exceeded', 402],
      [
        'an unregistered webhook secret',
        { callbacks: { webhookUrl: 'https://platform.invalid/x', webhookSecretId: 'whsec-nope' } },
        'validation_failed',
        400,
      ],
      ['an unknown sim scenario', { sim: { scenario: 'meteor-strike' } }, 'validation_failed', 400],
    ]
    for (const [label, overrides, code, status] of cases) {
      const error = await refusal(
        client.matches.create({
          body: pugRequest({ clientMatchId: label, ttlMinutes: 60, ...overrides }),
        }),
      )
      expect(error.code, label).toBe(code)
      expect(error.status, label).toBe(status)
    }
    // Nothing above wrote a ledger row.
    const admin = h.fake.client(h.fake.admin.secret)
    expect((await admin.fleet.ledger({ query: {} })).items).toEqual([])

    // Money: the second concurrent server crosses the ceiling.
    await client.matches.create({ body: pugRequest({ clientMatchId: 'one', ttlMinutes: 60 }) })
    const money = await refusal(
      client.matches.create({ body: pugRequest({ clientMatchId: 'two', ttlMinutes: 60 }) }),
    )
    expect(money.code).toBe('budget_exceeded')
    expect(money.details?.limit).toBe('maxConcurrentServers')
  })

  it('refuses a monthly ceiling when the provider has a price', async () => {
    const h = setup({
      providers: { sim: { hourlyCents: 100 } },
      budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 150 },
    })
    const client = h.fake.client(h.platform.secret)
    const error = await refusal(client.matches.create({ body: pugRequest({ ttlMinutes: 120 }) }))
    expect(error.code).toBe('budget_exceeded')
    expect(error.details?.limit).toBe('monthlyCents')
    await client.matches.create({ body: pugRequest({ ttlMinutes: 60 }) })
  })

  it('refuses allocation on the fault knob and while drained or down', async () => {
    const h = setup({ providers: { faults: { allocationRefused: true } } })
    const client = h.fake.client(h.platform.secret)
    expect((await refusal(client.matches.create({ body: pugRequest() }))).code).toBe(
      'no_capable_server',
    )
    h.fake.setFaults({ allocationRefused: false })

    const admin = h.fake.client(h.fake.admin.secret)
    await admin.fleet.providers.drain({ params: { providerId: 'sim' } })
    expect((await client.capacity.get()).providers[0]?.regions[0]?.available).toBe(0)
    expect((await refusal(client.matches.create({ body: pugRequest() }))).code).toBe(
      'no_capable_server',
    )
    await admin.fleet.providers.undrain({ params: { providerId: 'sim' } })

    const running = await client.matches.create({ body: pugRequest({ clientMatchId: 'running' }) })
    await h.clock.advance(10_000)
    h.fake.providerDownFor(60_000)
    const down = await refusal(
      client.matches.create({ body: pugRequest({ clientMatchId: 'later' }) }),
    )
    expect(down.code).toBe('provider_unavailable')
    expect((await admin.fleet.providers.list()).providers[0]?.healthy).toBe(false)
    const heard = await allEvents(h, running.id)
    expect(types(heard)).toContain('fleet.provider_unreachable')
    await h.clock.advance(60_000)
    expect((await admin.fleet.providers.list()).providers[0]?.healthy).toBe(true)
    await client.matches.create({ body: pugRequest({ clientMatchId: 'later' }) })
  })

  it('gates every route by scope and refuses unknown or revoked keys', async () => {
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    expect((await refusal(client.fleet.servers.list())).code).toBe('forbidden')
    expect((await refusal(client.keys.list())).code).toBe('forbidden')
    expect((await refusal(h.fake.client('fake-key-nope').gamemodes.list())).code).toBe(
      'unauthorized',
    )

    const admin = h.fake.client(h.fake.admin.secret)
    const minted = await admin.keys.create({
      body: {
        name: 'console',
        scopes: ['fleet'],
        budget: { maxConcurrentServers: 0, maxServerLifetimeMinutes: 60, monthlyCents: 0 },
      },
    })
    expect(minted.secret.startsWith(FAKE_SECRET_PREFIXES.apiKey)).toBe(true)
    expect(minted.key.webhookSecretIds).toEqual([])
    const consoleClient = h.fake.client(minted.secret)
    expect((await consoleClient.fleet.gslt()).total).toBe(0)
    expect((await refusal(consoleClient.matches.list({ query: {} }))).code).toBe('forbidden')
    const revoked = await admin.keys.revoke({ params: { keyId: minted.key.id } })
    expect(revoked.revokedAt).not.toBeNull()
    expect((await refusal(consoleClient.fleet.gslt())).code).toBe('unauthorized')
    const listed = await admin.keys.list()
    expect(listed.keys.map(k => k.name).sort()).toEqual(['console', 'fake-admin', 'platform'])
    expect(JSON.stringify(listed)).not.toContain(minted.secret)

    const rotated = await admin.keys.setWebhookSecrets({
      params: { keyId: h.platform.key.id },
      body: { secrets: [{ id: 'whsec-next', secret: WEBHOOK_SECRET }] },
    })
    expect(rotated.webhookSecretIds).toEqual(['whsec-next'])
    expect((await refusal(client.matches.create({ body: pugRequest() }))).code).toBe(
      'validation_failed',
    )
  })

  it('rotates a key’s secret and patches its ceilings without touching the rest', async () => {
    const h = setup()
    const admin = h.fake.client(h.fake.admin.secret)
    const before = h.platform.secret
    const rotated = await admin.keys.rotate({ params: { keyId: h.platform.key.id } })
    expect(rotated.key.id).toBe(h.platform.key.id)
    expect(rotated.secret).not.toBe(before)
    expect(rotated.key.prefix).toBe(rotated.secret.slice(0, 12))
    expect(rotated.key.webhookSecretIds).toEqual(h.platform.key.webhookSecretIds)
    // The old secret died the moment the new one was drawn.
    expect((await refusal(h.fake.client(before).matches.list({ query: {} }))).code).toBe(
      'unauthorized',
    )
    expect((await h.fake.client(rotated.secret).matches.list({ query: {} })).items).toEqual([])

    const patched = await admin.keys.setBudget({
      params: { keyId: h.platform.key.id },
      body: { monthlyCents: 12_345 },
    })
    expect(patched.budget.monthlyCents).toBe(12_345)
    expect(patched.budget.maxConcurrentServers).toBe(h.platform.key.budget.maxConcurrentServers)
    expect(patched.budget.maxServerLifetimeMinutes).toBe(
      h.platform.key.budget.maxServerLifetimeMinutes,
    )

    await admin.keys.revoke({ params: { keyId: h.platform.key.id } })
    expect((await refusal(admin.keys.rotate({ params: { keyId: h.platform.key.id } }))).code).toBe(
      'invalid_state',
    )
  })
})

describe('cancel and commands', () => {
  it('cancels before live, releases the row, and refuses from live on', async () => {
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest() })
    const cancelled = await client.matches.cancel({ params: { matchId: match.id } })
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.endedReason?.kind).toBe('cancelled')
    await h.fake.playOut()
    const envelopes = await allEvents(h, match.id)
    expect(types(envelopes)).toEqual(['match.ended'])
    expect(envelopes[0]?.payload).toEqual({
      type: 'match.ended',
      state: 'cancelled',
      reason: { kind: 'cancelled' },
      // A pug records a demo and the request said where to put one; nobody
      // ever played, so the honest answer is that there is none (T21).
      demo: { uploaded: 0, skipped: 'no_demo' },
    })
    const admin = h.fake.client(h.fake.admin.secret)
    expect((await admin.fleet.ledger({ query: {} })).items[0]?.state).toBe('released')

    const live = await client.matches.create({ body: pugRequest({ clientMatchId: 'live' }) })
    await h.clock.advance(120_000)
    expect((await client.matches.get({ params: { matchId: live.id } })).state).toBe('live')
    expect((await refusal(client.matches.cancel({ params: { matchId: live.id } }))).code).toBe(
      'invalid_state',
    )
  })

  it('applies announce, pause, unpause and force_end; replays a correlationId; gates rcon', async () => {
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest() })
    const params = { matchId: match.id }
    const early = await client.matches.command({
      params,
      body: { type: 'announce', correlationId: 'c0', text: 'too early' },
    })
    expect(early.status).toBe('rejected')
    expect(early.code).toBe('invalid_state')

    await h.clock.advance(120_000)
    const announced = await client.matches.command({
      params,
      body: { type: 'announce', correlationId: 'c1', text: 'glhf' },
    })
    expect(announced.status).toBe('applied')
    const replay = await client.matches.command({
      params,
      body: { type: 'announce', correlationId: 'c1', text: 'a different line' },
    })
    expect(replay).toEqual(announced)
    expect(h.fake.server(match.id)?.announced()).toEqual(['glhf'])

    const paused = await client.matches.command({
      params,
      body: { type: 'pause', correlationId: 'c2', kind: 'technical' },
    })
    expect(paused.status).toBe('applied')
    const before = (await client.matches.get({ params })).seq
    await h.clock.advance(120_000)
    expect((await client.matches.get({ params })).seq).toBe(before)
    const unpaused = await client.matches.command({
      params,
      body: { type: 'unpause', correlationId: 'c3' },
    })
    expect(unpaused.status).toBe('applied')
    await h.clock.advance(60_000)
    expect((await client.matches.get({ params })).seq).toBeGreaterThan(before)

    for (const type of ['restart_round', 'reroll', 'rcon'] as const) {
      const result =
        type === 'rcon'
          ? await refusal(
              client.matches.command({
                params,
                body: { type, correlationId: `x-${type}`, command: 'status' },
              }),
            )
          : await client.matches.command({ params, body: { type, correlationId: `x-${type}` } })
      if (result instanceof ApiError) expect(result.code).toBe('forbidden')
      else expect(result.code).toBe('command_unsupported')
    }
    const boss = h.fake.mintKey({
      name: 'boss',
      scopes: ['admin'],
      budget: { maxConcurrentServers: 2, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
      webhookSecrets: [{ id: WEBHOOK_SECRET_ID, secret: WEBHOOK_SECRET }],
    })
    const admin = h.fake.client(boss.secret)
    const adminMatch = await admin.matches.create({ body: pugRequest({ clientMatchId: 'admin' }) })
    await h.clock.advance(60_000)
    const rcon = await admin.matches.command({
      params: { matchId: adminMatch.id },
      body: { type: 'rcon', correlationId: 'r1', command: 'status' },
    })
    expect(rcon.status).toBe('rejected')
    expect(rcon.code).toBe('command_unsupported')

    const kicked = await client.matches.command({
      params,
      body: {
        type: 'kick',
        correlationId: 'c4',
        steamId64: rosterOf(['x'], 0)[0]?.steamId64 as string,
      },
    })
    expect(kicked.status).toBe('applied')
    const stranger = await client.matches.command({
      params,
      body: { type: 'kick', correlationId: 'c5', steamId64: '76561198999999999' },
    })
    expect(stranger.code).toBe('player_not_in_match')
    const profile = await client.matches.command({
      params,
      body: {
        type: 'profile',
        correlationId: 'c6',
        player: { steamId64: '76561198999999999', name: 'stranger' },
      },
    })
    expect(profile.code).toBe('player_not_in_match')

    const ended = await client.matches.command({
      params,
      body: { type: 'force_end', correlationId: 'c7', reason: 'admin call' },
    })
    expect(ended.status).toBe('applied')
    const final = await client.matches.get({ params })
    expect(final.state).toBe('ended')
    expect(final.endedReason).toEqual({ kind: 'force_ended', detail: 'admin call' })
    const order = types(await allEvents(h, match.id))
    expect(order).toContain('match_paused')
    expect(order).toContain('match_unpaused')
    expect(order.filter(t => t === 'player.left')).toHaveLength(1)
    expect(order.at(-1)).toBe('match.ended')
    const chat = (await allEvents(h, match.id)).find(
      e => e.payload.type === 'plugin_event' && e.payload.name === 'chat_announced',
    )
    expect(chat).toBeDefined()
  })

  it("prints the request's warmup lines while the simulated server waits", async () => {
    const warmupLines = ['Willkommen bei EZPug.', 'Dein Match steht auf ezpug.com.']
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest({ warmupLines }) })
    await h.clock.advance(600_000)

    const envelopes = await allEvents(h, match.id)
    const said = envelopes.filter(
      e => e.payload.type === 'plugin_event' && e.payload.name === 'chat_announced',
    )
    expect(said.length).toBeGreaterThan(1)
    // In order, cycling, exactly as the plugin's `WarmupChat` prints them.
    const lineOf = (envelope: WebhookEnvelope): unknown =>
      envelope.payload.type === 'plugin_event' ? envelope.payload.data?.line : undefined
    expect(said.map(lineOf)).toEqual(
      said.map((_, index) => warmupLines[index % warmupLines.length]),
    )

    // And only while the server waits: every one of them is before the map went live.
    const order = types(envelopes)
    const live = order.indexOf('going_live')
    expect(live).toBeGreaterThan(-1)
    for (const line of said) expect(envelopes.indexOf(line)).toBeLessThan(live)

    // A request that named no lines still says nothing at all.
    const quiet = setup()
    const other = await quiet.fake
      .client(quiet.platform.secret)
      .matches.create({ body: pugRequest() })
    await quiet.clock.advance(600_000)
    expect(
      (await allEvents(quiet, other.id)).filter(
        e => e.payload.type === 'plugin_event' && e.payload.name === 'chat_announced',
      ),
    ).toHaveLength(0)
  })

  it('drives the engine with the sim.* family', async () => {
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({
      body: pugRequest({ sim: { mode: 'step', seed: 'fixture-seed' } }),
    })
    const params = { matchId: match.id }
    await h.clock.advance(5_000)
    // Step mode arms nothing: the server is assigned but has said nothing.
    const parked = await client.matches.get({ params })
    expect(parked.state).toBe('configuring')
    expect(parked.sim?.mode).toBe('step')
    expect(parked.sim?.seed).toBe('fixture-seed')
    const stepped = await client.matches.command({
      params,
      body: { type: 'sim.step', correlationId: 's1' },
    })
    expect(stepped.status).toBe('applied')
    expect(stepped.stepped).toBe('server_ready')
    expect(stepped.sim?.remainingBeats).toBeGreaterThan(0)
    expect((await client.matches.get({ params })).state).toBe('ready')

    const faster = await client.matches.command({
      params,
      body: { type: 'sim.speed', correlationId: 's2', timeScale: 20 },
    })
    expect(faster.sim?.timeScale).toBe(20)
    const chaotic = await client.matches.command({
      params,
      body: { type: 'sim.chaos', correlationId: 's3', chaos: { duplicate: 1 } },
    })
    expect(chaotic.sim?.chaos).toEqual({ duplicate: 1 })
    const auto = await client.matches.command({
      params,
      body: { type: 'sim.mode', correlationId: 's4', mode: 'auto' },
    })
    expect(auto.sim?.mode).toBe('auto')
    const noStep = await client.matches.command({
      params,
      body: { type: 'sim.step', correlationId: 's5' },
    })
    expect(noStep.code).toBe('invalid_state')
    await h.fake.playOut()
    const final = await client.matches.get({ params })
    expect(final.state).toBe('ended')
    // Every event was duplicated by the server and taken once by the fake.
    const seqs = (await allEvents(h, match.id)).map(e => e.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(h.errors).toEqual([])
  })
})

describe('losing a server', () => {
  it('recovers from a crash with a backup on a replacement server and finishes the match', async () => {
    const h = setup({ providers: { faults: { crash: { afterRound: 3, backup: true } } } })
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest() })
    await h.fake.playOut()
    const final = await client.matches.get({ params: { matchId: match.id } })
    expect(final.state).toBe('ended')
    expect(final.endedReason?.kind).toBe('completed')
    expect(final.serverId).toBe('sim-2')
    const envelopes = await allEvents(h, match.id)
    const order = types(envelopes)
    const recovering = envelopes.find(e => e.payload.type === 'match.recovering')?.payload
    if (recovering?.type !== 'match.recovering') throw new Error('unreachable')
    expect(recovering.backupRound).toBe(3)
    const recovered = envelopes.find(e => e.payload.type === 'match.recovered')?.payload
    if (recovered?.type !== 'match.recovered') throw new Error('unreachable')
    expect(recovered.serverId).toBe('sim-2')
    expect(recovered.resumedFromRound).toBe(3)
    expect(order.filter(t => t === 'match.allocated')).toHaveLength(2)
    expect(order.filter(t => t === 'match.server_ready')).toHaveLength(2)
    expect(order.indexOf('match.recovering')).toBeLessThan(order.lastIndexOf('match.allocated'))
    expect(order.lastIndexOf('match.server_ready')).toBeLessThan(order.indexOf('match.recovered'))
    expect(order.at(-1)).toBe('match.ended')
    // The rounds after the crash were played once, by the replacement.
    const roundEnds = envelopes
      .map(e => e.payload)
      .filter(p => p.type === 'round_end')
      .map(p => (p.type === 'round_end' ? `${p.source.serverId}:${p.roundNumber}` : ''))
    expect(roundEnds.filter(r => r.startsWith('sim-1:'))).toEqual(['sim-1:1', 'sim-1:2', 'sim-1:3'])
    // The backup of round 3 was written at its start, so the replacement replays round 3.
    expect(roundEnds.filter(r => r.startsWith('sim-2:'))[0]).toBe('sim-2:3')
    const admin = h.fake.client(h.fake.admin.secret)
    const rows = (await admin.fleet.ledger({ query: {} })).items
    expect(rows.map(r => [r.serverId, r.state])).toEqual([
      ['sim-2', 'released'],
      ['sim-1', 'failed'],
    ])
    expect(h.errors).toEqual([])
  })

  it('fails server_lost when the crash took the backups with it', async () => {
    const h = setup({ providers: { faults: { crash: { afterRound: 2, backup: false } } } })
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest() })
    await h.fake.playOut()
    const final = await client.matches.get({ params: { matchId: match.id } })
    expect(final.state).toBe('failed')
    expect(final.endedReason).toEqual({ kind: 'server_lost', detail: 'no backup to restore from' })
    const order = types(await allEvents(h, match.id))
    expect(order.slice(-2)).toEqual(['match.recovering', 'match.failed'])
  })

  it('lets a client drive the restore by hand when auto-recovery is off, and refuses it elsewhere', async () => {
    const h = setup({ providers: { sim: { autoRecover: false } } })
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest() })
    const params = { matchId: match.id }
    await h.clock.advance(120_000)
    const notYet = await client.matches.command({
      params,
      body: { type: 'restore', correlationId: 'r0' },
    })
    expect(notYet.code).toBe('invalid_state')
    // Play into the map, then press the kill button.
    await h.clock.advance(10 * 60_000)
    const killed = await client.matches.command({
      params,
      body: { type: 'sim.kill', correlationId: 'k1' },
    })
    expect(killed.status).toBe('applied')
    expect(killed.sim?.finished).toBe(true)
    await h.clock.advance(30_000)
    let state = await client.matches.get({ params })
    expect(state.state).toBe('recovering')
    const wrongRound = await client.matches.command({
      params,
      body: { type: 'restore', correlationId: 'r1', roundNumber: 99 },
    })
    expect(wrongRound.code).toBe('no_backup')
    const restored = await client.matches.command({
      params,
      body: { type: 'restore', correlationId: 'r2' },
    })
    expect(restored.status).toBe('applied')
    await h.fake.playOut()
    state = await client.matches.get({ params })
    expect(state.state).toBe('ended')
    expect(state.endedReason?.kind).toBe('completed')
    expect(types(await allEvents(h, match.id))).toContain('match.recovered')
  })

  it('fails provider_error when a server never boots', async () => {
    const h = setup({ providers: { faults: { bootNeverEnds: true } } })
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest() })
    await h.fake.playOut()
    const final = await client.matches.get({ params: { matchId: match.id } })
    expect(final.state).toBe('failed')
    expect(final.endedReason?.kind).toBe('provider_error')
    expect(final.endedAt).toBe(new Date(T0 + 1_000 + 120_000).toISOString())
    expect(types(await allEvents(h, match.id))).toEqual(['match.allocated', 'match.failed'])
  })

  it('fails provider_error when an operator releases the server under it', async () => {
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    const admin = h.fake.client(h.fake.admin.secret)
    const match = await client.matches.create({ body: pugRequest() })
    await h.clock.advance(120_000)
    const { servers } = await admin.fleet.servers.list()
    expect(servers).toHaveLength(1)
    expect(servers[0]?.state).toBe('running')
    const lines = await admin.fleet.servers.console({ params: { serverId: 'sim-1' } })
    expect(lines.lines.some(l => l.line.includes('going live'))).toBe(true)
    const rcon = await refusal(
      admin.fleet.servers.rcon({ params: { serverId: 'sim-1' }, body: { command: 'status' } }),
    )
    expect(rcon.code).toBe('command_unsupported')
    const released = await admin.fleet.servers.release({
      params: { serverId: 'sim-1' },
      body: { reason: 'cost' },
    })
    expect(released.state).toBe('released')
    const final = await client.matches.get({ params: { matchId: match.id } })
    expect(final.state).toBe('failed')
    expect(final.endedReason).toEqual({
      kind: 'provider_error',
      detail: 'released by operator: cost',
    })
    expect(
      (await refusal(admin.fleet.servers.console({ params: { serverId: 'sim-9' } }))).code,
    ).toBe('not_found')
  })
})

describe('webhooks', () => {
  it('retries on the published schedule with the same deliveryId and a rising attempt header', async () => {
    const h = setup()
    const scripted: (number | null)[] = [500, null, 503]
    h.respond = request =>
      request.envelope.seq === 1 && scripted.length > 0 ? (scripted.shift() as number | null) : 200
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest() })
    await h.fake.playOut()
    const first = h.fake.deliveries(match.id).filter(a => a.seq === 1)
    expect(first.map(a => [a.attempt, a.status, a.outcome])).toEqual([
      [1, 500, 'retry'],
      [2, null, 'retry'],
      [3, 503, 'retry'],
      [4, 200, 'delivered'],
    ])
    expect(new Set(first.map(a => a.deliveryId)).size).toBe(1)
    expect(first.map(a => a.headers[WEBHOOK_ATTEMPT_HEADER])).toEqual(['1', '2', '3', '4'])
    const at = first.map(a => Date.parse(a.at))
    expect((at[1] as number) - (at[0] as number)).toBe(WEBHOOK_RETRY_DELAYS_MS[0])
    expect((at[2] as number) - (at[1] as number)).toBe(WEBHOOK_RETRY_DELAYS_MS[1])
    expect((at[3] as number) - (at[2] as number)).toBe(WEBHOOK_RETRY_DELAYS_MS[2])
    // A retry is re-signed with a fresh t, and still verifies.
    const last = first[3] as (typeof first)[number]
    const verdict = await verifyWebhookSignature({
      header: last.headers[WEBHOOK_SIGNATURE_HEADER],
      body: last.body,
      secrets: { [WEBHOOK_SECRET_ID]: WEBHOOK_SECRET },
      clock: createFakeClock({ start: Date.parse(last.at) }),
    })
    expect(verdict.ok).toBe(true)
    // Later deliveries were not held back by the one in retries.
    const second = h.fake.deliveries(match.id).find(a => a.seq === 2)
    expect(Date.parse(second?.at as string)).toBeLessThan(at[3] as number)
  })

  it('gives up after ten attempts and keeps the fact in the events route', async () => {
    const h = setup()
    h.respond = request => (request.envelope.seq === 1 ? 500 : 200)
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest({ ttlMinutes: 1 }) })
    await h.fake.playOut()
    const first = h.fake.deliveries(match.id).filter(a => a.seq === 1)
    expect(first).toHaveLength(10)
    expect(first.at(-1)?.outcome).toBe('given_up')
    expect((await allEvents(h, match.id))[0]?.seq).toBe(1)
  })

  it('stops every later delivery of the match on a 410', async () => {
    const h = setup()
    h.respond = request => (request.envelope.seq === 2 ? 410 : 200)
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest() })
    await h.fake.playOut()
    const attempts = h.fake.deliveries(match.id)
    expect(attempts.map(a => a.seq)).toEqual([1, 2])
    expect(attempts[1]?.outcome).toBe('stopped')
    expect((await client.matches.get({ params: { matchId: match.id } })).state).toBe('ended')
    expect((await allEvents(h, match.id)).length).toBeGreaterThan(2)
  })

  it('duplicates, reorders and fails deliveries on the fault knobs', async () => {
    const h = setup({
      providers: {
        faults: { webhookDuplicates: true, webhookOutOfOrder: true, webhookFailures: 2 },
      },
    })
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest({ ttlMinutes: 1 }) })
    await h.fake.playOut()
    const attempts = h.fake.deliveries(match.id)
    // The first two attempts never reached the endpoint.
    expect(attempts.slice(0, 2).map(a => a.status)).toEqual([503, 503])
    expect(h.posted.length).toBe(attempts.length - 2)
    // Every delivered envelope was POSTed twice under one deliveryId.
    const delivered = attempts.filter(a => a.outcome === 'delivered')
    for (const attempt of delivered.filter(a => !a.duplicate)) {
      expect(
        delivered.filter(a => a.deliveryId === attempt.deliveryId && a.duplicate),
      ).toHaveLength(1)
    }
    // An even seq waited: seq 3's first attempt precedes seq 2's.
    const firstOf = (seq: number) => attempts.findIndex(a => a.seq === seq && !a.duplicate)
    expect(firstOf(3)).toBeLessThan(firstOf(2))
  })
})

describe('the stream and the player door', () => {
  it('sends hello first, mirrors every durable fact, batches ticks and closes 4000 at the end', async () => {
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    const match = await client.matches.create({ body: pugRequest() })
    await h.clock.advance(3_000)
    const frames: import('../index').StreamFrame[] = []
    let closed: number | undefined
    const unsubscribe = h.fake.stream(
      { matchId: match.id, apiKey: h.platform.secret },
      frame => frames.push(frame),
      code => {
        closed = code
      },
    )
    expect(frames[0]).toEqual({ type: 'hello', matchId: match.id, seq: 1, state: 'configuring' })
    await h.fake.playOut()
    const kinds = new Set(frames.map(f => f.type))
    expect([...kinds].sort()).toEqual(['event', 'hello', 'presence', 'tick'])
    expect(frames.filter(f => f.type === 'tick').length).toBeGreaterThan(10)
    const mirrored = frames
      .filter(f => f.type === 'event')
      .map(f => (f.type === 'event' ? f.envelope : null))
    const envelopes = await allEvents(h, match.id)
    expect(mirrored).toEqual(envelopes.slice(1))
    expect(closed).toBe(4000)
    unsubscribe()

    // A subscriber to an ended match hears hello and the close, nothing else.
    const late: import('../index').StreamFrame[] = []
    let lateClose: number | undefined
    h.fake.stream(
      { matchId: match.id, apiKey: h.platform.secret },
      f => late.push(f),
      c => {
        lateClose = c
      },
    )
    expect(late.map(f => f.type)).toEqual(['hello'])
    expect(lateClose).toBe(4000)
  })

  it('mints player tokens scoped to a match and a SteamID and honours them on the stream and the widget door', async () => {
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    const pug = await client.matches.create({ body: pugRequest() })
    const dm = await client.matches.create({
      body: pugRequest({
        clientMatchId: 'dm',
        gamemode: 'powerup-dm',
        teams: { teamA: { name: 'Alle', players: [] }, teamB: { name: 'Niemand', players: [] } },
        callbacks: {
          webhookUrl: 'https://platform.invalid/hooks/ezpug',
          webhookSecretId: WEBHOOK_SECRET_ID,
        },
      }),
    })
    const steamId64 = rosterOf(['x'], 0)[0]?.steamId64 as string
    const stranger = await refusal(
      client.matches.mintPlayerToken({
        params: { matchId: pug.id },
        body: { steamId64: '76561198999999999' },
      }),
    )
    expect(stranger.code).toBe('player_not_in_match')
    const token = await client.matches.mintPlayerToken({
      params: { matchId: pug.id },
      body: { steamId64 },
    })
    expect(token.token.startsWith(FAKE_SECRET_PREFIXES.playerToken)).toBe(true)
    expect(token.expiresAt).toBe(new Date(T0 + 900_000).toISOString())
    const frames: import('../index').StreamFrame[] = []
    h.fake.stream({ matchId: pug.id, token: token.token }, f => frames.push(f))
    expect(frames[0]?.type).toBe('hello')
    expect(() => h.fake.stream({ matchId: dm.id, token: token.token }, () => undefined)).toThrow(
      /another match/,
    )
    expect(() =>
      h.fake.stream({ matchId: pug.id, token: 'fake-player-token-nope' }, () => undefined),
    ).toThrow(/player token/)

    await h.clock.advance(120_000)
    expect((await client.matches.get({ params: { matchId: dm.id } })).state).toBe('live')
    // An open-join mode mints for anyone.
    const dmToken = await client.matches.mintPlayerToken({
      params: { matchId: dm.id },
      body: { steamId64: '76561198999999999', ttlSeconds: 60 },
    })
    const answered = await h.fake.playerCommand({
      token: dmToken.token,
      command: 'powerup',
      args: { kind: 'speed' },
    })
    expect(answered.payload).toMatchObject({
      type: 'plugin_event',
      name: FAKE_PLAYER_COMMAND_EVENT,
      data: { command: 'powerup', steamId64: '76561198999999999', args: { kind: 'speed' } },
    })
    expect((await allEvents(h, dm.id)).at(-1)).toEqual(answered)
    expect(
      (await refusal(h.fake.playerCommand({ token: dmToken.token, command: 'fly' }))).code,
    ).toBe('command_unsupported')
    expect(
      (await refusal(h.fake.playerCommand({ token: token.token, command: 'powerup' }))).code,
    ).toBe('command_unsupported')
    // Invented open-join players are not rostered; a pushed profile makes one so.
    const joined = (await allEvents(h, dm.id)).filter(e => e.payload.type === 'player.joined')
    expect(joined.length).toBeGreaterThan(0)
    expect(
      joined.every(e => e.payload.type === 'player.joined' && e.payload.rostered === false),
    ).toBe(true)
    const invented = joined[0]?.payload
    if (invented?.type !== 'player.joined') throw new Error('unreachable')
    const pushed = await client.matches.command({
      params: { matchId: dm.id },
      body: {
        type: 'profile',
        correlationId: 'p1',
        player: { steamId64: invented.player.steamId64, name: 'Dressed' },
      },
    })
    expect(pushed.status).toBe('applied')
    // The token expires on the clock.
    await h.clock.advance(60_000)
    expect(
      (await refusal(h.fake.playerCommand({ token: dmToken.token, command: 'powerup' }))).code,
    ).toBe('unauthorized')
  })
})

describe('the fleet', () => {
  it('enrols, drains and revokes nodes, and shows the token once', async () => {
    const h = setup()
    const admin = h.fake.client(h.fake.admin.secret)
    const enrolled = await admin.fleet.nodes.enrol({
      body: { id: 'saarlan-rack-2', region: 'saarlan', labels: { venue: 'saarlan' } },
    })
    expect(enrolled.token.startsWith(FAKE_SECRET_PREFIXES.nodeToken)).toBe(true)
    expect(enrolled.node.connected).toBe(false)
    expect(JSON.stringify(await admin.fleet.nodes.list())).not.toContain(enrolled.token)
    expect(
      (
        await refusal(
          admin.fleet.nodes.enrol({ body: { id: 'saarlan-rack-2', region: 'saarlan' } }),
        )
      ).code,
    ).toBe('conflict')
    expect((await admin.fleet.nodes.drain({ params: { nodeId: 'saarlan-rack-2' } })).drained).toBe(
      true,
    )
    expect(
      (await admin.fleet.nodes.undrain({ params: { nodeId: 'saarlan-rack-2' } })).drained,
    ).toBe(false)
    expect(await admin.fleet.nodes.revoke({ params: { nodeId: 'saarlan-rack-2' } })).toEqual({
      ok: true,
    })
    expect(
      (await refusal(admin.fleet.nodes.revoke({ params: { nodeId: 'saarlan-rack-2' } }))).code,
    ).toBe('not_found')
    expect((await admin.fleet.nodes.list()).nodes).toEqual([])
  })

  it('pages the ledger and the match list, accrues cost and warns at the budget thresholds', async () => {
    const h = setup({
      providers: { sim: { hourlyCents: 60 } },
      budget: { maxConcurrentServers: 2, maxServerLifetimeMinutes: 240, monthlyCents: 100_000 },
    })
    const client = h.fake.client(h.platform.secret)
    const admin = h.fake.client(h.fake.admin.secret)
    const one = await client.matches.create({ body: pugRequest({ clientMatchId: 'one' }) })
    const two = await client.matches.create({ body: pugRequest({ clientMatchId: 'two' }) })
    await h.clock.advance(10 * 60_000)
    const page1 = await admin.fleet.ledger({ query: { limit: 1 } })
    expect(page1.items).toHaveLength(1)
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await admin.fleet.ledger({
      query: { limit: 1, cursor: page1.nextCursor as string },
    })
    expect(page2.nextCursor).toBeNull()
    expect(page1.items[0]?.matchId).toBe(two.id)
    expect(page1.items[0]?.cost.accruedCents).toBe(10)
    expect((await admin.fleet.ledger({ query: { matchId: one.id } })).items).toHaveLength(1)
    // The budget route answers for the calling key: the admin's own here.
    const budget = await admin.fleet.budget()
    expect(budget.keyId).toBe(h.fake.admin.key.id)
    expect(budget.usage.concurrentServers).toBe(0)
    expect(budget.usage.monthStartedAt).toBe('2026-09-01T00:00:00.000Z')
    const thresholds = (await allEvents(h, two.id)).filter(
      e => e.payload.type === 'fleet.budget_threshold',
    )
    expect(
      thresholds.map(e => (e.payload.type === 'fleet.budget_threshold' ? e.payload.fraction : 0)),
    ).toEqual([0.8, 0.95])
    const matches = await client.matches.list({ query: { state: 'live' } })
    expect(matches.items.map(m => m.clientMatchId)).toEqual(['two', 'one'])
    expect((await client.matches.list({ query: { clientMatchId: 'one' } })).items).toHaveLength(1)
  })

  it("sends the fleet facts to the key's fleet webhook and reads the ledger by since", async () => {
    const h = setup({
      providers: { sim: { hourlyCents: 60 } },
      budget: { maxConcurrentServers: 1, maxServerLifetimeMinutes: 240, monthlyCents: 100_000 },
    })
    const client = h.fake.client(h.platform.secret)
    const admin = h.fake.client(h.fake.admin.secret)

    // A secret nobody registered cannot sign anything: refuse the endpoint
    // rather than deliver with a `kid` no verifier knows.
    expect(
      (
        await refusal(
          admin.keys.setFleetWebhook({
            params: { keyId: h.platform.key.id },
            body: { fleetWebhook: { url: 'https://platform.invalid/fleet', secretId: 'nope' } },
          }),
        )
      ).code,
    ).toBe('validation_failed')
    const patched = await admin.keys.setFleetWebhook({
      params: { keyId: h.platform.key.id },
      body: {
        fleetWebhook: { url: 'https://platform.invalid/fleet', secretId: WEBHOOK_SECRET_ID },
      },
    })
    expect(patched.fleetWebhook?.url).toBe('https://platform.invalid/fleet')

    const match = await client.matches.create({ body: pugRequest({ clientMatchId: 'fleet' }) })
    await h.clock.advance(10 * 60_000)
    await h.fake.settle()
    const byUrl = (url: string): string[] =>
      h.fake
        .deliveries(match.id)
        .filter(attempt => attempt.url === url)
        .map(attempt => attempt.envelope.payload.type)
    expect(byUrl('https://platform.invalid/fleet')).toContain('fleet.budget_threshold')
    expect(byUrl(WEBHOOK_URL)).not.toContain('fleet.budget_threshold')
    // Same envelope, same signature scheme — the fleet secret signs it.
    const attempt = h.fake
      .deliveries(match.id)
      .find(a => a.envelope.payload.type === 'fleet.budget_threshold')
    expect(attempt?.headers[WEBHOOK_SIGNATURE_HEADER]).toContain(`kid=${WEBHOOK_SECRET_ID}`)
    // The events route still has it, whoever it was POSTed to.
    expect(types(await allEvents(h, match.id))).toContain('fleet.budget_threshold')

    // `since` is the cost window: the open row is in it however long ago it started.
    const now = new Date(h.clock.now()).toISOString()
    expect((await admin.fleet.ledger({ query: { since: now } })).items).toHaveLength(1)
    await client.matches.command({
      params: { matchId: match.id },
      body: { type: 'force_end', correlationId: 'fleet-end', reason: 'the ledger closes' },
    })
    await h.fake.settle()
    await h.clock.advance(60_000)
    const after = new Date(h.clock.now()).toISOString()
    expect((await admin.fleet.ledger({ query: { since: after } })).items).toEqual([])
    expect((await admin.fleet.ledger({ query: { since: now } })).items).toHaveLength(1)
  })

  it('serves the catalog and the manifests', async () => {
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    const { gamemodes } = await client.gamemodes.list()
    expect(gamemodes.map(g => g.id)).toEqual(['pug', 'flying-scoutsman', 'retakes', 'powerup-dm'])
    expect((await client.gamemodes.get({ params: { gamemodeId: 'retakes' } })).slots.openJoin).toBe(
      true,
    )
    expect((await refusal(client.gamemodes.get({ params: { gamemodeId: 'wingman' } }))).code).toBe(
      'not_found',
    )
    const capacity = await client.capacity.get()
    expect(capacity.providers[0]).toMatchObject({ id: 'sim', healthy: true, drained: false })
    expect(capacity.providers[0]?.regions[0]).toEqual({
      region: 'sim',
      games: ['cs2'],
      lan: false,
      available: 8,
    })
  })

  it('plays the other tiers: a config-only mode and an open-join retakes match', async () => {
    const h = setup()
    const client = h.fake.client(h.platform.secret)
    const scouts = await client.matches.create({
      body: pugRequest({ clientMatchId: 'scouts', gamemode: 'flying-scoutsman', rules: undefined }),
    })
    const retakes = await client.matches.create({
      body: pugRequest({
        clientMatchId: 'retakes',
        gamemode: 'retakes',
        teams: { teamA: { name: 'CT', players: [] }, teamB: { name: 'T', players: [] } },
        maps: [{ map: 'de_dust2', sides: 'ct' }],
      }),
    })
    await h.fake.playOut()
    for (const match of [scouts, retakes]) {
      const final: Match = await client.matches.get({ params: { matchId: match.id } })
      expect(final.state).toBe('ended')
      const order = types(await allEvents(h, match.id))
      // `records: events` — no demo leaves the server.
      expect(order).not.toContain('demo.uploaded')
      expect(order).toContain('round_end')
    }
    expect(h.uploads).toEqual([])
  })
})
