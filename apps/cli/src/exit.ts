/**
 * **How the command ends.** Four codes, the two conventional ones from
 * `sysexits.h` included, because an operator's shell script branches on
 * them and a CI job fails on them:
 *
 * - `0` — it worked.
 * - `1` — the orchestrator said no. An `ApiError` with a code from the
 *   Match API's closed set, or a command the server rejected.
 * - `64` (`EX_USAGE`) — the line was wrong: an unknown verb, a missing
 *   argument, no API key in the environment.
 * - `69` (`EX_UNAVAILABLE`) — nothing answered: the orchestrator is not
 *   listening, DNS did not resolve, the checkout has no build script.
 *
 * A refusal the API *did* answer is a `1` and never a `69`: "budget
 * exceeded" is an answer, and a script that retries on it would be wrong.
 */
export const EXIT = Object.freeze({
  ok: 0,
  refused: 1,
  usage: 64,
  unavailable: 69,
})

/** The line was wrong. Carries the exit code the CLI ends with. */
export class CliUsageError extends Error {
  override readonly name = 'CliUsageError'
  readonly exitCode = EXIT.usage
  constructor(
    message: string,
    /** Printed under the message when there is one — the group's own usage block. */
    readonly usage?: string,
  ) {
    super(message)
  }
}

/** Nothing answered. */
export class CliUnavailableError extends Error {
  override readonly name = 'CliUnavailableError'
  readonly exitCode = EXIT.unavailable
}
