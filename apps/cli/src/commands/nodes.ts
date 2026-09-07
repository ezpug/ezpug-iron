import { boolFlag, flag, flags } from '../args'
import type { CommandContext } from '../context'
import { CliUsageError, EXIT } from '../exit'
import { orDash } from '../output'

/**
 * **`ezpug-iron nodes`** — the self-hosted half of the fleet (decision 23,
 * `docs/nodes.md`).
 *
 * `enrol-token` is the one verb here that mints a secret. The token comes
 * back once, is shown once, and is typed into `ezpug-node enrol <token>` on
 * the venue box; nothing serves it again and nothing here echoes it back.
 * That is the whole enrolment: a node has no inbound port and no password —
 * it dials out with this token and is a ledger participant from then on.
 *
 * `drain` (and `--undrain`) is the lever before an event ends: stop placing
 * matches here, let the running ones finish, then unplug the box.
 *
 * `remove` is the end of that evening (PRD-02 T37b): the token is revoked,
 * the socket the agent holds is closed in force and the row is gone. It is
 * the one verb here that undoes an enrolment, and the rehearsal needed it
 * with no way to type it — `docs/nodes.md` had to send an operator to
 * `curl`.
 */

export const NODES_USAGE = `ezpug-iron nodes — self-hosted capacity (docs/nodes.md)

  nodes enrol-token --id <node-id> --region <region> [--label k=v]...
  nodes list
  nodes drain <nodeId> [--undrain]
  nodes remove <nodeId>

The enrolment token is printed once. On the venue box:
  EZPUG_NODE_ORCHESTRATOR_URL=<this orchestrator> ezpug-node enrol <token>

Drain before you remove: remove revokes the token and hangs up on the agent,
but the containers it was running keep running — they belong to the ledger,
not to the agent. On the venue box, docker stop the agent afterwards, or the
restart policy dials it straight back into a refusal.`

export async function runNodes(context: CommandContext): Promise<number> {
  const [verb, argument] = context.args.positionals.slice(1)
  switch (verb) {
    case 'enrol-token':
    case 'enroll-token':
      return await enrolToken(context)
    case 'list':
      return await list(context)
    case 'drain':
      return await drain(context, argument)
    case 'remove':
      return await remove(context, argument)
    default:
      throw new CliUsageError(
        verb === undefined ? 'nodes needs a verb' : `unknown verb 'nodes ${verb}'`,
        NODES_USAGE,
      )
  }
}

async function enrolToken(context: CommandContext): Promise<number> {
  const { args, out } = context
  const id = flag(args, 'id')
  const region = flag(args, 'region')
  if (!id) throw new CliUsageError('nodes enrol-token needs --id', NODES_USAGE)
  if (!region) throw new CliUsageError('nodes enrol-token needs --region', NODES_USAGE)

  const labels: Record<string, string> = {}
  for (const pair of flags(args, 'label')) {
    const equals = pair.indexOf('=')
    if (equals < 1) throw new CliUsageError(`--label takes key=value; got '${pair}'`, NODES_USAGE)
    labels[pair.slice(0, equals)] = pair.slice(equals + 1)
  }

  const enrolment = await context.client().fleet.nodes.enrol({ body: { id, region, labels } })
  out.say(`enrolled ${enrolment.node.id} in ${enrolment.node.region}`)
  out.reveal(
    'The enrolment token, once:',
    enrolment.token,
    `On the node: EZPUG_NODE_ORCHESTRATOR_URL=${context.baseUrl()} ezpug-node enrol <token>`,
  )
  out.emit(enrolment)
  return EXIT.ok
}

async function list(context: CommandContext): Promise<number> {
  const { nodes } = await context.client().fleet.nodes.list()
  context.out.table(
    ['id', 'region', 'version', 'link', 'drained', 'capacity', 'matches', 'labels', 'last seen'],
    nodes.map(node => [
      node.id,
      node.region,
      orDash(node.version),
      node.connected ? 'up' : 'down',
      node.drained ? 'yes' : 'no',
      `${node.capacity.inUse}/${node.capacity.total}${node.capacity.warm ? ` +${node.capacity.warm} warm` : ''}`,
      String(node.currentMatches.length),
      Object.entries(node.labels)
        .map(([key, value]) => `${key}=${value}`)
        .join(',') || '—',
      orDash(node.lastSeenAt),
    ]),
  )
  context.out.emit({ nodes })
  return EXIT.ok
}

async function drain(context: CommandContext, nodeId: string | undefined): Promise<number> {
  if (!nodeId) throw new CliUsageError('nodes drain needs the node id', NODES_USAGE)
  const undrain = boolFlag(context.args, 'undrain')
  const fleet = context.client().fleet.nodes
  const node = undrain
    ? await fleet.undrain({ params: { nodeId } })
    : await fleet.drain({ params: { nodeId } })
  context.out.say(
    node.drained
      ? `${node.id} is draining — no new match lands here; ${node.currentMatches.length} still running`
      : `${node.id} takes matches again`,
  )
  context.out.emit(node)
  return EXIT.ok
}

/**
 * **Un-enrol** (`DELETE /v1/fleet/nodes/:nodeId`). The row goes, the token is
 * revoked, the agent's socket is closed `4009` and every dial after it is
 * refused `4001` — both fatal by design, so the agent exits and `docker stop`
 * is what keeps its restart policy from dialling into the refusal forever.
 *
 * What it does *not* do is stop anything that is playing: the containers on
 * that box belong to the orchestrator's ledger, and a match killed by an
 * un-enrolment would be a match nobody asked to end. Hence the warning, and
 * hence `drain` first.
 */
async function remove(context: CommandContext, nodeId: string | undefined): Promise<number> {
  if (!nodeId) throw new CliUsageError('nodes remove needs the node id', NODES_USAGE)
  await context.client().fleet.nodes.revoke({ params: { nodeId } })
  context.out.say(
    `${nodeId} is un-enrolled — its token is revoked and its agent is disconnected. ` +
      'Whatever it was running keeps running; on the venue box, `docker stop` the agent.',
  )
  context.out.emit({ ok: true, nodeId })
  return EXIT.ok
}
