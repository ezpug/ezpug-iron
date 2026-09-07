import type { Clock } from '@ezpug/core'
import { ApiError } from '@ezpug/match-api'
import type { StreamWebSocketConstructor } from '@ezpug/match-api/client'
import { createMatchApiClient, type MatchApiClient } from '@ezpug/match-api/client'
import { boolFlag, flag, type ParsedArgs, parseArgs } from './args'
import { BUDGET_USAGE, runBudget } from './commands/budget'
import { DATHOST_USAGE, runDathost } from './commands/dathost'
import { GAMEMODES_USAGE, runGamemodes } from './commands/gamemodes'
import { KEYS_USAGE, runKeys } from './commands/keys'
import { MATCHES_USAGE, runMatches } from './commands/matches'
import { NODES_USAGE, runNodes } from './commands/nodes'
import { runServers, SERVERS_USAGE } from './commands/servers'
import { API_KEY_VAR, baseUrlFrom, type EnvRecord, readCliConfig } from './config'
import type { CommandContext, DathostImageRunner } from './context'
import { CliUnavailableError, CliUsageError, EXIT } from './exit'
import { createOutput } from './output'
import { CLI_VERSION } from './version'

/**
 * **`ezpug-iron`, the operator's command** (PRD-02 T33). Every lever the
 * orchestrator has, and no lever it does not: each verb is one call on the
 * typed client generated from `@ezpug/match-api`'s route table, so a route
 * this CLI can reach is a route the platform can reach, and a capability
 * that is not a route does not exist here either (CLAUDE.md, "the Match API
 * is the only door"). There is no second client, no hand-written fetch and
 * no admin surface that skips the API.
 *
 * Three rules hold across the whole surface:
 *
 * - **`--json` on everything.** The human channel is a table or a
 *   paragraph; the machine channel is one JSON document (one per line for
 *   `matches watch`, which is a stream). Nothing is half-formatted: a verb
 *   either printed prose or printed the resource, never both into the same
 *   pipe.
 * - **A secret leaves by one door, once.** `keys create` and
 *   `nodes enrol-token` mint; both show the secret at the mint and nowhere
 *   else, and every other line the command writes runs through
 *   `redactSecrets` on the way out. No verb takes a secret as a flag — not
 *   the API key, not the Dathost password — because a flag is in the shell
 *   history and in `/proc` for anyone on the box to read.
 * - **Exit codes an operator can branch on** (`exit.ts`): `0` it worked,
 *   `1` the orchestrator said no, `64` the line was wrong, `69` nothing
 *   answered.
 *
 * Everything is injected — the clock, the client factory, stdin, the signal
 * arming, the Dathost script — so the suite runs these exact verbs against
 * the fake orchestrator over a real socket.
 */

export const USAGE = `ezpug-iron ${CLI_VERSION} — the EZPug Iron operator's command (docs/operations.md)

Usage:
  ezpug-iron <group> <verb> [arguments] [--flags]

  keys create|list|revoke        API keys, their scopes and their ceilings (admin)
  gamemodes list                 what this orchestrator will play
  matches create|list|get|watch|cancel|command
                                 ask for a match, read it, watch it live, command it
  servers list|kill|console      the fleet ledger: what is running, what it cost
  nodes enrol-token|list|drain|remove
                                 self-hosted capacity (docs/nodes.md)
  budget                         this key's ceilings and this month's spend
  dathost image --check|--build  the Dathost template server (needs a checkout)

Anywhere:
  --json                         print the resource instead of a table
  --url <origin>                 the orchestrator to talk to
  --help                         this, or the group's own usage
  --version

Configuration is the environment (.env.example):
  ${API_KEY_VAR}            the API key. Environment only — never a flag.
  EZPUG_IRON_CLI_URL             the orchestrator; falls back to EZPUG_IRON_BASE_URL

Exit codes: 0 done, 1 the orchestrator said no, 64 bad usage, 69 nothing answered.`

export interface CliDependencies {
  env: EnvRecord
  clock: Clock
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Default: the published client over `globalThis.fetch`, sockets from `ws`. */
  createClient?: (options: { baseUrl: string; apiKey: string }) => MatchApiClient
  /**
   * What `matches watch` opens sockets with. `main.ts` hands in `ws`, which
   * is the only implementation that can carry the API key as a header; the
   * fallback is `globalThis.WebSocket`, which cannot.
   */
  WebSocket?: StreamWebSocketConstructor
  /** A fresh correlation id. Default: `randomUUID()`. */
  newId?: () => string
  /** Read a request document; `-` is stdin. Default: the file system and stdin. */
  readInput?: (path: string) => Promise<string>
  /** Arm SIGINT/SIGTERM. Default: the real process signals. */
  onSignal?: (handler: () => void) => () => void
  /** `scripts/dathost-image.mjs`. Default: the one in the checkout above us. */
  dathostImage?: DathostImageRunner
}

/** One group of verbs: what runs it, and the usage `--help` prints for it. */
interface CommandGroup {
  readonly run: (context: CommandContext) => Promise<number>
  readonly usage: string
}

const GROUPS: Readonly<Record<string, CommandGroup | undefined>> = {
  keys: { run: runKeys, usage: KEYS_USAGE },
  gamemodes: { run: runGamemodes, usage: GAMEMODES_USAGE },
  matches: { run: runMatches, usage: MATCHES_USAGE },
  servers: { run: runServers, usage: SERVERS_USAGE },
  nodes: { run: runNodes, usage: NODES_USAGE },
  budget: { run: runBudget, usage: BUDGET_USAGE },
  dathost: { run: runDathost, usage: DATHOST_USAGE },
}

/** Every group, for the docs test that holds the runbook against this. */
export const COMMAND_GROUPS = Object.keys(GROUPS)

/** Run one command line; resolves with the exit code. Never throws. */
export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const args = parseArgs(argv)
  const out = createOutput({
    json: boolFlag(args, 'json'),
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
  })

  if (boolFlag(args, 'version')) {
    out.say(CLI_VERSION)
    out.emit({ version: CLI_VERSION })
    return EXIT.ok
  }

  const name = args.positionals[0]
  const group = name === undefined ? undefined : GROUPS[name]

  // `--help` with no group is the whole map; with one it is that group's,
  // which is why it is answered before the verb is read: `ezpug-iron matches
  // --help` should not need a valid verb. `dathost --help` is the exception —
  // it belongs to the script that verb wraps.
  if (boolFlag(args, 'help') && name !== 'dathost') {
    out.say(group?.usage ?? USAGE)
    return name === undefined || group !== undefined ? EXIT.ok : EXIT.usage
  }

  try {
    if (name === undefined) {
      out.say(USAGE)
      return EXIT.usage
    }
    if (group === undefined)
      throw new CliUsageError(`unknown command '${name}'. One of: ${COMMAND_GROUPS.join(', ')}`)
    return await group.run(contextFor(args, out, dependencies))
  } catch (error) {
    return report(error, out)
  }
}

function contextFor(
  args: ParsedArgs,
  out: ReturnType<typeof createOutput>,
  dependencies: CliDependencies,
): CommandContext {
  const url = flag(args, 'url')
  let client: MatchApiClient | undefined
  return {
    args,
    out,
    env: dependencies.env,
    clock: dependencies.clock,
    baseUrl: () => baseUrlFrom(dependencies.env, url),
    client: () => {
      if (!client) {
        const config = readCliConfig(dependencies.env, url)
        client =
          dependencies.createClient?.(config) ??
          createMatchApiClient({
            ...config,
            clock: dependencies.clock,
            WebSocket: dependencies.WebSocket,
          })
      }
      return client
    },
    newId: dependencies.newId ?? defaultNewId,
    readInput: dependencies.readInput ?? (path => defaultReadInput(path, dependencies.env)),
    onSignal: dependencies.onSignal ?? defaultSignals,
    dathostImage: dependencies.dathostImage ?? lazyDathostImage,
  }
}

/**
 * One place where a thrown thing becomes an exit code and a line. An
 * `ApiError` prints its code first: `code` is what a script branches on and
 * what `docs/match-api.md` documents, the prose is for the reader.
 */
function report(error: unknown, out: ReturnType<typeof createOutput>): number {
  if (error instanceof CliUsageError) {
    out.warn(error.message)
    if (error.usage) out.warn(`\n${error.usage}`)
    out.emit({ error: { code: 'usage', message: error.message } })
    return error.exitCode
  }
  if (error instanceof CliUnavailableError) {
    out.warn(error.message)
    out.emit({ error: { code: 'unavailable', message: error.message } })
    return error.exitCode
  }
  if (error instanceof ApiError) {
    out.warn(`${error.code}: ${error.message}`)
    if (error.details) out.warn(JSON.stringify(error.details, null, 2))
    out.emit({ error: { code: error.code, message: error.message, details: error.details } })
    return EXIT.refused
  }
  const message = error instanceof Error ? error.message : String(error)
  // A fetch that never got an answer is the orchestrator being absent, not a
  // refusal — the difference a retry loop needs.
  out.warn(message)
  out.emit({ error: { code: 'unavailable', message } })
  return EXIT.unavailable
}

function defaultNewId(): string {
  // Not a clock reading and not a seeded draw: a correlation id only has to
  // be unique, and the orchestrator treats it as an opaque idempotency key.
  return globalThis.crypto.randomUUID()
}

/**
 * **A relative path means where you typed it** (PRD-02 T37b). `pnpm iron`
 * is `pnpm --filter @ezpug/cli start`, and pnpm runs a workspace script with
 * that package as the working directory — so `pnpm iron matches create --file
 * request.json` looked for `apps/cli/request.json` and said the file was not
 * there. pnpm (and npm) set `INIT_CWD` to the directory the command was typed
 * in, which is the honest fix: it is the operator's cwd whether the wrapper
 * moved or not, and it is simply absent for an installed `ezpug-iron`, where
 * `process.cwd()` already is that directory.
 *
 * A path that is not found is reported as the absolute path that was looked
 * for, so the answer to "which file did it want" is in the line itself.
 */
async function defaultReadInput(path: string, env: EnvRecord): Promise<string> {
  if (path === '-') {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }
  const { readFile } = await import('node:fs/promises')
  const { isAbsolute, resolve } = await import('node:path')
  const resolved = isAbsolute(path) ? path : resolve(env.INIT_CWD ?? process.cwd(), path)
  try {
    return await readFile(resolved, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new CliUsageError(`no such file: ${resolved}`)
    throw error
  }
}

function defaultSignals(handler: () => void): () => void {
  const listener = (): void => handler()
  process.once('SIGTERM', listener)
  process.once('SIGINT', listener)
  return () => {
    process.off('SIGTERM', listener)
    process.off('SIGINT', listener)
  }
}

const lazyDathostImage: DathostImageRunner = async options => {
  const { createDathostImageRunner } = await import('./dathost-script')
  return await createDathostImageRunner()(options)
}
