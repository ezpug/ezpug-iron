/// <reference types="node" />
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Match } from '@ezpug/match-api'
import { afterEach, describe, expect, it } from 'vitest'
import { API_KEY_VAR } from './config'
import { EXIT } from './exit'
import { type CliHarness, createCliHarness, pugRequest } from './testing'

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

  /**
   * The third of T37b's edges, and the only one no in-process test can see:
   * `pnpm iron` runs the command with `apps/cli` as its working directory,
   * so a relative `--file` was resolved there and not where it was typed.
   * This spawns exactly that situation — the child's cwd is `apps/cli` (the
   * suite's own), the document is somewhere else entirely, and `INIT_CWD`
   * is what pnpm would have set.
   */
  it('resolves a relative --file where the operator typed it, not where pnpm ran it', async () => {
    harness = await createCliHarness()
    const directory = await mkdtemp(join(tmpdir(), 'ezpug-iron-cli-'))
    try {
      await writeFile(join(directory, 'request.json'), JSON.stringify(pugRequest()), 'utf8')
      const env = {
        [API_KEY_VAR]: harness.admin.secret,
        EZPUG_IRON_CLI_URL: harness.listener.url,
      }

      const created = await run(['matches', 'create', '--file', 'request.json', '--json'], {
        ...env,
        INIT_CWD: directory,
      })
      expect(created.code, created.err).toBe(EXIT.ok)
      expect((JSON.parse(created.out) as Match).clientMatchId).toBe('cli-match-1')

      // Without it there is nothing to find, and the line says which path was looked for.
      const missing = await run(['matches', 'create', '--file', 'request.json'], env)
      expect(missing.code).toBe(EXIT.usage)
      expect(missing.err).toContain('no such file:')
      expect(missing.err).toContain('request.json')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
