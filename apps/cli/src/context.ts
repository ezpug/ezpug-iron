import type { Clock } from '@ezpug/core'
import type { MatchApiClient } from '@ezpug/match-api/client'
import type { ParsedArgs } from './args'
import type { EnvRecord } from './config'
import type { Output } from './output'

/**
 * What every verb is handed. Nothing here is reached for globally: the
 * client, the clock, the file reader, the signal arming and the Dathost
 * script are all injected, so `cli.test.ts` runs the real verbs against the
 * fake orchestrator over a real socket and asserts on captured streams.
 *
 * `client` is a function and not a value because a verb that needs no API
 * key must not demand one — `ezpug-iron dathost image --check` talks to
 * Dathost, not to us.
 */
export interface CommandContext {
  readonly args: ParsedArgs
  readonly out: Output
  readonly env: EnvRecord
  readonly clock: Clock
  /** The typed client for the configured origin and key. Throws `CliUsageError` when there is no key. */
  readonly client: () => MatchApiClient
  /** The configured origin, without demanding a key. */
  readonly baseUrl: () => string
  /** A fresh correlation id for a command call. */
  readonly newId: () => string
  /** Read a request document — a path, or `-` for stdin. */
  readonly readInput: (path: string) => Promise<string>
  /** Arm SIGINT/SIGTERM; returns the disarm. Used by the one verb that waits. */
  readonly onSignal: (handler: () => void) => () => void
  /** `scripts/dathost-image.mjs`, injected so a test never needs the checkout. */
  readonly dathostImage: DathostImageRunner
}

/**
 * The T18 script's own entry point, as this command calls it: argv in, an
 * exit code out, its two streams handed in so `--json` stays one document.
 */
export type DathostImageRunner = (options: {
  argv: readonly string[]
  env: EnvRecord
  stdout: (text: string) => void
  stderr: (text: string) => void
}) => Promise<number>
