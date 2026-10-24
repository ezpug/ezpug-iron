import type { Clock } from '@ezpug/core'
import { GAME_UPSTREAMS, type GamePinKey, type GameUpstreamSource } from './pins'

/**
 * **Where the watcher reads the world** (PRD-10 T2): Steam's public build
 * from Valve's own update check first and the steamcmd mirror second, and
 * the upstream releases of every pinned plugin. Every read is a plain
 * anonymous `GET` on the injected clock with a deadline; nothing here is
 * retried inside a tick, because the next tick is fifteen minutes away and
 * Valve's endpoints are not ours to hammer.
 *
 * **Which number is which** (the task's first finding, `docs/operations.md`
 * → "The build, by its three names"). A CS2 build goes by four numbers and
 * the contract uses exactly one of them as the id — the game's own
 * `PatchVersion`, `1.41.9.2`:
 *
 * - `ISteamApps/UpToDateCheck/v1?appid=730&version=0` answers
 *   `required_version: 14192` and `message: "Server version required:
 *   1.41.9.2"` — the PatchVersion with its dots removed, and the
 *   PatchVersion itself. Valve's, keyless, and what MatchZy's
 *   `cs2_update_required` is about.
 * - `steam.inf` on every server carries `PatchVersion=1.41.9.2`,
 *   `SourceRevision=11162119` (the engine's revision, the number a server
 *   console prints) and `ServerVersion=2000935` (the network protocol).
 *   The Dathost template's was read on 2026-10-24 to settle this.
 * - `appmanifest_730.acf` on a volume carries `buildid 26144732`, which is
 *   what `api.steamcmd.net/v1/info/730` reports as `public.buildid` — Steam's
 *   name for the same build, and the one `cs2:install` lands on.
 *
 * A server can be asked for the PatchVersion wherever it runs (a file on
 * Dathost, a file on a volume), so that is the id; the other two ride a
 * fact as labels and decide nothing.
 */

/** The `fetch` shape the watcher is injected with — the fake feeds' front door in a test. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface GameFeedUrls {
  /** Valve's own update check, keyless. */
  readonly steamUpToDateCheck: string
  /** The steamcmd mirror: Steam's `buildid` of the public branch, and when it moved. */
  readonly steamcmd: string
  /** GitHub's REST API origin — releases and issues. */
  readonly githubApi: string
  /** Metamod:Source's drop: the file name of the newest Linux build. */
  readonly metamodDrop: string
}

export const GAME_FEED_URLS: GameFeedUrls = {
  steamUpToDateCheck:
    'https://api.steampowered.com/ISteamApps/UpToDateCheck/v1?appid=730&version=0',
  steamcmd: 'https://api.steamcmd.net/v1/info/730',
  githubApi: 'https://api.github.com',
  metamodDrop: 'https://mms.alliedmods.net/mmsdrop/2.0/mmsource-latest-linux',
}

/** How long one feed may take to answer before it counts as silent. */
export const GAME_FEED_TIMEOUT_MS = 20_000

/**
 * **Every feed on one origin**, keeping its path — the dev world's scripted
 * feeds (`EZPUG_IRON_GAME_FEEDS_URL`, T9's rehearsal) serve all four under
 * one fake. `null` is the real world.
 */
export function feedUrls(origin: string | null): GameFeedUrls {
  if (origin === null) return GAME_FEED_URLS
  const base = origin.replace(/\/+$/, '')
  const rebase = (url: string): string => {
    const real = new URL(url)
    return `${base}${real.pathname}${real.search}`
  }
  return {
    steamUpToDateCheck: rebase(GAME_FEED_URLS.steamUpToDateCheck),
    steamcmd: rebase(GAME_FEED_URLS.steamcmd),
    githubApi: base,
    metamodDrop: rebase(GAME_FEED_URLS.metamodDrop),
  }
}

/** The PatchVersion out of Valve's `message` (`Server version required: 1.41.9.2`). */
export function parsePatchVersion(message: string | undefined): string | null {
  const match = message?.match(/(\d+(?:\.\d+){2,})/)
  return match?.[1] ?? null
}

/** A release tag as a version: `v1.0.378` → `1.0.378`; `1.7` stays. */
export function versionOfTag(tag: string): string {
  return tag.replace(/^v(?=\d)/, '')
}

/** The build out of the drop's file name: `mmsource-2.0.0-git1483-linux.tar.gz` → `2.0.0-git1483`. */
export function versionOfMetamodDrop(filename: string): string | null {
  const match = filename.trim().match(/^mmsource-(\d+\.\d+\.\d+-git\d+)-linux\.tar\.gz$/)
  return match?.[1] ?? null
}

/** One `GET`, bounded on the clock; the body's text, or a thrown reason. */
export async function fetchBounded(
  fetchImpl: FetchLike,
  clock: Clock,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const deadline = clock.after(timeoutMs, () =>
    controller.abort(new Error(`no answer within ${timeoutMs} ms`)),
  )
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    deadline.cancel()
  }
}

function failureText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 256)
}

// ---------------------------------------------------------------------------
// Steam
// ---------------------------------------------------------------------------

export interface SteamBuildReading {
  /** The PatchVersion, when Valve answered; null when only the mirror did, or neither. */
  id: string | null
  /** Steam's `buildid` of the public branch, when the mirror answered. */
  steamBuildId: string | null
  /** When the mirror says the public branch last moved. */
  steamUpdatedAt: string | null
  /** Every feed that did not answer, named — for the log, never a failure of the tick. */
  problems: string[]
}

export interface SteamReadOptions {
  fetch: FetchLike
  clock: Clock
  urls: GameFeedUrls
  timeoutMs?: number
}

interface UpToDateCheckBody {
  response?: { success?: boolean; required_version?: number; message?: string }
}

interface SteamcmdBody {
  data?: Record<
    string,
    { depots?: { branches?: { public?: { buildid?: string; timeupdated?: string } } } }
  >
}

/** Both readings, each on its own; one silent feed never hides the other. */
export async function readSteamBuild(options: SteamReadOptions): Promise<SteamBuildReading> {
  const { fetch: fetchImpl, clock, urls } = options
  const timeoutMs = options.timeoutMs ?? GAME_FEED_TIMEOUT_MS
  const reading: SteamBuildReading = {
    id: null,
    steamBuildId: null,
    steamUpdatedAt: null,
    problems: [],
  }
  const headers = { accept: 'application/json', 'user-agent': 'ezpug-iron' }

  const valve = (async () => {
    const response = await fetchBounded(
      fetchImpl,
      clock,
      urls.steamUpToDateCheck,
      { headers },
      timeoutMs,
    )
    if (!response.ok) throw new Error(`answered ${response.status}`)
    const body = (await response.json()) as UpToDateCheckBody
    const id = parsePatchVersion(body.response?.message)
    if (id === null) throw new Error('answered without a version in its message')
    reading.id = id
  })()
  const mirror = (async () => {
    const response = await fetchBounded(fetchImpl, clock, urls.steamcmd, { headers }, timeoutMs)
    if (!response.ok) throw new Error(`answered ${response.status}`)
    const body = (await response.json()) as SteamcmdBody
    const branch = body.data?.['730']?.depots?.branches?.public
    if (!branch?.buildid) throw new Error('answered without a public buildid')
    reading.steamBuildId = String(branch.buildid)
    const seconds = Number(branch.timeupdated)
    reading.steamUpdatedAt =
      Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null
  })()

  const [valveResult, mirrorResult] = await Promise.allSettled([valve, mirror])
  if (valveResult.status === 'rejected')
    reading.problems.push(`Valve's update check: ${failureText(valveResult.reason)}`)
  if (mirrorResult.status === 'rejected')
    reading.problems.push(`the steamcmd mirror: ${failureText(mirrorResult.reason)}`)
  return reading
}

// ---------------------------------------------------------------------------
// Upstream releases
// ---------------------------------------------------------------------------

export interface UpstreamRelease {
  pin: GamePinKey
  repo: string
  version: string
  publishedAt: string | null
  /** The release's title, for the issue comment and the follow policy (T5). */
  title: string | null
  /** The release notes, for the policy; never stored. */
  notes: string | null
  url: string | null
}

export interface UpstreamReading {
  releases: UpstreamRelease[]
  /** Set when GitHub refused for rate (403/429): the instant (clock ms) to try again. */
  rateLimitedUntil: number | null
  problems: string[]
}

export interface UpstreamReadOptions {
  fetch: FetchLike
  clock: Clock
  urls: GameFeedUrls
  /** `EZPUG_IRON_GITHUB_TOKEN`, or null for the anonymous 60/h. Never logged. */
  token: string | null
  timeoutMs?: number
  sources?: readonly GameUpstreamSource[]
}

interface GitHubRelease {
  tag_name?: string
  name?: string
  published_at?: string
  html_url?: string
  body?: string
}

/** GitHub's headers: the API version, a user agent (required), the token when there is one. */
export function githubHeaders(token: string | null): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'ezpug-iron',
    'x-github-api-version': '2022-11-28',
    ...(token !== null && { authorization: `Bearer ${token}` }),
  }
}

/**
 * When a 403 or 429 is GitHub's rate limit, the instant it lifts (ms on
 * the wall clock, which the injected clock also speaks); null otherwise.
 */
export function rateLimitResetOf(response: Response, now: number): number | null {
  if (response.status !== 403 && response.status !== 429) return null
  const remaining = response.headers.get('x-ratelimit-remaining')
  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (remaining === '0' && Number.isFinite(reset) && reset > 0) return reset * 1000
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000
  // A 403 for another reason is not a rate limit; a 429 with no hint waits an hour.
  return response.status === 429 ? now + 60 * 60_000 : null
}

/** Every upstream, each on its own; the first rate refusal stops the rest for this tick. */
export async function readUpstreamReleases(options: UpstreamReadOptions): Promise<UpstreamReading> {
  const { fetch: fetchImpl, clock, urls, token } = options
  const timeoutMs = options.timeoutMs ?? GAME_FEED_TIMEOUT_MS
  const sources = options.sources ?? GAME_UPSTREAMS
  const reading: UpstreamReading = { releases: [], rateLimitedUntil: null, problems: [] }

  for (const source of sources) {
    try {
      if (source.kind === 'metamod-drop') {
        const response = await fetchBounded(
          fetchImpl,
          clock,
          urls.metamodDrop,
          { headers: { 'user-agent': 'ezpug-iron' } },
          timeoutMs,
        )
        if (!response.ok) throw new Error(`answered ${response.status}`)
        const filename = await response.text()
        const version = versionOfMetamodDrop(filename)
        if (version === null)
          throw new Error(`answered an unexpected name (${filename.trim().slice(0, 64)})`)
        reading.releases.push({
          pin: source.pin,
          repo: source.repo,
          version,
          publishedAt: null,
          title: null,
          notes: null,
          url: `https://mms.alliedmods.net/mmsdrop/2.0/${filename.trim()}`,
        })
        continue
      }
      if (reading.rateLimitedUntil !== null) {
        reading.problems.push(`${source.repo}: not asked, GitHub's rate limit is in force`)
        continue
      }
      const response = await fetchBounded(
        fetchImpl,
        clock,
        `${urls.githubApi}/repos/${source.repo}/releases/latest`,
        { headers: githubHeaders(token) },
        timeoutMs,
      )
      const reset = rateLimitResetOf(response, clock.now())
      if (reset !== null) {
        reading.rateLimitedUntil = reset
        reading.problems.push(
          `${source.repo}: GitHub's rate limit (${response.status}); again at ${new Date(reset).toISOString()}`,
        )
        continue
      }
      if (!response.ok) throw new Error(`answered ${response.status}`)
      const release = (await response.json()) as GitHubRelease
      if (!release.tag_name) throw new Error('answered a release without a tag')
      reading.releases.push({
        pin: source.pin,
        repo: source.repo,
        version: versionOfTag(release.tag_name),
        publishedAt: release.published_at ?? null,
        title: release.name ?? null,
        notes: release.body ?? null,
        url: release.html_url ?? null,
      })
    } catch (error) {
      reading.problems.push(`${source.repo}: ${failureText(error)}`)
    }
  }
  return reading
}
