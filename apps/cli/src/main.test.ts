/// <reference types="node" />
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { API_KEY_VAR } from './config'
import { EXIT } from './exit'
import { type CliHarness, createCliHarness } from './testing'

/**
 * **The process, run as a process.** Everything else in this suite calls
 * `runCli` in-process and captures its two writers, which cannot see the one
 * thing only a real pipe shows: `process.exit()` tears a process down without
 * flushing what is still queued on stdout, and stdout to a pipe is queued in
 * 64 KB chunks. `gamemodes list --json` is bigger than one chunk, so before
 * `main.ts` drained its streams this exact command handed `jq` a JSON
 * document that stopped mid-string at byte 65 536.
 */

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))

let harness: CliHarness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

function run(argv: string[], env: Record<string, string>) {
  return new Promise<{ code: number; out: string; err: string }>(resolve => {
    const child = spawn(TSX, [MAIN, ...argv], {
      // No inherited environment: the box's own EZPUG_IRON_* must not reach in.
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', chunk => (out += chunk))
    child.stderr.setEncoding('utf8').on('data', chunk => (err += chunk))
    child.on('close', code => resolve({ code: code ?? -1, out, err }))
  })
}

describe('ezpug-iron, as a process', () => {
  it('hands a pipe a whole JSON document, however big it is', async () => {
    harness = await createCliHarness()
    // Enough keys that the answer crosses a pipe chunk. A deployment reaches
    // this on its own: the dev orchestrator on this box already listed more
    // than 64 KB of them the first time this command was pointed at it.
    for (let index = 0; index < 250; index += 1)
      harness.fake.mintKey({
        name: `filler-${index}`,
        scopes: ['matches'],
        budget: { maxConcurrentServers: 1, maxServerLifetimeMinutes: 60, monthlyCents: 0 },
        webhookSecrets: [],
      })
    const { code, out } = await run(['keys', 'list', '--json'], {
      [API_KEY_VAR]: harness.admin.secret,
      EZPUG_IRON_CLI_URL: harness.listener.url,
    })
    expect(code).toBe(EXIT.ok)
    expect(out.length, 'the answer is more than one 64 KB pipe chunk').toBeGreaterThan(65_536)
    const { keys } = JSON.parse(out) as { keys: { name: string }[] }
    expect(keys.map(key => key.name)).toContain('filler-249')
  })

  it('exits 64 with the usage on stderr when there is no key', async () => {
    const { code, err } = await run(['gamemodes', 'list'], {})
    expect(code).toBe(EXIT.usage)
    expect(err).toContain(API_KEY_VAR)
  })
})
