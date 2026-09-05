import { createPrng } from '@ezpug/core'
import { describe, expect, it } from 'vitest'
import {
  decodeSimulatedMatchRecord,
  SIMULATED_MATCH_RECORD_EXTENSION,
  simulatedRecordFilename,
  simulatedRecording,
} from './record'
import { buildMatchStory } from './story'
import { fixtureAssignment } from './testing'

function story(positionTickIntervalMs: number | null = 1_000) {
  return buildMatchStory({
    prng: createPrng('record-suite'),
    assignment: fixtureAssignment(),
    scenario: { name: 'happy-path' },
    source: { provider: 'sim', serverId: 'sim-record' },
    bootDelayMs: 1_000,
    positionTickIntervalMs,
  })
}

describe('the simulated match record', () => {
  it('is the map’s own events, without the ephemeral tier', () => {
    const played = story()
    const recorded = played.demos[0]

    expect(recorded).toBeDefined()
    expect(recorded?.record.events.some(event => event.type === 'going_live')).toBe(true)
    expect(recorded?.record.events.some(event => event.type === 'round_end')).toBe(true)
    expect(recorded?.record.events.some(event => event.type === 'map_end')).toBe(true)
    // Position ticks are the ephemeral tier and are never stored — the story
    // emitted plenty of them, and none of them is in here.
    expect(played.beats.some(beat => beat.event.type === 'position_tick')).toBe(true)
    expect(recorded?.record.events.some(event => event.type === 'position_tick')).toBe(false)
    // And no derived stat: a recording carries what the server said.
    expect(JSON.stringify(recorded?.record)).not.toContain('"adr"')
  })

  it('says what it is, and what it costs, before anything reads it', () => {
    const recorded = story(null).demos[0]
    expect(recorded?.filename.endsWith(SIMULATED_MATCH_RECORD_EXTENSION)).toBe(true)
    expect(recorded?.filename).not.toContain('.dem')
    expect(recorded?.sizeBytes).toBe(recorded?.bytes.byteLength)
    expect(new TextDecoder().decode(recorded?.bytes).startsWith('{"marker"')).toBe(true)
  })

  it('addresses a stored recording without replaying the story', () => {
    const recorded = story(null).demos[0]
    expect(recorded?.filename).toBe(
      simulatedRecordFilename(
        recorded?.record.matchId as string,
        recorded?.record.mapNumber as number,
        recorded?.record.map as string,
      ),
    )
  })

  it('round-trips through the bytes it is stored as', () => {
    const recorded = story(null).demos[0]
    const decoded = decodeSimulatedMatchRecord(recorded?.bytes as Uint8Array)
    expect(decoded).toEqual(recorded?.record)
  })

  it('answers null for anything that is not one, rather than throwing', () => {
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
    expect(decodeSimulatedMatchRecord(bytes('PBDEMS2\0 …binary…'))).toBeNull()
    expect(decodeSimulatedMatchRecord(bytes('EZPUG SIMULATED DEMO PLACEHOLDER'))).toBeNull()
    expect(decodeSimulatedMatchRecord(bytes('{"marker":"ezpug-simulated-match-record"'))).toBeNull()
    expect(
      decodeSimulatedMatchRecord(
        bytes('{"marker":"ezpug-simulated-match-record","version":99,"events":[]}'),
      ),
    ).toBeNull()
    expect(decodeSimulatedMatchRecord(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull()
  })

  it('refuses a recording it cannot honestly read', () => {
    const recorded = story(null).demos[0]
    const record = structuredClone(recorded?.record) as NonNullable<typeof recorded>['record']
    const broken = { ...record, players: [] }
    expect(decodeSimulatedMatchRecord(JSON.stringify(broken))).toBeNull()
  })

  it('builds nothing a clock or a coin decides', () => {
    const input = () => ({
      matchId: '00000000-0000-4000-8000-0000000000d1',
      serverId: 'sim-1',
      scenario: 'happy-path',
      mapNumber: 2,
      map: 'de_nuke',
      players: [{ steamId64: '76561198000000001', name: 'hunzR', team: 'team_a' as const }],
      events: story(null).demos[0]?.record.events ?? [],
    })
    const first = simulatedRecording(input())
    const second = simulatedRecording(input())
    expect(second.bytes).toEqual(first.bytes)
    expect(second.filename).toBe(first.filename)
  })
})
