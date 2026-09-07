/**
 * **The two channels a command writes on**, so that `--json` is a property
 * of the writer and not a branch in every verb.
 *
 * - The **human** channel — {@link Output.say}, {@link Output.table},
 *   {@link Output.warn}. Silent under `--json` except for `warn`, which is
 *   stderr and therefore never part of the document a pipe reads.
 * - The **machine** channel — {@link Output.emit}, called exactly once per
 *   run, printing nothing unless `--json` was asked for.
 *   {@link Output.emitLine} is its streaming form: one JSON document per
 *   line (NDJSON), which is what `matches watch --json | jq` wants.
 *
 * **Secrets.** Everything on the human channel goes through
 * {@link redactSecrets} first: an `ezi*_` token that reaches a line by
 * accident — inside an error message, inside a match's connect string —
 * comes out as its prefix and an ellipsis. The machine channel is *not*
 * redacted, because the one-time reveal is the whole point of
 * `keys create --json`, and neither is {@link Output.reveal}, the human
 * form of the same deliberate act. Those two are the only doors a secret
 * leaves by, and `cli.test.ts` holds them shut: the API key the CLI
 * authenticated with never appears in any stream of any command.
 */

/** Every token the orchestrator mints is `ezi<kind>_<43 base64url chars>` (its `tokens.ts`). */
const TOKEN_PATTERN = /\b(ezi[a-z]+_)[A-Za-z0-9_-]{8,}/g

export function redactSecrets(line: string): string {
  return line.replace(TOKEN_PATTERN, (_match, prefix: string) => `${prefix}…`)
}

export interface Output {
  readonly json: boolean
  /** A line for a human. Nothing under `--json`. */
  say: (line?: string) => void
  /** A table for a human, columns padded to the widest cell. Nothing under `--json`. */
  table: (headers: readonly string[], rows: readonly (readonly string[])[]) => void
  /** The command's value. Printed as one JSON document under `--json`, dropped otherwise. */
  emit: (value: unknown) => void
  /** One JSON document per line, for a stream. Dropped unless `--json`. */
  emitLine: (value: unknown) => void
  /** A warning, on stderr, in both modes. */
  warn: (line: string) => void
  /**
   * Another program's stdout, verbatim and in both modes — the one door
   * `dathost image` needs, because the script it wraps writes its own
   * `--json` document and suppressing it here would leave the pipe empty.
   */
  raw: (text: string) => void
  /**
   * A secret, shown once and never again: unredacted, framed, and to stdout
   * so an operator can pipe it into a password manager. Nothing under
   * `--json` — the value is in the emitted document instead.
   */
  reveal: (label: string, secret: string, note: string) => void
}

export interface OutputOptions {
  json: boolean
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export function createOutput(options: OutputOptions): Output {
  const { json, stdout, stderr } = options
  return {
    json,
    say: line => {
      if (!json) stdout(`${line === undefined ? '' : redactSecrets(line)}\n`)
    },
    table: (headers, rows) => {
      if (json) return
      for (const line of renderTable(headers, rows)) stdout(`${redactSecrets(line)}\n`)
    },
    emit: value => {
      if (json) stdout(`${JSON.stringify(value, null, 2)}\n`)
    },
    emitLine: value => {
      if (json) stdout(`${JSON.stringify(value)}\n`)
    },
    warn: line => stderr(`${redactSecrets(line)}\n`),
    raw: text => stdout(redactSecrets(text)),
    reveal: (label, secret, note) => {
      if (json) return
      stdout(`\n${label}\n\n    ${secret}\n\n${note}\n`)
    },
  }
}

/**
 * Header, a dashed rule, then the rows — columns padded to the widest cell,
 * the last column never padded so a trailing value has no trailing spaces.
 * An empty table says so instead of printing a lonely header.
 */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string[] {
  if (rows.length === 0) return ['(none)']
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map(row => (row[column] ?? '').length)),
  )
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => (column === headers.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join('  ')
      .trimEnd()
  return [
    line(headers),
    line(widths.map(width => '─'.repeat(width))),
    ...rows.map(row => line(headers.map((_header, column) => row[column] ?? ''))),
  ]
}

/** `null` and `undefined` as a dash, so a column never collapses to nothing. */
export function orDash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : String(value)
}

/** Cents as euros, the currency every price in this repo is quoted in. */
export function euros(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`
}
