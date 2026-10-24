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
  /** The servers whose `hello` said `hud`, as the link would have heard it. */
  saidHud: Set<string>
}

async function createRig(options: { hudAddon?: boolean } = {}): Promise<Rig> {
  const saidHud = new Set<string>()
  const app = createTestApp({
    noProviders: true,
    githubToken: TOKEN,
    hudAddon: options.hudAddon ?? true,
    capabilities: server => (saidHud.has(server.serverId) ? ['hud'] : []),
  })
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
    saidHud,
  }
  return rig
}

/** Play a booted canary match through: ready, the bots-only start, live, one round. */
async function playRound(rig: Rig, matchId: string, serverId: string): Promise<void> {
  await rig.say(matchId, serverId, { type: 'server_ready', map: 'de_dust2' })
  await rig.poll()
  await rig.poll()
  await rig.say(matchId, serverId, { type: 'going_live', mapNumber: 1, map: 'de_dust2' })
  await rig.poll()
  await rig.poll()
  await rig.say(matchId, serverId, {
    type: 'round_end',
    mapNumber: 1,
    roundNumber: 1,
    winner: { team: 'team_a', side: 'ct' },
    winCondition: 'elimination',
    score: { teamA: 1, teamB: 0 },
  })
  await rig.poll()
}

/** The open `hud` canary run, with its Dathost server. */
async function hudRun(rig: Rig): Promise<{ matchId: string; serverId: string }> {
  const run = rig.app.canaries.runs().find(candidate => candidate.hud && !candidate.finishedAt)
  if (!run) throw new Error('no hud canary is playing')
  const serverId = (await rig.app.store.findMatch(run.matchId))?.serverId
  if (!serverId) throw new Error('the hud canary has no server yet')
  return { matchId: run.matchId, serverId }
}

/** A match a player would sit in, on Dathost, through the operator's key. */
async function realMatch(rig: Rig, clientMatchId: string): Promise<string> {
  const operator = (await rig.app.keys.list()).find(key => key.name === 'operator')
  const key = await rig.app.keys.get(operator?.id ?? '')
  if (!key) throw new Error('no operator key')
  const { match } = await rig.app.matches.create(key, {
    clientMatchId,
    game: 'cs2',
    gamemode: 'pug',
    teams: { teamA: { name: 'A', players: [] }, teamB: { name: 'B', players: [] } },
    maps: [{ map: 'de_dust2', sides: 'ct' }],
    requirements: { provider: DATHOST_PROVIDER_ID },
    callbacks: { webhookUrl: 'https://webhooks.invalid/platform', webhookSecretId: 'whsec' },
    ttlMinutes: 60,
  } as never)
  await rig.app.settle()
  return (await rig.app.store.findMatch(match.id))?.serverId ?? ''
}

/** What `configure` put on a server: the loader file, and the id in `ezpug.json`. */
function hudOn(rig: Rig, serverId: string): { loader: boolean; id: unknown } {
  const server = rig.fake.server(serverId)
  return {
    loader: server?.files.has(HUD_ADDON_LOADER_PATH) ?? false,
    id: JSON.parse(server?.files.get('ezpug.json') ?? '{}').hudAddon,
  }
}

/** Boot the clone: the fake vendor's thirty seconds of `booting`. */
const boot = (rig: Rig) => rig.app.advance(30_000)

const canaryOf = (providers: Record<string, unknown>[]) =>
  (providers.find(p => p.id === DATHOST_PROVIDER_ID) as { game: { canary: unknown } }).game
    .canary as { state: string; build: string | null; reason: string | null }

const hudOf = (providers: Record<string, unknown>[]) =>
  (providers.find(p => p.id === DATHOST_PROVIDER_ID) as { game: { hud: unknown } }).game.hud as {
    state: string
    build: string | null
    reason: string | null
  }

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
    // The bots joined an emptied live map: the engine restarted the game and
    // the plugin's restore left round 1 paused for sides that never unpause.
    await rig.say(matchId, serverId, { type: 'match_paused', mapNumber: 1, kind: 'technical' })
    await rig.poll()
    const asked = await app.store.findCommand(matchId, `canary-unpause-${matchId}-1`)
    expect(asked?.commandJson).toMatchObject({ type: 'unpause' })
    // Not asked again within the gap, nor once the plugin says it is lifted.
    await rig.poll()
    expect(await app.store.findCommand(matchId, `canary-unpause-${matchId}-2`)).toBeUndefined()
    await rig.say(matchId, serverId, { type: 'match_unpaused', mapNumber: 1 })
    await app.advance(30_000)
    expect(await app.store.findCommand(matchId, `canary-unpause-${matchId}-2`)).toBeUndefined()
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
    // Walked in steps, as the time passes: one ten-minute jump of the fake
    // clock outruns the teardown it sets off.
    for (let at = 0; at < CANARY_LIFETIME_MINUTES * 60_000; at += 20_000) await app.advance(20_000)
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

describe('the HUD gate (PRD-10 T6, decision 40)', () => {
  it('runs the hud canary after a green plain one, and only its green lets the loader reach a player', async () => {
    const rig = await createRig()
    const { app } = rig
    await app.game.tick()
    await app.settle()
    const plain = await rig.canaryMatch()
    await boot(rig)
    await playRound(rig, plain.matchId, plain.serverId)
    // The next poll after the plain server is given back starts the hud one.
    await rig.poll()
    await app.settle()
    expect(canaryOf(await rig.providers()).state).toBe('green')

    // The plain canary's green is the hud canary's start, unattended.
    const hudStarted = app.gameStore.rows.facts.filter(
      f => f.fact.type === 'game.canary_started' && f.fact.hud,
    )
    expect(hudStarted.map(f => f.fact)).toEqual([
      expect.objectContaining({ build: BUILD, attempt: 1, cause: 'build_moved' }),
    ])
    expect(hudOf(await rig.providers())).toMatchObject({ state: 'unproven', build: BUILD })
    // While it plays, a player's server is still served without the loader.
    expect(hudOn(rig, await realMatch(rig, 'before-the-hud-canary'))).toEqual({
      loader: false,
      id: undefined,
    })

    const hud = await hudRun(rig)
    expect(hudOn(rig, hud.serverId)).toEqual({ loader: true, id: HUD_ADDON })
    await boot(rig)
    // MultiAddonManager 1.7's word for it; 1.6.2 said "Steam API Activated".
    rig.fake.say(hud.serverId, '[MultiAddonManager] Logged on to Steam')
    rig.saidHud.add(hud.serverId)
    await playRound(rig, hud.matchId, hud.serverId)

    const providers = await rig.providers()
    expect(hudOf(providers)).toMatchObject({ state: 'green', build: BUILD, reason: null })
    expect(providers.find(p => p.id === DATHOST_PROVIDER_ID)).toMatchObject({ healthy: true })
    expect(app.feeds.comments.map(c => c.body)).toEqual([
      expect.stringContaining('**Canary green** — canary on dathost'),
      expect.stringContaining('**Canary green** — hud canary on dathost'),
    ])
    // Green: a player's server carries both, so its hello will say `hud`.
    expect(hudOn(rig, await realMatch(rig, 'after-the-hud-canary'))).toEqual({
      loader: true,
      id: HUD_ADDON,
    })
  })

  it('is red when the hello lacks hud or MultiAddonManager never woke, and the loader stays off', async () => {
    const rig = await createRig()
    const { app } = rig
    await app.game.tick()
    await app.settle()
    const plain = await rig.canaryMatch()
    await boot(rig)
    await playRound(rig, plain.matchId, plain.serverId)
    // The next poll after the plain server is given back starts the hud one.
    await rig.poll()
    await app.settle()

    // Attempt 1: the server played, but its hello never said `hud`.
    const first = await hudRun(rig)
    await boot(rig)
    rig.fake.say(first.serverId, '[MultiAddonManager] Steam API Activated')
    await playRound(rig, first.matchId, first.serverId)
    let hud = hudOf(await rig.providers())
    expect(hud.state).toBe('red')
    expect(hud.reason).toMatch(/^the server played a round but its hello did not say hud/)
    expect(hud.reason).toContain('(dathost, build 1.41.9.2)')
    expect((await app.store.findMatch(first.matchId))?.state).not.toBe('live')

    // Attempt 2, on demand: `hud` said, but no word from MultiAddonManager.
    const asked = await app.canaries.play({
      provider: DATHOST_PROVIDER_ID,
      hud: true,
      cause: 'demand',
    })
    expect(asked).toMatchObject({ attempt: 2 })
    await app.settle()
    const second = await hudRun(rig)
    rig.saidHud.add(second.serverId)
    await boot(rig)
    await playRound(rig, second.matchId, second.serverId)
    hud = hudOf(await rig.providers())
    expect(hud.state).toBe('red')
    expect(hud.reason).toMatch(/MultiAddonManager never said it reached Steam/)

    // The build is served — the plain canary is green — and without the loader.
    expect(canaryOf(await rig.providers()).state).toBe('green')
    expect(hudOn(rig, await realMatch(rig, 'on-a-red-hud'))).toEqual({
      loader: false,
      id: undefined,
    })
  })

  it('has nothing to prove without an addon id: no hud canary follows, and one asked for is refused', async () => {
    const rig = await createRig({ hudAddon: false })
    const { app } = rig
    await app.game.tick()
    await app.settle()
    const plain = await rig.canaryMatch()
    await boot(rig)
    await playRound(rig, plain.matchId, plain.serverId)
    // The next poll after the plain server is given back starts the hud one.
    await rig.poll()
    await app.settle()
    expect(canaryOf(await rig.providers()).state).toBe('green')
    expect(app.canaries.runs().filter(run => run.hud)).toEqual([])
    const asked = await app.request('/v1/fleet/game/canary', {
      method: 'POST',
      key: rig.operator,
      json: { provider: DATHOST_PROVIDER_ID, hud: true },
    })
    expect(asked.body.error).toMatchObject({ code: 'invalid_state' })
    expect(asked.body.error.message).toMatch(/EZPUG_IRON_HUD_ADDON/)
  })
})
