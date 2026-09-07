import { type MatchApiScope, matchApiScopesSchema } from '@ezpug/match-api'
import { flag } from '../args'
import type { CommandContext } from '../context'
import { CliUsageError, EXIT } from '../exit'
import { euros, orDash } from '../output'

/**
 * **`ezpug-iron keys`** — the `admin` scope's own verbs (decision 7): mint a
 * key, list what exists, revoke one.
 *
 * The mint's flag names and defaults are the orchestrator's
 * `keys:mint` script's, deliberately: an operator who learned the first door
 * on a box with no CLI does not have to learn a second vocabulary when the
 * CLI arrives, and the two cannot disagree about what an unstated ceiling is.
 *
 * **No webhook secret is a flag here.** A key's webhook secrets are secrets
 * and the rule of this whole command is that a secret never travels on a
 * command line; `PUT /v1/keys/:keyId/webhook-secrets` is the door, and the
 * client that owns the secret is the one that should open it.
 */

export const KEYS_USAGE = `ezpug-iron keys — API keys and their ceilings (the admin scope)

  keys create --name <name> [--scopes matches,fleet,admin]
              [--max-concurrent 4] [--max-lifetime-minutes 240] [--monthly-cents 0]
  keys list
  keys revoke <keyId>

The secret is printed once, by the mint that made it, and never again: no
route serves it and this command never echoes one back. Lose it and rotate.`

export async function runKeys(context: CommandContext): Promise<number> {
  const [verb, argument] = context.args.positionals.slice(1)
  switch (verb) {
    case 'create':
      return await create(context)
    case 'list':
      return await list(context)
    case 'revoke':
      return await revoke(context, argument)
    default:
      throw new CliUsageError(
        verb === undefined ? 'keys needs a verb' : `unknown verb 'keys ${verb}'`,
        KEYS_USAGE,
      )
  }
}

async function create(context: CommandContext): Promise<number> {
  const { args, out } = context
  const name = flag(args, 'name')
  if (!name) throw new CliUsageError('keys create needs --name', KEYS_USAGE)
  const scopes = parseScopes(flag(args, 'scopes') ?? 'matches')
  const budget = {
    maxConcurrentServers: integer(args, 'max-concurrent', 4),
    maxServerLifetimeMinutes: integer(args, 'max-lifetime-minutes', 240),
    monthlyCents: integer(args, 'monthly-cents', 0),
  }

  const created = await context.client().keys.create({ body: { name, scopes, budget } })
  out.say(
    `minted ${created.key.id} — ${created.key.name} (${created.key.scopes.join(',')}), ` +
      `${budget.maxConcurrentServers} server(s) at once, ${budget.maxServerLifetimeMinutes} min each, ` +
      `${budget.monthlyCents === 0 ? 'no monthly ceiling' : `${euros(budget.monthlyCents)} a month`}`,
  )
  out.reveal(
    'The secret, once:',
    created.secret,
    `Put it in ${'EZPUG_IRON_API_KEY'} or the consumer's environment now — nothing can show it again.`,
  )
  out.emit(created)
  return EXIT.ok
}

async function list(context: CommandContext): Promise<number> {
  const { keys } = await context.client().keys.list()
  context.out.table(
    ['id', 'name', 'prefix', 'scopes', 'servers', 'minutes', 'monthly', 'state'],
    keys.map(key => [
      key.id,
      key.name,
      key.prefix,
      key.scopes.join(','),
      String(key.budget.maxConcurrentServers),
      String(key.budget.maxServerLifetimeMinutes),
      key.budget.monthlyCents === 0 ? '—' : euros(key.budget.monthlyCents),
      key.revokedAt ? `revoked ${key.revokedAt}` : `last used ${orDash(key.lastUsedAt)}`,
    ]),
  )
  context.out.emit({ keys })
  return EXIT.ok
}

async function revoke(context: CommandContext, keyId: string | undefined): Promise<number> {
  if (!keyId) throw new CliUsageError('keys revoke needs the key id', KEYS_USAGE)
  const key = await context.client().keys.revoke({ params: { keyId } })
  context.out.say(`revoked ${key.id} (${key.name}) at ${orDash(key.revokedAt)}`)
  context.out.emit(key)
  return EXIT.ok
}

function parseScopes(raw: string): MatchApiScope[] {
  const scopes = raw
    .split(',')
    .map(scope => scope.trim())
    .filter(scope => scope.length > 0)
  const parsed = matchApiScopesSchema.safeParse(scopes)
  if (!parsed.success)
    throw new CliUsageError(
      `--scopes takes matches, fleet and/or admin, comma-separated; got '${raw}'`,
      KEYS_USAGE,
    )
  return parsed.data
}

function integer(args: CommandContext['args'], name: string, fallback: number): number {
  const raw = flag(args, name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0)
    throw new CliUsageError(`--${name} takes a non-negative whole number; got '${raw}'`, KEYS_USAGE)
  return value
}
