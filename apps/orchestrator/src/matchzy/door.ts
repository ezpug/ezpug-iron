import { isTerminalMatchState } from '@ezpug/match-api'
import { MATCHZY_PAYLOAD_MAX, MATCHZY_TOKEN_HEADER } from '@ezpug/protocol'
import type { ServerEventSink } from '../link/channels'
import type { Log } from '../log'
import type { MatchStore } from '../match/store'
import { matchzySerial } from '../match-config/matchzy'
import { hashToken, looksLikeToken } from '../tokens'
import {
  initialMatchZyState,
  type MatchZyState,
  type TranslateOptions,
  translateMatchZyEvent,
} from './translate'

/**
 * **The MatchZy door** — `POST /matchzy/log` (decision 19, PRD-02 T9). The
 * one HTTP path a server speaks to besides its link, because MatchZy 0.8.15
 * only knows how to POST its events to a URL. The core plugin sets
 * `matchzy_remote_log_url` to this path and the header
 * (`MATCHZY_TOKEN_HEADER`) to the server's own link token, from its sidecar;
 * the door hashes the token, finds the ledger row it was minted for, the
 * match that row holds, and hands the translated events to the same sink
 * the link feeds (`matches.ingest`), attributed to the same server — the
 * machine cannot tell which door a fact came through.
 *
 * No API key, no scope: the token is the server's identity, exactly as on
 * the link. It is a header and never the path, so neither the request log
 * nor a proxy's access log holds it. MatchZy sends each event once, with a
 * fifteen-second timeout and no retry, and only reads the status to log it;
 * the door therefore answers `200` for everything it could read — dropped
 * events included, with the reason in the body — and a refusal only for a
 * token it does not know or a body it cannot read.
 *
 * Per-match state (the last score seen, for the round winner) lives in this
 * process and is forgotten when the match ends; a restart between two rounds
 * falls back to the schedule and says so in the log.
 */

export interface MatchZyDoorOptions {
  store: MatchStore
  matches: ServerEventSink
  log: Log
  translate?: TranslateOptions
}

export interface MatchZyDoorRequest {
  /** The token from `MATCHZY_TOKEN_HEADER`, or nothing. */
  token: string | undefined
  /** The raw body. */
  body: string
}

export interface MatchZyDoorAnswer {
  status: number
  body: Record<string, unknown>
}

export interface MatchZyDoor {
  handle: (request: MatchZyDoorRequest) => Promise<MatchZyDoorAnswer>
  /** The header a POST must carry the server token in. */
  readonly tokenHeader: string
}

export function createMatchZyDoor(options: MatchZyDoorOptions): MatchZyDoor {
  const { store, matches, log } = options
  const states = new Map<string, MatchZyState>()

  const refuse = (status: number, error: string): MatchZyDoorAnswer => ({
    status,
    body: { error },
  })

  return {
    tokenHeader: MATCHZY_TOKEN_HEADER,
    async handle(request) {
      const token = request.token?.trim()
      if (!token || !looksLikeToken('server', token)) return refuse(401, 'no server token')
      if (request.body.length > MATCHZY_PAYLOAD_MAX) return refuse(413, 'payload too large')
      const record = await store.findServerTokenByHash(hashToken(token))
      if (!record || record.revokedAt) return refuse(401, 'unknown server token')
      const server = await store.findServer(record.fleetServerId)
      if (!server || server.releasedAt || !server.matchId || !server.serverId) {
        return refuse(409, 'this server holds no match')
      }
      const row = await store.findMatch(server.matchId)
      if (!row || isTerminalMatchState(row.state)) {
        states.delete(server.matchId)
        return refuse(409, 'the match is over')
      }

      let payload: unknown
      try {
        payload = JSON.parse(request.body)
      } catch {
        return refuse(400, 'the body is not JSON')
      }

      const source = { provider: server.provider, serverId: server.serverId }
      const state = states.get(row.id) ?? initialMatchZyState()
      const rules = row.requestJson.rules
      const result = translateMatchZyEvent(
        payload,
        { matchId: row.id, source, serial: matchzySerial(row.id), maps: row.requestJson.maps },
        state,
        {
          ...(rules && {
            regulationRounds: rules.regulationRounds,
            overtimeRounds: rules.overtime.maxRounds,
          }),
          ...options.translate,
        },
      )
      states.set(row.id, result.state)
      if (result.note) log.warn(`matchzy ${result.name} for ${row.id}: ${result.note}`)
      if (result.dropped) {
        log.info(`matchzy ${result.name} for ${row.id} dropped: ${result.dropped}`)
        return { status: 200, body: { accepted: 0, dropped: result.dropped } }
      }

      const statuses: string[] = []
      for (const event of result.events) {
        statuses.push(await matches.ingest(source, event))
        if (event.type === 'series_end') states.delete(row.id)
      }
      return { status: 200, body: { accepted: result.events.length, statuses } }
    },
  }
}
