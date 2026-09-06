import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stringifyRecording } from '@ezpug/match-api/fixtures'
import { describe, expect, it } from 'vitest'
import type { LinkExchangeFixture } from './fake-server'
import { FIXTURE_TOKEN_MARK, protocolFixtureFiles, stringifyProtocolFixture } from './fixtures'
import { nodeFrameSchema, orchestratorNodeFrameSchema } from './node-link'
import { orchestratorFrameSchema, serverFrameSchema } from './server-link'

/**
 * **The frame fixtures** (PRD-02 T1). One file per union under
 * `fixtures/frames/`, written from the tables in `fixtures.ts` and asserted
 * byte for byte here; `EZPug.Sdk.Tests` reads the same files and proves the
 * generated C# writes them back unchanged. Re-record with
 * `pnpm --filter @ezpug/protocol record`, read the diff, and ship it with the
 * change that caused it.
 */

const FRAMES_DIR = fileURLToPath(new URL('../fixtures/frames/', import.meta.url))
const LINK_DIR = fileURLToPath(new URL('../fixtures/link/', import.meta.url))
const RECORDED_DIR = fileURLToPath(new URL('../fixtures/recorded/', import.meta.url))
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

/**
 * **The recorded link exchanges** (PRD-02 T6): what the fake server and the
 * real `/link` said to each other, written by the orchestrator's link tests.
 * Here every frame must parse with its direction's schema and the file must
 * be its own canonical bytes; the C# side reads the same files.
 */
describe('the recorded link exchanges', () => {
  const files = readdirSync(LINK_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()

  it('exist', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file} parses each way and is canonical`, () => {
      const text = readFileSync(`${LINK_DIR}${file}`, 'utf8')
      const fixture = JSON.parse(text) as LinkExchangeFixture
      expect(fixture.schema).toBe('LinkExchange')
      expect(fixture.exchange.length).toBeGreaterThan(0)
      const reparsed = fixture.exchange.map(entry => {
        if (!('frame' in entry)) return entry
        return entry.from === 'server'
          ? { from: entry.from, frame: serverFrameSchema.parse(entry.frame) }
          : { from: entry.from, frame: orchestratorFrameSchema.parse(entry.frame) }
      })
      expect(stringifyRecording({ schema: 'LinkExchange', exchange: reparsed })).toBe(text)
      for (const match of text.matchAll(/"(?:token|serverToken|nodeToken)": "([^"]*)"/g))
        expect(match[1], `${file}: ${match[0]}`).toContain(FIXTURE_TOKEN_MARK)
    })
  }
})

/**
 * **What a real server actually said** (PRD-02 T13). `scripts/iron-match.mjs`
 * plays one match on the dev node — a `pug`, bots, MatchZy — and writes what
 * crossed `/link` and `/node` and what MatchZy POSTed to its door into
 * `fixtures/recorded/`, scrubbed of every secret, every address and every wall
 * clock. These are not goldens a generator reproduces: they are evidence, and
 * the only thing asserted about them is that the schemas in this package still
 * read them. The day a frame here stops parsing, the protocol moved under a
 * server that already shipped.
 *
 * **No `position_tick` is in here, by construction.** Decision 6 makes it
 * stream-only — never stored, never replayed — so a file in the tree holding
 * one would be storing it; the recorder drops the ticks and the acks they
 * earned, and this test holds that rule.
 */
describe('the recorded real match', () => {
  const files = readdirSync(RECORDED_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()

  it('exists — a real server has been recorded', () => {
    expect(files).toContain('real-pug-link.json')
    expect(files).toContain('real-pug-node.json')
    expect(files).toContain('real-pug-matchzy.json')
  })

  for (const file of files) {
    it(`${file} parses, is canonical, and holds no secret`, () => {
      const text = readFileSync(`${RECORDED_DIR}${file}`, 'utf8')
      const fixture = JSON.parse(text) as { schema: string }
      if (fixture.schema === 'LinkExchange' || fixture.schema === 'NodeExchange') {
        const [up, down] =
          fixture.schema === 'LinkExchange'
            ? [serverFrameSchema, orchestratorFrameSchema]
            : [nodeFrameSchema, orchestratorNodeFrameSchema]
        const exchange = (fixture as unknown as LinkExchangeFixture).exchange
        expect(exchange.length).toBeGreaterThan(0)
        for (const entry of exchange) {
          if (!('frame' in entry)) continue
          ;(entry.from === 'orchestrator' ? down : up).parse(entry.frame)
        }
      } else if (fixture.schema === 'MatchZyExchange') {
        // MatchZy's own wire, verbatim: every payload names its event and the
        // `matchid` the config gave the match. What it *means* is the
        // orchestrator's (`matchzy/fixtures/`), which is why nothing here
        // asserts a translation.
        const events = (
          fixture as unknown as {
            events: { name: string; payload: { event?: string; matchid?: number } }[]
          }
        ).events
        expect(events.length).toBeGreaterThan(0)
        for (const entry of events) {
          expect(entry.payload.event, entry.name).toBe(entry.name)
          expect(typeof entry.payload.matchid, entry.name).toBe('number')
        }
      } else {
        throw new Error(`${file}: unknown schema ${fixture.schema}`)
      }
      // The file's *formatting* is canonical; its field order is the wire's,
      // not a schema's — a recording is evidence and is never regenerated, so
      // reordering it through Zod would only hide what actually crossed.
      expect(stringifyRecording(JSON.parse(text))).toBe(text)
      expect(text, `${file} names a position_tick`).not.toContain('position_tick')
      for (const prefix of ['ezik_', 'ezis_', 'ezin_', 'ezie_', 'ezip_'])
        expect(text, `${file} carries a ${prefix} token`).not.toContain(prefix)
      for (const match of text.matchAll(/"(?:token|serverToken|nodeToken)": "([^"]*)"/g))
        expect(match[1], `${file}: ${match[0]}`).toContain(FIXTURE_TOKEN_MARK)
    })
  }
})
