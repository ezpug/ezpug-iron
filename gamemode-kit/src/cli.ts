import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { buildWidget, findWidgets } from './build'
import { startHarness } from './dev'
import { widgetPaths } from './vite'

/**
 * `ezpug-widget` — the gamemode widget toolchain (`gamemode-kit/`, PRD-02 T25).
 *
 *   ezpug-widget build [id …] [--gamemodes <dir>] [--sourcemap]
 *       Build every `<dir>/<id>/widget/index.ts` (or the ids named) into
 *       `<dir>/<id>/dist/widget.js`. `<dir>` defaults to the working directory,
 *       which is `gamemodes/` when `@ezpug/gamemodes`'s own build runs it.
 *
 *   ezpug-widget dev <id> [--gamemodes <dir>] [--port 3432] [--time-scale 1]
 *       The harness: the widget under Vite against the fake orchestrator.
 */

const HELP = `ezpug-widget build [id …] [--gamemodes <dir>] [--sourcemap]
ezpug-widget dev <id> [--gamemodes <dir>] [--port 3432] [--time-scale 1]`

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      gamemodes: { type: 'string' },
      sourcemap: { type: 'boolean', default: false },
      port: { type: 'string' },
      'time-scale': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command, ...ids] = positionals
  if (values.help || !command) {
    console.log(HELP)
    return command ? 0 : 1
  }
  const gamemodesDir = resolve(values.gamemodes ?? process.cwd())

  if (command === 'build') {
    const widgets = findWidgets(gamemodesDir, ids)
    if (widgets.length === 0) {
      console.log(
        `ezpug-widget: no widget under ${gamemodesDir} (a widget is <id>/widget/index.ts)`,
      )
      return 0
    }
    for (const paths of widgets) {
      const built = await buildWidget(paths, { sourcemap: values.sourcemap })
      console.log(
        `ezpug-widget: ${built.id} → ${built.file} (${(built.bytes / 1024).toFixed(1)} KiB, sha256 ${built.sha256.slice(0, 16)})`,
      )
    }
    return 0
  }

  if (command === 'dev') {
    const id = ids[0]
    if (!id) {
      console.error(`ezpug-widget dev: which gamemode?\n${HELP}`)
      return 1
    }
    const paths = widgetPaths(resolve(gamemodesDir, id))
    if (!paths) {
      console.error(`ezpug-widget dev: ${id} has no widget/index.ts under ${gamemodesDir}`)
      return 1
    }
    const harness = await startHarness(paths, {
      ...(values.port !== undefined && { port: Number(values.port) }),
      ...(values['time-scale'] !== undefined && { timeScale: Number(values['time-scale']) }),
    })
    console.log(
      `ezpug-widget: ${id} harness at ${harness.url} (fake orchestrator at ${harness.listener.url})`,
    )
    const stop = (): void => {
      harness.close().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    await new Promise<never>(() => {})
  }

  console.error(`ezpug-widget: unknown command ${command}\n${HELP}`)
  return 1
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code
  },
  error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  },
)
