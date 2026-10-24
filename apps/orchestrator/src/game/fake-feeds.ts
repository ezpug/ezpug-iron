import type { Clock } from '@ezpug/core'
import { Hono } from 'hono'
import type { FetchLike } from './feeds'

/**
 * **The scripted world the watcher reads in a test** (PRD-10 T2): Valve's
 * update check, the steamcmd mirror, GitHub's releases and issues, and
 * Metamod's drop — all four under one origin, in process, on the injected
 * clock, so that "no test needs Steam" holds for the build watcher as it
 * does for the GSLT pool (`gslt/fake-steam.ts`). `pnpm dev:up` can point
 * the orchestrator at a listening one through `EZPUG_IRON_GAME_FEEDS_URL`,
 * which is how T9's rehearsal walks a fictional build end to end.
 *
 * What it models is exactly what the watcher reads: the two Steam bodies,
 * a release per repository, the drop's file name, and the two issue
 * writes — plus the one read `pnpm game:follow` adds, a release by its tag
 * (every release a repository was ever given, for T9's rehearsal). Nothing
 * else.
 */

export interface FakeRelease {
  tag: string
  name?: string
  publishedAt?: string
  body?: string
}

export interface FakeFeedsOptions {
  clock: Clock
  /** The PatchVersion Valve reports. Default {@link FAKE_FEEDS_BUILD}. */
  build?: string
  /** Steam's buildid the mirror reports. Default {@link FAKE_FEEDS_STEAM_BUILD_ID}. */
  steamBuildId?: string
  /** The Metamod build the drop names. Default `2.0.0-git1483`. */
  metamod?: string
  /** The latest release per `owner/repo`. */
  releases?: Record<string, FakeRelease>
  /** The token issue writes must carry; any bearer is accepted when unset. */
  token?: string
}

export interface FakeIssue {
  number: number
  title: string
  body: string
}

export interface FakeFeeds {
  readonly fetch: FetchLike
  listen: (options?: { port?: number; hostname?: string }) => Promise<FakeFeedsListener>
  /** `METHOD path` for every request, in order — including the refused ones. */
  readonly calls: string[]
  readonly issues: FakeIssue[]
  readonly comments: { number: number; body: string }[]
  /** Move Steam's public build: the PatchVersion, and the mirror's buildid with it. */
  setBuild: (build: string, steamBuildId?: string) => void
  setRelease: (repo: string, release: FakeRelease | null) => void
  setMetamod: (version: string) => void
  /** Make a feed answer 503 until told otherwise. */
  silence: (feeds: { valve?: boolean; steamcmd?: boolean; github?: boolean }) => void
  /** Make GitHub refuse for rate until this instant (ms), with the headers it really sends. */
  rateLimitUntil: (untilMs: number | null) => void
}

export interface FakeFeedsListener {
  url: string
  port: number
  close: () => Promise<void>
}

export const FAKE_FEEDS_BUILD = '1.41.9.2'
export const FAKE_FEEDS_STEAM_BUILD_ID = '26144732'

/** `1.41.9.2` → `14192`, the way Valve's `required_version` says it. */
export function requiredVersionOf(build: string): number {
  return Number(build.replace(/\./g, ''))
}

export function createFakeFeeds(options: FakeFeedsOptions): FakeFeeds {
  const { clock } = options
  const state = {
    build: options.build ?? FAKE_FEEDS_BUILD,
    steamBuildId: options.steamBuildId ?? FAKE_FEEDS_STEAM_BUILD_ID,
    steamUpdatedAt: Math.floor(clock.now() / 1000),
    metamod: options.metamod ?? '2.0.0-git1483',
    releases: new Map(Object.entries(options.releases ?? {})),
    /** Every release each repository was given, for the by-tag read. */
    history: new Map(Object.entries(options.releases ?? {}).map(([repo, r]) => [repo, [r]])),
    silent: { valve: false, steamcmd: false, github: false },
    rateLimitedUntil: null as number | null,
  }
  const calls: string[] = []
  const issues: FakeIssue[] = []
  const comments: { number: number; body: string }[] = []

  const app = new Hono()
  app.use('*', async (c, next) => {
    calls.push(`${c.req.method} ${new URL(c.req.url).pathname}`)
    await next()
  })

  app.get('/ISteamApps/UpToDateCheck/v1', c => {
    if (state.silent.valve) return c.text('', 503)
    return c.json({
      response: {
        success: true,
        up_to_date: false,
        version_is_listable: false,
        required_version: requiredVersionOf(state.build),
        message: `Server version required: ${state.build}`,
      },
    })
  })

  app.get('/v1/info/730', c => {
    if (state.silent.steamcmd) return c.text('', 503)
    return c.json({
      data: {
        '730': {
          depots: {
            branches: {
              public: { buildid: state.steamBuildId, timeupdated: String(state.steamUpdatedAt) },
            },
          },
        },
      },
      status: 'success',
    })
  })

  app.get('/mmsdrop/2.0/mmsource-latest-linux', c =>
    c.text(`mmsource-${state.metamod}-linux.tar.gz`),
  )

  const github = (c: {
    req: { header: (name: string) => string | undefined }
  }): Response | null => {
    if (state.silent.github) return new Response('', { status: 503 })
    if (state.rateLimitedUntil !== null && clock.now() < state.rateLimitedUntil)
      return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.ceil(state.rateLimitedUntil / 1000)),
        },
      })
    if (options.token !== undefined) {
      const authorization = c.req.header('authorization')
      if (authorization !== undefined && authorization !== `Bearer ${options.token}`)
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
    }
    return null
  }

  const releaseJson = (repo: string, release: FakeRelease) => ({
    tag_name: release.tag,
    name: release.name ?? release.tag,
    published_at: release.publishedAt ?? null,
    html_url: `https://github.com/${repo}/releases/tag/${release.tag}`,
    body: release.body ?? '',
    assets: [],
  })

  app.get('/repos/:owner/:repo/releases/latest', c => {
    const refused = github(c)
    if (refused) return refused
    const repo = `${c.req.param('owner')}/${c.req.param('repo')}`
    const release = state.releases.get(repo)
    if (!release) return c.json({ message: 'Not Found' }, 404)
    return c.json(releaseJson(repo, release))
  })

  app.get('/repos/:owner/:repo/releases/tags/:tag', c => {
    const refused = github(c)
    if (refused) return refused
    const repo = `${c.req.param('owner')}/${c.req.param('repo')}`
    const release = state.history.get(repo)?.findLast(r => r.tag === c.req.param('tag'))
    if (!release) return c.json({ message: 'Not Found' }, 404)
    return c.json(releaseJson(repo, release))
  })

  app.post('/repos/:owner/:repo/issues', async c => {
    const refused = github(c)
    if (refused) return refused
    if (!c.req.header('authorization')) return c.json({ message: 'Requires authentication' }, 401)
    const repo = `${c.req.param('owner')}/${c.req.param('repo')}`
    const body = (await c.req.json()) as { title?: string; body?: string }
    const issue = { number: issues.length + 1, title: body.title ?? '', body: body.body ?? '' }
    issues.push(issue)
    return c.json(
      { number: issue.number, html_url: `https://github.com/${repo}/issues/${issue.number}` },
      201,
    )
  })

  app.post('/repos/:owner/:repo/issues/:number/comments', async c => {
    const refused = github(c)
    if (refused) return refused
    if (!c.req.header('authorization')) return c.json({ message: 'Requires authentication' }, 401)
    const number = Number(c.req.param('number'))
    if (!issues.some(issue => issue.number === number)) return c.json({ message: 'Not Found' }, 404)
    const body = (await c.req.json()) as { body?: string }
    comments.push({ number, body: body.body ?? '' })
    return c.json({ id: comments.length }, 201)
  })

  const fetchImpl: FetchLike = (input, init) => Promise.resolve(app.request(input, init))

  return {
    fetch: fetchImpl,
    calls,
    issues,
    comments,
    setBuild(build, steamBuildId) {
      state.build = build
      if (steamBuildId !== undefined) state.steamBuildId = steamBuildId
      state.steamUpdatedAt = Math.floor(clock.now() / 1000)
    },
    setRelease(repo, release) {
      if (release === null) state.releases.delete(repo)
      else {
        state.releases.set(repo, release)
        state.history.set(repo, [...(state.history.get(repo) ?? []), release])
      }
    },
    setMetamod(version) {
      state.metamod = version
    },
    silence(feeds) {
      Object.assign(state.silent, feeds)
    },
    rateLimitUntil(untilMs) {
      state.rateLimitedUntil = untilMs
    },
    async listen(listenOptions = {}) {
      const { serve } = await import('@hono/node-server')
      const hostname = listenOptions.hostname ?? '127.0.0.1'
      const server = serve({ fetch: app.fetch, port: listenOptions.port ?? 0, hostname })
      await new Promise<void>(resolve => {
        if (server.listening) resolve()
        else server.once('listening', () => resolve())
      })
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      return {
        url: `http://${hostname}:${port}`,
        port,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close(error => (error ? reject(error) : resolve()))
          }),
      }
    },
  }
}
