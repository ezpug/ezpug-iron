import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeClock } from '@ezpug/core'
import { describe, expect, it } from 'vitest'
import { readOrchestratorConfig } from './config'
import { createFileTrace, nullTrace, scrubTrace, TRACE_REDACTED } from './trace'

/**
 * **The dev recorder** (T13). Two things are worth a test and nothing else
 * is: that a secret cannot reach the file, and that production cannot turn
 * it on.
 */

const ENV = {
  EZPUG_IRON_BASE_URL: 'http://localhost:3430',
  EZPUG_IRON_DATABASE_URL: 'postgres://ezpug:ezpug@127.0.0.1:5443/ezpug_iron',
  EZPUG_IRON_REDIS_URL: 'redis://127.0.0.1:6383',
}

describe('the trace', () => {
  it('records nothing when nothing asked it to', () => {
    expect(nullTrace.on).toBe(false)
    expect(readOrchestratorConfig(ENV).traceFile).toBeNull()
  })

  it('is refused in production', () => {
    expect(() =>
      readOrchestratorConfig({
        ...ENV,
        NODE_ENV: 'production',
        EZPUG_IRON_TRACE_FILE: '/tmp/trace.ndjson',
      }),
    ).toThrow(/EZPUG_IRON_TRACE_FILE: refused under NODE_ENV=production/)
  })

  it('replaces every secret it knows a name for, at any depth', () => {
    expect(
      scrubTrace({
        frame: {
          type: 'hello',
          token: 'ezis_averyrealsecret0000000000000000000000000',
          versions: { plugin: '0.1.0' },
          teams: [{ password: 'apfel' }],
        },
      }),
    ).toEqual({
      frame: {
        type: 'hello',
        token: TRACE_REDACTED,
        versions: { plugin: '0.1.0' },
        teams: [{ password: TRACE_REDACTED }],
      },
    })
  })

  it('keeps a presigned URL’s path and drops its signature', () => {
    expect(
      scrubTrace({ demoUploadUrl: 'http://127.0.0.1:9400/demos/a.dem?X-Amz-Signature=deadbeef' }),
    ).toEqual({ demoUploadUrl: `http://127.0.0.1:9400/demos/a.dem?${TRACE_REDACTED}` })
  })

  it('writes one scrubbed NDJSON line per entry, stamped by the clock', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ezpug-trace-')), 'nested', 'trace.ndjson')
    const clock = createFakeClock({ start: '2026-09-06T00:00:00.000Z' })
    const trace = createFileTrace({ path, clock })
    trace.write('link', { socket: 'link-1', from: 'server', frame: { type: 'heartbeat' } })
    // A token that arrived inside some other string is caught by the log's
    // own redaction on the serialised line — belt under the braces above.
    trace.write('link', {
      socket: 'link-1',
      note: 'sidecar ezis_leakedbyaccident00000000000000000000',
    })
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(lines).toEqual([
      {
        at: Date.parse('2026-09-06T00:00:00.000Z'),
        kind: 'link',
        socket: 'link-1',
        from: 'server',
        frame: { type: 'heartbeat' },
      },
      {
        at: Date.parse('2026-09-06T00:00:00.000Z'),
        kind: 'link',
        socket: 'link-1',
        note: 'sidecar ezis_…',
      },
    ])
  })
})
