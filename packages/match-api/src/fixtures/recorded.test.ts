/// <reference types="node" />
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FAKE_CONFORMANCE_SECRET, FAKE_SECRET_PREFIXES } from '../fake'
import { createFakeConformanceTarget } from '../fake/conformance'
import { streamFrameSchema } from '../stream/frames'
import { webhookEnvelopeSchema } from '../webhooks/envelope'
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

  it('has one file per flow, plus the real recordings, and no orphans', () => {
    const files = readdirSync(RECORDED_DIR)
      .filter(name => name.endsWith('.json'))
      .map(name => name.replace(/\.json$/, ''))
      .filter(name => !name.startsWith('real-'))
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

/**
 * **The real recordings** (PRD-02 T13). `real-*.json` is not a golden: it is
 * what one match on real hardware said over the published surface — the calls
 * a client made, the envelopes the events route replayed, the webhook
 * deliveries with their verification, the stream frames. It is written by
 * `scripts/iron-match.mjs --write-fixtures` and never regenerated from code,
 * which is exactly what makes it worth having: **every payload in it must
 * still parse**, and the day one stops, the vocabulary moved under a server
 * that already shipped.
 */
describe('the real recordings', () => {
  const files = readdirSync(RECORDED_DIR)
    .filter(name => name.startsWith('real-') && name.endsWith('.json'))
    .sort()

  it('exists — one match has been played and written down', () => {
    expect(files.length, 'no real-*.json: run `pnpm iron:match --write-fixtures`').toBeGreaterThan(
      0,
    )
  })

  for (const file of files) {
    it(`${file} still parses, whole`, () => {
      const text = readFileSync(`${RECORDED_DIR}${file}`, 'utf8')
      const recording = JSON.parse(text) as {
        envelopes: { seq: number }[]
        deliveries: { seq: number; type: string; signature: string }[]
        frames: unknown[]
      }
      expect(recording.envelopes.length).toBeGreaterThan(0)
      const seqs = new Set<number>()
      for (const envelope of recording.envelopes) {
        webhookEnvelopeSchema.parse(envelope)
        seqs.add(envelope.seq)
      }
      for (const delivery of recording.deliveries) {
        // Every delivery that arrived was signed by the orchestrator and
        // verified by the published verifier before it was written down, and
        // the events route replayed the same fact under the same `seq`.
        expect(delivery.signature, `${file} seq ${delivery.seq}`).toBe('verified')
        expect(seqs, `${file}: seq ${delivery.seq} was delivered but never replayed`).toContain(
          delivery.seq,
        )
      }
      for (const frame of recording.frames) streamFrameSchema.parse(frame)
      // Ephemeral by decision 6: never stored, so never in a file either.
      expect(text, `${file} names a position_tick`).not.toContain('position_tick')
      expect(stringifyRecording(JSON.parse(text))).toBe(text)
    })

    it(`${file} carries no secret`, () => {
      const text = readFileSync(`${RECORDED_DIR}${file}`, 'utf8')
      for (const prefix of ['ezik_', 'ezis_', 'ezin_', 'ezie_', 'ezip_'])
        expect(text, `${file} carries a ${prefix} token`).not.toContain(prefix)
      expect(text, `${file} carries a presigned signature`).not.toContain('X-Amz-Signature')
    })
  }
})
