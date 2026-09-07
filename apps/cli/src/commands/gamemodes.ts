import { flag } from '../args'
import type { CommandContext } from '../context'
import { CliUsageError, EXIT } from '../exit'

/**
 * **`ezpug-iron gamemodes list`** — what this orchestrator will play
 * (`GET /v1/gamemodes`, `docs/gamemodes.md`). The catalog serves whole
 * manifests; the table shows the identity a request needs (`id`, `game`) and
 * the facts that decide whether a roster fits (`slots`, `flow`, open join).
 *
 * Titles are printed in both languages, because that is what they are: a
 * manifest's `title` is `{ de, en }` and the German one is the default a
 * player sees (CLAUDE.md, "Bilingual where a human reads it"). `--locale de`
 * or `--locale en` narrows it to one column when the terminal is narrow.
 * Everything the command says on its own account stays English — it is
 * talking to an operator, not to a player.
 */

export const GAMEMODES_USAGE = `ezpug-iron gamemodes — the catalog this orchestrator serves

  gamemodes list [--locale de|en]     ids, titles, slots and flow
  gamemodes list --json               every manifest, whole`

export async function runGamemodes(context: CommandContext): Promise<number> {
  const verb = context.args.positionals[1]
  if (verb !== 'list')
    throw new CliUsageError(
      verb === undefined ? 'gamemodes needs a verb' : `unknown verb 'gamemodes ${verb}'`,
      GAMEMODES_USAGE,
    )

  const locale = flag(context.args, 'locale')
  if (locale !== undefined && locale !== 'de' && locale !== 'en')
    throw new CliUsageError(`--locale takes de or en; got '${locale}'`, GAMEMODES_USAGE)

  const { gamemodes } = await context.client().gamemodes.list()
  const titles = locale === undefined ? (['de', 'en'] as const) : ([locale] as const)
  context.out.table(
    ['id', 'game', 'tier', 'flow', 'slots', 'records', ...titles.map(one => `title (${one})`)],
    gamemodes.map(mode => [
      mode.id,
      mode.game,
      mode.tier,
      mode.flow,
      `${mode.slots.teams}×${mode.slots.teamSize}${mode.slots.openJoin ? ' open' : ''}`,
      mode.records,
      ...titles.map(one => mode.title[one]),
    ]),
  )
  context.out.emit({ gamemodes })
  return EXIT.ok
}
