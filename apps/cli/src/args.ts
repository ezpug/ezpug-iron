/**
 * **The argument grammar**, decided in one place so every verb reads the
 * same. `ezpug-iron <group> <verb> [positionals] [--flags]`:
 *
 * - `--flag value` and `--flag=value` are the same thing.
 * - A flag in {@link BOOLEAN_FLAGS}, a flag followed by another flag, and a
 *   flag at the end of the line are all `true`. Everything else takes the
 *   next token — which is why the boolean set is a declaration and not a
 *   guess: without it `ezpug-iron --json matches get X` would read `matches`
 *   as the value of `--json`.
 * - A flag may repeat (`--label venue=saarlan --label rack=2`); {@link flag}
 *   gives the last, {@link flags} gives all of them in order.
 * - `--` ends the flags; everything after it is a positional, so an RCON
 *   command that starts with a dash can still be sent.
 *
 * No secret is ever a flag. The API key comes from the environment
 * (`config.ts`), the Dathost password likewise (`scripts/dathost-image.mjs`):
 * a flag lands in shell history and in `/proc/<pid>/cmdline`, where anyone
 * on the box can read it.
 */

/** Flags that never take a value. Everything else does when a value follows. */
export const BOOLEAN_FLAGS: readonly string[] = [
  'json',
  'help',
  'version',
  'all',
  'ticks',
  'undrain',
  'check',
  'build',
  'dry-run',
  'adopt',
  'force',
  'no-wait',
]

export interface ParsedArgs {
  /** Everything that was not a flag or a flag's value, in order. */
  readonly positionals: readonly string[]
  /** Every occurrence of every flag, in order. */
  readonly flags: ReadonlyMap<string, readonly string[]>
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  const push = (name: string, value: string): void => {
    const seen = flags.get(name)
    if (seen) seen.push(value)
    else flags.set(name, [value])
  }

  let literal = false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (literal || !token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }
    if (token === '--') {
      literal = true
      continue
    }
    // `-h` / `-v`, the two short forms an operator types without thinking.
    const name = token.startsWith('--') ? token.slice(2) : SHORT_FLAGS[token.slice(1)]
    if (name === undefined) {
      positionals.push(token)
      continue
    }
    const equals = name.indexOf('=')
    if (equals !== -1) {
      push(name.slice(0, equals), name.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (
      BOOLEAN_FLAGS.includes(name) ||
      next === undefined ||
      (next.startsWith('-') && next !== '-')
    )
      push(name, 'true')
    else {
      push(name, next)
      index += 1
    }
  }
  return { positionals, flags }
}

const SHORT_FLAGS: Readonly<Record<string, string | undefined>> = {
  h: 'help',
  v: 'version',
}

/** The last value given for a flag, or undefined. */
export function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1)
}

/** Every value given for a flag, in order. */
export function flags(args: ParsedArgs, name: string): readonly string[] {
  return args.flags.get(name) ?? []
}

/** True when the flag was given at all and not as `--flag=false`. */
export function boolFlag(args: ParsedArgs, name: string): boolean {
  const value = flag(args, name)
  return value !== undefined && value !== 'false'
}
