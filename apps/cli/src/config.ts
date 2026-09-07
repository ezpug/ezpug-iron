import { CliUsageError } from './exit'

/**
 * **Where the command points and what it authenticates with.** Two facts,
 * both from the environment, documented in `.env.example` beside every other
 * variable this repo reads.
 *
 * The **URL** may also come from `--url`, because an operator on this box
 * talks to the dev orchestrator one minute and to `gs.ezpug.com` the next
 * and should not have to edit a file in between.
 *
 * The **API key** may not. A key on the command line is a key in the shell's
 * history file and in `/proc/<pid>/cmdline`, where every other process on the
 * box can read it while the command runs — the same rule
 * `scripts/dathost-image.mjs` keeps for the Dathost password. `EZPUG_IRON_API_KEY`,
 * or nothing.
 */

export type EnvRecord = Readonly<Record<string, string | undefined>>

/** Where the CLI points, in precedence order after `--url`. */
export const BASE_URL_VARS = ['EZPUG_IRON_CLI_URL', 'EZPUG_IRON_BASE_URL'] as const

/** The key, from the environment only. */
export const API_KEY_VAR = 'EZPUG_IRON_API_KEY'

/** The dev orchestrator on this box (`.env.example`: `EZPUG_IRON_PORT=3430`). */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3430'

export interface CliConfig {
  /** The orchestrator's origin, no trailing slash. */
  readonly baseUrl: string
  /** The API key sent as `Authorization: Bearer`. */
  readonly apiKey: string
}

/** The origin alone — what a verb that needs no key (`dathost image`) may still want to print. */
export function baseUrlFrom(env: EnvRecord, override?: string): string {
  const raw =
    override ?? BASE_URL_VARS.map(name => env[name]).find(value => value) ?? DEFAULT_BASE_URL
  const trimmed = raw.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new CliUsageError(
      `not a URL: ${trimmed} (--url, or ${BASE_URL_VARS[0]} in the environment)`,
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new CliUsageError(`the orchestrator's origin is http or https, not ${url.protocol}`)
  return trimmed
}

export function readCliConfig(env: EnvRecord, override?: string): CliConfig {
  const apiKey = env[API_KEY_VAR]?.trim()
  if (!apiKey)
    throw new CliUsageError(
      `no API key: set ${API_KEY_VAR} in the environment (never as a flag — a flag lands in shell ` +
        'history and in /proc). `ezpug-iron keys create` on a key that already has `admin` mints one; ' +
        'the first key of a deployment comes from `pnpm --filter @ezpug/orchestrator keys:mint`.',
    )
  return { baseUrl: baseUrlFrom(env, override), apiKey }
}
