import { randomUUID } from 'node:crypto'
import type { Clock, Timer } from '@ezpug/core'
import type { GameBuildMovedFact, GameCanary, GameUpstreamReleasedFact } from '@ezpug/match-api'
import type { Log } from '../log'
import type { ProviderRegistry } from '../providers/registry'
import {
  type FetchLike,
  GAME_FEED_TIMEOUT_MS,
  type GameFeedUrls,
  readSteamBuild,
  readUpstreamReleases,
  type UpstreamRelease,
} from './feeds'
import type { GitHubIssues } from './github'
import { GAME_PINS, GAME_UPSTREAMS, type GameUpstreamSource } from './pins'
import type { GameBuildRow, GameProviderStateRow, GameStore } from './store'

/**
 * **The build watcher** (PRD-10 T2, decision 37): one more loop in the
 * orchestrator, beside the probes, on the injected clock. Every
 * {@link GAME_WATCH_INTERVAL_MS} it reads Steam's public build and the
 * upstream releases of every pinned plugin, and turns what moved into
 * **facts with a time** — never an edit, never an alert that names a dead
 * server:
 *
 * - `game.build_moved` once per build, the moment Steam's public build is
 *   not the one this deployment last saw. Every provider's picture then
 *   reads the new build with both canaries `unproven` (T3 and T6 write the
 *   verdicts), and one GitHub issue is filed for the build — the one place
 *   every later verdict and release lands as a comment.
 * - `game.upstream_released` once per release, when an upstream's newest
 *   release is not the version the stack pins; the build's issue hears it.
 *
 * **Why the orchestrator and not a cron.** It is the one process that is
 * always up, holds the store, the clock, the registry and the health route
 * the platform polls every 30 s; a scheduled script on the box would be a
 * second writer with no door and no fake.
 *
 * **Which number is which** is `feeds.ts`'s note: the id is the game's own
 * `PatchVersion`. A provider that can be asked for its servers' build
 * (`provider.gameBuild`) says so, and its picture follows its own reading
 * rather than Steam's — a Dathost template still on yesterday's build is
 * on yesterday's build, whatever Valve shipped an hour ago.
 *
 * Every read is bounded and every failure is a line, never a thrown tick: a
 * silent feed leaves the picture as it was and the next tick asks again.
 */
export interface GameWatcher {
  /** Arm the loop. Idempotent. The first tick is one interval away. */
  start: () => void
  /** Disarm; a tick already running finishes but does not re-arm. */
  stop: () => Promise<void>
  /** One pass — what the interval calls, and what tests and the canary route drive. */
  tick: () => Promise<GameTickReport>
}

/** What one tick found and did. */
export interface GameTickReport {
  /** Steam's public build as read; null when both feeds were silent. */
  build: string | null
  moved: { from: string | null; to: string } | null
  /** Releases recorded as new this tick. */
  released: UpstreamRelease[]
  /** Every feed or provider that did not answer, named. */
  problems: string[]
}

export interface GameWatcherOptions {
  clock: Clock
  log: Log
  store: GameStore
  registry: ProviderRegistry
  fetch: FetchLike
  urls: GameFeedUrls
  issues: GitHubIssues
  /** `EZPUG_IRON_GITHUB_TOKEN`, for the release reads' rate ceiling; null is the anonymous 60/h. */
  githubToken?: string | null
  /** The stack's pins, for the fact. Default {@link GAME_PINS}. */
  pins?: Readonly<Record<string, string>>
  upstreams?: readonly GameUpstreamSource[]
  intervalMs?: number
  timeoutMs?: number
}

/**
 * Fifteen minutes: a build is hours apart, Valve's endpoints are not ours
 * to hammer, and the owner's brief asks for detection inside a quarter hour.
 */
export const GAME_WATCH_INTERVAL_MS = 15 * 60_000

const UNPROVEN: GameCanary = { state: 'unproven', build: null, since: null, reason: null }

function failureText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 256)
}

/** The issue a build gets, in the title's one grammar. */
export function issueTitle(build: string, sourceRevision: string | null): string {
  return sourceRevision === null
    ? `CS2 build ${build}`
    : `CS2 build ${build} (source revision ${sourceRevision})`
}

export function createGameWatcher(options: GameWatcherOptions): GameWatcher {
  const { clock, log, store, registry, fetch: fetchImpl, urls, issues } = options
  const githubToken = options.githubToken ?? null
  const pins = options.pins ?? GAME_PINS
  const upstreams = options.upstreams ?? GAME_UPSTREAMS
  const intervalMs = options.intervalMs ?? GAME_WATCH_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? GAME_FEED_TIMEOUT_MS

  let timer: Timer | undefined
  let running = false
  let pass: Promise<GameTickReport> | undefined
  /** GitHub asked us to wait: no release read before this instant. */
  let githubPausedUntil: number | null = null

  /** A provider's own reading of the build its servers run, bounded; null when it has none or did not answer. */
  const askProvider = async (
    id: string,
    problems: string[],
  ): Promise<{ id: string; sourceRevision: string | null } | null> => {
    const provider = registry.get(id)
    if (!provider?.gameBuild) return null
    let deadline: Timer | undefined
    try {
      return await Promise.race([
        provider.gameBuild(),
        new Promise<never>((_resolve, reject) => {
          deadline = clock.after(timeoutMs, () =>
            reject(new Error(`no answer within ${timeoutMs} ms`)),
          )
        }),
      ])
    } catch (error) {
      problems.push(`provider ${id}'s build: ${failureText(error)}`)
      return null
    } finally {
      deadline?.cancel()
    }
  }

  const askStack = async (id: string, problems: string[]): Promise<string | null | undefined> => {
    const provider = registry.get(id)
    if (!provider?.stack) return undefined
    try {
      return await provider.stack()
    } catch (error) {
      problems.push(`provider ${id}'s stack: ${failureText(error)}`)
      return undefined
    }
  }

  const issueBodyForMove = (fact: GameBuildMovedFact): string => {
    const labels = [
      fact.steamBuildId === null ? null : `Steam build \`${fact.steamBuildId}\``,
      fact.sourceRevision === null ? null : `source revision \`${fact.sourceRevision}\``,
    ].filter((label): label is string => label !== null)
    const pinLines = Object.entries(fact.pins)
      .map(([name, version]) => `- ${name}: \`${version}\``)
      .join('\n')
    return [
      `Steam's public build of CS2 moved from ${fact.from === null ? 'nothing this deployment had seen' : `\`${fact.from}\``} to **\`${fact.to}\`** at ${fact.observedAt}${labels.length > 0 ? ` (${labels.join(', ')})` : ''}.`,
      '',
      "The orchestrator keeps serving matches on it — there is no safe alternative to a match — and refuses nothing but the HUD's addon loader until a canary has seen the build. Every provider now reads `unproven` on `GET /v1/fleet/providers`. This issue follows the build: each canary verdict and each upstream release it waits for lands here as a comment, never as a second issue.",
      '',
      "The server stack's pins at the moment of the move:",
      pinLines,
      '',
      "_Filed by the orchestrator's build watcher (PRD-10, decision 37)._",
    ].join('\n')
  }

  const commentForRelease = (fact: GameUpstreamReleasedFact, release: UpstreamRelease): string =>
    [
      `**Upstream released:** ${fact.repo} \`${fact.version}\`${release.title && release.title !== fact.version ? ` — ${release.title}` : ''}${fact.publishedAt ? ` (published ${fact.publishedAt})` : ''}, while the stack pins \`${fact.pinned}\`.`,
      release.url ? `\n${release.url}` : '',
    ].join('\n')

  /** The move: one fact, one build row, every provider unproven, one issue. */
  const recordMove = async (
    current: GameBuildRow | undefined,
    to: { id: string; steamBuildId: string | null; sourceRevision: string | null },
    at: Date,
  ): Promise<void> => {
    const fact: GameBuildMovedFact = {
      type: 'game.build_moved',
      from: current?.build ?? null,
      to: to.id,
      observedAt: at.toISOString(),
      steamBuildId: to.steamBuildId,
      sourceRevision: to.sourceRevision,
      pins: { ...pins },
    }
    await store.appendFact({ id: randomUUID(), at, build: to.id, fact })
    await store.insertBuild({
      build: to.id,
      steamBuildId: to.steamBuildId,
      sourceRevision: to.sourceRevision,
      observedAt: at,
      issueNumber: null,
      issueUrl: null,
    })
    log.warn(
      `game: CS2 build moved ${fact.from ?? '(none)'} → ${to.id}` +
        `${to.steamBuildId ? ` (Steam build ${to.steamBuildId})` : ''}; every provider is unproven until a canary has seen it`,
    )
    const filed = await issues.create({
      title: issueTitle(to.id, to.sourceRevision),
      body: issueBodyForMove(fact),
    })
    if (filed) await store.updateBuild(to.id, { issueNumber: filed.number, issueUrl: filed.url })
  }

  /** One provider's picture folded with this tick's readings. */
  const fold = (
    prev: GameProviderStateRow | undefined,
    provider: string,
    build: string | null,
    stack: string | null | undefined,
    at: Date,
  ): GameProviderStateRow => {
    const sameBuild = prev !== undefined && prev.build === build
    const verdict = (previous: GameCanary | undefined): GameCanary =>
      previous !== undefined && previous.build === build
        ? previous
        : build === null
          ? UNPROVEN
          : { state: 'unproven', build, since: at.toISOString(), reason: null }
    return {
      provider,
      build,
      buildSince: build === null ? null : sameBuild ? (prev?.buildSince ?? at) : at,
      stack: stack === undefined ? (prev?.stack ?? null) : stack,
      canary: verdict(prev?.canary),
      hud: verdict(prev?.hud),
      updatedAt: at,
    }
  }

  const sameState = (a: GameProviderStateRow | undefined, b: GameProviderStateRow): boolean =>
    a !== undefined &&
    a.build === b.build &&
    a.stack === b.stack &&
    (a.buildSince?.getTime() ?? null) === (b.buildSince?.getTime() ?? null) &&
    JSON.stringify(a.canary) === JSON.stringify(b.canary) &&
    JSON.stringify(a.hud) === JSON.stringify(b.hud)

  const tick = async (): Promise<GameTickReport> => {
    const at = clock.date()
    const report: GameTickReport = { build: null, moved: null, released: [], problems: [] }

    // 1. The world's build, and what every server that can be asked says.
    const steam = await readSteamBuild({ fetch: fetchImpl, clock, urls, timeoutMs })
    report.problems.push(...steam.problems)
    const own = new Map<string, { id: string; sourceRevision: string | null } | null>()
    for (const provider of registry.all())
      own.set(provider.id, await askProvider(provider.id, report.problems))

    const current = await store.latestBuild()
    let moveTo: { id: string; steamBuildId: string | null; sourceRevision: string | null } | null =
      null
    if (steam.id !== null) {
      report.build = steam.id
      if (current?.build !== steam.id) {
        const asked = [...own.values()].find(reading => reading?.id === steam.id)
        moveTo = {
          id: steam.id,
          steamBuildId: steam.steamBuildId,
          sourceRevision: asked?.sourceRevision ?? null,
        }
      } else if (current.steamBuildId === null && steam.steamBuildId !== null) {
        // Learned late: the mirror answered this time and Valve did last time.
        await store.updateBuild(current.build, { steamBuildId: steam.steamBuildId })
      }
    } else if (
      steam.steamBuildId !== null &&
      current !== undefined &&
      current.steamBuildId !== null &&
      current.steamBuildId !== steam.steamBuildId
    ) {
      // Valve is silent and the mirror says Steam's build moved: the id is
      // the PatchVersion, which only a server can tell us now.
      report.build = current.build
      const fresh = [...own.values()].find(
        reading => reading !== null && reading.id !== current.build,
      )
      if (fresh)
        moveTo = {
          id: fresh.id,
          steamBuildId: steam.steamBuildId,
          sourceRevision: fresh.sourceRevision,
        }
      else
        log.warn(
          `game: Steam's public build moved to ${steam.steamBuildId} (was ${current.steamBuildId}) but Valve's update check is silent and no server can be asked yet; waiting for the next tick`,
        )
    } else {
      report.build = current?.build ?? null
    }
    if (moveTo) {
      await recordMove(current, moveTo, at)
      report.moved = { from: current?.build ?? null, to: moveTo.id }
    }

    // 2. Every provider's picture: its own reading where it has one, the world's otherwise.
    const latest = moveTo?.id ?? current?.build ?? null
    const states = await store.listProviderStates()
    for (const provider of registry.all()) {
      const reading = own.get(provider.id) ?? null
      const stack = await askStack(provider.id, report.problems)
      const prev = states.find(state => state.provider === provider.id)
      // A provider that can be asked and did not answer keeps what it last
      // said rather than borrowing the world's build for one tick.
      const build = reading?.id ?? (provider.gameBuild ? (prev?.build ?? latest) : latest)
      const next = fold(prev, provider.id, build, stack, at)
      if (!sameState(prev, next)) await store.upsertProviderState(next)
      // A server that caught up with the world names the engine's revision
      // the move itself could not: fill it in once.
      if (reading !== null && reading.id === latest && reading.sourceRevision !== null) {
        const row = await store.findBuild(latest)
        if (row && row.sourceRevision === null)
          await store.updateBuild(latest, { sourceRevision: reading.sourceRevision })
      }
    }

    // 3. The upstreams, unless GitHub asked us to wait.
    if (githubPausedUntil !== null && clock.now() < githubPausedUntil) {
      report.problems.push(
        `GitHub: not asked, its rate limit lifts at ${new Date(githubPausedUntil).toISOString()}`,
      )
    } else {
      githubPausedUntil = null
      const upstream = await readUpstreamReleases({
        fetch: fetchImpl,
        clock,
        urls,
        token: githubToken,
        timeoutMs,
        sources: upstreams,
      })
      report.problems.push(...upstream.problems)
      if (upstream.rateLimitedUntil !== null) githubPausedUntil = upstream.rateLimitedUntil
      const known = await store.listFacts(500, 'game.upstream_released')
      const build = moveTo?.id ?? current?.build ?? null
      const buildRow = build === null ? undefined : await store.findBuild(build)
      for (const release of upstream.releases) {
        const pinned = pins[release.pin]
        if (pinned === undefined || release.version === pinned) continue
        const seen = known.some(
          row =>
            row.fact.type === 'game.upstream_released' &&
            row.fact.repo === release.repo &&
            row.fact.version === release.version,
        )
        if (seen) continue
        const fact: GameUpstreamReleasedFact = {
          type: 'game.upstream_released',
          repo: release.repo,
          version: release.version,
          publishedAt: release.publishedAt,
          pinned,
          observedAt: at.toISOString(),
        }
        await store.appendFact({ id: randomUUID(), at, build, fact })
        report.released.push(release)
        log.info(`game: upstream ${release.repo} released ${release.version} (pinned ${pinned})`)
        if (buildRow?.issueNumber != null)
          await issues.comment(buildRow.issueNumber, commentForRelease(fact, release))
      }
    }

    for (const problem of report.problems) log.warn(`game: ${problem}`)
    return report
  }

  const arm = (): void => {
    timer = clock.after(intervalMs, () => {
      pass = tick()
      void pass
        .catch((error: unknown) => {
          log.error('game: watcher tick failed', error)
          return { build: null, moved: null, released: [], problems: [] } as GameTickReport
        })
        .finally(() => {
          pass = undefined
          if (running) arm()
        })
    })
  }

  return {
    start() {
      if (running) return
      running = true
      arm()
    },
    async stop() {
      running = false
      timer?.cancel()
      timer = undefined
      await pass?.catch(() => undefined)
    },
    tick,
  }
}
