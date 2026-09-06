import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NODE_AGENT_VERSION } from './version'

describe('the agent version', () => {
  it('is the package version — the bundle has no package.json to read', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(NODE_AGENT_VERSION).toBe(manifest.version)
  })
})
