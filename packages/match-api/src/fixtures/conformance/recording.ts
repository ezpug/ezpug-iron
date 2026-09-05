import { ApiError } from '../../errors'
import type { ConformanceCall, ConformanceClient } from './types'

/**
 * **The golden files' machinery** (PRD-01 T8). A flow's calls are recorded by
 * wrapping the client, not by writing them down twice: whatever the flow
 * asks for is what the fixture holds, so a fixture can never drift from the
 * suite that produced it.
 *
 * Two rules make the result committable to a public repo:
 *
 * - **Secrets are redacted by name.** A server password, a player token, an
 *   API key secret: replaced with `REDACTED` wherever they appear, at any
 *   depth. The fake's are obviously fake, but a fixture that carries a
 *   password teaches the shape of one, and a test greps these files for the
 *   fakes' known strings.
 * - **The bytes are canonical.** One writer (`stringifyRecording`), so
 *   "byte-for-byte" is a property of the data and not of whoever wrote it.
 */

/** What a redacted field says. Recognisable, and not mistakable for a value. */
export const REDACTED = '<redacted>'

/** Field names whose value never lands in a fixture, at any depth. */
export const REDACTED_FIELDS = ['password', 'token', 'secret', 'apiKey'] as const

/** Deep copy with every {@link REDACTED_FIELDS} value replaced. */
export function redact<T>(value: T): T {
  return redactUnknown(value) as T
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactUnknown)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = (REDACTED_FIELDS as readonly string[]).includes(key)
      ? entry === null || entry === undefined
        ? entry
        : REDACTED
      : redactUnknown(entry)
  }
  return out
}

/**
 * The client again, with every call appended to `sink` — input, and either
 * the response or the typed error. The shape is the client's own, so a flow
 * that uses `ctx.api` reads exactly like a flow that uses `ctx.raw`.
 */
export function createRecordingClient(client: ConformanceClient, sink: ConformanceCall[]) {
  return wrap(client as unknown as Record<string, unknown>, '', sink) as ConformanceClient
}

function wrap(node: Record<string, unknown>, dotted: string, sink: ConformanceCall[]): unknown {
  if (typeof node === 'function') {
    const call = node as unknown as (input?: unknown) => Promise<unknown>
    return async (input?: Record<string, unknown>) => {
      try {
        const response = await call(input)
        sink.push({ route: dotted, ...inputOf(input), ok: true, response: redact(response) })
        return response
      } catch (error) {
        if (error instanceof ApiError) {
          sink.push({
            route: dotted,
            ...inputOf(input),
            ok: false,
            status: error.status,
            code: error.code,
            message: error.message,
          })
        }
        throw error
      }
    }
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    out[key] = wrap(
      value as Record<string, unknown>,
      dotted ? `${dotted}.${key}` : key,
      sink,
    ) as unknown
  }
  return out
}

function inputOf(input: Record<string, unknown> | undefined): { input?: Record<string, unknown> } {
  if (input === undefined || Object.keys(input).length === 0) return {}
  return { input: redact(input) }
}

/**
 * The one writer for a recorded fixture: two-space JSON with a trailing
 * newline, so a golden file is a readable diff and `git` never argues about
 * the last byte.
 */
export function stringifyRecording(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Structural equality for wire data. Two envelopes that travelled different
 * paths — one parsed out of a webhook body, one handed straight to a stream
 * subscriber — carry their fields in whatever order they were built in, so a
 * flow that compared their JSON text would fail on nothing. The golden files
 * are compared as text (one writer, one path); everything a flow compares is
 * compared with this.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqual(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
}
