import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Clock } from '@ezpug/core'
import { redactSecrets } from './log'

/**
 * **The trace** (PRD-02 T13): a dev-only, off-by-default recorder of the two
 * conversations no client can see — the frames on `/link` and `/node`, and
 * the payloads MatchZy POSTs to its door. `scripts/iron-match.mjs` turns one
 * run of it into the recorded fixtures; nothing else reads it.
 *
 * Everything a client *can* see (envelopes, webhooks, stream frames) is
 * recorded by the script itself over the public surface, so the orchestrator
 * only grows the seam for what is genuinely internal.
 *
 * Three rules, because this writes a file on a real box:
 *
 * - **Off unless asked.** `EZPUG_IRON_TRACE_FILE` names the file; without it
 *   {@link nullTrace} is wired everywhere and costs one boolean per frame.
 *   It is refused under `NODE_ENV=production` (`config.ts`) — a production
 *   orchestrator does not write conversations to disk.
 * - **Scrubbed on the way in, not on the way out.** {@link scrubTrace}
 *   replaces every token, password and presigned query *before* the line is
 *   written, so the file on disk never holds a secret even if the run dies
 *   before the script gets to it. The fixture writer scrubs again for
 *   addresses and relative timestamps; this is the belt under those braces.
 * - **Line-at-a-time and synchronous.** One NDJSON line per entry, appended
 *   with `appendFileSync`: a trace that loses its tail when a run is killed
 *   is worth nothing, and the only process that ever turns this on is a
 *   developer's own.
 */

export interface Trace {
  /** False when nothing is being written — a caller may skip composing an entry. */
  readonly on: boolean
  /** Append one entry. `kind` is the discriminator the fixture writer switches on. */
  write: (kind: string, entry: Record<string, unknown>) => void
}

/** The trace that records nothing. Wired whenever `EZPUG_IRON_TRACE_FILE` is unset. */
export const nullTrace: Trace = { on: false, write: () => {} }

/** Keys whose value is a secret wherever it appears, at any depth. */
const SECRET_KEYS = new Set([
  'token',
  'serverToken',
  'nodeToken',
  'password',
  'rconPassword',
  'headerValue',
  'secret',
  'loginToken',
  'steam_game_server_login_token',
])

/** Keys holding a presigned URL: the path is a fact, the query is the signature. */
const PRESIGNED_KEYS = new Set(['demoUploadUrl', 'url'])

/** What a scrubbed value says it was — greppable, and obviously not a secret. */
export const TRACE_REDACTED = '<redacted>'

function scrubUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!url.search) return value
    url.search = ''
    return `${url.toString()}?${TRACE_REDACTED}`
  } catch {
    return value
  }
}

/**
 * A deep copy with every secret replaced. Applied to each entry before it is
 * serialised; the serialised line then goes through {@link redactSecrets} as
 * well, which catches a token that arrived inside some other string.
 */
export function scrubTrace(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubTrace)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(key) && typeof item === 'string') out[key] = TRACE_REDACTED
      else if (PRESIGNED_KEYS.has(key) && typeof item === 'string') out[key] = scrubUrl(item)
      else out[key] = scrubTrace(item)
    }
    return out
  }
  return value
}

export interface FileTraceOptions {
  path: string
  clock: Clock
  /** Said once, when the first line is written. */
  onOpen?: (path: string) => void
}

/** A trace that appends NDJSON to `path`, creating its directory on the first line. */
export function createFileTrace(options: FileTraceOptions): Trace {
  const { path, clock } = options
  let opened = false
  return {
    on: true,
    write(kind, entry) {
      if (!opened) {
        mkdirSync(dirname(path), { recursive: true })
        opened = true
        options.onOpen?.(path)
      }
      const line = JSON.stringify({
        at: clock.now(),
        kind,
        ...(scrubTrace(entry) as Record<string, unknown>),
      })
      appendFileSync(path, `${redactSecrets(line)}\n`)
    },
  }
}
