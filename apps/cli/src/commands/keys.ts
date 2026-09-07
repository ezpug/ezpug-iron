import { randomBytes } from 'node:crypto'
import {
  type MatchApiScope,
  matchApiScopesSchema,
  type WebhookSecretRegistration,
} from '@ezpug/match-api'
import { flag, flags } from '../args'
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
 * **`--webhook-secret <id>` names one, it never carries one** (PRD-02 T37b).
 * Every match request must name a registered webhook secret
 * (`callbacks.webhookSecretId`), so a key minted without one cannot create a
 * match — which is how the rehearsal found that the key it needed could not
 * be minted from a terminal at all. The flag takes the *id*; the secret
 * behind it is drawn here from the platform CSPRNG and shown once, like the
 * key's own, because a secret on a command line is a secret in the shell's
 * history and in `/proc/<pid>/cmdline`. A client that already owns its
 * secret still registers it through `PUT /v1/keys/:keyId/webhook-secrets`,
 * which is the door for rotation and the one this command deliberately does
 * not wrap.
 */

/** What `webhookSecretsRequestSchema` allows on one key. */
const MAX_WEBHOOK_SECRETS = 8

export const KEYS_USAGE = `ezpug-iron keys — API keys and their ceilings (the admin scope)

  keys create --name <name> [--scopes matches,fleet,admin]
              [--max-concurrent 4] [--max-lifetime-minutes 240] [--monthly-cents 0]
              [--webhook-secret <id>]...
  keys list
  keys revoke <keyId>

--webhook-secret names a webhook secret to register on the new key (repeat it
for up to ${MAX_WEBHOOK_SECRETS}); the secret itself is drawn here and shown once, and is what a
match request then names as callbacks.webhookSecretId. Never pass a secret on
the command line — the flag takes the id.

Every secret is printed once, by the mint that made it, and never again: no
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
  const webhookSecrets = mintWebhookSecrets(flags(args, 'webhook-secret'))

  const created = await context.client().keys.create({
    body: { name, scopes, budget, webhookSecrets },
  })
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
  for (const registered of webhookSecrets)
    out.reveal(
      `The webhook secret '${registered.id}', once:`,
      registered.secret,
      `The consumer verifies every webhook with it; a match request names the id: ` +
        `"callbacks": { "webhookUrl": "…", "webhookSecretId": "${registered.id}" }.`,
    )
  out.emit({ ...created, webhookSecrets })
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

/**
 * A webhook secret, in the grammar every other secret in this system uses
 * (`ezi<kind>_<43 base64url chars>`, the orchestrator's `tokens.ts`): 32
 * bytes from the platform CSPRNG, so a previous one says nothing about the
 * next, and a prefix the output redactor already knows — a secret that
 * reaches a human line by accident comes out as `eziw_…` rather than whole.
 *
 * Nothing injects this draw. A seeded secret would be a reproducible secret,
 * which is the one thing a webhook signature may never be, so the CSPRNG is
 * reached for directly here and the determinism rule does not apply.
 */
function mintWebhookSecrets(ids: readonly string[]): WebhookSecretRegistration[] {
  if (ids.length > MAX_WEBHOOK_SECRETS)
    throw new CliUsageError(
      `--webhook-secret takes at most ${MAX_WEBHOOK_SECRETS} ids on one key; got ${ids.length}`,
      KEYS_USAGE,
    )
  const seen = new Set<string>()
  return ids.map(id => {
    // `--webhook-secret` with nothing after it parses as the boolean `true`
    // (`args.ts`), which would otherwise become an id nobody meant to name.
    if (id === 'true')
      throw new CliUsageError(
        '--webhook-secret needs the id to register, e.g. --webhook-secret whsec-2026-09',
        KEYS_USAGE,
      )
    if (id.length > 64)
      throw new CliUsageError(
        '--webhook-secret takes an id of at most 64 characters — a name for the secret, never ' +
          'the secret itself',
        KEYS_USAGE,
      )
    if (seen.has(id)) throw new CliUsageError(`--webhook-secret ${id} was given twice`, KEYS_USAGE)
    seen.add(id)
    return { id, secret: `eziw_${randomBytes(32).toString('base64url')}` }
  })
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
