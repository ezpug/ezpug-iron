import { createPrng } from '@ezpug/core'
import type { GameserverEventOf, GameserverEventType, MapRadar } from '@ezpug/match-api'
import { gameserverEventSchema, worldToRadar } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import type { MatchAssignment } from './assignment'
import { planSimulatedChatter, SIMULATED_CHAT_LINES } from './chatter'
import { SIMULATOR_SCENARIOS, type SimulatorScenario } from './scenario'
import {
  BACKUP_RESTORED_EVENT,
  buildMatchStory,
  type MatchStory,
  planMapRounds,
  resumeStory,
  SimulatorRestoreError,
  teamASideAt,
} from './story'
import { fixtureAssignment } from './testing'

const SOURCE = { provider: 'sim', serverId: 'sim-1' }

function storyFor(
  scenario: SimulatorScenario,
  seed = 'story-test',
  overrides: Partial<MatchAssignment> = {},
  positionTickIntervalMs: number | null = 5_000,
  radars: readonly (MapRadar | null)[] = [],
): MatchStory {
  return buildMatchStory({
    prng: createPrng(seed),
    assignment: fixtureAssignment(overrides),
    scenario,
    source: SOURCE,
    bootDelayMs: 4_000,
    positionTickIntervalMs,
    radars,
  })
}

/** Mirage's own overview numbers — the fixture assignment plays it. */
const MIRAGE: MapRadar = {
  layers: [
    {
      name: 'default',
      imageUrl: '/radar/de_mirage.png',
      posX: -3230,
      posY: 1713,
      scale: 5,
      size: 1024,
      zMin: null,
      zMax: null,
    },
  ],
}

function ofType<T extends GameserverEventType>(story: MatchStory, type: T): GameserverEventOf<T>[] {
  return story.beats
    .map(beat => beat.event)
    .filter((event): event is GameserverEventOf<T> => event.type === type)
}

describe('buildMatchStory', () => {
  it('is deterministic under a seed, and a different seed tells a different story', () => {
    const one = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'seed-a')
    const two = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'seed-a')
    const three = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'seed-b')
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(three))
  })

  it('emits only events that parse against the normalized contract, in time order', () => {
    const story = storyFor(SIMULATOR_SCENARIOS.overtime)
    expect(story.beats.length).toBeGreaterThan(50)
    let previous = 0
    for (const beat of story.beats) {
      gameserverEventSchema.parse(beat.event)
      expect(beat.atMs).toBeGreaterThanOrEqual(previous)
      previous = beat.atMs
    }
  })

  it('plays a happy-path Bo1 to a consistent, clinched result', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'])
    expect(story.outcome).toBe('completed')

    const first = story.beats[0]?.event
    expect(first?.type).toBe('server_ready')
    expect(ofType(story, 'player_connected')).toHaveLength(10)
    expect(ofType(story, 'going_live')).toHaveLength(1)

    const rounds = ofType(story, 'round_end')
    rounds.forEach((round, index) => {
      expect(round.roundNumber).toBe(index + 1)
      expect(round.score.teamA + round.score.teamB).toBe(index + 1)
    })

    // MR12, no overtime: the winner clinches at exactly 13.
    const [mapEnd] = ofType(story, 'map_end')
    const lastRound = rounds[rounds.length - 1]
    expect(mapEnd?.score).toEqual(lastRound?.score)
    expect(Math.max(mapEnd?.score.teamA ?? 0, mapEnd?.score.teamB ?? 0)).toBe(13)
    expect(mapEnd?.winner).not.toBeNull()

    const [seriesEnd] = ofType(story, 'series_end')
    expect(seriesEnd?.winner).toBe(mapEnd?.winner)
    expect(story.beats[story.beats.length - 1]?.event.type).toBe('series_end')
    expect(ofType(story, 'demo_available')).toHaveLength(1)
    expect(ofType(story, 'backup_written')).toHaveLength(rounds.length)
  })

  it('keeps win conditions consistent with the winning side', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'sides')
    for (const round of ofType(story, 'round_end')) {
      if (round.winCondition === 'bomb_exploded') expect(round.winner.side).toBe('t')
      if (round.winCondition === 'bomb_defused' || round.winCondition === 'time_expired') {
        expect(round.winner.side).toBe('ct')
      }
    }
  })

  it('swaps sides at halftime, between round 12 and round 13', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'])
    const types = story.beats.map(beat => beat.event)
    const swapAt = types.findIndex(event => event.type === 'side_swap')
    const round12End = types.findIndex(
      event => event.type === 'round_end' && event.roundNumber === 12,
    )
    const round13Start = types.findIndex(
      event => event.type === 'round_start' && event.roundNumber === 13,
    )
    expect(swapAt).toBeGreaterThan(round12End)
    expect(swapAt).toBeLessThan(round13Start)
  })

  it('shows every kill it counts: the final summary matches the kill feed', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'])
    const kills = ofType(story, 'player_death')
    const rounds = ofType(story, 'round_end')
    const summary = rounds[rounds.length - 1]?.players ?? []
    expect(summary).toHaveLength(10)
    expect(summary.reduce((sum, p) => sum + p.kills, 0)).toBe(kills.length)
    expect(summary.reduce((sum, p) => sum + p.deaths, 0)).toBe(kills.length)
    // The feed names rostered humans, never invented ones.
    const rostered = new Set(summary.map(p => p.player.steamId64))
    for (const kill of kills) {
      expect(rostered.has(kill.victim.steamId64)).toBe(true)
      if (kill.killer) expect(rostered.has(kill.killer.steamId64)).toBe(true)
    }
  })

  it('tells a coherent bomb story inside each bomb round', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'bombs')
    const rounds = ofType(story, 'round_end')
    const bombRounds = rounds.filter(
      r => r.winCondition === 'bomb_exploded' || r.winCondition === 'bomb_defused',
    )
    expect(bombRounds.length).toBeGreaterThan(0)
    for (const round of bombRounds) {
      const plant = ofType(story, 'bomb_planted').find(e => e.roundNumber === round.roundNumber)
      expect(plant).toBeDefined()
      const resolution =
        round.winCondition === 'bomb_exploded'
          ? ofType(story, 'bomb_exploded').find(e => e.roundNumber === round.roundNumber)
          : ofType(story, 'bomb_defused').find(e => e.roundNumber === round.roundNumber)
      expect(resolution?.roundTimeMs).toBeGreaterThan(plant?.roundTimeMs ?? 0)
    }
  })

  it('overtime: regulation ends tied and the map is decided past it', () => {
    const story = storyFor(SIMULATOR_SCENARIOS.overtime)
    const rounds = ofType(story, 'round_end')
    const regulationEnd = rounds.find(round => round.roundNumber === 24)
    expect(regulationEnd?.score).toEqual({ teamA: 12, teamB: 12 })
    expect(rounds.length).toBeGreaterThan(24)
    expect(rounds.length).toBeLessThanOrEqual(30)
    const [mapEnd] = ofType(story, 'map_end')
    expect(Math.max(mapEnd?.score.teamA ?? 0, mapEnd?.score.teamB ?? 0)).toBe(16)
  })

  it('comeback: the eventual winner trails at the half', () => {
    const story = storyFor(SIMULATOR_SCENARIOS.comeback)
    const [mapEnd] = ofType(story, 'map_end')
    const half = ofType(story, 'round_end').find(round => round.roundNumber === 12)
    const winnerAtHalf =
      mapEnd?.winner === 'team_a' ? (half?.score.teamA ?? 0) : (half?.score.teamB ?? 0)
    const loserAtHalf =
      mapEnd?.winner === 'team_a' ? (half?.score.teamB ?? 0) : (half?.score.teamA ?? 0)
    expect(loserAtHalf).toBeGreaterThan(winnerAtHalf)
  })

  it('pauses: every tactical pause unpauses before the next round starts', () => {
    const story = storyFor(SIMULATOR_SCENARIOS.pauses)
    const paused = ofType(story, 'match_paused')
    expect(paused).toHaveLength(2)
    expect(ofType(story, 'match_unpaused')).toHaveLength(2)
    const events = story.beats.map(beat => beat.event)
    events.forEach((event, index) => {
      if (event.type !== 'match_paused') return
      expect(events[index + 1]?.type).toBe('match_unpaused')
    })
  })

  it('no-show: some never connect, nothing goes live, the story runs dry', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['no-show'])
    expect(story.outcome).toBe('idle')
    expect(ofType(story, 'player_connected')).toHaveLength(8)
    expect(ofType(story, 'going_live')).toHaveLength(0)
  })

  it('server-crash: the stream stops right after the configured round', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['server-crash'])
    expect(story.outcome).toBe('crashed')
    const last = story.beats[story.beats.length - 1]?.event
    expect(last?.type).toBe('round_end')
    expect((last as GameserverEventOf<'round_end'>).roundNumber).toBe(9)
    expect(ofType(story, 'map_end')).toHaveLength(0)
    expect(ofType(story, 'series_end')).toHaveLength(0)
  })

  it('says three lines a match: warmup all-chat, a team line after the pistol, a gg at the end', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'])
    const said = ofType(story, 'chat_message')
    expect(said).toHaveLength(3)
    expect(said.map(event => event.scope)).toEqual(['all', 'team', 'all'])
    // Every speaker is somebody on the box, and every line is one of the
    // fixture's — the simulator invents no conversation.
    const roster = new Set(ofType(story, 'player_connected').map(event => event.player.steamId64))
    for (const event of said) {
      expect(roster.has(event.player.steamId64)).toBe(true)
      expect(Object.values(SIMULATED_CHAT_LINES).flat()).toContain(event.text)
    }
    // The warmup line comes before the map goes live; the gg after the last round.
    const live = ofType(story, 'going_live')[0]
    const rounds = ofType(story, 'round_end')
    const beats = story.beats.map(beat => beat.event)
    expect(beats.indexOf(said[0] as never)).toBeLessThan(beats.indexOf(live as never))
    expect(beats.indexOf(said[2] as never)).toBeGreaterThan(
      beats.indexOf(rounds.at(-1) as never) - 1,
    )
    // A no-show never gets that far and says nothing.
    expect(ofType(storyFor(SIMULATOR_SCENARIOS['no-show']), 'chat_message')).toHaveLength(0)
  })

  it('draws its chat on a stream of its own — which is why no seeded match moved', () => {
    // The guard behind `prng.fork('chatter')`: the lines a match says do not
    // depend on how much of the story's own stream has been spent, and
    // spending them costs the story nothing.
    const stream = createPrng('story-test')
    const before = planSimulatedChatter(stream.fork('chatter'), 10)
    const rounds = [stream.next(), stream.next(), stream.next()]
    expect(planSimulatedChatter(stream.fork('chatter'), 10)).toEqual(before)
    const fresh = createPrng('story-test')
    fresh.fork('chatter')
    expect([fresh.next(), fresh.next(), fresh.next()]).toEqual(rounds)
  })

  it('never-ready: not a single event', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['never-ready'])
    expect(story.outcome).toBe('idle')
    expect(story.beats).toHaveLength(0)
  })

  it('samples positions of the living only, and not at all when switched off', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'])
    const ticks = ofType(story, 'position_tick')
    expect(ticks.length).toBeGreaterThan(0)
    for (const tick of ticks) {
      expect(tick.positions.length).toBeLessThanOrEqual(10)
      expect(tick.positions.length).toBeGreaterThan(0)
    }
    const silent = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'story-test', {}, null)
    expect(ofType(silent, 'position_tick')).toHaveLength(0)
  })

  it('walks its people on the map it was told it is playing', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'story-test', {}, 5_000, [MIRAGE])
    const ticks = ofType(story, 'position_tick')
    expect(ticks.length).toBeGreaterThan(0)

    for (const tick of ticks) {
      for (const position of tick.positions) {
        const point = worldToRadar(MIRAGE, position)
        // On the picture, with room to spare — a dot half off the image is a
        // dot a spectator reads as somebody standing in the void.
        expect(point.x).toBeGreaterThanOrEqual(0)
        expect(point.x).toBeLessThanOrEqual(1024)
        expect(point.y).toBeGreaterThanOrEqual(0)
        expect(point.y).toBeLessThanOrEqual(1024)
      }
    }
  })

  it('tells the same match whether or not it was told what the map looks like', () => {
    const told = storyFor(SIMULATOR_SCENARIOS.overtime, 'story-test', {}, 5_000, [MIRAGE])
    const untold = storyFor(SIMULATOR_SCENARIOS.overtime, 'story-test', {}, 5_000)

    // Only the ephemeral tier reads the radar, and both wanders draw the same
    // dice in the same order — so everything that is *history* is identical.
    const permanent = (story: MatchStory) =>
      story.beats.filter(beat => beat.event.type !== 'position_tick')
    expect(JSON.stringify(permanent(told))).toBe(JSON.stringify(permanent(untold)))
    expect(ofType(told, 'position_tick').length).toBe(ofType(untold, 'position_tick').length)
  })

  it('plays a csgo assignment the same way, with Get5 backup names', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'csgo', {
      game: 'csgo',
      regulationRounds: 30,
    })
    expect(story.outcome).toBe('completed')
    // MR15 came from the assignment, and the clinch follows it.
    const [mapEnd] = ofType(story, 'map_end')
    expect(Math.max(mapEnd?.score.teamA ?? 0, mapEnd?.score.teamB ?? 0)).toBe(16)
    expect(ofType(story, 'backup_written')[0]?.filename).toMatch(/^get5_backup_/)
  })

  it('knifes for sides when the config leaves them open', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'knife', {
      maps: [{ map: 'de_inferno', teamASide: 'knife' }],
    })
    const knife = ofType(story, 'plugin_event').find(event => event.name === 'knife_round_won')
    expect(knife).toBeDefined()
  })
})

describe('planMapRounds', () => {
  it('always ends on the winning round, at a clinched score', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const rounds = planMapRounds(createPrng(seed), 'team_a', 24, 6, {
        overtimes: 0,
        comeback: false,
      })
      expect(rounds[rounds.length - 1]).toBe('team_a')
      expect(rounds.filter(team => team === 'team_a')).toHaveLength(13)
      expect(rounds.filter(team => team === 'team_b').length).toBeLessThan(13)
    }
  })

  it('through two overtimes: 12-12, then 15-15, then decided', () => {
    const rounds = planMapRounds(createPrng('double-ot'), 'team_b', 24, 6, {
      overtimes: 2,
      comeback: false,
    })
    const at = (count: number): { a: number; b: number } => ({
      a: rounds.slice(0, count).filter(team => team === 'team_a').length,
      b: rounds.slice(0, count).filter(team => team === 'team_b').length,
    })
    expect(at(24)).toEqual({ a: 12, b: 12 })
    expect(at(30)).toEqual({ a: 15, b: 15 })
    expect(rounds.filter(team => team === 'team_b')).toHaveLength(19)
  })
})

describe('teamASideAt', () => {
  it('halves and overtime halves alternate', () => {
    expect(teamASideAt(1, 'ct', 24, 6)).toBe('ct')
    expect(teamASideAt(12, 'ct', 24, 6)).toBe('ct')
    expect(teamASideAt(13, 'ct', 24, 6)).toBe('t')
    expect(teamASideAt(24, 'ct', 24, 6)).toBe('t')
    expect(teamASideAt(25, 'ct', 24, 6)).toBe('ct')
    expect(teamASideAt(27, 'ct', 24, 6)).toBe('ct')
    expect(teamASideAt(28, 'ct', 24, 6)).toBe('t')
    expect(teamASideAt(30, 'ct', 24, 6)).toBe('t')
    expect(teamASideAt(31, 'ct', 24, 6)).toBe('ct')
  })
})

describe('resumeStory', () => {
  const assignment = fixtureAssignment()
  const full = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'resume-test')
  const resumed = () =>
    resumeStory({
      story: full,
      assignment,
      source: { provider: 'sim', serverId: 'sim-2' },
      point: { mapNumber: 1, roundNumber: 9 },
      prng: createPrng('resume-test').fork('restore'),
      bootDelayMs: 4_000,
    })

  it('boots, reconnects everybody, restores the backup, goes live and plays on', () => {
    const story = resumed()
    const types = story.beats.map(beat => beat.event.type)
    expect(types[0]).toBe('server_ready')
    expect(ofType(story, 'player_connected')).toHaveLength(10)
    const restoredAt = story.beats.findIndex(
      ({ event }) => event.type === 'plugin_event' && event.name === BACKUP_RESTORED_EVENT,
    )
    expect(restoredAt).toBe(11)
    expect(story.beats[restoredAt]?.event).toMatchObject({
      data: { mapNumber: 1, roundNumber: 9, filename: 'matchzy_backup_map1_round09.cfg' },
    })
    expect(types[restoredAt + 1]).toBe('going_live')
    expect(types[restoredAt + 2]).toBe('side_swap')
    expect(types[restoredAt + 3]).toBe('backup_written')
    expect(types[restoredAt + 4]).toBe('round_start')
    // Nothing from before the round is replayed: round 9 is the first one.
    const rounds = ofType(story, 'round_end').map(event => event.roundNumber)
    expect(rounds[0]).toBe(9)
    expect(rounds).toEqual(
      ofType(full, 'round_end')
        .map(e => e.roundNumber)
        .slice(8),
    )
    expect(story.outcome).toBe('completed')
    expect(story.beats[story.beats.length - 1]?.event.type).toBe('series_end')
  })

  it('keeps the original story byte for byte from the resumed round on, retimed in order', () => {
    const story = resumed()
    const from = full.beats.findIndex(
      ({ event }) => event.type === 'backup_written' && event.roundNumber === 9,
    )
    const original = full.beats.slice(from)
    const replayed = story.beats.slice(story.beats.length - original.length)
    expect(replayed.map(beat => beat.event)).toEqual(original.map(beat => beat.event))
    // Retimed as one block: the round's backup lands right after the prelude,
    // and every later beat keeps its distance from it.
    const preludeEnd = story.beats[story.beats.length - original.length - 1]?.atMs ?? 0
    const shift = (replayed[0]?.atMs ?? 0) - (original[0]?.atMs ?? 0)
    expect(replayed[0]?.atMs).toBeGreaterThan(preludeEnd)
    replayed.forEach((beat, index) => {
      expect(beat.atMs).toBe((original[index]?.atMs ?? 0) + shift)
    })
    let previous = 0
    for (const beat of story.beats) {
      gameserverEventSchema.parse(beat.event)
      expect(beat.atMs).toBeGreaterThanOrEqual(previous)
      previous = beat.atMs
    }
  })

  it('states the sides of the resumed round, so a consumer knows who is where', () => {
    const story = resumed()
    const [swap] = ofType(story, 'side_swap')
    const round9 = ofType(full, 'round_end').find(event => event.roundNumber === 9)
    const teamASide =
      round9?.winner.team === 'team_a'
        ? round9.winner.side
        : round9?.winner.side === 'ct'
          ? 't'
          : 'ct'
    expect(swap?.sides.teamA).toBe(teamASide)
  })

  it('refuses a round the story never backed up', () => {
    expect(() =>
      resumeStory({
        story: full,
        assignment,
        source: SOURCE,
        point: { mapNumber: 2, roundNumber: 1 },
        prng: createPrng('x'),
        bootDelayMs: 1_000,
      }),
    ).toThrow(SimulatorRestoreError)
  })
})
