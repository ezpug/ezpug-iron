import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FIXTURE_TOKEN_MARK, protocolFixtureFiles, stringifyProtocolFixture } from './fixtures'

/**
 * **The frame fixtures** (PRD-02 T1). One file per union under
 * `fixtures/frames/`, written from the tables in `fixtures.ts` and asserted
 * byte for byte here; `EZPug.Sdk.Tests` reads the same files and proves the
 * generated C# writes them back unchanged. Re-record with
 * `pnpm --filter @ezpug/protocol record`, read the diff, and ship it with the
 * change that caused it.
 */

const FRAMES_DIR = fileURLToPath(new URL('../fixtures/frames/', import.meta.url))
const RECORDING = process.env.EZPUG_IRON_RECORD === '1'

describe('the frame fixtures', () => {
  if (RECORDING) mkdirSync(FRAMES_DIR, { recursive: true })

  for (const fixture of protocolFixtureFiles()) {
    it(`${fixture.file} is what the tables say`, () => {
      const produced = stringifyProtocolFixture(fixture)
      const path = `${FRAMES_DIR}${fixture.file}`
      if (RECORDING) {
        writeFileSync(path, produced)
        return
      }
      expect(existsSync(path), `no fixture ${fixture.file} — run the record script`).toBe(true)
      expect(produced).toBe(readFileSync(path, 'utf8'))
    })
  }

  it('has one file per union and no orphans', () => {
    const files = readdirSync(FRAMES_DIR)
      .filter(name => name.endsWith('.json'))
      .sort()
    expect(files).toEqual(
      protocolFixtureFiles()
        .map(f => f.file)
        .sort(),
    )
  })

  it('every token in a fixture says it is not a secret', () => {
    for (const fixture of protocolFixtureFiles()) {
      const text = readFileSync(`${FRAMES_DIR}${fixture.file}`, 'utf8')
      for (const match of text.matchAll(/"(?:token|serverToken|nodeToken)": "([^"]*)"/g)) {
        expect(match[1], `${fixture.file}: ${match[0]}`).toContain(FIXTURE_TOKEN_MARK)
      }
    }
  })
})
