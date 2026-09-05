/// <reference types="node" />
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FAKE_CONFORMANCE_SECRET, FAKE_SECRET_PREFIXES } from '../fake'
import { createFakeConformanceTarget } from '../fake/conformance'
import {
  formatConformanceReport,
  MATCH_API_CONFORMANCE_FLOWS,
  runMatchApiConformance,
  stringifyRecording,
} from './conformance'

/**
 * **The golden files** (PRD-01 T8). Every flow the conformance suite runs
 * against the fake is recorded into `fixtures/recorded/<flow>.json` — the
 * calls with their inputs and answers, every envelope in `seq` order, the
 * order the deliveries arrived in, the stream frames — and this test asserts
 * the fake still produces them byte for byte. They are the contract's
 * goldens: the files PRD-02's generated C# types round-trip, the files the
 * platform's translator is proven against, and the diff that shows up in
 * review when a schema moved.
 *
 * Re-record with `pnpm --filter @ezpug/match-api record`, read the diff, and
 * ship it in the same commit as the change that caused it — a golden that is
 * regenerated without being read is worth nothing.
 */

const RECORDED_DIR = fileURLToPath(new URL('../../fixtures/recorded/', import.meta.url))
const RECORDING = process.env.EZPUG_IRON_RECORD === '1'

function fileFor(flow: string): string {
  return `${RECORDED_DIR}${flow}.json`
}

/** One flow, alone, against a fresh fake: the same instance every time. */
async function record(flow: string): Promise<string> {
  const report = await runMatchApiConformance({
    flows: [flow],
    target: () => createFakeConformanceTarget(),
  })
  expect(report.ok, formatConformanceReport(report)).toBe(true)
  return stringifyRecording(report.results[0]?.recording)
}

describe('the recorded fixtures', () => {
  if (RECORDING) mkdirSync(RECORDED_DIR, { recursive: true })

  for (const flow of MATCH_API_CONFORMANCE_FLOWS) {
    it(`${flow.id} is what it was recorded as`, async () => {
      const produced = await record(flow.id)
      if (RECORDING) {
        writeFileSync(fileFor(flow.id), produced)
        return
      }
      expect(existsSync(fileFor(flow.id)), `no golden for ${flow.id} — run the record script`).toBe(
        true,
      )
      // A string comparison, not a deep one: the golden is bytes on disk.
      expect(produced).toBe(readFileSync(fileFor(flow.id), 'utf8'))
    })
  }

  it('has one file per flow and no orphans', () => {
    const files = readdirSync(RECORDED_DIR)
      .filter(name => name.endsWith('.json'))
      .map(name => name.replace(/\.json$/, ''))
      .sort()
    expect(files).toEqual([...MATCH_API_CONFORMANCE_FLOWS.map(flow => flow.id)].sort())
  })

  it('carries no secret, not even a fake one', () => {
    const needles = [...Object.values(FAKE_SECRET_PREFIXES), FAKE_CONFORMANCE_SECRET]
    for (const flow of MATCH_API_CONFORMANCE_FLOWS) {
      const text = readFileSync(fileFor(flow.id), 'utf8')
      for (const needle of needles) {
        expect(text, `${flow.id}.json carries ${needle}`).not.toContain(needle)
      }
    }
  })
})
