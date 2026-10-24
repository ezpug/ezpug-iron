import { describe, expect, it } from 'vitest'
import { createTestApp, type TestApp, type TestAppOptions } from '../http/testing'
import type { GameServerProvider } from '../providers/provider'
import { NO_TOKEN_LINE } from './github'
import { GAME_PINS } from './pins'
import { GAME_WATCH_INTERVAL_MS } from './watcher'

/**
 * **The build watcher** (PRD-10 T2). What is proved here is the shape of
 * the round's promise — a CS2 update is a version fact with a time, seen
 * before a player does:
 *
 * - a build move is **one** fact, **one** issue, and every provider's
 *   canary flips to `unproven` on the health route the platform polls;
 * - the same build seen again is nothing;
 * - without a token the fact and the health move and the log says why no
 *   issue was filed;
 * - an upstream release newer than the pin is one fact and one comment on
 *   the build's issue;
 * - a silent Valve with a moved mirror takes the id from a server that can
 *   be asked, and a provider with its own reading follows it, not Steam.
 *
 * The world is the test app's: scripted feeds, the sim provider, a fake
 * clock. Nothing here reaches Valve or GitHub.
 */

const TOKEN = 'ghp_fake-token-for-the-watcher-tests'

interface Rig {
  app: TestApp
  secret: string
  providers: () => Promise<Record<string, unknown>[]>
  game: () => Promise<Record<string, unknown>>
}

async function createRig(options: TestAppOptions = {}): Promise<Rig> {
  const app = createTestApp(options)
  const minted = await app.keys.mint({
    name: 'operator',
    scopes: ['fleet', 'admin'],
    budget: { maxConcurrentServers: 1, maxServerLifetimeMinutes: 60, monthlyCents: 0 },
    webhookSecrets: [],
  })
  return {
    app,
    secret: minted.secret,
    providers: async () =>
      (await app.request('/v1/fleet/providers', { key: minted.secret })).body.providers,
    game: async () => (await app.request('/v1/fleet/game', { key: minted.secret })).body,
  }
}

const moveFacts = (facts: { type: string }[]) => facts.filter(f => f.type === 'game.build_moved')

describe('the build watcher', () => {
  it('starts from nothing: no build, both canaries unproven, no fact yet', async () => {
    const rig = await createRig()
    const providers = await rig.providers()
    expect(providers[0]?.game).toEqual({
      build: null,
      stack: null,
      canary: { state: 'unproven', build: null, since: null, reason: null },
      hud: { state: 'unproven', build: null, since: null, reason: null },
    })
    const game = await rig.game()
    expect(game.build).toBeNull()
    expect(game.recent).toEqual([])
    expect(game.upstream).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: 'roflmuffin/CounterStrikeSharp',
          pinned: GAME_PINS.counterStrikeSharp,
        }),
      ]),
    )
  })

  it('a build move writes one fact, files one issue, and flips every provider to unproven', async () => {
    const rig = await createRig({ githubToken: TOKEN })
    const { app, feeds } = { app: rig.app, feeds: rig.app.feeds }
    const first = await app.game.tick()
    // The first reading of a fresh deployment is a move from nothing.
    expect(first.moved).toEqual({ from: null, to: '1.41.9.2' })
    expect(feeds.issues).toHaveLength(1)
    expect(feeds.issues[0]?.title).toBe('CS2 build 1.41.9.2')

    feeds.setBuild('1.41.9.3', '26200000')
    await app.advance(60_000)
    const report = await app.game.tick()
    expect(report.moved).toEqual({ from: '1.41.9.2', to: '1.41.9.3' })

    const game = await rig.game()
    const moves = moveFacts(game.recent as { type: string }[])
    expect(moves).toHaveLength(2)
    expect(moves[0]).toMatchObject({
      type: 'game.build_moved',
      from: '1.41.9.2',
      to: '1.41.9.3',
      steamBuildId: '26200000',
      sourceRevision: null,
      observedAt: app.clock.date().toISOString(),
      pins: GAME_PINS,
    })
    expect(game.build).toMatchObject({ id: '1.41.9.3', steamBuildId: '26200000' })

    expect(feeds.issues).toHaveLength(2)
    expect(feeds.issues[1]).toMatchObject({ number: 2, title: 'CS2 build 1.41.9.3' })
    expect(feeds.issues[1]?.body).toContain('`1.41.9.2`')
    expect(feeds.issues[1]?.body).toContain(
      `counterStrikeSharp: \`${GAME_PINS.counterStrikeSharp}\``,
    )
    expect(feeds.issues[1]?.body).not.toContain(TOKEN)
    expect(app.gameStore.rows.builds.find(b => b.build === '1.41.9.3')).toMatchObject({
      issueNumber: 2,
      issueUrl: 'https://github.com/ezpug/ezpug-iron/issues/2',
    })

    const providers = await rig.providers()
    expect(providers).toHaveLength(1)
    const since = app.clock.date().toISOString()
    expect(providers[0]).toMatchObject({
      id: 'sim',
      healthy: true,
      game: {
        build: { id: '1.41.9.3', since },
        canary: { state: 'unproven', build: '1.41.9.3', since, reason: null },
        hud: { state: 'unproven', build: '1.41.9.3', since, reason: null },
      },
    })
    // The token went on the wire and nowhere else.
    expect(app.log.lines.join('\n')).not.toContain(TOKEN)
    expect(JSON.stringify(game)).not.toContain(TOKEN)
  })

  it('the same build seen again writes nothing', async () => {
    const rig = await createRig({ githubToken: TOKEN })
    const { app } = rig
    await app.game.tick()
    const before = await rig.game()
    const issues = app.feeds.issues.length
    const posts = app.feeds.calls.filter(call => call.startsWith('POST')).length

    await app.advance(GAME_WATCH_INTERVAL_MS)
    const report = await app.game.tick()
    expect(report.moved).toBeNull()
    await app.advance(GAME_WATCH_INTERVAL_MS)
    await app.game.tick()

    const after = await rig.game()
    expect(moveFacts(after.recent as { type: string }[])).toHaveLength(1)
    expect(after.providers).toEqual(before.providers)
    expect(app.feeds.issues).toHaveLength(issues)
    expect(app.feeds.calls.filter(call => call.startsWith('POST'))).toHaveLength(posts)
    expect(app.gameStore.rows.builds).toHaveLength(1)
  })

  it('without a token the fact and the health move and the log says no issue was filed', async () => {
    const rig = await createRig()
    const { app } = rig
    const report = await app.game.tick()
    expect(report.moved).toEqual({ from: null, to: '1.41.9.2' })
    expect(app.feeds.issues).toHaveLength(0)
    expect(app.feeds.calls.some(call => call.startsWith('POST'))).toBe(false)
    expect(app.log.lines.some(line => line.includes(NO_TOKEN_LINE))).toBe(true)
    const providers = await rig.providers()
    expect(providers[0]).toMatchObject({
      game: { build: { id: '1.41.9.2' }, canary: { state: 'unproven', build: '1.41.9.2' } },
    })
    expect(app.gameStore.rows.builds[0]).toMatchObject({ issueNumber: null, issueUrl: null })
  })

  it('an upstream release newer than the pin is one fact and one comment on the build’s issue', async () => {
    const rig = await createRig({ githubToken: TOKEN })
    const { app } = rig
    app.feeds.setRelease('roflmuffin/CounterStrikeSharp', {
      tag: `v${GAME_PINS.counterStrikeSharp}`,
      publishedAt: '2026-10-23T14:22:56Z',
    })
    app.feeds.setRelease('Source2ZE/MultiAddonManager', {
      tag: 'v1.7.1',
      name: 'v1.7.1',
      publishedAt: '2026-10-23T23:12:21Z',
    })
    const first = await app.game.tick()
    expect(first.released.map(r => `${r.repo}@${r.version}`)).toEqual([
      'Source2ZE/MultiAddonManager@1.7.1',
    ])
    expect(app.feeds.comments).toHaveLength(1)
    expect(app.feeds.comments[0]).toMatchObject({ number: 1 })
    expect(app.feeds.comments[0]?.body).toContain('Source2ZE/MultiAddonManager `1.7.1`')
    expect(app.feeds.comments[0]?.body).toContain(`pins \`${GAME_PINS.multiAddonManager}\``)

    const game = await rig.game()
    expect(game.recent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'game.upstream_released',
          repo: 'Source2ZE/MultiAddonManager',
          version: '1.7.1',
          pinned: GAME_PINS.multiAddonManager,
          publishedAt: '2026-10-23T23:12:21Z',
        }),
      ]),
    )
    expect(game.upstream).toEqual(
      expect.arrayContaining([
        {
          repo: 'Source2ZE/MultiAddonManager',
          pinned: GAME_PINS.multiAddonManager,
          latest: '1.7.1',
          publishedAt: '2026-10-23T23:12:21Z',
        },
        {
          repo: 'roflmuffin/CounterStrikeSharp',
          pinned: GAME_PINS.counterStrikeSharp,
          latest: null,
          publishedAt: null,
        },
        {
          repo: 'alliedmodders/metamod-source',
          pinned: GAME_PINS.metamod,
          latest: null,
          publishedAt: null,
        },
      ]),
    )

    // Seen again: nothing. A newer one: one more.
    await app.advance(GAME_WATCH_INTERVAL_MS)
    const again = await app.game.tick()
    expect(again.released).toEqual([])
    expect(app.feeds.comments).toHaveLength(1)
    app.feeds.setMetamod('2.0.0-git1490')
    await app.advance(GAME_WATCH_INTERVAL_MS)
    const metamod = await app.game.tick()
    expect(metamod.released.map(r => r.version)).toEqual(['2.0.0-git1490'])
    expect(app.feeds.comments).toHaveLength(2)
  })

  it('a silent Valve with a moved mirror takes the id from a server that can be asked', async () => {
    const asked: GameServerProvider = {
      id: 'rented',
      offerings: async () => [],
      allocate: () => Promise.reject(new Error('not in this test')),
      configure: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      status: async () => ({ state: 'gone' }),
      deallocate: async () => undefined,
      list: async () => [],
      gameBuild: async () => ({ id: reading.id, sourceRevision: reading.rev }),
      stack: async () => 'template-abc1234',
    }
    const reading = { id: '1.41.9.2', rev: '11162119' }
    const rig = await createRig({ providers: [asked] })
    const { app } = rig
    const first = await app.game.tick()
    expect(first.moved).toEqual({ from: null, to: '1.41.9.2' })
    expect(app.gameStore.rows.builds[0]).toMatchObject({
      steamBuildId: '26144732',
      sourceRevision: '11162119',
    })
    expect((await rig.providers())[0]).toMatchObject({
      id: 'rented',
      game: { build: { id: '1.41.9.2' }, stack: 'template-abc1234' },
    })

    // Valve goes quiet, Steam's buildid moves, the template still says the old build: wait.
    app.feeds.silence({ valve: true })
    app.feeds.setBuild('1.41.9.3', '26200000')
    await app.advance(GAME_WATCH_INTERVAL_MS)
    const waiting = await app.game.tick()
    expect(waiting.moved).toBeNull()
    expect(app.log.lines.some(line => line.includes('no server can be asked yet'))).toBe(true)

    // The template updated: its reading is the id.
    reading.id = '1.41.9.3'
    reading.rev = '11170000'
    await app.advance(GAME_WATCH_INTERVAL_MS)
    const moved = await app.game.tick()
    expect(moved.moved).toEqual({ from: '1.41.9.2', to: '1.41.9.3' })
    expect(app.gameStore.rows.builds.find(b => b.build === '1.41.9.3')).toMatchObject({
      steamBuildId: '26200000',
      sourceRevision: '11170000',
    })
  })

  it('a provider with its own reading follows it, not Steam', async () => {
    const own: GameServerProvider = {
      id: 'rented',
      offerings: async () => [],
      allocate: () => Promise.reject(new Error('not in this test')),
      configure: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      status: async () => ({ state: 'gone' }),
      deallocate: async () => undefined,
      list: async () => [],
      gameBuild: async () => ({ id: '1.41.9.2', sourceRevision: null }),
    }
    const rig = await createRig({ providers: [own] })
    const { app } = rig
    await app.game.tick()
    const before = (await rig.providers())[0] as { game: { canary: { since: string } } }
    app.feeds.setBuild('1.41.9.3')
    await app.advance(GAME_WATCH_INTERVAL_MS)
    const report = await app.game.tick()
    // The world moved — one fact — but this provider's servers have not.
    expect(report.moved).toEqual({ from: '1.41.9.2', to: '1.41.9.3' })
    const after = (await rig.providers())[0] as {
      game: { build: { id: string }; canary: { since: string; build: string } }
    }
    expect(after.game.build.id).toBe('1.41.9.2')
    expect(after.game.canary).toMatchObject({ build: '1.41.9.2', since: before.game.canary.since })
    expect((await rig.game()).build).toMatchObject({ id: '1.41.9.3' })
  })

  it('a world with every feed silent changes nothing and names what was silent', async () => {
    const rig = await createRig()
    const { app } = rig
    await app.game.tick()
    app.feeds.silence({ valve: true, steamcmd: true, github: true })
    await app.advance(GAME_WATCH_INTERVAL_MS)
    const report = await app.game.tick()
    expect(report.moved).toBeNull()
    expect(report.build).toBe('1.41.9.2')
    expect(report.problems.join('\n')).toContain("Valve's update check: answered 503")
    expect(report.problems.join('\n')).toContain('the steamcmd mirror: answered 503')
    expect(moveFacts((await rig.game()).recent as { type: string }[])).toHaveLength(1)
  })

  it('backs off GitHub until the rate limit it names lifts', async () => {
    const rig = await createRig()
    const { app } = rig
    const reset = app.clock.now() + 30 * 60_000
    app.feeds.rateLimitUntil(reset)
    app.feeds.setRelease('Source2ZE/MultiAddonManager', { tag: 'v1.7.1' })
    const refused = await app.game.tick()
    expect(refused.released).toEqual([])
    expect(refused.problems.join('\n')).toContain("GitHub's rate limit (403)")
    const asks = () => app.feeds.calls.filter(call => call.includes('/releases/latest')).length
    const before = asks()

    await app.advance(GAME_WATCH_INTERVAL_MS)
    const paused = await app.game.tick()
    expect(asks()).toBe(before)
    expect(paused.problems.join('\n')).toContain('rate limit lifts at')

    await app.advance(GAME_WATCH_INTERVAL_MS)
    app.feeds.rateLimitUntil(null)
    const resumed = await app.game.tick()
    expect(asks()).toBeGreaterThan(before)
    expect(resumed.released.map(r => r.version)).toEqual(['1.7.1'])
  })

  it('ticks on the clock once started, and not before', async () => {
    const rig = await createRig()
    const { app } = rig
    app.game.start()
    await app.advance(GAME_WATCH_INTERVAL_MS - 1)
    expect(app.gameStore.rows.builds).toHaveLength(0)
    await app.advance(1)
    await app.settle()
    expect(app.gameStore.rows.builds).toHaveLength(1)
    await app.game.stop()
    app.feeds.setBuild('1.41.9.3')
    await app.advance(GAME_WATCH_INTERVAL_MS * 2)
    expect(app.gameStore.rows.builds).toHaveLength(1)
  })

  it('serves the game to the fleet scope and refuses the matches scope', async () => {
    const rig = await createRig()
    const matchesOnly = await rig.app.keys.mint({
      name: 'platform',
      scopes: ['matches'],
      budget: { maxConcurrentServers: 1, maxServerLifetimeMinutes: 60, monthlyCents: 0 },
      webhookSecrets: [],
    })
    const refused = await rig.app.request('/v1/fleet/game', { key: matchesOnly.secret })
    expect(refused.status).toBe(403)
    const allowed = await rig.app.request('/v1/fleet/game', { key: rig.secret })
    expect(allowed.status).toBe(200)
  })
})
