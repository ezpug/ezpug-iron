import type { GameserverEvent } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from '../http/testing'
import type { AuthenticatedKey } from '../keys/service'
import { createFakeDathost, type FakeDathost } from '../providers/dathost/fake'
import { createDathostProvider, DATHOST_PROVIDER_ID } from '../providers/dathost/provider'
import { HUD_ADDON_LOADER_PATH } from '../providers/hud-addon'
import {
  CANARY_KEY_NAME,
  CANARY_LIFETIME_MINUTES,
  CANARY_POLL_MS,
  canaryReason,
  createGameCanaries,
} from './canary'
import { createExclusive } from './exclusive'

/**
 * **The canary** (PRD-10 T3, decision 38), on the fake Dathost. What is
 * proved here is the round's second promise — a build is a verdict before
 * it is a player's evening:
 *
 * - a build move on a provider that updates itself puts **one** canary match
 *   on the ledger, on the orchestrator's own key, and the match the canary
 *   starts and plays reads `green` on the health route;
 * - a server that crashes is `red` with the crash named and its line quoted,
 *   the provider reads unhealthy, and a match configured meanwhile carries
 *   no HUD addon loader — except the `hud` canary's own;
 * - the key's lifetime wall cuts a canary that hangs, and a second trigger
 *   while one plays is answered with the running one.
 *
 * Nothing here dials a link: the server's words are put into the machine
 * the way the link puts them, and the console is the fake vendor's.
 */

const EMAIL = 'canary@example.invalid'
const PASSWORD = 'fake-dathost-password'
const TOKEN = 'ghp_fake-token-for-the-canary-tests'
const HUD_ADDON = '3561234567'
const BUILD = '1.41.9.2'
const STEAM_INF = (build: string) =>
  [`PatchVersion=${build}`, 'ProductName=cs2', 'SourceRevision=11162119', ''].join('\r\n')

interface Rig {
  app: TestApp
  fake: FakeDathost
  operator: string
  /** The canary key, as the orchestrator acts with it. */
  canaryKey: () => Promise<AuthenticatedKey>
  providers: () => Promise<Record<string, unknown>[]>
  /** The one canary match the ledger holds right now, with its Dathost server. */
  canaryMatch: () => Promise<{ matchId: string; serverId: string }>
  /** What the server would say over the link. */
  say: (matchId: string, serverId: string, event: Record<string, unknown>) => Promise<void>
  /** Let the canary's poll run once. */
  poll: () => Promise<void>
}

async function createRig(): Promise<Rig> {
  const app = createTestApp({ noProviders: true, githubToken: TOKEN })
  const fake = createFakeDathost({ clock: app.clock, email: EMAIL, password: PASSWORD })
  const form = new FormData()
  for (const [name, value] of Object.entries({
    game: 'cs2',
    name: 'ezpug-template',
    location: 'dusseldorf',
    deletion_protection: 'true',
    'cs2_settings.slots': '12',
    'cs2_settings.rcon': 'a-template-rcon-password',
  }))
    form.append(name, value)
  const created = await fake.fetch('https://dathost.net/api/0.1/game-servers', {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${EMAIL}:${PASSWORD}`).toString('base64')}` },
    body: form,
  })
  const template = String(((await created.json()) as { id: unknown }).id)
  fake.setGameFiles({ 'steam.inf': STEAM_INF(BUILD) })
  app.providers.register(
    createDathostProvider({
      clock: app.clock,
      log: app.log,
      email: EMAIL,
      password: PASSWORD,
      templateServerId: template,
      fetch: fake.fetch,
      gslt: app.gslt,
      hudAddon: HUD_ADDON,
      hudGate: matchId => app.canaries.hudAllowed(DATHOST_PROVIDER_ID, matchId),
    }),
  )
  const minted = await app.keys.mint({
    name: 'operator',
    scopes: ['matches', 'fleet', 'admin'],
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 60, monthlyCents: 100_000 },
    webhookSecrets: [{ id: 'whsec', secret: 'a-webhook-secret-of-at-least-32-chars!' }],
  })

  const canaryKey = async (): Promise<AuthenticatedKey> => {
    const row = (await app.keys.list()).find(key => key.name === CANARY_KEY_NAME)
    if (!row) throw new Error('no canary key was minted')
    return (await app.keys.get(row.id)) as AuthenticatedKey
  }
  const rig: Rig = {
    app,
    fake,
    operator: minted.secret,
    canaryKey,
    providers: async () =>
      (await app.request('/v1/fleet/providers', { key: minted.secret })).body.providers,
    canaryMatch: async () => {
      const key = await canaryKey()
      const open = (await app.store.listOpenServers(DATHOST_PROVIDER_ID)).filter(
        row => row.keyId === key.key.id,
      )
      expect(open).toHaveLength(1)
      const row = open[0]
      if (!row?.matchId || !row.serverId) throw new Error('the canary row has no match or server')
      return { matchId: row.matchId, serverId: row.serverId }
    },
    say: async (matchId, serverId, event) => {
      const source = { provider: DATHOST_PROVIDER_ID, serverId }
      await app.matches.ingest(source, { matchId, source, ...event } as GameserverEvent)
      await app.settle()
    },
    poll: () => app.advance(CANARY_POLL_MS),
  }
  return rig
}

/** Boot the clone: the fake vendor's thirty seconds of `booting`. */
const boot = (rig: Rig) => rig.app.advance(30_000)

const canaryOf = (providers: Record<string, unknown>[]) =>
  (providers.find(p => p.id === DATHOST_PROVIDER_ID) as { game: { canary: unknown } }).game
    .canary as { state: string; build: string | null; reason: string | null }

describe('the canary', () => {
  it('plays a build move on Dathost to green: one match on its own key, started, a round, ended', async () => {
    const rig = await createRig()
    const { app } = rig
    await app.game.tick()
    await app.settle()

    // One canary match on the ledger, on the canary key, and one fact.
    const started = app.gameStore.rows.facts.filter(f => f.fact.type === 'game.canary_started')
    expect(started).toHaveLength(1)
    expect(started[0]?.fact).toMatchObject({
      provider: DATHOST_PROVIDER_ID,
      build: BUILD,
      hud: false,
      attempt: 1,
      cause: 'build_moved',
    })
    const key = await rig.canaryKey()
    expect(key.key.scopes).toEqual(['matches'])
    expect(key.key.budget).toEqual({
      maxConcurrentServers: 1,
      maxServerLifetimeMinutes: CANARY_LIFETIME_MINUTES,
      monthlyCents: 200,
    })
    const { matchId, serverId } = await rig.canaryMatch()
    const request = (await app.store.findMatch(matchId))?.requestJson
    expect(request).toMatchObject({
      gamemode: 'pug',
      maps: [{ map: 'de_dust2' }],
      rules: { regulationRounds: 2, warmup: { minPlayersToReady: 0 } },
      requirements: { provider: DATHOST_PROVIDER_ID },
      ttlMinutes: CANARY_LIFETIME_MINUTES,
    })
    expect(request?.rules?.cvars).toMatchObject({ bot_quota: '4' })
    expect(request?.teams.teamA.players).toEqual([])
    expect(request?.simulation).toBeUndefined()
    // While it plays the picture says what it is waiting for.
    expect(canaryOf(await rig.providers())).toMatchObject({ state: 'unproven', build: BUILD })
    expect(canaryOf(await rig.providers()).reason).toMatch(/a canary is playing \(attempt 1/)

    await boot(rig)
    await rig.say(matchId, serverId, { type: 'server_ready', map: 'de_dust2' })
    // The bots-only start, one step a poll, through the fleet's RCON door.
    await rig.poll()
    await rig.poll()
    const console = () => rig.fake.server(serverId)?.console ?? []
    expect(console()).toEqual(expect.arrayContaining(['bot_kick; bot_quota 0', 'css_start']))
    await rig.say(matchId, serverId, { type: 'going_live', mapNumber: 1, map: 'de_dust2' })
    await rig.poll()
    await rig.poll()
    expect(console()).toEqual(expect.arrayContaining(['bot_quota 4', 'mp_warmup_end']))
    await rig.say(matchId, serverId, {
      type: 'round_end',
      mapNumber: 1,
      roundNumber: 1,
      winner: { team: 'team_a', side: 'ct' },
      winCondition: 'elimination',
      score: { teamA: 1, teamB: 0 },
    })
    await rig.poll()

    const providers = await rig.providers()
    expect(canaryOf(providers)).toMatchObject({ state: 'green', build: BUILD, reason: null })
    expect(providers.find(p => p.id === DATHOST_PROVIDER_ID)).toMatchObject({ healthy: true })
    const verdicts = app.gameStore.rows.facts.filter(f => f.fact.type === 'game.canary_verdict')
    expect(verdicts.map(f => f.fact)).toEqual([
      expect.objectContaining({ state: 'green', attempt: 1, matchId, reason: null }),
    ])
    // Two rounds are the ceiling, not the goal: the match ends at the verdict.
    expect((await app.store.findMatch(matchId))?.state).toBe('ended')
    expect((await app.store.findMatch(matchId))?.endedReason?.kind).toBe('force_ended')
    // The build's issue hears it.
    expect(app.feeds.comments.map(c => c.body)).toEqual([
      expect.stringContaining('**Canary green**'),
    ])
  })

  it('is red on a crash, names it, and keeps the loader off every server but the hud canary’s', async () => {
    const rig = await createRig()
    const { app } = rig
    await app.game.tick()
    await app.settle()
    const { matchId, serverId } = await rig.canaryMatch()
    // A plain canary on a build no hud canary has seen: no loader, no id.
    expect(rig.fake.server(serverId)?.files.has(HUD_ADDON_LOADER_PATH)).toBe(false)
    expect(
      JSON.parse(rig.fake.server(serverId)?.files.get('ezpug.json') ?? '{}'),
    ).not.toHaveProperty('hudAddon')

    await boot(rig)
    rig.fake.say(serverId, '[MultiAddonManager] Steam API Activated')
    rig.fake.say(serverId, 'Thread 0 crashed: Engine2PreBreakpadDumpFunction+0x41 (libengine2.so)')
    await rig.poll()

    const providers = await rig.providers()
    const canary = canaryOf(providers)
    expect(canary.state).toBe('red')
    expect(canary.reason).toMatch(
      /^the server crashed \(breakpad\) on dathost, build 1\.41\.9\.2: /,
    )
    expect(canary.reason).toContain('Engine2PreBreakpadDumpFunction')
    expect(canary.reason).toContain('Steam API Activated')
    // The tile the platform already renders goes red, with the build and the reason.
    expect(providers.find(p => p.id === DATHOST_PROVIDER_ID)).toMatchObject({
      healthy: false,
      lastError: expect.stringMatching(/^canary red on build 1\.41\.9\.2: the server crashed/),
    })
    // The canary's server is given back at once, not at the boot deadline.
    expect((await app.store.findMatch(matchId))?.state).toBe('cancelled')
    expect(app.feeds.comments.map(c => c.body)).toEqual([expect.stringContaining('**Canary red**')])

    // Decision 38: a red build is still served — and served without the loader.
    const { match } = await app.matches.create(
      (await app.keys.get((await app.keys.list()).find(k => k.name === 'operator')?.id ?? ''))!,
      {
        clientMatchId: 'a-real-match',
        game: 'cs2',
        gamemode: 'pug',
        teams: { teamA: { name: 'A', players: [] }, teamB: { name: 'B', players: [] } },
        maps: [{ map: 'de_dust2', sides: 'ct' }],
        requirements: { provider: DATHOST_PROVIDER_ID },
        callbacks: { webhookUrl: 'https://webhooks.invalid/platform', webhookSecretId: 'whsec' },
        ttlMinutes: 60,
      } as never,
    )
    await app.settle()
    const real = (await app.store.findMatch(match.id))?.serverId ?? ''
    expect(rig.fake.server(real)?.files.has(HUD_ADDON_LOADER_PATH)).toBe(false)
    expect(JSON.parse(rig.fake.server(real)?.files.get('ezpug.json') ?? '{}')).not.toHaveProperty(
      'hudAddon',
    )

    // The hud canary is the one match that carries it, because it finds out.
    const asked = await app.request('/v1/fleet/game/canary', {
      method: 'POST',
      key: rig.operator,
      json: { provider: DATHOST_PROVIDER_ID, hud: true },
    })
    expect(asked.status).toBe(200)
    expect(asked.body).toMatchObject({ hud: true, attempt: 1, cause: 'demand', finishedAt: null })
    await app.settle()
    const hudServer = (await app.store.findMatch(asked.body.matchId))?.serverId ?? ''
    expect(rig.fake.server(hudServer)?.files.has(HUD_ADDON_LOADER_PATH)).toBe(true)
    expect(JSON.parse(rig.fake.server(hudServer)?.files.get('ezpug.json') ?? '{}')).toMatchObject({
      hudAddon: HUD_ADDON,
    })
  })

  it('is cut by its key’s lifetime when it hangs, and a second trigger is the running one', async () => {
    const rig = await createRig()
    const { app } = rig
    await app.game.tick()
    await app.settle()
    const { matchId, serverId } = await rig.canaryMatch()
    const again = await app.canaries.play({
      provider: DATHOST_PROVIDER_ID,
      hud: false,
      cause: 'demand',
    })
    expect(again).toMatchObject({ matchId, attempt: 1, finishedAt: null })

    await boot(rig)
    await rig.say(matchId, serverId, { type: 'server_ready', map: 'de_dust2' })
    // …and nothing ever goes live. The wall is the request's ttl, which the
    // canary key will not let be more than ten minutes.
    await app.advance(CANARY_LIFETIME_MINUTES * 60_000)
    await rig.poll()
    const canary = canaryOf(await rig.providers())
    expect(canary.state).toBe('red')
    expect(canary.reason).toMatch(
      /^the match ended: ttl_expired — .*; it was ready but never went live \(dathost, build 1\.41\.9\.2\)/,
    )
    expect(app.store.rows.servers.filter(row => row.releasedAt === null)).toEqual([])

    // A red may be run again on demand, and the fact says which attempt.
    const rerun = await app.canaries.play({
      provider: DATHOST_PROVIDER_ID,
      hud: false,
      cause: 'demand',
    })
    expect(rerun).toMatchObject({ attempt: 2, finishedAt: null })
    expect(canaryOf(await rig.providers()).state).toBe('red')
  })

  it('refuses a provider nobody registered and one whose build is not known yet', async () => {
    const rig = await createRig()
    const ask = (provider: string) =>
      rig.app.request('/v1/fleet/game/canary', {
        method: 'POST',
        key: rig.operator,
        json: { provider },
      })
    expect((await ask('nowhere')).body.error.code).toBe('not_found')
    expect((await ask(DATHOST_PROVIDER_ID)).body.error.code).toBe('invalid_state')
  })

  it('picks up a canary a restart interrupted, and decides it off the match’s log', async () => {
    const rig = await createRig()
    const { app } = rig
    await app.game.tick()
    await app.settle()
    const { matchId, serverId } = await rig.canaryMatch()
    await app.canaries.stop()
    const revived = createGameCanaries({
      clock: app.clock,
      log: app.log,
      store: app.gameStore,
      registry: app.providers,
      matches: app.matches,
      keys: app.keys,
      rcon: (key, id, command) => app.fleet.rcon(key, id, command),
      issues: {
        enabled: false,
        repo: 'ezpug/ezpug-iron',
        create: async () => null,
        comment: async () => false,
      },
      gamemodes: [],
      exclusive: createExclusive(),
    })
    await revived.start()
    expect(revived.runs()).toEqual([expect.objectContaining({ matchId, finishedAt: null })])
    await boot(rig)
    rig.fake.say(serverId, 'Failed to find signature CBaseEntity_TakeDamage')
    await revived.pass()
    expect(revived.runs()[0]?.verdict).toMatchObject({ state: 'red' })
    expect(revived.runs()[0]?.verdict.reason).toMatch(/Failed to find signature/)
    await revived.stop()
  })
})

describe('the canary’s reason', () => {
  it('names the first fatal pattern, quotes the lines that showed it and stays one sentence', () => {
    const reason = canaryReason({
      build: BUILD,
      provider: 'dathost',
      console: [
        'Loading map de_dust2',
        '[MultiAddonManager] Steam API Activated',
        `${'x'.repeat(400)} SIGNONSTATE_SPAWN`,
        'Engine2PreBreakpadDumpFunction',
        'rcon_password "hunter22hunter22"',
      ],
    })
    expect(reason.length).toBeLessThanOrEqual(512)
    expect(reason).toMatch(/^the server crashed \(breakpad\) on dathost, build 1\.41\.9\.2: "/)
    expect(reason).not.toContain('Loading map')
    expect(reason).not.toContain('hunter22')
  })

  it('falls back to how the match ended and the last two lines', () => {
    expect(
      canaryReason({
        build: BUILD,
        provider: 'dathost',
        console: [
          'one',
          'two',
          'three',
          'L 10/24/2026 - 15:37:57: rcon from "152.233.60.3:53946": command "status_json"',
        ],
        progress: 'it never got ready',
        ended: 'the match failed: provider_error — no server_ready on de_dust2 within 180 s',
      }),
    ).toBe(
      'the match failed: provider_error — no server_ready on de_dust2 within 180 s; it never got ready (dathost, build 1.41.9.2): "two" … "three"',
    )
  })
})
