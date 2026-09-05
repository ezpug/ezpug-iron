/**
 * **What this process says.** One line per fact, prefixed `[orchestrator]`,
 * to stdout for `info` and stderr for the rest — what `docker compose logs`
 * and journald expect. Injected everywhere a line is written, so a test
 * captures lines instead of reading the console, and so the rule "never a
 * secret in a log line" is checkable in one place: every writer goes through
 * `redactSecrets`.
 */
import { TOKEN_PREFIXES } from './tokens'

export interface Log {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string, error?: unknown) => void
}

const PREFIX = '[orchestrator]'

/**
 * A token of ours anywhere in a line becomes its prefix and an ellipsis.
 * Belt and braces: nothing should put one there, and if something does, the
 * log still holds nothing usable.
 */
const TOKEN_PATTERN = new RegExp(
  `(${TOKEN_PREFIXES.map(prefix => prefix.replace('_', '\\_')).join('|')})[A-Za-z0-9_-]{8,}`,
  'g',
)

export function redactSecrets(line: string): string {
  return line.replace(TOKEN_PATTERN, (_match, prefix: string) => `${prefix}…`)
}

export function createConsoleLog(): Log {
  return {
    info: message => console.log(`${PREFIX} ${redactSecrets(message)}`),
    warn: message => console.warn(`${PREFIX} ${redactSecrets(message)}`),
    error: (message, error) => {
      const detail =
        error instanceof Error ? error.message : error === undefined ? '' : String(error)
      console.error(`${PREFIX} ${redactSecrets(detail ? `${message}: ${detail}` : message)}`)
    },
  }
}

/** A log that keeps its lines — for tests. */
export function createMemoryLog(): Log & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: message => void lines.push(`info ${redactSecrets(message)}`),
    warn: message => void lines.push(`warn ${redactSecrets(message)}`),
    error: (message, error) => {
      const detail =
        error instanceof Error ? error.message : error === undefined ? '' : String(error)
      lines.push(`error ${redactSecrets(detail ? `${message}: ${detail}` : message)}`)
    },
  }
}
