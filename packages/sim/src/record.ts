/**
 * **What a simulated match leaves behind.** A simulated match has no `.dem`
 * to hand over, and the pipe that carries demos should still be exercised end
 * to end — so the simulator produces its own **recording**: the map's
 * normalized gameserver events, exactly the vocabulary the server spoke live,
 * in one JSON document per map. The platform's history producer reads it
 * (its `history.ts` stays on the platform; this is the writer's half).
 *
 * Honesty is the whole design. Nothing about this file pretends to be a demo:
 * the first key says what it is, the extension says it too, it is stored as
 * `application/json`, and `demo_available` reports its real byte length.
 *
 * Two things it deliberately does **not** carry:
 *
 * - **Position ticks.** They are the ephemeral tier and are never stored
 *   (`isEphemeralGameserverEvent` is the one switch).
 * - **Any derived stat.** No ADR, no KAST, no score beyond what the events
 *   themselves reported. A recording that carried answers would be a second
 *   rulebook.
 *
 * The platform's `record.ts` on 2026-09-05, verbatim; the platform's copy of
 * `simulated-history.record.json` is parsed by this schema in the vocabulary's
 * own tests, which is the proof the two still agree.
 */
import type { GameserverEvent, MatchTeam } from '@ezpug/match-api'
import { gameserverEventSchema, matchTeamSchema, steamId64Schema } from '@ezpug/match-api'
import { z } from 'zod'

/** The first key of every recording — what a reader (or a parser) sees first. */
export const SIMULATED_MATCH_RECORD_MARKER = 'ezpug-simulated-match-record'

/** Bumped when this document reshapes; the producer refuses what it cannot read. */
export const SIMULATED_MATCH_RECORD_VERSION = 1

/** Stored as what it is: JSON, not a demo. */
export const SIMULATED_MATCH_RECORD_CONTENT_TYPE = 'application/json; charset=utf-8'

/** The suffix the filename carries, so nothing downstream reads it as a `.dem`. */
export const SIMULATED_MATCH_RECORD_EXTENSION = '.ezpug-sim.json'

export const simulatedMatchRecordSchema = z.object({
  marker: z.literal(SIMULATED_MATCH_RECORD_MARKER),
  version: z.literal(SIMULATED_MATCH_RECORD_VERSION),
  matchId: z.uuid(),
  /** 1-based, matching the `demo_available` event this recording rides with. */
  mapNumber: z.number().int().positive(),
  /** Engine map identifier — the recording is one map, as one demo is. */
  map: z.string().min(1),
  /** Which simulated box played it, and which scenario it was told to play. */
  serverId: z.string().min(1),
  scenario: z.string().min(1),
  /**
   * The roster as the server saw it. Carried explicitly because the map's own
   * events do not name the people who never appeared in one.
   */
  players: z
    .array(
      z.object({
        steamId64: steamId64Schema,
        name: z.string().min(1),
        team: matchTeamSchema,
      }),
    )
    .min(1),
  /** This map's normalized events in emission order, ephemeral ones excluded. */
  events: z.array(gameserverEventSchema).min(1),
})
export type SimulatedMatchRecord = z.infer<typeof simulatedMatchRecordSchema>

export interface SimulatedMatchRecordInput {
  matchId: string
  serverId: string
  scenario: string
  mapNumber: number
  map: string
  players: readonly { steamId64: string; name: string; team: MatchTeam }[]
  events: readonly GameserverEvent[]
}

/** One recording, and the bytes it will be stored as. */
export interface SimulatedRecording {
  /** 1-based, matching the `demo_available` event. */
  mapNumber: number
  /** The filename the event announces; the storage layer sanitizes it into a key. */
  filename: string
  record: SimulatedMatchRecord
  /** The document itself, UTF-8 JSON — what `record()` hands the upload. */
  bytes: Uint8Array
  /** `bytes.byteLength` — what the event reports as `sizeBytes`. */
  sizeBytes: number
}

/**
 * The name a recording is announced and stored under. Deterministic on
 * purpose: a caller holding only a match and a map can address the object
 * without replaying the story.
 */
export function simulatedRecordFilename(matchId: string, mapNumber: number, map: string): string {
  return `${matchId}_map${mapNumber}_${map}${SIMULATED_MATCH_RECORD_EXTENSION}`
}

/** Build one recording. Pure and deterministic — no clock, no randomness. */
export function simulatedRecording(input: SimulatedMatchRecordInput): SimulatedRecording {
  const record: SimulatedMatchRecord = {
    marker: SIMULATED_MATCH_RECORD_MARKER,
    version: SIMULATED_MATCH_RECORD_VERSION,
    matchId: input.matchId,
    mapNumber: input.mapNumber,
    map: input.map,
    serverId: input.serverId,
    scenario: input.scenario,
    players: input.players.map(player => ({ ...player })),
    events: [...input.events],
  }
  const bytes = new TextEncoder().encode(JSON.stringify(record))
  return {
    mapNumber: input.mapNumber,
    filename: simulatedRecordFilename(input.matchId, input.mapNumber, input.map),
    record,
    bytes,
    sizeBytes: bytes.byteLength,
  }
}

/**
 * Read bytes as a recording, or answer `null`.
 *
 * Null is the load-bearing half: a reader hands *every* object that is not a
 * CS2 demo to this, so "not a recording" — a CS:GO demo, a truncated download,
 * a text file — has to be an answer rather than a throw. A recording from a
 * future version answers null too: the shape it promises is not one this
 * build can read.
 */
const MARKER_WINDOW = 256

/** The first `length` bytes as text, latin1-safe for arbitrary binary input. */
function decodeHead(bytes: Uint8Array, length: number): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, length))
}

export function decodeSimulatedMatchRecord(
  bytes: Uint8Array | string,
): SimulatedMatchRecord | null {
  // The marker is checked against the head alone, before anything decodes the
  // whole object: a reader runs this over things that are hundreds of
  // megabytes, and only a recording says what it is in its first line.
  const head =
    typeof bytes === 'string' ? bytes.slice(0, MARKER_WINDOW) : decodeHead(bytes, MARKER_WINDOW)
  if (!head.includes(SIMULATED_MATCH_RECORD_MARKER)) return null
  try {
    const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)
    const parsed = simulatedMatchRecordSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
