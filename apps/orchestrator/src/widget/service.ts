import type { Clock } from '@ezpug/core'
import type {
  Locale,
  WidgetCloseCode,
  WidgetCommandFrame,
  WidgetCommandRefusal,
  WidgetCommandState,
  WidgetServerFrame,
} from '@ezpug/match-api'
import {
  DEFAULT_LOCALE,
  isTerminalMatchState,
  WIDGET_CLOSE_CODES,
  WIDGET_COMMAND_RATE_LIMIT,
  WIDGET_SOCKET_PROTOCOL,
} from '@ezpug/match-api'
import { createRateLimiter, type RateLimiter } from '../http/rate-limit'
import type { Log } from '../log'
import type { Matches, WidgetTapOutcome } from '../match/machine'
import type { MatchStore } from '../match/store'
import type { StreamHub } from '../stream/hub'
import { hashToken, looksLikeToken } from '../tokens'

/**
 * **The widget socket's behaviour, without the socket** (decision 17, PRD-02
 * T24): a session opens with the player token from the widget's `hello`,
 * answers with the mode's verbs and their state, forwards every durable
 * fact of the match as an `event` frame, and relays each tap to the plugin
 * through the machine, answering with a `command_result`. `widget/upgrade.ts`
 * is the socket around this; the conformance target uses it in-process.
 *
 * What is decided here: a token must look like ours, hash to a row, be
 * unexpired and unrevoked; its match must exist and — for a browser — allow
 * the socket's origin; a token over {@link WIDGET_COMMAND_RATE_LIMIT} is
 * answered `rate_limited` rather than relayed; a tap on a match that is not
 * `live` is `not_live`; the refusals the orchestrator makes itself are said
 * in the player's language from the roster profile, German by default. The
 * `hello` reports what this process last learned about each verb's charges
 * and cooldown for this player, from the results it relayed; the SDK is the
 * truth and the widget treats it as a hint. A token dies with the match: the
 * hub's close for the match ends every session on it.
 */

export interface WidgetSubscriber {
  send: (frame: WidgetServerFrame) => void
  close: (code: WidgetCloseCode, reason: string) => void
}

export interface WidgetSession {
  /** A `command` frame from the widget; resolves once the `command_result` was sent. */
  command: (frame: WidgetCommandFrame) => Promise<void>
  /** The widget hung up. */
  close: () => void
}

export interface WidgetOpenRequest {
  token: string
  /** The browser's `Origin` header, when there was one. */
  origin?: string | undefined
}

export type WidgetOpenResult =
  | { ok: true; session: WidgetSession }
  | { ok: false; code: WidgetCloseCode; reason: string }

export interface WidgetServiceOptions {
  clock: Clock
  log: Log
  store: MatchStore
  matches: Matches
  hub: StreamHub
}

export interface WidgetService {
  /** Open a session for a token; the `hello` is sent before this resolves. */
  open: (request: WidgetOpenRequest, subscriber: WidgetSubscriber) => Promise<WidgetOpenResult>
  /** Sessions open in this process, in all or for one match. */
  size: (matchId?: string) => number
  /** End every session with the code — the drain. */
  close: (code: WidgetCloseCode, reason: string) => void
}

/** What a door refusal says on the phone, both languages. */
const DOOR_LINES: Record<
  Locale,
  Record<
    Extract<WidgetCommandRefusal, 'rate_limited' | 'not_live' | 'unavailable' | 'unknown_command'>,
    string
  >
> = {
  de: {
    rate_limited: 'Zu viele Eingaben – kurz warten.',
    not_live: 'Das Match läuft gerade nicht.',
    unavailable: 'Der Server hat nicht geantwortet – noch einmal versuchen.',
    unknown_command: 'Diesen Befehl gibt es nicht.',
  },
  en: {
    rate_limited: 'Too many taps – wait a moment.',
    not_live: 'The match is not live right now.',
    unavailable: 'The server did not answer – try again.',
    unknown_command: 'No such command.',
  },
}

/** The door's refusal in the player's language; the SDK's refusals arrive already said. */
export function widgetDoorLine(
  code: keyof (typeof DOOR_LINES)['de'],
  locale: Locale | undefined,
): string {
  return DOOR_LINES[locale ?? DEFAULT_LOCALE][code]
}

/** What this process last learned about one player's use of one verb. */
interface VerbMemory {
  chargesLeft: number | null
  readyAt: number
}

export function createWidgetService(options: WidgetServiceOptions): WidgetService {
  const { clock, log, store, matches, hub } = options
  /** Open sessions by match, each with the way to end it and tell its socket why. */
  const sessions = new Map<string, Set<(code: WidgetCloseCode, reason: string) => void>>()
  /** `<matchId>#<steamId64>#<verb>` → what the last relayed result said. */
  const memory = new Map<string, VerbMemory>()
  /** One bucket per token hash — the token itself is never a map key. */
  const limiter: RateLimiter = createRateLimiter({ clock, ...WIDGET_COMMAND_RATE_LIMIT })

  const remember = (
    matchId: string,
    steamId64: string,
    command: string,
    spec: { cooldownMs: number; charges: { count: number } | null },
    outcome: WidgetTapOutcome,
  ): void => {
    const key = `${matchId}#${steamId64}#${command}`
    const previous = memory.get(key)
    const chargesLeft =
      outcome.chargesLeft ?? previous?.chargesLeft ?? (spec.charges ? spec.charges.count : null)
    let readyAt = previous?.readyAt ?? 0
    if (outcome.status === 'applied') readyAt = clock.now() + spec.cooldownMs
    else if (outcome.code === 'cooldown' && outcome.cooldownMs !== undefined)
      readyAt = clock.now() + outcome.cooldownMs
    memory.set(key, { chargesLeft, readyAt })
  }

  const commandsOf = (
    matchId: string,
    steamId64: string,
    specs: WidgetCommandState[] | readonly Omit<WidgetCommandState, 'chargesLeft' | 'readyInMs'>[],
  ): WidgetCommandState[] =>
    specs.map(spec => {
      const known = memory.get(`${matchId}#${steamId64}#${spec.name}`)
      return {
        ...spec,
        chargesLeft: known ? known.chargesLeft : (spec.charges?.count ?? null),
        readyInMs: known ? Math.max(0, known.readyAt - clock.now()) : 0,
      }
    })

  const track = (
    matchId: string,
    end: (code: WidgetCloseCode, reason: string) => void,
  ): (() => void) => {
    let set = sessions.get(matchId)
    if (!set) {
      set = new Set()
      sessions.set(matchId, set)
    }
    set.add(end)
    return () => {
      const current = sessions.get(matchId)
      current?.delete(end)
      if (current?.size === 0) sessions.delete(matchId)
    }
  }

  const open: WidgetService['open'] = async (request, subscriber) => {
    const refused = (code: WidgetCloseCode, reason: string): WidgetOpenResult => ({
      ok: false,
      code,
      reason,
    })
    const { token } = request
    if (!looksLikeToken('player', token))
      return refused(WIDGET_CLOSE_CODES.unauthorized, 'not a player token')
    const tokenHash = hashToken(token)
    const record = await store.findPlayerTokenByHash(tokenHash)
    if (!record || record.revokedAt || record.expiresAt.getTime() <= clock.now())
      return refused(WIDGET_CLOSE_CODES.unauthorized, 'no such player token')
    const facts = await matches.widgetFacts(record.matchId, record.steamId64)
    if (!facts) return refused(WIDGET_CLOSE_CODES.unauthorized, 'no such match')
    const { row, manifest, profile } = facts
    const allowed = row.requestJson.callbacks.streamAllowedOrigins
    // The platform mounts the widget in a sandboxed frame without
    // `allow-same-origin` (decision 17, `docs/gamemodes.md` "The widget
    // host"), whose origin is opaque: the browser sends the literal `null`.
    // That is the widget's own door, not a stranger's — the token is the
    // credential here, and an allow-list of page origins cannot name a
    // frame that has none (T25).
    if (
      request.origin !== undefined &&
      request.origin !== 'null' &&
      allowed !== undefined &&
      !allowed.includes(request.origin)
    )
      return refused(WIDGET_CLOSE_CODES.forbidden, 'origin not allowed')
    const locale = profile?.locale
    const { matchId, steamId64 } = record

    // Subscribed before the hello is built and every frame held behind it
    // (the stream's ordering promise, `stream/upgrade.ts`): nothing published
    // in between is missed, and the hello is the first frame.
    let greeted = false
    let closed = false
    const held: WidgetServerFrame[] = []
    let untrack: (() => void) | undefined
    let unsubscribe: (() => void) | undefined
    const end = (code: WidgetCloseCode, reason: string): void => {
      if (closed) return
      closed = true
      unsubscribe?.()
      untrack?.()
      subscriber.close(code, reason)
    }
    const send = (frame: WidgetServerFrame): void => {
      if (closed) return
      if (!greeted) {
        held.push(frame)
        return
      }
      subscriber.send(frame)
    }
    unsubscribe = hub.subscribe(matchId, {
      send: frame => {
        if (frame.type === 'event') send({ type: 'event', envelope: frame.envelope })
      },
      close: () => end(WIDGET_CLOSE_CODES.matchEnded, 'the match is over'),
    })

    const fresh = (await store.findMatch(matchId)) ?? row
    subscriber.send({
      type: 'hello',
      protocol: WIDGET_SOCKET_PROTOCOL,
      matchId,
      steamId64,
      gamemode: manifest.id,
      state: fresh.state,
      ...(locale !== undefined && { locale }),
      commands: commandsOf(matchId, steamId64, manifest.commands),
    })
    greeted = true
    for (const frame of held.splice(0)) {
      if (frame.type === 'event' && frame.envelope.seq <= fresh.seq) continue
      subscriber.send(frame)
    }
    if (isTerminalMatchState(fresh.state)) {
      end(WIDGET_CLOSE_CODES.matchEnded, 'the match is over')
      return { ok: true, session: { command: () => Promise.resolve(), close: () => undefined } }
    }

    const session: WidgetSession = {
      async command(frame) {
        if (closed) return
        const answer = (outcome: WidgetTapOutcome): void =>
          send({
            type: 'command_result',
            correlationId: frame.correlationId,
            command: frame.command,
            ...outcome,
          })
        if (record.expiresAt.getTime() <= clock.now()) {
          end(WIDGET_CLOSE_CODES.unauthorized, 'the player token expired')
          return
        }
        const taken = limiter.take(tokenHash)
        if (!taken.ok) {
          answer({
            status: 'rejected',
            code: 'rate_limited',
            message: widgetDoorLine('rate_limited', locale),
            cooldownMs: taken.retryAfterMs,
          })
          return
        }
        const outcome = await matches.playerCommand(matchId, {
          correlationId: frame.correlationId,
          steamId64,
          command: frame.command,
          ...(frame.args && { args: frame.args }),
        })
        const spec = manifest.commands.find(command => command.name === frame.command)
        if (spec) remember(matchId, steamId64, frame.command, spec, outcome)
        if (outcome.message === undefined && outcome.code !== undefined) {
          const code = outcome.code
          if (
            code === 'rate_limited' ||
            code === 'not_live' ||
            code === 'unavailable' ||
            code === 'unknown_command'
          )
            answer({ ...outcome, message: widgetDoorLine(code, locale) })
          else answer(outcome)
        } else answer(outcome)
      },
      close() {
        if (closed) return
        closed = true
        unsubscribe?.()
        untrack?.()
      },
    }
    untrack = track(matchId, end)
    log.info(`widget ${matchId} ${steamId64} joined`)
    return { ok: true, session }
  }

  return {
    open,
    size: matchId => {
      if (matchId !== undefined) return sessions.get(matchId)?.size ?? 0
      let total = 0
      for (const set of sessions.values()) total += set.size
      return total
    },
    close: (code, reason) => {
      for (const set of [...sessions.values()]) for (const end of [...set]) end(code, reason)
    },
  }
}
