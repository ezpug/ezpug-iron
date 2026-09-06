/**
 * **What this process says.** One line per fact, prefixed `[ezpug-node]`,
 * to stdout for `info` and stderr for the rest — what `docker logs` and
 * journald expect. Injected everywhere a line is written, so a test captures
 * lines instead of reading the console, and so "never a secret in a log
 * line" is checkable in one place: every writer goes through
 * {@link redactSecrets}.
 *
 * The same shape as the orchestrator's `log.ts`, not the same module: an
 * app never imports an app (`turbo.json` boundaries), and a log is thirty
 * lines.
 */

export interface Log {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string, error?: unknown) => void
}

const PREFIX = '[ezpug-node]'

/**
 * Every token the orchestrator mints is `ezi<kind>_<43 base64url chars>`
 * (its `tokens.ts`): an API key, a server token, a node token, an enrolment
 * token, a player token. Anywhere one lands in a line it becomes its prefix
 * and an ellipsis. Belt and braces: nothing should put one there, and if
 * something does, the log still holds nothing usable.
 */
const TOKEN_PATTERN = /\b(ezi[a-z]+_)[A-Za-z0-9_-]{8,}/g

export function redactSecrets(line: string): string {
  return line.replace(TOKEN_PATTERN, (_match, prefix: string) => `${prefix}…`)
}

function detailOf(message: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error)
  return detail ? `${message}: ${detail}` : message
}

export function createConsoleLog(): Log {
  return {
    info: message => console.log(`${PREFIX} ${redactSecrets(message)}`),
    warn: message => console.warn(`${PREFIX} ${redactSecrets(message)}`),
    error: (message, error) =>
      console.error(`${PREFIX} ${redactSecrets(detailOf(message, error))}`),
  }
}

/** A log that keeps its lines — for tests. */
export function createMemoryLog(): Log & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: message => void lines.push(`info ${redactSecrets(message)}`),
    warn: message => void lines.push(`warn ${redactSecrets(message)}`),
    error: (message, error) => void lines.push(`error ${redactSecrets(detailOf(message, error))}`),
  }
}
