import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { USAGE } from './cli'
import { CLI_VERSION } from './version'

/**
 * `CLI_VERSION` is a constant because the bundle the image runs has no
 * `package.json` beside it. This is what keeps the two the same number.
 */
describe('the version', () => {
  it('is the package’s, and the usage prints it', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string; bin: Record<string, string> }
    expect(CLI_VERSION).toBe(manifest.version)
    expect(USAGE).toContain(`ezpug-iron ${CLI_VERSION}`)
    expect(manifest.bin['ezpug-iron']).toBe('./bin/ezpug-iron.mjs')
  })
})
