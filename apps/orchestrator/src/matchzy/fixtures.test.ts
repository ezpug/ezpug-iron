import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * **Where each fixture's payload came from** (PRD-02 T9, settled in T13).
 * The files under `fixtures/` began as placeholders written from MatchZy's
 * `event_schema.yml` and its code (`"source": "schema"`), to be replaced by a
 * recording of a real MatchZy once one existed. `scripts/iron-match.mjs` made
 * that recording — a `pug` on the dev node with bots — and this test is what
 * keeps the tree honest about it afterwards.
 *
 * Three sources, and only three, because a bots match on one map cannot
 * produce every case the translator has to get right:
 *
 * - **`recorded`** — the payload is bytes a real MatchZy 0.8.15 sent to the
 *   door on this box. `from` names the run.
 * - **`derived`** — a recorded payload, edited to make a case the run did not
 *   produce (a draw, a lost POST, a foreign `matchid`). `from` names the
 *   `recorded` fixture beside it that it was edited from, so a reader can
 *   diff the two and see exactly what was invented.
 * - **`upstream`** — an event our flow never produces at all: the veto trio
 *   (the platform vetoes), `demo_upload_ended` (the core plugin uploads,
 *   decision 10) and `player_disconnect` (the plugin speaks it from the
 *   engine). Their shape is read off MatchZy's own serialisers and `from`
 *   says which file; the only thing asserted about them is that the door
 *   **drops** them, which no payload detail can change.
 *
 * `schema` is gone and may not come back: T13 is ticked in the PRD, and this
 * test reads that checkbox so the rule cannot quietly lapse.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const PRD = fileURLToPath(new URL('../../../../ralph/PRD-02-iron.md', import.meta.url))

interface Provenance {
  source?: string
  from?: string
  state?: unknown
  expect?: { events?: unknown[]; dropped?: string }
}

function fixtures(): { name: string; fixture: Provenance }[] {
  return readdirSync(FIXTURES)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(name => ({
      name,
      fixture: JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as Provenance,
    }))
}

function t13Ticked(): boolean {
  const prd = readFileSync(PRD, 'utf8')
  const line = prd.split('\n').find(candidate => /^- \[[ x]\] \*\*T13/.test(candidate))
  if (!line) throw new Error('ralph/PRD-02-iron.md no longer has a T13 line')
  return line.startsWith('- [x]')
}

describe('the fixtures’ provenance', () => {
  it('names a source and a provenance on every file', () => {
    for (const { name, fixture } of fixtures()) {
      expect(['recorded', 'derived', 'upstream', 'schema'], name).toContain(fixture.source)
      if (fixture.source !== 'schema') expect(fixture.from, `${name} names no origin`).toBeTruthy()
    }
  })

  it('holds no schema-sourced fixture once T13 recorded the real thing', () => {
    const placeholders = fixtures().filter(({ fixture }) => fixture.source === 'schema')
    if (t13Ticked()) {
      expect(
        placeholders.map(({ name }) => name),
        'T13 is ticked in ralph/PRD-02-iron.md: replace these with recordings',
      ).toEqual([])
    } else {
      // Before T13 the placeholders are the whole point; there must be some.
      expect(placeholders.length).toBeGreaterThan(0)
    }
  })

  it('records at least the flow a bots match plays', () => {
    if (!t13Ticked()) return
    const recorded = fixtures().filter(({ fixture }) => fixture.source === 'recorded')
    expect(recorded.length, 'no recorded fixture survived').toBeGreaterThan(0)
  })

  it('has every derived fixture pointing at a recorded one beside it', () => {
    const recorded = new Set(
      fixtures()
        .filter(({ fixture }) => fixture.source === 'recorded')
        .map(({ name }) => name),
    )
    for (const { name, fixture } of fixtures()) {
      if (fixture.source !== 'derived') continue
      expect(
        recorded,
        `${name} is derived from ${fixture.from}, which is not a recorded fixture`,
      ).toContain(fixture.from)
    }
  })

  it('has every derived and upstream fixture declaring its own starting state', () => {
    for (const { name, fixture } of fixtures()) {
      if (fixture.source === 'recorded') {
        expect(fixture.state, `${name} is recorded: it carries the story's state`).toBeUndefined()
        continue
      }
      expect(fixture.state, `${name} does not say what score it starts from`).toBeDefined()
    }
  })

  it('asserts nothing but a drop about an upstream-shaped payload', () => {
    for (const { name, fixture } of fixtures()) {
      if (fixture.source !== 'upstream') continue
      expect(fixture.expect?.dropped, `${name} is upstream-shaped but expects events`).toBeTruthy()
      expect(fixture.expect?.events ?? [], name).toEqual([])
    }
  })
})
