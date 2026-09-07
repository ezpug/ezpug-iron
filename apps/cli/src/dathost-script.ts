import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { DathostImageRunner } from './context'
import { CliUnavailableError } from './exit'

/**
 * **Finding `scripts/dathost-image.mjs`.** The template builder is a repo
 * script, not a bundled module: it reads `docker/cs2/Dockerfile` for its
 * pins and extracts five hundred files out of the CS2 image, so it only
 * means anything inside a checkout. The CLI therefore *locates* it rather
 * than importing it — walking up from this module (the source tree, or
 * `dist/` in the image) and from the working directory — and says plainly
 * where it looked when there is nothing to find. Every other verb works
 * from anywhere, because every other verb is one HTTP call.
 */

export const DATHOST_SCRIPT_PATH = 'scripts/dathost-image.mjs'

/** The checkout containing the script, from the two places worth looking. */
export function findRepoRoot(from: readonly string[]): string | undefined {
  for (const start of from) {
    let directory = resolve(start)
    for (;;) {
      if (existsSync(join(directory, DATHOST_SCRIPT_PATH))) return directory
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return undefined
}

/** What the script's module must look like for this to be a wrapper and not a fork. */
interface DathostImageModule {
  main: (options: {
    argv: readonly string[]
    env: Readonly<Record<string, string | undefined>>
    stdout: (text: string) => void
    stderr: (text: string) => void
  }) => Promise<number>
}

function isRunnable(module: unknown): module is DathostImageModule {
  return typeof (module as DathostImageModule | undefined)?.main === 'function'
}

export function createDathostImageRunner(
  searchFrom: readonly string[] = [fileURLToPath(new URL('.', import.meta.url)), process.cwd()],
): DathostImageRunner {
  return async options => {
    const root = findRepoRoot(searchFrom)
    if (root === undefined)
      throw new CliUnavailableError(
        `no ${DATHOST_SCRIPT_PATH} above ${searchFrom.join(' or ')}. ` +
          '`dathost image` builds the template out of a checkout — run it from one ' +
          '(`pnpm iron dathost image --check`); every other verb works from anywhere.',
      )
    const module: unknown = await import(pathToFileURL(join(root, DATHOST_SCRIPT_PATH)).href)
    if (!isRunnable(module))
      throw new CliUnavailableError(`${join(root, DATHOST_SCRIPT_PATH)} exports no main()`)
    return await module.main(options)
  }
}
