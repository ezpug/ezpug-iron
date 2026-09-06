/**
 * The process: the repo's `.env` when there is one (a venue box has none;
 * the image has the environment compose gave it), the real clock, the real
 * docker socket, the real signals, then `runCli`. Everything else is
 * `cli.ts` and what it composes.
 */
import { fileURLToPath } from 'node:url'
import { systemClock } from '@ezpug/core'
import { runCli } from './cli'
import { createConsoleLog } from './log'

try {
  // Same rule as `--env-file`: never overwrites a variable already set, so
  // the layering `.env.example` documents holds. The bundle sits at
  // `dist/main.mjs`, the source at `src/main.ts`: both are three levels
  // below the repo root.
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)))
} catch {
  // No .env: the process environment is all there is.
}

const log = createConsoleLog()
let code: number
try {
  code = await runCli(process.argv.slice(2), {
    env: process.env,
    clock: systemClock,
    log,
    stdout: line => console.log(line),
  })
} catch (error) {
  log.error('ezpug-node did not start', error)
  code = 1
}
process.exit(code)
