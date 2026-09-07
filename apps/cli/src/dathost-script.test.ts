import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDathostImageRunner, DATHOST_SCRIPT_PATH, findRepoRoot } from './dathost-script'
import { CliUnavailableError } from './exit'

/**
 * The one verb that is not an HTTP call: `dathost image` wraps the T18
 * script, which only means anything inside a checkout. This proves the
 * wrapper is real — the script is found, called, and its exit code is the
 * verb's — and that a missing checkout is named rather than crashed on.
 */

const here = fileURLToPath(new URL('.', import.meta.url))

describe('finding scripts/dathost-image.mjs', () => {
  it('walks up out of this module to the checkout it lives in', () => {
    const root = findRepoRoot([here])
    expect(root).toBeTruthy()
    expect(join(root!, DATHOST_SCRIPT_PATH)).toContain('scripts/dathost-image.mjs')
  })

  it('says where it looked when there is no checkout above it', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'ezpug-cli-'))
    expect(findRepoRoot([elsewhere])).toBeUndefined()
    const runner = createDathostImageRunner([elsewhere])
    await expect(
      runner({ argv: [], env: {}, stdout: () => {}, stderr: () => {} }),
    ).rejects.toBeInstanceOf(CliUnavailableError)
  })

  it('runs the real script’s --help, which needs no account and no network', async () => {
    const out: string[] = []
    const code = await createDathostImageRunner([here])({
      argv: ['--help'],
      // An environment of our own, so the script does not read the
      // checkout's `.env`: nothing here may see a real credential.
      env: {},
      stdout: text => out.push(text),
      stderr: () => {},
    })
    expect(code).toBe(0)
    expect(out.join('')).toContain('dathost-image')
    expect(out.join('')).toContain('--check')
  })
})
