import {
  type Match,
  type MatchCommand,
  matchCommandSchema,
  matchListFilterSchema,
  matchRequestSchema,
  pageQuerySchema,
  STREAM_CLOSE_CODES,
  type StreamFrame,
} from '@ezpug/match-api'
import { boolFlag, flag } from '../args'
import type { CommandContext } from '../context'
import { CliUsageError, EXIT } from '../exit'
import { orDash } from '../output'

/**
 * **`ezpug-iron matches`** — the `matches` scope's verbs: ask for a match,
 * read one, watch one live, cancel one, tell one what to do.
 *
 * **Create takes a document, not thirty flags.** A match request is a
 * rosters-and-rules structure (`matchRequestSchema`): two teams with
 * SteamID64s, locales and loadouts, a map plan, a webhook URL and the id of
 * a registered secret. A flag surface over that would be a second, worse
 * schema that drifts from the first. So `--file` takes the JSON the platform
 * would have POSTed — `-` reads stdin — and the only flags are the two
 * things an operator genuinely re-decides between runs
 * (`--client-match-id`, `--ttl-minutes`), which are patched onto the
 * document before it is validated here and again by the server.
 *
 * **Watch is the stream, not a poll.** `GET /v1/matches/:id/stream` is best
 * effort by contract: the first frame is a `hello` carrying the last durable
 * `seq`, and anything missed is fetched from the events route. This verb
 * prints frames until the socket closes, and says which close code closed
 * it, so an operator can tell "the match ended" (4000) from "the network
 * went" (1006). Position ticks are off unless `--ticks` asks: they are the
 * ephemeral tier, several a second, and they are never stored anywhere.
 * Under `--json` the pipe carries stream frames and nothing else — the close
 * is the exit code's to report, so `| jq` never meets a line that is not a
 * frame.
 */

export const MATCHES_USAGE = `ezpug-iron matches — ask for a match, read it, watch it, command it

  matches create --file <path|->         a Match API request document (JSON)
                 [--client-match-id <id>] [--ttl-minutes <n>]
  matches list [--state <state>] [--client-match-id <id>] [--limit <n>] [--cursor <c>]
  matches get <matchId>
  matches watch <matchId> [--ticks]      the live stream until it closes
  matches cancel <matchId>
  matches command <matchId> <type> [fields]

Commands and the fields they take:
  pause [--kind <kind>]            unpause                  restart_round
  reroll                           force_end [--reason <t>]
  kick --steam-id <id> [--reason <t>]                       announce --text <t>
  rcon --command <line>            (needs the admin scope; refused on a sim)
  restore [--round <n>]            profile --file <path|->   (one roster entry)
  sim.step  sim.kill  sim.mode --mode <m>  sim.speed --time-scale <x>
  sim.chaos --chaos <json|none>    (the sim provider only)`

/** `GET /v1/matches`' query, as the route declares it. */
const matchListQuerySchema = pageQuerySchema.extend(matchListFilterSchema.shape)

export async function runMatches(context: CommandContext): Promise<number> {
  const [verb, argument, third] = context.args.positionals.slice(1)
  switch (verb) {
    case 'create':
      return await create(context)
    case 'list':
      return await list(context)
    case 'get':
      return await get(context, argument)
    case 'watch':
      return await watch(context, argument)
    case 'cancel':
      return await cancel(context, argument)
    case 'command':
      return await command(context, argument, third)
    default:
      throw new CliUsageError(
        verb === undefined ? 'matches needs a verb' : `unknown verb 'matches ${verb}'`,
        MATCHES_USAGE,
      )
  }
}

// ---------------------------------------------------------------------------
// create, list, get, cancel
// ---------------------------------------------------------------------------

async function create(context: CommandContext): Promise<number> {
  const { args, out } = context
  const path = flag(args, 'file')
  if (!path) throw new CliUsageError('matches create needs --file <path|-> ', MATCHES_USAGE)
  const document = await readJson(context, path, 'the match request')

  const clientMatchId = flag(args, 'client-match-id')
  const ttlMinutes = flag(args, 'ttl-minutes')
  const patched = {
    ...(document as Record<string, unknown>),
    ...(clientMatchId !== undefined && { clientMatchId }),
    ...(ttlMinutes !== undefined && { ttlMinutes: Number(ttlMinutes) }),
  }
  // Parsed here as well as by the orchestrator: a typo in a roster should
  // print the field it is in, on this box, before a request goes out.
  const parsed = matchRequestSchema.safeParse(patched)
  if (!parsed.success)
    throw new CliUsageError(`${path} is not a match request:\n${issuesOf(parsed.error.issues)}`)

  const match = await context.client().matches.create({ body: parsed.data })
  out.say(`created ${match.id} (${match.clientMatchId}) — ${match.state}, ${match.gamemode}`)
  out.say(`watch it: ezpug-iron matches watch ${match.id}`)
  out.emit(match)
  return EXIT.ok
}

async function list(context: CommandContext): Promise<number> {
  const { args, out } = context
  // The route's own query schema, so a bad `--state` is named here with the
  // set it had to come from instead of travelling as a 400.
  const parsed = matchListQuerySchema.safeParse({
    state: flag(args, 'state'),
    clientMatchId: flag(args, 'client-match-id'),
    cursor: flag(args, 'cursor'),
    limit: flag(args, 'limit'),
  })
  if (!parsed.success)
    throw new CliUsageError(`matches list: \n${issuesOf(parsed.error.issues)}`, MATCHES_USAGE)
  const page = await context.client().matches.list({ query: parsed.data })
  out.table(
    ['id', 'clientMatchId', 'state', 'gamemode', 'provider', 'created', 'ended'],
    page.items.map(match => [
      match.id,
      match.clientMatchId,
      match.state,
      match.gamemode,
      orDash(match.provider),
      match.createdAt,
      match.endedReason ? endedReasonText(match.endedReason) : orDash(match.endedAt),
    ]),
  )
  if (page.nextCursor) out.say(`\nmore: --cursor ${page.nextCursor}`)
  out.emit(page)
  return EXIT.ok
}

async function get(context: CommandContext, matchId: string | undefined): Promise<number> {
  if (!matchId) throw new CliUsageError('matches get needs the match id', MATCHES_USAGE)
  const match = await context.client().matches.get({ params: { matchId } })
  describe(context, match)
  context.out.emit(match)
  return EXIT.ok
}

async function cancel(context: CommandContext, matchId: string | undefined): Promise<number> {
  if (!matchId) throw new CliUsageError('matches cancel needs the match id', MATCHES_USAGE)
  const match = await context.client().matches.cancel({ params: { matchId } })
  context.out.say(
    `${match.id} is ${match.state}${match.endedReason ? ` (${endedReasonText(match.endedReason)})` : ''}`,
  )
  context.out.emit(match)
  return EXIT.ok
}

/** `{ kind, detail? }` as one word for a column, the detail behind a colon. */
function endedReasonText(reason: NonNullable<Match['endedReason']>): string {
  return reason.detail ? `${reason.kind}: ${reason.detail}` : reason.kind
}

/** The one-screen picture of a match: what it is, where it landed, how to join it. */
function describe(context: CommandContext, match: Match): void {
  const { out } = context
  out.say(
    `${match.id}  ${match.state}${match.endedReason ? ` (${endedReasonText(match.endedReason)})` : ''}`,
  )
  out.say(`client id     ${match.clientMatchId}`)
  out.say(`gamemode      ${match.gamemode} on ${match.game}`)
  out.say(`provider      ${orDash(match.provider)}${match.serverId ? ` / ${match.serverId}` : ''}`)
  out.say(`ledger row    ${orDash(match.fleetServerId)}`)
  out.say(
    match.connect
      ? `connect       ${match.connect.host}:${match.connect.port}${match.connect.password ? ' (password set — not shown)' : ''}`
      : 'connect       — (not ready yet)',
  )
  if (match.tv) out.say(`gotv          ${match.tv.host}:${match.tv.port}`)
  out.say(`seq           ${match.seq}`)
  out.say(`created       ${match.createdAt}`)
  out.say(`ready / live  ${orDash(match.readyAt)} / ${orDash(match.liveAt)}`)
  out.say(`ends by       ${match.expiresAt}${match.endedAt ? ` (ended ${match.endedAt})` : ''}`)
  if (match.sim) out.say(`sim           ${JSON.stringify(match.sim)}`)
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

const CLOSE_REASONS: Readonly<Record<number, string>> = {
  [STREAM_CLOSE_CODES.matchEnded]: 'the match reached a terminal state',
  [STREAM_CLOSE_CODES.unauthorized]: 'the key was not accepted',
  [STREAM_CLOSE_CODES.forbidden]: 'the key lacks the scope, or the origin is not allowed',
  [STREAM_CLOSE_CODES.notFound]: 'no such match for this key',
  [STREAM_CLOSE_CODES.slowConsumer]: 'this subscriber fell behind and was dropped',
  1000: 'closed from here',
  1006: 'the socket dropped — reconnect and replay from `matches` events',
}

async function watch(context: CommandContext, matchId: string | undefined): Promise<number> {
  if (!matchId) throw new CliUsageError('matches watch needs the match id', MATCHES_USAGE)
  const { out } = context
  const ticks = boolFlag(context.args, 'ticks')

  const subscription = context.client().subscribeStream({
    matchId,
    onFrame: frame => {
      if (frame.type === 'tick' && !ticks) return
      out.emitLine(frame)
      out.say(describeFrame(frame))
    },
    onError: error => out.warn(`stream: ${error instanceof Error ? error.message : String(error)}`),
  })
  out.say(
    `watching ${matchId} — Ctrl-C to stop${ticks ? '' : ' (position ticks hidden; --ticks shows them)'}`,
  )

  const disarm = context.onSignal(() => subscription.close())
  try {
    const closed = await subscription.closed
    const why = CLOSE_REASONS[closed.code] ?? closed.reason
    out.say(`stream closed ${closed.code}${why ? ` — ${why}` : ''}`)
    // A stream that ended because the match did is a success; one that was
    // refused is the same refusal the routes would have given.
    return closed.code === STREAM_CLOSE_CODES.unauthorized ||
      closed.code === STREAM_CLOSE_CODES.forbidden ||
      closed.code === STREAM_CLOSE_CODES.notFound
      ? EXIT.refused
      : EXIT.ok
  } finally {
    disarm()
  }
}

function describeFrame(frame: StreamFrame): string {
  switch (frame.type) {
    case 'hello':
      return `hello         ${frame.matchId} is ${frame.state}, seq ${frame.seq}`
    case 'event': {
      const { seq, occurredAt, payload } = frame.envelope
      const { type, ...rest } = payload
      const detail = JSON.stringify(rest)
      return `${String(seq).padStart(4)} ${occurredAt} ${type} ${detail === '{}' ? '' : truncate(detail, 120)}`.trimEnd()
    }
    case 'tick':
      return `tick          ${frame.ticks.length} position(s)`
    case 'command_result':
      return `result        ${frame.result.correlationId} ${frame.result.type} ${frame.result.status}`
    case 'presence':
      return `presence      ${frame.players.length} on the server`
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

/**
 * Which flag fills which field, per command type. The table exists so the
 * usage block above and the parser cannot drift; the *shape* is still
 * `matchCommandSchema`'s, parsed below, so a field this table gets wrong is
 * a validation error with a path and not a silent misfire.
 */
type FieldKind = 'string' | 'number' | 'json' | 'file'
const COMMAND_FIELDS: Readonly<
  Record<string, readonly { flag: string; key: string; kind: FieldKind }[]>
> = {
  pause: [{ flag: 'kind', key: 'kind', kind: 'string' }],
  unpause: [],
  restart_round: [],
  reroll: [],
  force_end: [{ flag: 'reason', key: 'reason', kind: 'string' }],
  kick: [
    { flag: 'steam-id', key: 'steamId64', kind: 'string' },
    { flag: 'reason', key: 'reason', kind: 'string' },
  ],
  announce: [{ flag: 'text', key: 'text', kind: 'string' }],
  rcon: [{ flag: 'command', key: 'command', kind: 'string' }],
  restore: [{ flag: 'round', key: 'roundNumber', kind: 'number' }],
  profile: [{ flag: 'file', key: 'player', kind: 'file' }],
  'sim.step': [],
  'sim.kill': [],
  'sim.mode': [{ flag: 'mode', key: 'mode', kind: 'string' }],
  'sim.speed': [{ flag: 'time-scale', key: 'timeScale', kind: 'number' }],
  'sim.chaos': [{ flag: 'chaos', key: 'chaos', kind: 'json' }],
}

async function command(
  context: CommandContext,
  matchId: string | undefined,
  type: string | undefined,
): Promise<number> {
  if (!matchId) throw new CliUsageError('matches command needs the match id', MATCHES_USAGE)
  if (!type) throw new CliUsageError('matches command needs a command type', MATCHES_USAGE)
  const fields = COMMAND_FIELDS[type]
  if (!fields)
    throw new CliUsageError(
      `unknown command '${type}'. One of: ${Object.keys(COMMAND_FIELDS).join(', ')}`,
      MATCHES_USAGE,
    )

  const body: Record<string, unknown> = { type, correlationId: context.newId() }
  for (const field of fields) {
    const raw = flag(context.args, field.flag)
    if (raw === undefined) continue
    body[field.key] =
      field.kind === 'number'
        ? Number(raw)
        : field.kind === 'json'
          ? raw === 'none'
            ? null
            : parseJson(raw, `--${field.flag}`)
          : field.kind === 'file'
            ? await readJson(context, raw, `--${field.flag}`)
            : raw
  }

  const parsed = matchCommandSchema.safeParse(body)
  if (!parsed.success)
    throw new CliUsageError(
      `${type} is missing or has a bad field:\n${issuesOf(parsed.error.issues)}`,
      MATCHES_USAGE,
    )

  const result = await context
    .client()
    .matches.command({ params: { matchId }, body: parsed.data as MatchCommand })
  context.out.say(
    `${result.type} ${result.status}${result.code ? ` ${result.code}` : ''}` +
      `${result.message ? ` — ${result.message}` : ''}`,
  )
  if (result.output !== undefined && result.output !== '') context.out.say(result.output)
  if (result.sim) context.out.say(`sim           ${JSON.stringify(result.sim)}`)
  if (result.status === 'accepted')
    context.out.say(
      `the server answers later; watch for correlationId ${result.correlationId} on the stream`,
    )
  context.out.emit(result)
  // A rejected command is not a broken call — the route answered 200 — but a
  // shell script that pauses a match and carries on regardless is a bug.
  return result.status === 'rejected' ? EXIT.refused : EXIT.ok
}

// ---------------------------------------------------------------------------

async function readJson(context: CommandContext, path: string, what: string): Promise<unknown> {
  return parseJson(await context.readInput(path), `${what} (${path === '-' ? 'stdin' : path})`)
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CliUsageError(`${what} is not JSON: ${error instanceof Error ? error.message : ''}`)
  }
}

function issuesOf(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 10)
    .map(issue => `  ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
}
