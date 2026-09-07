/**
 * The process: the repo's `.env` when there is one (the image has the
 * environment compose gave it), the real clock, `ws` for the one verb that
 * opens a socket, the real signals, then `runCli`. Everything else is
 * `cli.ts` and what it composes.
 */
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { systemClock } from '@ezpug/core'
import type { StreamWebSocketConstructor } from '@ezpug/match-api/client'
import WebSocket from 'ws'
import { runCli } from './cli'
import { EXIT } from './exit'

try {
  // Same rule as `--env-file`: never overwrites a variable already set, so an
  // `EZPUG_IRON_API_KEY` in the shell wins over the checkout's. The bundle
  // sits at `dist/main.mjs`, the source at `src/main.ts`: both three levels
  // below the repo root.
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)))
} catch {
  // No .env: the process environment is all there is.
}

/**
 * **Wait for the pipe before leaving.** `process.exit()` tears the process
 * down without flushing what is still queued on stdout, and stdout to a pipe
 * (`ezpug-iron gamemodes list --json | jq`) is queued in 64 KB chunks — the
 * catalog is bigger than one. So every write is drained first, and only then
 * does the exit code become the process's. `main.test.ts` runs this file as a
 * real subprocess through a pipe and parses what came out.
 */
function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise(resolve => {
    stream.write('', () => resolve())
  })
}

let code: number
try {
  code = await runCli(process.argv.slice(2), {
    env: process.env,
    clock: systemClock,
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
    WebSocket: WebSocket as unknown as StreamWebSocketConstructor,
  })
} catch (error) {
  process.stderr.write(`ezpug-iron: ${error instanceof Error ? error.message : String(error)}\n`)
  code = EXIT.unavailable
}
await Promise.all([drain(process.stdout), drain(process.stderr)])
process.exit(code)
