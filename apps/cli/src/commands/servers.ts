import { type FleetServer, ledgerFilterSchema, pageQuerySchema } from '@ezpug/match-api'
import { boolFlag, flag } from '../args'
import type { CommandContext } from '../context'
import { CliUsageError, EXIT } from '../exit'
import { euros, orDash } from '../output'

/**
 * **`ezpug-iron servers`** — the ledger, which is the truth about what is
 * running and what it costs (CLAUDE.md, "every server is a ledger row").
 *
 * - `list` reads the open rows; `--all` reads the ledger itself, closed rows
 *   included, and `--since` narrows it to a window — "what did tonight cost"
 *   is that read with the evening's timestamp.
 * - `kill` is `POST /v1/fleet/servers/:id/release`: deallocate now, whatever
 *   the match thinks. It is the button an operator presses at 2 a.m. when
 *   something is burning money, so it prints what it is about to kill and
 *   ends with the row it closed.
 * - `console` is the bounded tail the orchestrator caches off the server's
 *   link — the operator fallback beside RCON (`matches command … rcon`),
 *   never a second control channel.
 */

export const SERVERS_USAGE = `ezpug-iron servers — the fleet ledger: what is running, what it cost

  servers list [--all] [--provider <id>] [--state <state>] [--match <id>]
               [--since <iso>] [--limit <n>] [--cursor <c>]
  servers kill <serverId> [--reason <text>]
  servers console <serverId> [--lines <n>]

\`list\` reads the open rows; --all reads the ledger, closed rows included.
<serverId> is the ledger row's id or the provider's own handle — both are
columns of \`servers list\`.`

export async function runServers(context: CommandContext): Promise<number> {
  const [verb, argument] = context.args.positionals.slice(1)
  switch (verb) {
    case 'list':
      return await list(context)
    case 'kill':
      return await kill(context, argument)
    case 'console':
      return await console_(context, argument)
    default:
      throw new CliUsageError(
        verb === undefined ? 'servers needs a verb' : `unknown verb 'servers ${verb}'`,
        SERVERS_USAGE,
      )
  }
}

const ledgerQuerySchema = pageQuerySchema.extend(ledgerFilterSchema.shape)

async function list(context: CommandContext): Promise<number> {
  const { args, out } = context
  const client = context.client()
  if (boolFlag(args, 'all')) {
    const parsed = ledgerQuerySchema.safeParse({
      state: flag(args, 'state'),
      provider: flag(args, 'provider'),
      matchId: flag(args, 'match'),
      since: flag(args, 'since'),
      cursor: flag(args, 'cursor'),
      limit: flag(args, 'limit'),
    })
    if (!parsed.success)
      throw new CliUsageError(
        `servers list --all:\n${issuesOf(parsed.error.issues)}`,
        SERVERS_USAGE,
      )
    const page = await client.fleet.ledger({ query: parsed.data })
    printServers(context, page.items)
    if (page.nextCursor) out.say(`\nmore: --cursor ${page.nextCursor}`)
    out.emit(page)
    return EXIT.ok
  }

  const { servers } = await client.fleet.servers.list()
  printServers(context, servers)
  out.emit({ servers })
  return EXIT.ok
}

function printServers(context: CommandContext, servers: readonly FleetServer[]): void {
  context.out.table(
    [
      'id',
      'provider',
      'serverId',
      'state',
      'match',
      'address',
      'cost/h',
      'accrued',
      'allocated',
      'released',
    ],
    servers.map(server => [
      server.id,
      server.provider + (server.node ? `/${server.node}` : ''),
      orDash(server.serverId),
      server.state,
      orDash(server.matchId),
      server.address ? `${server.address.host}:${server.address.port}` : '—',
      euros(server.cost.hourlyCents),
      euros(server.cost.accruedCents),
      server.allocatedAt,
      orDash(server.releasedAt),
    ]),
  )
}

async function kill(context: CommandContext, serverId: string | undefined): Promise<number> {
  if (!serverId) throw new CliUsageError('servers kill needs a server id', SERVERS_USAGE)
  const reason = flag(context.args, 'reason')
  const server = await context
    .client()
    .fleet.servers.release({ params: { serverId }, body: reason === undefined ? {} : { reason } })
  context.out.say(
    `released ${server.id} on ${server.provider} — ${server.state}` +
      `${server.releasedAt ? ` at ${server.releasedAt}` : ''}` +
      `${server.matchId ? `; match ${server.matchId} ends provider_error` : ''}`,
  )
  context.out.emit(server)
  return EXIT.ok
}

async function console_(context: CommandContext, serverId: string | undefined): Promise<number> {
  if (!serverId) throw new CliUsageError('servers console needs a server id', SERVERS_USAGE)
  const { lines } = await context.client().fleet.servers.console({ params: { serverId } })
  const raw = flag(context.args, 'lines')
  const tail = raw === undefined ? lines : lines.slice(-Math.max(Number(raw), 0))
  for (const line of tail) context.out.say(`${line.at}  ${line.line}`)
  if (tail.length === 0) context.out.say('(the orchestrator has no console lines for this server)')
  context.out.emit({ lines: tail })
  return EXIT.ok
}

function issuesOf(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 10)
    .map(issue => `  ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
}
