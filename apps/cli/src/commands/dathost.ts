import { boolFlag } from '../args'
import type { CommandContext } from '../context'
import { CliUsageError, EXIT } from '../exit'

/**
 * **`ezpug-iron dathost image`** — the rented half of the fleet's "image"
 * (PRD-02 T18). Dathost has no registry: a server is a box with files on it
 * and `duplicate` copies them, so the template is a server that never plays
 * a match, and `scripts/dathost-image.mjs` is what puts our Metamod,
 * CounterStrikeSharp, MatchZy and plugins on it.
 *
 * This verb is a wrapper and deliberately a thin one. Every flag is the
 * script's own, passed through untouched, so there is exactly one place
 * where "what the template must hold" is decided and no chance of the two
 * drifting; `--check` and `--build` are the two an operator types, and
 * `--check` is what a deploy asks before it trusts a clone.
 *
 * The account's password is read by the script from the environment and
 * only from there. Nothing about that changes by coming through here.
 */

export const DATHOST_USAGE = `ezpug-iron dathost — the Dathost template server (docs/operations.md)

  dathost image --check          is the template what this tree says it is?
  dathost image --build          create or refresh it from the CS2 image's artifacts
  dathost image --build --dry-run
  dathost image --help           every flag scripts/dathost-image.mjs takes

Credentials come from the environment only: EZPUG_IRON_DATHOST_EMAIL and
EZPUG_IRON_DATHOST_PASSWORD. This verb needs no API key — it talks to
Dathost, not to the orchestrator.`

/** Flags this verb owns; everything else is handed to the script verbatim. */
const OWN_FLAGS = new Set(['build', 'url'])

export async function runDathost(context: CommandContext): Promise<number> {
  const verb = context.args.positionals[1]
  if (verb !== 'image')
    throw new CliUsageError(
      verb === undefined ? 'dathost needs a verb' : `unknown verb 'dathost ${verb}'`,
      DATHOST_USAGE,
    )

  const { args, out } = context
  const check = boolFlag(args, 'check')
  const build = boolFlag(args, 'build')
  const help = boolFlag(args, 'help')
  if (!check && !build && !help)
    throw new CliUsageError('dathost image needs --check or --build', DATHOST_USAGE)
  if (check && build) throw new CliUsageError('--check and --build are exclusive', DATHOST_USAGE)

  // `--build` is this verb's word for the script's default (no verb at all);
  // everything else — `--dry-run`, `--tree`, `--template`, `--adopt`,
  // `--force`, `--slots` — is the script's and goes through as it was typed.
  const argv: string[] = []
  for (const [name, values] of args.flags)
    for (const value of values) {
      if (OWN_FLAGS.has(name)) continue
      argv.push(value === 'true' ? `--${name}` : `--${name}=${value}`)
    }

  const code = await context.dathostImage({
    argv,
    env: context.env,
    // The script writes its own `--json` document and its own progress lines;
    // both go where ours would, so a pipe reads one stream either way.
    stdout: text => out.raw(text),
    stderr: text => out.warn(text.replace(/\n$/, '')),
  })
  return code === 0 ? EXIT.ok : EXIT.refused
}
