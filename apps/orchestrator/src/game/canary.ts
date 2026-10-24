import { randomBytes, randomUUID } from 'node:crypto'
import type { Clock, Timer } from '@ezpug/core'
import type {
  GameCanary,
  GameCanaryCause,
  GameCanaryRun,
  GameCanaryStartedFact,
  GameCanaryVerdictFact,
  GamemodeManifest,
  Match,
  MatchRequestInput,
} from '@ezpug/match-api'
import {
  ApiError,
  isTerminalMatchState,
  MATCH_API_ERROR_STATUS,
  matchRequestSchema,
} from '@ezpug/match-api'
import { DEFAULT_CANARY_MONTHLY_CENTS } from '../config'
import type { AuthenticatedKey, Keys } from '../keys/service'
import type { Log } from '../log'
import type { Matches } from '../match/machine'
import type { ProviderRegistry } from '../providers/registry'
import { redactConsoleLine } from '../rcon/redact'
import type { GitHubIssues } from './github'
import type { GameStore } from './store'

/**
 * **The canary** (PRD-10 T3, decision 38): the match the owner ran by hand
 * on 2026-10-23 to see whether a build boots, played by the orchestrator
 * itself the moment a provider's build moves — and on demand through
 * `POST /v1/fleet/game/canary` — so the cents are spent before a player's
 * evening is.
 *
 * **The match.** `pug` on `de_dust2`, nobody rostered, four of the engine's
 * own bots by rules (`bot_quota` and friends in `rules.cvars`, a warmup
 * nobody has to ready for), two rounds, pinned to the provider by
 * `requirements.provider`. Puppets stay out of it: a canary is bots and
 * rules, so `simulation` (and the scope that guards it) is not part of it.
 * Played on **a key of the orchestrator's own** (`canary`: `matches` only,
 * one server at a time, ten minutes a server, a monthly ceiling from
 * `EZPUG_IRON_CANARY_MONTHLY_CENTS`), minted at boot, so the money has a
 * wall that is not this module's good behaviour: a canary that hangs is cut
 * by the key's lifetime, not by luck.
 *
 * **How a bots-only pug starts.** MatchZy waits for its roster to ready up
 * and an anonymous bot never types `.ready`, so a `matchzy` canary is
 * started the way the iron's own bots runs are (`scripts/iron-match.mjs`,
 * `--force-start`): the server emptied, `css_start`, the quota back, the
 * warmup ended, one step a poll. That is the iron speaking its own stack's
 * language through the fleet's RCON door, recorded on the row's audit
 * column under the canary key — never something a client is asked to type.
 *
 * **The verdict is per build**: `green` once `server_ready` came, the match
 * went live and a `round_end` was heard (the match is force-ended there, two
 * rounds being the ceiling, not the goal); `red` when the server crashed,
 * the boot deadline fired, the server was lost or the match ended any other
 * way, with a reason read off the provider's console door — the crash
 * pattern named and the lines that showed it, never the whole log;
 * `unproven` until one of those. A red canary makes the provider's health
 * read `healthy: false` (`fleet/service.ts`), so the platform's existing
 * tile goes red without learning a word of this.
 *
 * **One run per (provider, build, hud) at a time**: a second trigger while
 * one plays is answered with the running one; a finished one may be run
 * again on demand, and the fact counts the attempt.
 *
 * **What it refuses on its own** (decision 38's second half): the HUD's
 * addon loader, on any provider whose `hud` canary has not passed the build
 * it runs — {@link GameCanaries.hudAllowed}, the gate `configure` asks. A
 * canary with `hud: true` is the one match that carries the loader before
 * that, because it is the one that finds out.
 *
 * **The `hud` canary** (PRD-10 T6, decision 40) is the same match with the
 * loader on. It is green only when the plain verdict's three things came
 * *and* the server's `hello` said `hud` (the id and the loader file reached
 * it) *and*, where the provider has a console door, MultiAddonManager's own
 * `Steam API Activated` was read before the server lived on — the line the
 * 2026-10-23 servers died one second after. On a build move it follows a
 * green plain canary unattended, when an addon id is configured at all.
 */
export interface GameCanaries {
  /** Mint or adopt the canary key, and pick up runs a restart interrupted. */
  start: () => Promise<void>
  /** Disarm the poll; a pass already running finishes. */
  stop: () => Promise<void>
  /** Play the canary for the provider's current build, or answer the one already playing. */
  play: (request: {
    provider: string
    hud: boolean
    cause: GameCanaryCause
  }) => Promise<GameCanaryRun>
  /**
   * The watcher's word that a provider's servers now run `build`. A provider
   * whose game the vendor updates itself (`updatesItself`) gets a plain
   * canary unattended; any other waits to be asked.
   */
  providerMoved: (provider: string, build: string) => void
  /**
   * **May this match's server carry the HUD's addon loader?** Only when the
   * provider's `hud` canary is green on the build it runs, or when the match
   * is itself a `hud` canary. Anything that cannot be read is a no.
   */
  hudAllowed: (provider: string, matchId: string) => Promise<boolean>
  /** One pass over every running canary — what the poll calls, and what tests drive. */
  pass: () => Promise<void>
  /** Every run this process knows, running or finished, newest last. */
  runs: () => GameCanaryRun[]
}

/** The canary key's name — the one the orchestrator adopts at every boot. */
export const CANARY_KEY_NAME = 'canary'
/** The webhook secret id the canary's requests name; its secret is drawn once and shown nowhere. */
export const CANARY_WEBHOOK_SECRET_ID = 'canary'
/**
 * Where the canary's webhooks go: nowhere. The orchestrator reads its own
 * canary off the match's log; `.invalid` never resolves (RFC 2606), so the
 * worker's attempts fail at once and give up on their schedule.
 */
export const CANARY_WEBHOOK_URL = 'https://webhooks.invalid/canary'
/** Ten minutes a server — the key's wall and the request's own ttl. */
export const CANARY_LIFETIME_MINUTES = 10
/** How often a running canary is looked at: its match's log, its console, the next start step. */
export const CANARY_POLL_MS = 5_000
export const CANARY_GAMEMODE = 'pug'
export const CANARY_MAP = 'de_dust2'
export const CANARY_BOTS = 4
/** How many times a canary asks for an unpause nobody else will give, and how far apart. */
export const CANARY_UNPAUSES = 3
export const CANARY_UNPAUSE_GAP_MS = 30_000
/** How many console lines a run keeps for its reason. */
const CONSOLE_KEEP = 60
/** How many lines a reason quotes, each cut to {@link REASON_LINE_MAX}. */
const REASON_LINES = 3
const REASON_LINE_MAX = 140
const REASON_MAX = 512

/**
 * **What a dead server says before it dies**, as the console door shows it
 * (the 2026-10-23 crashes, `docs/pins.md`). A `fatal` line ends the canary
 * red at once — there is no round coming after it; a `context` line is
 * quoted in a reason when it is there and decides nothing on its own (a
 * `SIGNONSTATE_SPAWN` is every client's, and only the line after it says
 * whether that one was fatal).
 */
export const CANARY_CONSOLE_PATTERNS: readonly {
  pattern: RegExp
  name: string
  fatal: boolean
}[] = [
  { pattern: /Engine2PreBreakpadDumpFunction/, name: 'the server crashed (breakpad)', fatal: true },
  { pattern: /SERVER EXITED/i, name: 'the server process exited', fatal: true },
  {
    pattern: /Failed to find signature/,
    name: "a plugin's game signatures no longer match the build (Failed to find signature)",
    fatal: true,
  },
  {
    pattern: /cs2_update_required|MasterRequestRestart|Your server is out of date/i,
    name: 'the game asks for an update (cs2_update_required)',
    fatal: true,
  },
  { pattern: /SIGNONSTATE_SPAWN/, name: 'a client reached SIGNONSTATE_SPAWN', fatal: false },
  { pattern: /Steam API Activated/, name: 'the addon loader woke the Steam API', fatal: false },
]

/** A control plane asking the server how it is (`rcon from "…": command "status_json"`): never a reason. */
const CONSOLE_NOISE = /rcon from "[^"]*": command "/

/** How far a run got, in the words a reason uses. */
function progressOf(saw: { ready: boolean; live: boolean; round: boolean }): string {
  if (!saw.ready) return 'it never got ready'
  if (!saw.live) return 'it was ready but never went live'
  return 'it went live but no round was played'
}

/** MultiAddonManager's own word that it woke the Steam API — what killed the 2026-10-23 servers a second later. */
export const CANARY_LOADER_LINE = /\[MultiAddonManager\] Steam API Activated/

/** Why a `hud` run that played its round is still not green, or null when it is. */
export function hudShortfall(input: {
  hello: boolean
  loader: boolean
  /** The provider has a console door, so the loader's line could have been read. */
  console: boolean
}): string | null {
  if (!input.hello)
    return "the server played a round but its hello did not say hud: the addon id or MultiAddonManager's loader file did not reach it"
  if (input.console && !input.loader)
    return 'the server played a round but MultiAddonManager never said "Steam API Activated": the loader did not load'
  return null
}

/** The request a canary plays: composed here, the shape of the hand-run one, never copied from a client. */
export function canaryRequest(input: {
  provider: string
  build: string
  hud: boolean
  attempt: number
}): MatchRequestInput {
  const { provider, build, hud, attempt } = input
  return {
    clientMatchId: `canary:${provider}:${build}:${hud ? 'hud' : 'plain'}:${attempt}`,
    game: 'cs2',
    gamemode: CANARY_GAMEMODE,
    teams: {
      teamA: { name: 'Canary A', players: [] },
      teamB: { name: 'Canary B', players: [] },
    },
    maps: [{ map: CANARY_MAP, sides: 'ct' }],
    rules: {
      regulationRounds: 2,
      overtime: { enabled: false, maxRounds: 6, startMoney: 10_000 },
      warmup: { minPlayersToReady: 0, minSpectatorsToReady: 0 },
      // The bots are rules (the platform's test match and the iron's bots
      // runs alike): `normal` bots that fight, a short freeze nobody buys in.
      cvars: {
        bot_quota: String(CANARY_BOTS),
        bot_difficulty: '2',
        bot_join_after_player: '0',
        mp_freezetime: '5',
      },
    },
    requirements: { provider },
    callbacks: { webhookUrl: CANARY_WEBHOOK_URL, webhookSecretId: CANARY_WEBHOOK_SECRET_ID },
    branding: {
      hostname: `EZPug · canary · ${build}`,
      eventName: 'canary',
      ...(hud && { hud: true }),
    },
    ttlMinutes: CANARY_LIFETIME_MINUTES,
  }
}

/**
 * The reason a red run gives: the first fatal pattern the console showed
 * (else what the match's end said), and the lines that showed it — redacted,
 * cut short, never the whole log.
 */
export function canaryReason(input: {
  build: string
  provider: string
  console: readonly string[]
  ended?: string | null
  /** How far the match got, when it ended without a fatal line: "it went live but no round was played". */
  progress?: string | null
}): string {
  const { build, provider, console: lines, ended, progress } = input
  const hits = lines
    .map(line => ({
      line,
      hit: CANARY_CONSOLE_PATTERNS.find(candidate => candidate.pattern.test(line)),
    }))
    .filter((entry): entry is { line: string; hit: (typeof CANARY_CONSOLE_PATTERNS)[number] } =>
      Boolean(entry.hit),
    )
  const fatal = hits.find(entry => entry.hit.fatal)
  const head = fatal
    ? `${fatal.hit.name} on ${provider}, build ${build}`
    : `${ended ?? 'the canary ended without a round'}${progress ? `; ${progress}` : ''} (${provider}, build ${build})`
  // The fatal line, what led to it, and otherwise the last lines the server
  // printed — not counting the vendor's own RCON polling, which is most of a
  // quiet console and says nothing about the game.
  const said = lines.filter(line => !CONSOLE_NOISE.test(line))
  const quoted = (
    hits.length > 0 ? hits.slice(-REASON_LINES).map(entry => entry.line) : said.slice(-2)
  ).map(line => `"${redactConsoleLine(line.trim()).slice(0, REASON_LINE_MAX)}"`)
  const text = quoted.length > 0 ? `${head}: ${quoted.join(' … ')}` : head
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text
}

export interface GameCanariesOptions {
  clock: Clock
  log: Log
  store: GameStore
  registry: ProviderRegistry
  matches: Pick<Matches, 'create' | 'get' | 'events' | 'cancel' | 'command'>
  keys: Pick<Keys, 'list' | 'mint' | 'get' | 'setBudget'>
  /** The fleet's RCON door (`Fleet.rcon`): what starts a bots-only `matchzy` canary. */
  rcon: (key: AuthenticatedKey, serverId: string, command: string) => Promise<string>
  issues: GitHubIssues
  gamemodes: readonly GamemodeManifest[]
  /**
   * `EZPUG_IRON_HUD_ADDON` is set. Without an id there is no loader to prove:
   * a `hud` canary is refused, and none follows a green plain one.
   */
  hudAddon?: boolean
  /** What the server's `hello` said it can do (the link's session), while it is connected. */
  capabilities?: (server: { provider: string; serverId: string }) => readonly string[] | undefined
  /** Serialises writes to a provider's picture with the watcher's (`game/exclusive.ts`). */
  exclusive: <T>(work: () => Promise<T>) => Promise<T>
  /** `EZPUG_IRON_CANARY_MONTHLY_CENTS`. Default {@link DEFAULT_CANARY_MONTHLY_CENTS}. */
  monthlyCents?: number
  pollMs?: number
}

interface Run {
  provider: string
  build: string
  hud: boolean
  attempt: number
  matchId: string
  cause: GameCanaryCause
  startedAt: Date
  finishedAt: Date | null
  verdict: GameCanary
  /** The match's log, read up to here. */
  afterSeq: number
  saw: { ready: boolean; live: boolean; round: boolean }
  /** What only a `hud` run asks: the hello said `hud`; MultiAddonManager said it woke. */
  hudSaw: { hello: boolean; loader: boolean }
  /** The start, one step a poll: emptied, started, filled, warmup ended. */
  steps: { emptied: boolean; started: boolean; filled: boolean; warmupEnded: boolean }
  /** The match's last word on a pause: a `match_paused` with no `match_unpaused` after it. */
  paused: boolean
  /** The unpauses asked for, and when the last one was. */
  unpauses: { count: number; lastAt: number | null }
  /** The console as last read, oldest first, at most {@link CONSOLE_KEEP} lines. */
  console: string[]
}

const runKey = (provider: string, build: string, hud: boolean): string =>
  `${provider}|${build}|${hud ? 'hud' : 'plain'}`

function failureText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 256)
}

export function createGameCanaries(options: GameCanariesOptions): GameCanaries {
  const { clock, log, store, registry, matches, keys, issues, exclusive } = options
  const monthlyCents = options.monthlyCents ?? DEFAULT_CANARY_MONTHLY_CENTS
  const pollMs = options.pollMs ?? CANARY_POLL_MS
  const flow = options.gamemodes.find(mode => mode.id === CANARY_GAMEMODE)?.flow ?? null

  /** Every run this process knows, by match id; the running ones also by (provider, build, hud). */
  const runs = new Map<string, Run>()
  const running = new Map<string, Run>()
  /** A play in flight for a (provider, build, hud), so two triggers at once make one match. */
  const starting = new Map<string, Promise<GameCanaryRun>>()
  /** `hud` canaries a green plain one on a build move asked for, waiting for the key's slot. */
  const hudDue = new Map<string, { provider: string; build: string }>()
  let key: AuthenticatedKey | undefined
  let keyPending: Promise<AuthenticatedKey> | undefined
  let timer: Timer | undefined
  let armed = false
  let stopped = false
  let passing: Promise<void> | undefined

  const view = (run: Run): GameCanaryRun => ({
    provider: run.provider,
    build: run.build,
    hud: run.hud,
    attempt: run.attempt,
    matchId: run.matchId,
    cause: run.cause,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    verdict: { ...run.verdict },
  })

  /**
   * The canary key: adopted when a live one carries the name, minted
   * otherwise, its monthly ceiling held to the configured one. The secret a
   * mint returns is dropped on the floor — the orchestrator acts as the key
   * in process and never presents it.
   */
  const ensureKey = (): Promise<AuthenticatedKey> => {
    if (key) return Promise.resolve(key)
    keyPending ??= (async () => {
      const limits = {
        maxConcurrentServers: 1,
        maxServerLifetimeMinutes: CANARY_LIFETIME_MINUTES,
        monthlyCents,
      }
      const existing = (await keys.list()).find(
        candidate => candidate.name === CANARY_KEY_NAME && candidate.revokedAt === null,
      )
      let id: string
      if (existing) {
        id = existing.id
        const budget = existing.budget
        if (
          budget.maxConcurrentServers !== limits.maxConcurrentServers ||
          budget.maxServerLifetimeMinutes !== limits.maxServerLifetimeMinutes ||
          budget.monthlyCents !== limits.monthlyCents
        )
          await keys.setBudget(id, limits)
      } else {
        const minted = await keys.mint({
          name: CANARY_KEY_NAME,
          scopes: ['matches'],
          budget: limits,
          webhookSecrets: [
            { id: CANARY_WEBHOOK_SECRET_ID, secret: randomBytes(32).toString('base64url') },
          ],
        })
        id = minted.key.id
        log.info(
          `game: minted the canary key ${id} (matches only, one server, ${CANARY_LIFETIME_MINUTES} min, ${monthlyCents} ¢ a month)`,
        )
      }
      const authenticated = await keys.get(id)
      if (!authenticated) throw new Error(`the canary key ${id} vanished as it was read`)
      key = authenticated
      return authenticated
    })().finally(() => {
      keyPending = undefined
    })
    return keyPending
  }

  const stateOf = async (provider: string) =>
    (await store.listProviderStates()).find(row => row.provider === provider)

  /** Write a verdict onto the provider's picture — only while the provider still runs that build. */
  const writePicture = (run: Run, verdict: GameCanary): Promise<boolean> =>
    exclusive(async () => {
      const state = await stateOf(run.provider)
      if (!state || state.build !== run.build) return false
      await store.upsertProviderState({
        ...state,
        ...(run.hud ? { hud: verdict } : { canary: verdict }),
        updatedAt: clock.date(),
      })
      return true
    })

  const commentOnBuild = async (build: string, body: string): Promise<void> => {
    try {
      const row = await store.findBuild(build)
      if (row?.issueNumber != null) await issues.comment(row.issueNumber, body)
    } catch (error) {
      log.warn(`game: the canary's comment on build ${build}'s issue failed: ${failureText(error)}`)
    }
  }

  const label = (run: Pick<Run, 'hud' | 'attempt' | 'provider' | 'build'>): string =>
    `${run.hud ? 'hud canary' : 'canary'} on ${run.provider}, build ${run.build}, attempt ${run.attempt}`

  /** The end of a run: the fact, the picture, the issue, the log. Once. */
  const decide = async (run: Run, state: 'green' | 'red', reason: string | null): Promise<void> => {
    if (run.finishedAt !== null) return
    const at = clock.date()
    run.finishedAt = at
    run.verdict = { state, build: run.build, since: at.toISOString(), reason }
    running.delete(runKey(run.provider, run.build, run.hud))
    const fact: GameCanaryVerdictFact = {
      type: 'game.canary_verdict',
      provider: run.provider,
      build: run.build,
      hud: run.hud,
      attempt: run.attempt,
      matchId: run.matchId,
      state,
      reason,
      observedAt: at.toISOString(),
    }
    await store.appendFact({ id: randomUUID(), at, build: run.build, fact })
    const written = await writePicture(run, run.verdict)
    if (state === 'green') log.info(`game: ${label(run)}: green (match ${run.matchId})`)
    else log.warn(`game: ${label(run)}: red — ${reason ?? 'no reason'} (match ${run.matchId})`)
    if (!written)
      log.warn(
        `game: ${label(run)} is decided, but ${run.provider} no longer runs ${run.build}; its picture is left as it is`,
      )
    await commentOnBuild(
      run.build,
      state === 'green'
        ? `**Canary green** — ${label(run)}: the server booted${run.hud ? ' with the HUD addon loader, said `hud` and MultiAddonManager woke' : ''}, the match went live and a round was played (match \`${run.matchId}\`).`
        : `**Canary red** — ${label(run)} (match \`${run.matchId}\`): ${reason ?? 'no reason given'}\n\nThe orchestrator keeps serving matches on this build${run.hud ? ' and serves them without the HUD addon loader' : ''}; \`POST /v1/fleet/game/canary\` runs it again.`,
    )
    // Decision 40: on a build move the loader is proven after the build is,
    // never before — a build that cannot boot plain says nothing about the HUD.
    // Queued, not played here: the plain canary's server still holds the
    // key's one slot until it is given back, and the poll starts it then.
    if (state === 'green' && !run.hud && run.cause === 'build_moved' && options.hudAddon)
      hudDue.set(runKey(run.provider, run.build, true), {
        provider: run.provider,
        build: run.build,
      })
  }

  /** End the canary's match: it said what it had to, and every minute of it is money. */
  const endMatch = async (run: Run, match: Match, why: string): Promise<void> => {
    if (!key || isTerminalMatchState(match.state)) return
    try {
      if (match.state === 'live' || match.state === 'recovering' || match.state === 'ready')
        await matches.command(key, run.matchId, {
          correlationId: `canary-end-${run.matchId}`,
          type: 'force_end',
          reason: why,
        })
      else await matches.cancel(key, run.matchId)
    } catch (error) {
      log.warn(
        `game: ending the canary match ${run.matchId} failed (${failureText(error)}); its ttl ends it`,
      )
    }
  }

  /** Read the match's log from where the run left off. */
  const readLog = async (run: Run, as: AuthenticatedKey): Promise<void> => {
    for (let page = 0; page < 20; page += 1) {
      const { items } = await matches.events(as, run.matchId, run.afterSeq, 200)
      if (items.length === 0) return
      for (const envelope of items) {
        run.afterSeq = Math.max(run.afterSeq, envelope.seq)
        const type = envelope.payload.type
        if (type === 'match_paused') run.paused = true
        else if (type === 'match_unpaused') run.paused = false
        const milestone =
          type === 'match.server_ready' || type === 'server_ready'
            ? 'ready'
            : type === 'going_live'
              ? 'live'
              : type === 'round_end'
                ? 'round'
                : null
        if (milestone === null || run.saw[milestone]) continue
        run.saw[milestone] = true
        log.info(`game: canary ${run.matchId}: saw ${type} (seq ${envelope.seq})`)
      }
    }
  }

  /** The provider's console door, bounded to what a reason needs; quiet when it has none. */
  const readConsole = async (run: Run, match: Match): Promise<void> => {
    if (match.serverId === null || match.provider === null) return
    const provider = registry.get(match.provider)
    if (!provider?.console) return
    try {
      const lines = await provider.console(match.serverId)
      if (lines !== null && lines.length > 0) {
        run.console = lines.slice(-CONSOLE_KEEP).map(line => line.line)
        // Read on every pass, from the whole backlog: the line is a boot's,
        // and by the round it may have scrolled out of what a reason keeps.
        if (run.hud && lines.some(line => CANARY_LOADER_LINE.test(line.line)))
          run.hudSaw.loader = true
      }
    } catch (error) {
      log.warn(`game: reading the canary's console on ${match.serverId}: ${failureText(error)}`)
    }
  }

  /**
   * **A pause nobody will lift.** Bots joining a live map that had emptied
   * make the engine restart the game, and the core plugin restores round 1
   * from MatchZy's backup — paused, waiting for the sides to type
   * `.unpause`, which a bot never does (seen on production's first canary,
   * 2026-10-24: ten minutes standing). So a live canary that reads a
   * `match_paused` with no `match_unpaused` after it asks the Match API's own
   * `unpause` — the front door, the canary key's `matches` scope — at most
   * {@link CANARY_UNPAUSES} times, {@link CANARY_UNPAUSE_GAP_MS} apart.
   */
  const unpause = async (run: Run, match: Match, as: AuthenticatedKey): Promise<boolean> => {
    if (match.state !== 'live' || !run.paused || run.unpauses.count >= CANARY_UNPAUSES) return false
    const now = clock.now()
    if (run.unpauses.lastAt !== null && now - run.unpauses.lastAt < CANARY_UNPAUSE_GAP_MS)
      return false
    run.unpauses.count += 1
    run.unpauses.lastAt = now
    try {
      const result = await matches.command(as, run.matchId, {
        correlationId: `canary-unpause-${run.matchId}-${run.unpauses.count}`,
        type: 'unpause',
      })
      log.info(
        `game: canary ${run.matchId}: asked for an unpause (${run.unpauses.count}): ${result.status}`,
      )
    } catch (error) {
      log.info(`game: canary ${run.matchId}: the unpause was not taken: ${failureText(error)}`)
    }
    return true
  }

  /** One step of the bots-only start (module note), at most one a poll. */
  const startStep = async (run: Run, match: Match, as: AuthenticatedKey): Promise<void> => {
    if (flow !== 'matchzy' || match.serverId === null) return
    let command: string | null = null
    if (match.state === 'ready') {
      if (!run.steps.emptied) {
        run.steps.emptied = true
        command = 'bot_kick; bot_quota 0'
      } else if (!run.steps.started) {
        run.steps.started = true
        command = 'css_start'
      }
    } else if (match.state === 'live') {
      run.steps.emptied = true
      run.steps.started = true
      if (!run.steps.filled) {
        run.steps.filled = true
        command = `bot_quota ${CANARY_BOTS}`
      } else if (!run.steps.warmupEnded) {
        run.steps.warmupEnded = true
        command = 'mp_warmup_end'
      }
    }
    if (command === null) return
    try {
      await options.rcon(as, match.serverId, command)
      log.info(`game: canary ${run.matchId}: sent \`${command}\` (match ${match.state})`)
    } catch (error) {
      log.info(`game: canary ${run.matchId}: \`${command}\` was not taken: ${failureText(error)}`)
    }
  }

  const look = async (run: Run): Promise<void> => {
    const as = await ensureKey()
    const match = await matches.get(as, run.matchId)
    await readLog(run, as)
    if (match.state === 'live') run.saw.live = true
    const terminal = isTerminalMatchState(match.state)
    if (!terminal) await readConsole(run, match)
    if (run.hud && match.serverId !== null && match.provider !== null)
      if (
        options
          .capabilities?.({ provider: match.provider, serverId: match.serverId })
          ?.includes('hud')
      )
        run.hudSaw.hello = true

    if (run.saw.ready && run.saw.live && run.saw.round) {
      const short = run.hud
        ? hudShortfall({
            ...run.hudSaw,
            console: registry.get(run.provider)?.console !== undefined,
          })
        : null
      if (short === null) await decide(run, 'green', null)
      else await decide(run, 'red', `${short} (${run.provider}, build ${run.build})`)
      await endMatch(run, match, short === null ? 'the canary saw a round' : 'the canary is red')
      return
    }
    const fatal = run.console.find(line =>
      CANARY_CONSOLE_PATTERNS.some(candidate => candidate.fatal && candidate.pattern.test(line)),
    )
    if (fatal !== undefined || terminal) {
      const ended =
        terminal && match.endedReason
          ? `the match ${match.state}: ${match.endedReason.kind}${match.endedReason.detail ? ` — ${match.endedReason.detail}` : ''}`
          : null
      await decide(
        run,
        'red',
        canaryReason({
          build: run.build,
          provider: run.provider,
          console: run.console,
          ended,
          progress: fatal === undefined ? progressOf(run.saw) : null,
        }),
      )
      await endMatch(run, match, 'the canary is red')
      return
    }
    if (await unpause(run, match, as)) return
    await startStep(run, match, as)
  }

  /** Start the queued `hud` canaries whose plain one has given its server back. */
  const startDue = async (): Promise<void> => {
    for (const [slot, due] of [...hudDue]) {
      try {
        const state = await stateOf(due.provider)
        if (state?.build !== due.build) {
          hudDue.delete(slot)
          continue
        }
        await play({ provider: due.provider, hud: true, cause: 'build_moved' })
        hudDue.delete(slot)
      } catch (error) {
        // The key's one slot still held is the wait this queue is for.
        if (error instanceof ApiError && error.code === 'budget_exceeded') continue
        hudDue.delete(slot)
        log.warn(
          `game: the hud canary for ${due.provider} on build ${due.build} did not start: ${failureText(error)}`,
        )
      }
    }
  }

  const pass = async (): Promise<void> => {
    for (const run of [...running.values()]) {
      try {
        await look(run)
      } catch (error) {
        log.warn(`game: looking at the canary ${run.matchId}: ${failureText(error)}`)
      }
    }
    await startDue()
  }

  const arm = (): void => {
    if (armed || stopped || (running.size === 0 && hudDue.size === 0)) return
    armed = true
    timer = clock.after(pollMs, () => {
      armed = false
      passing = pass().finally(() => {
        passing = undefined
        arm()
      })
    })
  }

  const play: GameCanaries['play'] = async ({ provider, hud, cause }) => {
    registry.require(provider)
    if (hud && !options.hudAddon)
      throw new ApiError(
        MATCH_API_ERROR_STATUS.invalid_state,
        'invalid_state',
        'no HUD addon is configured (EZPUG_IRON_HUD_ADDON), so there is no loader for a hud canary to prove',
      )
    const state = await stateOf(provider)
    if (!state?.build)
      throw new ApiError(
        MATCH_API_ERROR_STATUS.invalid_state,
        'invalid_state',
        `no build is known for ${provider} yet; the build watcher has not read it`,
      )
    const build = state.build
    const slot = runKey(provider, build, hud)
    const current = running.get(slot)
    if (current) return view(current)
    const pending = starting.get(slot)
    if (pending) return pending
    const begun = (async (): Promise<GameCanaryRun> => {
      const as = await ensureKey()
      const attempt =
        (await store.listFacts(500, 'game.canary_started')).filter(
          row =>
            row.fact.type === 'game.canary_started' &&
            row.fact.provider === provider &&
            row.fact.build === build &&
            row.fact.hud === hud,
        ).length + 1
      const { match } = await matches.create(
        as,
        matchRequestSchema.parse(canaryRequest({ provider, build, hud, attempt })),
      )
      const at = clock.date()
      const run: Run = {
        provider,
        build,
        hud,
        attempt,
        matchId: match.id,
        cause,
        startedAt: at,
        finishedAt: null,
        verdict: {
          state: 'unproven',
          build,
          since: at.toISOString(),
          reason: `a canary is playing (attempt ${attempt}, since ${at.toISOString()})`,
        },
        afterSeq: 0,
        saw: { ready: false, live: false, round: false },
        hudSaw: { hello: false, loader: false },
        steps: { emptied: false, started: false, filled: false, warmupEnded: false },
        paused: false,
        unpauses: { count: 0, lastAt: null },
        console: [],
      }
      runs.set(run.matchId, run)
      running.set(slot, run)
      const fact: GameCanaryStartedFact = {
        type: 'game.canary_started',
        provider,
        build,
        hud,
        attempt,
        matchId: match.id,
        cause,
        observedAt: at.toISOString(),
      }
      await store.appendFact({ id: randomUUID(), at, build, fact })
      // An unproven picture says what it is waiting for; a red one stays red
      // until the run in flight says otherwise.
      await exclusive(async () => {
        const fresh = await stateOf(provider)
        const verdict = fresh && (hud ? fresh.hud : fresh.canary)
        if (!fresh || fresh.build !== build || verdict?.state !== 'unproven') return
        await store.upsertProviderState({
          ...fresh,
          ...(hud ? { hud: run.verdict } : { canary: run.verdict }),
          updatedAt: at,
        })
      })
      log.info(`game: ${label(run)}: playing match ${match.id} (${cause})`)
      arm()
      return view(run)
    })().finally(() => starting.delete(slot))
    starting.set(slot, begun)
    return begun
  }

  return {
    async start() {
      stopped = false
      // A canary that cannot start is a line, never a boot that fails: the
      // orchestrator serves matches whatever the canary knows (decision 38).
      let started: Awaited<ReturnType<GameStore['listFacts']>>
      let decided: typeof started
      try {
        await ensureKey()
        // A restart forgets what it was watching; the facts do not. Every run
        // started and never decided is looked at again from its log's start.
        ;[started, decided] = await Promise.all([
          store.listFacts(200, 'game.canary_started'),
          store.listFacts(200, 'game.canary_verdict'),
        ])
      } catch (error) {
        log.error('game: the canary did not start; it is asked again on the next play', error)
        return
      }
      const done = new Set(
        decided.map(row => (row.fact.type === 'game.canary_verdict' ? row.fact.matchId : '')),
      )
      for (const row of started) {
        const fact = row.fact
        if (fact.type !== 'game.canary_started' || done.has(fact.matchId)) continue
        if (runs.has(fact.matchId)) continue
        const slot = runKey(fact.provider, fact.build, fact.hud)
        if (running.has(slot)) continue
        const run: Run = {
          provider: fact.provider,
          build: fact.build,
          hud: fact.hud,
          attempt: fact.attempt,
          matchId: fact.matchId,
          cause: fact.cause,
          startedAt: new Date(fact.observedAt),
          finishedAt: null,
          verdict: { state: 'unproven', build: fact.build, since: fact.observedAt, reason: null },
          afterSeq: 0,
          saw: { ready: false, live: false, round: false },
          hudSaw: { hello: false, loader: false },
          steps: { emptied: false, started: false, filled: false, warmupEnded: false },
          paused: false,
          unpauses: { count: 0, lastAt: null },
          console: [],
        }
        runs.set(run.matchId, run)
        running.set(slot, run)
        log.info(`game: ${label(run)}: picked up after a restart (match ${run.matchId})`)
      }
      arm()
    },
    async stop() {
      stopped = true
      timer?.cancel()
      timer = undefined
      armed = false
      await passing?.catch(() => undefined)
    },
    play,
    providerMoved(provider, build) {
      const updatesItself = registry.get(provider)?.updatesItself === true
      if (!updatesItself) return
      void play({ provider, hud: false, cause: 'build_moved' }).catch((error: unknown) =>
        log.warn(
          `game: the canary for ${provider} on build ${build} did not start: ${failureText(error)}`,
        ),
      )
    },
    async hudAllowed(provider, matchId) {
      const run = runs.get(matchId)
      if (run?.hud && run.provider === provider && run.finishedAt === null) return true
      try {
        const state = await stateOf(provider)
        return (
          state !== undefined &&
          state.build !== null &&
          state.hud.state === 'green' &&
          state.hud.build === state.build
        )
      } catch (error) {
        log.warn(`game: the HUD gate could not read ${provider}'s picture: ${failureText(error)}`)
        return false
      }
    },
    pass,
    runs: () => [...runs.values()].map(view),
  }
}
