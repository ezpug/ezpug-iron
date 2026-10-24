import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createFakeClock, systemClock } from '@ezpug/core'
import { eventually } from '@ezpug/core/testing'
import type { GameserverEvent } from '@ezpug/match-api'
import { createFakeServer, type FakeServer } from '@ezpug/protocol/fake-server'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type OrchestratorConfig, readDatabaseConfig, readOrchestratorConfig } from './config'
import { createDatabase } from './db/client'
import { gsltTokens } from './db/schema'
import { sweepTestNamespace, testNamespace } from './db/testing'
import { loadRootEnv } from './env'
import { CANARY_LOADER_QUESTION, CANARY_POLL_MS } from './game/canary'
import { createFakeFeeds, type FakeFeeds } from './game/fake-feeds'
import { GAME_PINS } from './game/pins'
import { GSLT_MEMO_PREFIX } from './gslt/pool'
import { createMemoryLog } from './log'
import { createOrchestrator, type Orchestrator } from './orchestrator'
import { createFakeDathost, type FakeDathost } from './providers/dathost/fake'
import { DATHOST_PROVIDER_ID } from './providers/dathost/provider'

/**
 * **The move, rehearsed end to end** (PRD-10 T9) — the round's closing
 * checkpoint: a CS2 update walked from Valve's first word to the follow
 * verb's plan, with nobody's hand on it and nothing rented.
 *
 * The orchestrator is composed as `main.ts` composes it, over the dev
 * world's Postgres and Redis, on a **fake clock**: the watcher's own loop
 * ticks when fifteen clock minutes have passed, the canary's poll when five
 * seconds have. Steam and GitHub are the scripted feeds
 * (`game/fake-feeds.ts`), Dathost is the fake vendor (the clones' consoles,
 * the template's `steam.inf`), and each clone's plugin is a fake server
 * dialling `/link` on the real port with the token its `ezpug.json` carries
 * — so the `hud` a hello says is the link's, not a test's override.
 *
 * The story, in the order the PRD tells it:
 *
 * 1. Steam's public build moves (and Dathost's template with it, the vendor
 *    updating its own servers) → within one watcher tick: one
 *    `game.build_moved` fact, one issue on the fake GitHub, and every
 *    provider reads `unproven` in `GET /v1/fleet/providers`.
 * 2. The canary plays unattended on the provider that updates itself and
 *    reads `green`; the `hud` canary follows it unattended, its clone
 *    carrying the loader, its hello saying `hud`, MultiAddonManager
 *    answering for itself → `green`. The issue hears two comments.
 *    The PRD names the sim here; the sim is never updated by anyone, so no
 *    canary plays on it unattended (decision 38) and it stays `unproven` —
 *    the Dathost path is the one a real update takes, and the one rehearsed.
 * 3. A release feed offers a fictional CounterStrikeSharp patch with a
 *    "Game Update" title → `game:follow --auto --dry-run` prints the plan it
 *    would run and names the policy that allowed it; a minor of
 *    CounterStrikeSharp and of MultiAddonManager print "waiting for a
 *    human".
 *
 * Skips loudly when the dev world is down; `EZPUG_IRON_DATABASE_TESTS=required`
 * (what `pnpm verify:extended` sets) makes that red.
 */

const namespace = testNamespace(import.meta.url)
/** This suite's own host, which the GSLT memo names (`gslt/pool.ts`). */
const HOST = `${namespace}.test:3430`
const REPO = fileURLToPath(new URL('../../../', import.meta.url))

const DATHOST_EMAIL = 'rehearsal@ezpug.test'
const DATHOST_PASSWORD = 'not-a-real-dathost-password'
const GITHUB_TOKEN = 'ghp_fake-token-for-the-rehearsal'
const HUD_ADDON = '3561234567'
/** Tonight's build, and the fictional one Valve ships during the rehearsal. */
const TONIGHT = '1.41.9.2'
const MOVED = '1.41.9.3'
const MOVED_STEAM_BUILD = '26200001'
const STEAM_INF = (build: string, revision: string) =>
  [`PatchVersion=${build}`, 'ProductName=cs2', `SourceRevision=${revision}`, ''].join('\r\n')
/** CounterStrikeSharp's metamod-source submodule at 1.0.378, which the fictional patch keeps. */
const SUBMODULE = '170058a2f0dbd58106b7c76bfe88a94672295356'

/** The next patch and the next minor of a pinned `a.b.c` (or `a.b`), so the story outlives a bump. */
function nextPatch(version: string): string {
  const [a, b, c = '0'] = version.split('.')
  return `${a}.${b}.${Number(c) + 1}`
}
function nextMinor(version: string): string {
  const [a, b] = version.split('.')
  return `${a}.${Number(b) + 1}`
}

let orchestrator: Orchestrator | undefined
let config: OrchestratorConfig | undefined
let feeds: FakeFeeds
let dathost: FakeDathost
let url = ''
let operator = ''
let unavailable: string | undefined
const clock = createFakeClock({ start: '2026-10-25T18:00:00.000Z' })
const log = createMemoryLog()
const plugins: FakeServer[] = []

async function createTemplate(fake: FakeDathost): Promise<string> {
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
  const response = await fake.fetch('https://dathost.net/api/0.1/game-servers', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${DATHOST_EMAIL}:${DATHOST_PASSWORD}`).toString('base64')}`,
    },
    body: form,
  })
  if (!response.ok) throw new Error(`the fake Dathost refused the template: ${response.status}`)
  return String(((await response.json()) as { id: unknown }).id)
}

/**
 * The rehearsal's residue beyond the namespace sweep: the accounts the fake
 * Steam minted. Their memo names this suite's host, and the fake mints the
 * same Steam ids in every process, so a second run would collide with them.
 */
async function sweepRehearsal(database: OrchestratorConfig['database']): Promise<void> {
  await sweepTestNamespace(database, namespace)
  const cleanup = createDatabase(database, { applicationName: 'ezpug-iron-test-cleanup' })
  try {
    await cleanup.db.delete(gsltTokens).where(eq(gsltTokens.memo, `${GSLT_MEMO_PREFIX} ${HOST}`))
  } finally {
    await cleanup.close()
  }
}

beforeAll(async () => {
  loadRootEnv()
  try {
    feeds = createFakeFeeds({
      clock,
      build: TONIGHT,
      token: GITHUB_TOKEN,
      // Every upstream at its pin: nothing is news until the story makes it so.
      releases: {
        'roflmuffin/CounterStrikeSharp': { tag: `v${GAME_PINS.counterStrikeSharp}` },
        'Source2ZE/MultiAddonManager': { tag: `v${GAME_PINS.multiAddonManager}` },
        'ezpug/MatchZy-Enhanced': { tag: `v${GAME_PINS.matchzy}` },
      },
      metamod: GAME_PINS.metamod,
    })
    dathost = createFakeDathost({ clock, email: DATHOST_EMAIL, password: DATHOST_PASSWORD })
    dathost.setGameFiles({ 'steam.inf': STEAM_INF(TONIGHT, '11162119') })
    // MultiAddonManager's answer when the hud canary asks it, once its server is ready.
    dathost.answer(CANARY_LOADER_QUESTION, [`mm_client_extra_addons = ${HUD_ADDON}`])
    const template = await createTemplate(dathost)
    config = {
      ...readOrchestratorConfig({
        ...process.env,
        EZPUG_IRON_PROVIDERS: 'sim,dathost',
        // The test database is shared; this suite's rows and game tables are its own (T21c).
        EZPUG_IRON_DEPLOYMENT: namespace,
        // The GSLT memo names this host, so the sweep finds the accounts the fake Steam minted.
        EZPUG_IRON_BASE_URL: `http://${HOST}`,
        EZPUG_IRON_GAME_FEEDS_URL: 'http://fake-feeds.invalid',
        EZPUG_IRON_GITHUB_TOKEN: GITHUB_TOKEN,
        EZPUG_IRON_HUD_ADDON: HUD_ADDON,
        EZPUG_IRON_HUD_ADDON_NODES: '',
        // The box's `.env` carries the real account; nothing here may reach it.
        EZPUG_IRON_DATHOST_EMAIL: DATHOST_EMAIL,
        EZPUG_IRON_DATHOST_PASSWORD: DATHOST_PASSWORD,
        EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID: template,
        EZPUG_IRON_STEAM_FAKE_TOKENS: 'true',
        EZPUG_IRON_STEAM_WEB_API_KEY: '',
        STEAM_WEB_API_KEY: '',
        EZPUG_IRON_GAME_WATCH_INTERVAL_MS: '',
      }),
      database: readDatabaseConfig(process.env, { target: 'test' }),
    }
    orchestrator = createOrchestrator({
      config,
      clock,
      log,
      gameFetch: feeds.fetch,
      dathostFetch: dathost.fetch,
    })
    await orchestrator.database.ping()
    await orchestrator.redis.ping()
    const { runMigrations } = await import('./db/migrate')
    await runMigrations(orchestrator.database)
    await sweepRehearsal(config.database)
    // Tonight, as production stands: the build known, Dathost green on both canaries.
    const tonight = clock.date()
    await orchestrator.gameStore.insertBuild({
      build: TONIGHT,
      steamBuildId: '26144732',
      sourceRevision: '11162119',
      observedAt: tonight,
      issueNumber: null,
      issueUrl: null,
    })
    const green = {
      state: 'green' as const,
      build: TONIGHT,
      since: tonight.toISOString(),
      reason: null,
    }
    for (const provider of ['sim', DATHOST_PROVIDER_ID])
      await orchestrator.gameStore.upsertProviderState({
        provider,
        build: TONIGHT,
        buildSince: tonight,
        stack: null,
        canary: provider === 'sim' ? { ...green, state: 'unproven', since: null } : green,
        hud: provider === 'sim' ? { ...green, state: 'unproven', since: null } : green,
        updatedAt: tonight,
      })
    await orchestrator.start()
    url = (await orchestrator.listen({ port: 0, host: '127.0.0.1' })).url
    operator = (
      await orchestrator.keys.mint({
        name: `${namespace}-operator`,
        scopes: ['matches', 'fleet', 'admin'],
        budget: { maxConcurrentServers: 2, maxServerLifetimeMinutes: 60, monthlyCents: 10_000 },
        webhookSecrets: [{ id: 'whsec', secret: 'a-webhook-secret-of-at-least-32-chars!' }],
      })
    ).secret
  } catch (error) {
    unavailable = error instanceof Error ? error.message : String(error)
    await orchestrator?.database.close().catch(() => {})
    await orchestrator?.redis.close().catch(() => {})
    orchestrator = undefined
    if (process.env.EZPUG_IRON_DATABASE_TESTS === 'required')
      throw new Error(`the rehearsal is required but ${unavailable}`)
    process.stderr.write(
      `\n[orchestrator] skipping the CS2 update rehearsal — ${unavailable}\n` +
        '               boot the dev world with `pnpm dev:up`.\n\n',
    )
  }
}, 60_000)

afterAll(async () => {
  for (const plugin of plugins.splice(0)) await plugin.close().catch(() => {})
  if (!orchestrator || !config) return
  if (orchestrator.server.listening) {
    // The drain waits on the clock it was given; move it while it runs.
    let closed = false
    const closing = orchestrator.close('afterAll').finally(() => {
      closed = true
    })
    while (!closed) {
      await clock.advance(1_000)
      await breathe()
    }
    await closing
  }
  await sweepRehearsal(config.database)
}, 60_000)

// ---------------------------------------------------------------------------
// Moving the world
// ---------------------------------------------------------------------------

/** A breath of real time, for the Postgres and socket round trips a fake clock cannot hurry. */
const breathe = () => systemClock.sleep(20)

/** Advance the clock a step at a time until `check` holds; the plugins stay alive meanwhile. */
async function until<T>(
  what: string,
  check: () => Promise<T | undefined | null | false>,
  options: { stepMs?: number; maxMs?: number } = {},
): Promise<T> {
  const step = options.stepMs ?? CANARY_POLL_MS
  const budget = options.maxMs ?? 10 * 60_000
  for (let moved = 0; ; moved += step) {
    for (let i = 0; i < 5; i += 1) {
      const value = await check()
      if (value) return value
      await breathe()
    }
    if (moved >= budget)
      throw new Error(
        `${what}: not after ${budget / 60_000} clock minutes; the log's last lines:\n${log.lines.slice(-25).join('\n')}`,
      )
    for (const plugin of plugins) if (plugin.connected()) plugin.heartbeat()
    await clock.advance(step)
  }
}

async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${url}${path}`, {
    headers: { authorization: `Bearer ${operator}` },
  })
  expect(response.status, `GET ${path}`).toBe(200)
  return (await response.json()) as T
}

type Verdict = { state: string; build: string | null; reason: string | null }
type ProviderRead = {
  id: string
  healthy: boolean
  game?: { build: { id: string } | null; canary: Verdict; hud: Verdict }
}
const providers = async () =>
  (await read<{ providers: ProviderRead[] }>('/v1/fleet/providers')).providers
const providerOf = async (id: string) => (await providers()).find(p => p.id === id)

type FleetGame = {
  build: { id: string } | null
  upstream: { repo: string; pinned: string; latest: string | null; publishedAt: string | null }[]
  recent: Record<string, unknown>[]
}

/**
 * Play the canary match that is starting on Dathost the way a server would:
 * the clone boots, its plugin dials with the token the provider planted,
 * says ready; the canary's start steps go down the console door; the match
 * goes live and a round is played. The canary ends it.
 */
async function playCanary(hud: boolean): Promise<void> {
  const o = orchestrator as Orchestrator
  const { matchId, serverId } = await until(`the ${hud ? 'hud ' : ''}canary's clone`, async () => {
    const run = o.canaries.runs().find(r => r.hud === hud && r.finishedAt === null)
    if (!run) return null
    const match = await o.store.findMatch(run.matchId)
    const serverId = match?.serverId
    if (!serverId || !dathost.server(serverId)?.files.has('ezpug.json')) return null
    return { matchId: run.matchId, serverId }
  })
  const files = dathost.server(serverId)?.files
  const sidecar = JSON.parse(files?.get('ezpug.json') ?? '{}') as {
    token: string
    hudAddon?: string
  }
  // The gate: only the hud canary's clone carries the loader before its verdict.
  expect(sidecar.hudAddon, 'the addon id on the canary clone').toBe(hud ? HUD_ADDON : undefined)

  await clock.advance(30_000) // the fake vendor's boot
  const plugin = createFakeServer({
    url: `${url.replace(/^http/, 'ws')}/link`,
    token: sidecar.token,
    // What the real plugin says when the id and the loader file reached it.
    hello: hud
      ? { capabilities: ['positions', 'chat', 'playerCommands', 'widget', 'backups', 'hud'] }
      : {},
  })
  plugins.push(plugin)
  await plugin.connect()
  await until('the assignment', async () => plugin.assignment())
  const source = { provider: DATHOST_PROVIDER_ID, serverId }
  const say = (event: Record<string, unknown>) =>
    plugin.emit({ matchId, source, ...event } as GameserverEvent)
  const consoleSays = (command: string) => async () =>
    dathost.server(serverId)?.console.includes(command)
  await say({ type: 'server_ready', map: 'de_dust2' })
  // The bots-only start goes down the console door, one step a poll (`canary.ts`):
  // emptied and started while ready, filled and out of warmup once live.
  await until('the canary’s css_start', consoleSays('css_start'))
  if (hud) await until('the loader asked for itself', consoleSays(CANARY_LOADER_QUESTION))
  await say({ type: 'going_live', mapNumber: 1, map: 'de_dust2' })
  await until('the canary’s mp_warmup_end', consoleSays('mp_warmup_end'))
  await say({
    type: 'round_end',
    mapNumber: 1,
    roundNumber: 1,
    winner: { team: 'team_a', side: 'ct' },
    winCondition: 'elimination',
    score: { teamA: 1, teamB: 0 },
  })
  await until(`the ${hud ? 'hud ' : ''}canary’s verdict`, async () =>
    o.canaries.runs().find(r => r.matchId === matchId && r.finishedAt !== null),
  )
  await plugin.close().catch(() => {})
}

/** `scripts/game-follow.mjs`, imported as `game-follow.test.ts` does (an operator script outside the tsconfig). */
type AutoReport = {
  action: string
  specs: Record<string, string>
  waiting: { repo: string; version: string; why: string }[]
  why: string
  follow: { action: string; plan: string | null } | null
}
type FollowModule = {
  DEFAULT_ROWS: string[]
  runAuto: (options: Record<string, unknown>, deps: Record<string, unknown>) => Promise<AutoReport>
}
const modulePath = `${REPO}scripts/game-follow.mjs`

/**
 * `game:follow --auto --dry-run`, with the box's hands faked the way the
 * verb's own test fakes them — except the two reads that matter here, which
 * are real: the orchestrator's picture over HTTP, and the release by its tag
 * off the scripted feed the watcher read. A dry run touches nothing; any
 * hand that would write throws.
 */
async function followAutoDryRun(): Promise<{ report: AutoReport; lines: string[] }> {
  const follow = (await import(modulePath)) as FollowModule
  const lines: string[] = []
  const refuse = (what: string) => () => {
    throw new Error(`a dry run reached for ${what}`)
  }
  const feed = async (path: string) => {
    const response = await feeds.fetch(`http://fake-feeds.invalid${path}`, {
      headers: { authorization: `Bearer ${GITHUB_TOKEN}` },
    })
    return response.status === 404 ? null : response.json()
  }
  const deps = {
    clock: { now: () => clock.now(), sleep: refuse('the clock') },
    every: refuse('a timer'),
    say: (line: string) => lines.push(line),
    env: {
      policy: 'patch',
      apiKey: operator,
      publicUrl: url,
      baseUrl: null,
      githubToken: GITHUB_TOKEN,
      githubRepo: 'ezpug/ezpug-iron',
    },
    day: clock.date().toISOString().slice(0, 10),
    tree: {
      status: () => '',
      read: (path: string) => readFileSync(`${REPO}${path}`, 'utf8'),
      write: refuse('the tree'),
      restore: refuse('the tree'),
      commit: refuse('git'),
    },
    github: {
      enabled: true,
      release: (repo: string, tag: string) => feed(`/repos/${repo}/releases/tags/${tag}`),
      // The fictional patch builds against the Metamod 1.0.378 does.
      submoduleSha: async () => SUBMODULE,
      metamodLatest: async () => GAME_PINS.metamod,
      issueFor: refuse('the issue'),
      comments: refuse('the issue'),
      comment: refuse('the issue'),
    },
    download: async (artifact: string) => ({
      sha256: 'f'.repeat(64),
      path: `/scratch/${artifact.split('/').pop()}`,
    }),
    metamodFacts: () => ({
      build: Number(GAME_PINS.metamod.split('git')[1]),
      commits: [SUBMODULE.slice(0, 7)],
    }),
    run: refuse('a command'),
    lane: {
      read: () => null,
      take: refuse('the lane'),
      refresh: refuse('the lane'),
      release: refuse('the lane'),
    },
    orchestrator: {
      game: () => read<FleetGame>('/v1/fleet/game'),
      canary: refuse('a canary'),
    },
  }
  const report = await follow.runAuto(
    {
      specs: {},
      auto: true,
      dryRun: true,
      target: 'both',
      rows: follow.DEFAULT_ROWS,
      boots: null,
      hud: false,
      lockToken: null,
      lockWaitMs: 45 * 60_000,
      orchestrator: url,
      envFile: '.env',
      trailers: [],
      json: false,
      help: false,
    },
    deps,
  )
  return { report, lines }
}

// ---------------------------------------------------------------------------
// The rehearsal
// ---------------------------------------------------------------------------

describe('a CS2 update, rehearsed end to end (PRD-10 T9)', () => {
  it('is detected in one tick, proven by both canaries, and followed only as far as the policy allows', async () => {
    if (!orchestrator) return
    const o = orchestrator
    const intervalMs = (config as OrchestratorConfig).game.intervalMs
    expect(feeds.issues).toEqual([])

    // 1. Valve ships; Dathost updates its servers itself.
    feeds.setBuild(MOVED, MOVED_STEAM_BUILD)
    dathost.setGameFiles({ 'steam.inf': STEAM_INF(MOVED, '11170000') })
    await clock.advance(intervalMs) // one watcher tick, the loop's own
    const moved = await until('the build_moved fact', async () =>
      (await o.gameStore.listFacts(50, 'game.build_moved')).find(
        row => row.fact.type === 'game.build_moved' && row.fact.to === MOVED,
      ),
    )
    expect(moved.fact).toMatchObject({ from: TONIGHT, to: MOVED, steamBuildId: MOVED_STEAM_BUILD })
    await until('the issue', async () => feeds.issues.length > 0)
    expect(feeds.issues.map(issue => issue.title)).toEqual([
      `CS2 build ${MOVED} (source revision 11170000)`,
    ])
    // The pictures are written after the fact, in the same tick.
    await until('every picture on the new build', async () =>
      (await providers()).every(p => p.game?.build?.id === MOVED),
    )
    for (const id of ['sim', DATHOST_PROVIDER_ID]) {
      const read = await providerOf(id)
      expect(read?.game?.build?.id, `${id}'s build`).toBe(MOVED)
      expect(read?.game?.canary, `${id}'s canary`).toMatchObject({
        state: 'unproven',
        build: MOVED,
      })
      expect(read?.game?.hud, `${id}'s hud`).toMatchObject({ state: 'unproven', build: MOVED })
    }

    // 2. The canary, unattended, then the hud canary after it.
    await playCanary(false)
    await eventually(async () =>
      expect((await providerOf(DATHOST_PROVIDER_ID))?.game?.canary).toMatchObject({
        state: 'green',
        build: MOVED,
      }),
    )
    // A player's match meanwhile would carry no loader: the hud verdict is not in yet.
    expect((await providerOf(DATHOST_PROVIDER_ID))?.game?.hud.state).toBe('unproven')
    await playCanary(true)
    const dathostRead = await eventually(async () => {
      const read = await providerOf(DATHOST_PROVIDER_ID)
      expect(read?.game?.hud).toMatchObject({ state: 'green', build: MOVED, reason: null })
      return read
    })
    expect(dathostRead?.healthy).toBe(true)
    expect((await providerOf('sim'))?.game?.canary.state).toBe('unproven')
    expect(feeds.comments.map(c => `#${c.number} ${c.body.split(' — ')[0]}`)).toEqual([
      '#1 **Canary green**',
      '#1 **Canary green**',
    ])
    expect(feeds.comments[1]?.body).toContain('hud canary on dathost')
    // Both canary servers were given back.
    await until('the canary clones gone', async () =>
      dathost.servers().every(server => server.name === 'ezpug-template'),
    )

    // 3. A CounterStrikeSharp patch with a "Game Update" title.
    const patch = nextPatch(GAME_PINS.counterStrikeSharp)
    feeds.setRelease('roflmuffin/CounterStrikeSharp', {
      tag: `v${patch}`,
      name: `v${patch}`,
      publishedAt: clock.date().toISOString(),
      body: `## What's Changed\n* fix: Game Update ${MOVED} by @roflmuffin`,
    })
    await clock.advance(intervalMs)
    await until('the release on the route', async () =>
      (await read<FleetGame>('/v1/fleet/game')).upstream.find(
        u => u.repo === 'roflmuffin/CounterStrikeSharp' && u.latest === patch,
      ),
    )
    await until('the release on the issue', async () =>
      feeds.comments.at(-1)?.body.includes(`roflmuffin/CounterStrikeSharp \`${patch}\``),
    )
    const allowed = await followAutoDryRun()
    expect(allowed.lines).toContain(`auto: the policy allows css@${patch}`)
    expect(allowed.report).toMatchObject({ action: 'follow', specs: { css: patch } })
    expect(allowed.report.follow?.action).toBe('dry-run')
    expect(allowed.report.follow?.plan).toContain(
      `CounterStrikeSharp: ${GAME_PINS.counterStrikeSharp} → ${patch}`,
    )
    expect(allowed.report.follow?.plan).toContain('is a patch')

    // …and a minor of each, which wait for a human.
    const minor = `${nextMinor(GAME_PINS.counterStrikeSharp)}.0`
    const mam = nextMinor(GAME_PINS.multiAddonManager)
    feeds.setRelease('roflmuffin/CounterStrikeSharp', {
      tag: `v${minor}`,
      body: `* fix: Game Update ${MOVED}`,
    })
    feeds.setRelease('Source2ZE/MultiAddonManager', { tag: `v${mam}`, body: '* fix a crash' })
    await clock.advance(intervalMs)
    await until('both releases on the route', async () => {
      const game = await read<FleetGame>('/v1/fleet/game')
      return (
        game.upstream.some(u => u.latest === minor) && game.upstream.some(u => u.latest === mam)
      )
    })
    const waiting = await followAutoDryRun()
    expect(waiting.report.action).toBe('nothing')
    expect(waiting.report.waiting.map(w => `${w.repo}@${w.version}`)).toEqual([
      `roflmuffin/CounterStrikeSharp@${minor}`,
      `Source2ZE/MultiAddonManager@${mam}`,
    ])
    expect(waiting.lines.filter(line => line.startsWith('waiting for a human:'))).toHaveLength(2)
    expect(waiting.lines.join('\n')).toMatch(/is a minor/)

    // One issue for the whole story, every word of it a comment there.
    expect(feeds.issues).toHaveLength(1)
    expect(feeds.comments.every(c => c.number === 1)).toBe(true)
    expect(feeds.calls.some(call => call.includes('api.github.com'))).toBe(false)
  }, 180_000)
})
