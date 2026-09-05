import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * **A `schema`-sourced fixture does not survive past T13** (PRD-02 T9): the
 * fixtures under `fixtures/` were written from MatchZy's `event_schema.yml`
 * and its code, as placeholders until a real MatchZy on the dev node was
 * recorded (`scripts/iron-match.mjs`, T13). Once the PRD ticks T13, every
 * file here must say `"source": "recorded"` — this test reads the PRD's own
 * checkbox, so the moment T13 lands with a placeholder still in the tree,
 * `pnpm verify` says so.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const PRD = fileURLToPath(new URL('../../../../ralph/PRD-02-iron.md', import.meta.url))

function t13Ticked(): boolean {
  const prd = readFileSync(PRD, 'utf8')
  const line = prd.split('\n').find(candidate => /^- \[[ x]\] \*\*T13/.test(candidate))
  if (!line) throw new Error('ralph/PRD-02-iron.md no longer has a T13 line')
  return line.startsWith('- [x]')
}

describe('the fixtures’ provenance', () => {
  it('names a source on every file', () => {
    for (const name of readdirSync(FIXTURES).filter(file => file.endsWith('.json'))) {
      const fixture = JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as { source?: string }
      expect(['schema', 'recorded'], name).toContain(fixture.source)
    }
  })

  it('holds no schema-sourced fixture once T13 recorded the real thing', () => {
    const placeholders = readdirSync(FIXTURES)
      .filter(file => file.endsWith('.json'))
      .filter(
        name =>
          (JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as { source?: string }).source ===
          'schema',
      )
    if (t13Ticked()) {
      expect(
        placeholders,
        'T13 is ticked in ralph/PRD-02-iron.md: replace these with recordings',
      ).toEqual([])
    } else {
      // Before T13 the placeholders are the whole point; there must be some.
      expect(placeholders.length).toBeGreaterThan(0)
    }
  })
})
