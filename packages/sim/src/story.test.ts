import { createPrng } from '@ezpug/core'
import type {
  GameserverEventOf,
  GameserverEventType,
  MapRadar,
  SimKnifePerk,
} from '@ezpug/match-api'
import {
  gameserverEventSchema,
  SIM_KNIFE_PERK_LINE,
  SIM_KNIFE_WEAPON,
  worldToRadar,
} from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import type { MatchAssignment } from './assignment'
import { SIM_CHAT_EVENT } from './chat'
import { planSimulatedChatter, SIMULATED_CHAT_LINES } from './chatter'
import { SIMULATOR_SCENARIOS, type SimulatorScenario } from './scenario'
import {
  BACKUP_RESTORED_EVENT,
  buildMatchStory,
  type MatchStory,
  planMapRounds,
  resumeStory,
  SimulatorRestoreError,
  type StoryBeat,
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
  timeScale = 1,
): MatchStory {
  return buildMatchStory({
    prng: createPrng(seed),
    assignment: fixtureAssignment(overrides),
    scenario,
    source: SOURCE,
    bootDelayMs: 4_000,
    positionTickIntervalMs,
    radars,
    timeScale,
  })
}

/** `powerup-dm`'s own numbers: ten minutes, or five with nobody on the server. */
const DEATHMATCH: Partial<MatchAssignment> = {
  flow: 'plugin',
  teamCount: 1,
  length: { durationSeconds: 600, idleTimeoutSeconds: 300 },
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

  it('no-show: some never connect, nothing goes live under matchzy, the story runs dry', () => {
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

  it("prints the assignment's warmup lines while it waits, one every few seconds, in order", () => {
    const lines = ['Willkommen bei EZPug.', 'Dein Match steht auf ezpug.com.']
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'story-test', {
      warmupLines: lines,
    })
    const said = ofType(story, 'plugin_event').filter(event => event.name === SIM_CHAT_EVENT)
    expect(said.length).toBeGreaterThan(1)
    // In order, cycling — the plugin's own rule (`WarmupChat`).
    expect(said.map(event => (event.data as { line: string }).line)).toEqual(
      said.map((_, index) => lines[index % lines.length]),
    )

    // Only while the server waits: the first is a beat after `server_ready`,
    // the last before the map goes live, and the times are one interval apart.
    const beats = story.beats.filter(
      beat => beat.event.type === 'plugin_event' && beat.event.name === SIM_CHAT_EVENT,
    )
    const ready = story.beats.find(beat => beat.event.type === 'server_ready') as StoryBeat
    const live = story.beats.find(beat => beat.event.type === 'going_live') as StoryBeat
    expect(beats[0]?.atMs).toBe(ready.atMs + 8_000)
    expect((beats.at(-1) as StoryBeat).atMs).toBeLessThan(live.atMs)
    expect(beats.map(beat => beat.atMs - ready.atMs)).toEqual(
      beats.map((_, index) => (index + 1) * 8_000),
    )

    // Merged into the story by time, not appended: playback walks the list in
    // order and never has to sort it.
    expect(story.beats.map(beat => beat.atMs)).toEqual(
      [...story.beats.map(beat => beat.atMs)].sort((a, b) => a - b),
    )

    // A line that is nothing once it is safe to say is dropped, and a match
    // nobody wrote a line for says nothing at all.
    expect(
      ofType(
        storyFor(SIMULATOR_SCENARIOS['happy-path'], 'story-test', { warmupLines: [';'] }),
        'plugin_event',
      ).filter(event => event.name === SIM_CHAT_EVENT),
    ).toHaveLength(0)
    expect(
      ofType(storyFor(SIMULATOR_SCENARIOS['happy-path']), 'plugin_event').filter(
        event => event.name === SIM_CHAT_EVENT,
      ),
    ).toHaveLength(0)
  })

  it("says its warmup lines on nobody's dice: a seeded match plays the same match with them", () => {
    const plain = storyFor(SIMULATOR_SCENARIOS['happy-path'])
    const spoken = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'story-test', {
      warmupLines: ['Willkommen bei EZPug.'],
    })
    const without = (story: MatchStory) =>
      story.beats.filter(
        beat => !(beat.event.type === 'plugin_event' && beat.event.name === SIM_CHAT_EVENT),
      )
    expect(without(spoken)).toEqual(without(plain))
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

  it('throws utility and carries the bomb on the live tier (#5)', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'utility', {}, 500)
    const ticks = ofType(story, 'position_tick')
    expect(ticks.length).toBeGreaterThan(0)
    const rostered = new Set(
      [...fixtureAssignment().teamA.players, ...fixtureAssignment().teamB.players].map(
        p => p.steamId64,
      ),
    )

    // Every tick is valid, and says it sampled utility even when nothing is in the air.
    const lives = new Map<string, string[]>()
    for (const tick of ticks) {
      expect(gameserverEventSchema.safeParse(tick).success).toBe(true)
      expect(tick.grenades).toBeDefined()
      for (const grenade of tick.grenades ?? []) {
        expect(rostered.has(grenade.steamId64 ?? '')).toBe(true)
        const life = lives.get(grenade.id) ?? []
        life.push(`${grenade.kind}:${grenade.state}`)
        lives.set(grenade.id, life)
      }
    }

    // A smoke flies, stands with its radius for several ticks, and is gone.
    const smokes = [...lives.values()].filter(life => life[0]?.startsWith('smoke'))
    expect(smokes.length).toBeGreaterThan(ticks.length / 1_000)
    const smoke = smokes.find(life => life.includes('smoke:flying')) as string[]
    expect(smoke.indexOf('smoke:active')).toBeGreaterThan(smoke.lastIndexOf('smoke:flying'))
    expect(smoke.filter(state => state === 'smoke:active').length).toBeGreaterThan(10)
    // A flash goes off in exactly one tick.
    const flashes = [...lives.values()].filter(life => life[0]?.startsWith('flash'))
    expect(flashes.length).toBeGreaterThan(0)
    for (const flash of flashes) expect(flash.filter(s => s === 'flash:active')).toHaveLength(1)
    const actives = ticks.flatMap(tick => tick.grenades ?? []).filter(g => g.state === 'active')
    for (const grenade of actives) {
      if (grenade.kind === 'smoke' || grenade.kind === 'molotov' || grenade.kind === 'incendiary')
        expect(grenade.radius).toBeGreaterThan(0)
      else expect(grenade.radius).toBeUndefined()
    }

    // The bomb: carried by somebody, planted in the site the kill feed names,
    // gone once it went off or was defused.
    const carried = ticks.flatMap(tick => (tick.bomb?.state === 'carried' ? [tick.bomb] : []))
    expect(carried.length).toBeGreaterThan(0)
    for (const bomb of carried) expect(rostered.has(bomb.steamId64 ?? '')).toBe(true)
    const plant = ofType(story, 'bomb_planted')[0] as GameserverEventOf<'bomb_planted'>
    const inRound = ticks.filter(tick => tick.roundNumber === plant.roundNumber)
    const planted = inRound.filter(tick => tick.bomb?.state === 'planted')
    expect(planted.length).toBeGreaterThan(0)
    for (const tick of planted) expect(tick.bomb?.site).toBe(plant.site)
    const resolved = story.beats.find(
      beat =>
        (beat.event.type === 'bomb_exploded' || beat.event.type === 'bomb_defused') &&
        beat.event.roundNumber === plant.roundNumber,
    ) as StoryBeat
    const after = story.beats.filter(
      beat =>
        beat.atMs > resolved.atMs &&
        beat.event.type === 'position_tick' &&
        beat.event.roundNumber === plant.roundNumber,
    )
    for (const beat of after)
      expect((beat.event as GameserverEventOf<'position_tick'>).bomb).toBeUndefined()
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

describe('a mode with a length (PRD-03 T9a)', () => {
  it('plays one round nobody wins, for as long as the manifest says', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-a', DEATHMATCH)
    expect(story.outcome).toBe('completed')

    const [live] = ofType(story, 'going_live')
    // What a client counts down, and at time scale 1 it is the manifest's own.
    expect(live?.length).toEqual({ durationSeconds: 600 })

    // A round starts and never ends: on hardware the SDK owns the clock
    // (`mp_timelimit 0`), so the engine counts to nothing.
    expect(ofType(story, 'round_start')).toHaveLength(1)
    expect(ofType(story, 'round_end')).toHaveLength(0)
    expect(ofType(story, 'side_swap')).toHaveLength(0)
    expect(ofType(story, 'backup_written')).toHaveLength(0)

    const liveAtMs = story.beats.find(beat => beat.event.type === 'going_live')?.atMs as number
    const deaths = story.beats.filter(beat => beat.event.type === 'player_death')
    expect(deaths.length).toBeGreaterThan(50)
    const last = deaths[deaths.length - 1]?.atMs as number
    expect(last - liveAtMs).toBeLessThanOrEqual(600_000)
    expect(last - liveAtMs).toBeGreaterThan(550_000)

    const [mapEnd] = ofType(story, 'map_end')
    expect(mapEnd?.reason).toBe('time_limit')
    expect(mapEnd?.score).toEqual({ teamA: 0, teamB: 0 })
    const [seriesEnd] = ofType(story, 'series_end')
    expect(seriesEnd?.reason).toBe('time_limit')
    expect(story.beats[story.beats.length - 1]?.event.type).toBe('series_end')
  })

  it('names no winner for a one-team mode, in the map and in the series', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-b', DEATHMATCH)
    expect(ofType(story, 'map_end')[0]?.winner).toBeNull()
    expect(ofType(story, 'series_end')[0]?.winner).toBeNull()
  })

  it('names no winner for a one-team mode that plays rounds either', () => {
    const rounds = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-c', { teamCount: 1 })
    expect(ofType(rounds, 'round_end').length).toBeGreaterThan(0)
    expect(ofType(rounds, 'map_end')[0]?.winner).toBeNull()
    expect(ofType(rounds, 'series_end')[0]?.winner).toBeNull()
    // Two teams still have one, off the same rule.
    const two = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-c')
    expect(ofType(two, 'map_end')[0]?.winner).not.toBeNull()
  })

  it('states the duration in the client’s seconds, the time scale already divided out', () => {
    const slow = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-d', DEATHMATCH)
    const fast = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-d', DEATHMATCH, 5_000, [], 20)
    expect(ofType(fast, 'going_live')[0]?.length).toEqual({ durationSeconds: 30 })
    // The story itself is match time and does not move: only the number a
    // client counts down does, exactly as `MatchLength.InForce` computes it.
    const span = (story: MatchStory) =>
      (story.beats[story.beats.length - 1]?.atMs ?? 0) -
      (story.beats.find(beat => beat.event.type === 'going_live')?.atMs ?? 0)
    expect(span(fast)).toBe(span(slow))
  })

  it('ends on a frag limit when somebody reaches it first', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-e', {
      teamCount: 1,
      length: { durationSeconds: 600, fragLimit: 12 },
    })
    const [live] = ofType(story, 'going_live')
    expect(live?.length).toEqual({ durationSeconds: 600, fragLimit: 12 })

    const kills = new Map<string, number>()
    for (const death of ofType(story, 'player_death')) {
      const killer = death.killer?.steamId64
      if (killer) kills.set(killer, (kills.get(killer) ?? 0) + 1)
    }
    expect(Math.max(...kills.values())).toBe(12)
    expect(ofType(story, 'map_end')[0]?.reason).toBe('frag_limit')
    expect(ofType(story, 'series_end')[0]?.reason).toBe('frag_limit')

    // A frag limit with nothing else still stops.
    const bare = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-f', {
      teamCount: 1,
      length: { fragLimit: 7 },
    })
    expect(ofType(bare, 'going_live')[0]?.length).toEqual({ fragLimit: 7 })
    expect(ofType(bare, 'series_end')[0]?.reason).toBe('frag_limit')
  })

  it('nobody kills a teammate where the mode has two teams', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-g', {
      teamCount: 2,
      length: { durationSeconds: 120 },
    })
    for (const death of ofType(story, 'player_death')) {
      expect(death.killer?.team).not.toBe(death.victim.team)
      expect(death.killer?.steamId64).not.toBe(death.victim.steamId64)
    }
    // And in a free-for-all somebody eventually kills their own colour.
    const ffa = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-g', DEATHMATCH)
    expect(
      ofType(ffa, 'player_death').some(death => death.killer?.team === death.victim.team),
    ).toBe(true)
  })

  it('leaves a mode whose length is only an idle timeout playing rounds', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-h', {
      length: { idleTimeoutSeconds: 300 },
    })
    expect(ofType(story, 'round_end').length).toBeGreaterThan(0)
    expect(ofType(story, 'going_live')[0]?.length).toBeUndefined()
    expect(ofType(story, 'map_end')[0]?.reason).toBeUndefined()
  })

  it('emits only events that parse against the contract, in time order', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-i', DEATHMATCH)
    let previous = 0
    for (const beat of story.beats) {
      gameserverEventSchema.parse(beat.event)
      expect(beat.atMs).toBeGreaterThanOrEqual(previous)
      previous = beat.atMs
    }
  })

  it('is deterministic under a seed', () => {
    const one = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-j', DEATHMATCH)
    const two = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-j', DEATHMATCH)
    const other = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'length-k', DEATHMATCH)
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(other))
  })
})

describe('the idle scenario (PRD-03 T9a, T11a)', () => {
  it('goes live on an empty server for a flow the SDK tells the story of, and ends on it', () => {
    // `powerup-dm` whole: its clocks and its `records`, so the sequence below
    // is the one the dev node produced beat for beat.
    const story = storyFor(SIMULATOR_SCENARIOS.idle, 'idle-a', {
      ...DEATHMATCH,
      records: 'events',
    })
    expect(story.outcome).toBe('completed')
    expect(story.demos).toHaveLength(0)
    // The dev node's own sequence, measured in the lane's `idle` row (T11):
    // a server nobody came to ends its warmup anyway and ends as a match.
    expect(story.beats.map(beat => beat.event.type)).toEqual([
      'server_ready',
      'going_live',
      'round_start',
      'map_end',
      'series_end',
    ])
    expect(ofType(story, 'player_connected')).toHaveLength(0)
    expect(ofType(story, 'player_death')).toHaveLength(0)
    // Twenty seconds after the map is up, `GenericFlow.GoLiveDelayMs` to the
    // millisecond, carrying the length a client counts down.
    const readyAtMs = story.beats[0]?.atMs ?? 0
    const [live] = ofType(story, 'going_live')
    expect(live?.length).toEqual({ durationSeconds: 600 })
    expect((story.beats[1]?.atMs ?? 0) - readyAtMs).toBe(20_000)
    // The idle clock runs from `server_ready` and beats the duration, which
    // runs from `going_live`: five minutes, not ten minutes and twenty seconds.
    const [mapEnd] = ofType(story, 'map_end')
    const [seriesEnd] = ofType(story, 'series_end')
    expect(mapEnd?.reason).toBe('idle')
    expect(mapEnd?.winner).toBeNull()
    expect(mapEnd?.score).toEqual({ teamA: 0, teamB: 0 })
    expect(seriesEnd?.reason).toBe('idle')
    expect(seriesEnd?.winner).toBeNull()
    expect(seriesEnd?.seriesScore).toEqual({ teamA: 0, teamB: 0 })
    const endAtMs = story.beats.find(beat => beat.event.type === 'map_end')?.atMs ?? 0
    expect(endAtMs - readyAtMs).toBe(300_000)
  })

  it('ends on the duration where that is the clock that runs out first', () => {
    const story = storyFor(SIMULATOR_SCENARIOS.idle, 'idle-c', {
      flow: 'plugin',
      teamCount: 1,
      length: { durationSeconds: 60, idleTimeoutSeconds: 3_600 },
    })
    expect(ofType(story, 'map_end')[0]?.reason).toBe('time_limit')
    expect(ofType(story, 'series_end')[0]?.reason).toBe('time_limit')
  })

  it('leaves an SDK-told mode that names no clock live for ever, nothing ending it', () => {
    const story = storyFor(SIMULATOR_SCENARIOS.idle, 'idle-d', { flow: 'none' })
    expect(story.outcome).toBe('idle')
    expect(story.beats.map(beat => beat.event.type)).toEqual([
      'server_ready',
      'going_live',
      'round_start',
    ])
    // Nothing to count down when the mode declares no length at all.
    expect(ofType(story, 'going_live')[0]?.length).toBeUndefined()
  })

  it('plays a short-handed SDK-told match with the bodies that came (T11a)', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['no-show'], 'no-show-sdk', DEATHMATCH)
    expect(story.outcome).toBe('completed')
    const connected = ofType(story, 'player_connected')
    expect(connected).toHaveLength(8)
    expect(ofType(story, 'going_live')).toHaveLength(1)
    expect(ofType(story, 'series_end')[0]?.reason).toBe('time_limit')
    // The two who never came are in nothing that follows: no kill, no death,
    // no scoreboard line, and nobody's chat.
    const present = new Set(connected.map(event => event.player.steamId64))
    expect(present.size).toBe(8)
    for (const death of ofType(story, 'player_death')) {
      expect(present.has(death.victim.steamId64)).toBe(true)
      if (death.killer) expect(present.has(death.killer.steamId64)).toBe(true)
    }
    for (const said of ofType(story, 'chat_message')) {
      expect(present.has(said.player.steamId64)).toBe(true)
    }
  })

  it('never empties a side of an SDK-told match, however many the scenario keeps away', () => {
    const story = storyFor({ name: 'deserted', absentPlayers: 9 }, 'no-show-9', {
      flow: 'plugin',
      length: { durationSeconds: 60 },
    })
    const connected = ofType(story, 'player_connected')
    expect(connected).toHaveLength(2)
    expect(new Set(connected.map(event => event.player.team))).toEqual(
      new Set(['team_a', 'team_b']),
    )
    expect(story.outcome).toBe('completed')
  })

  it('leaves a matchzy mode waiting in warmup, for the join deadline to decide', () => {
    // MatchZy holds warmup open until two teams ready up, and a `length` is
    // never its to enforce (`MatchLength.OnAssigned`) — so neither shape ends.
    for (const overrides of [{}, { ...DEATHMATCH, flow: 'matchzy' as const }]) {
      const story = storyFor(SIMULATOR_SCENARIOS.idle, 'idle-b', overrides)
      expect(story.outcome).toBe('idle')
      expect(story.beats.map(beat => beat.event.type)).toEqual(['server_ready'])
      expect(ofType(story, 'player_connected')).toHaveLength(0)
    }
  })
})

describe('what the mode records (PRD-03 T9c)', () => {
  it('announces no demo for a mode that records events only', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'records-a', {
      records: 'events',
    })
    expect(ofType(story, 'round_end').length).toBeGreaterThan(0)
    expect(ofType(story, 'demo_available')).toHaveLength(0)
    // And there are no bytes to hand out either: a server that makes no demo
    // has no recording of one, so nothing can be PUT where the request said.
    expect(story.demos).toHaveLength(0)
    // The map still ends and the series still ends — only the file is missing.
    expect(story.outcome).toBe('completed')
    expect(story.beats[story.beats.length - 1]?.event.type).toBe('series_end')
  })

  it('announces no demo for a length story either, which is where the deathmatches are', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'records-b', {
      ...DEATHMATCH,
      records: 'events',
    })
    expect(ofType(story, 'map_end')[0]?.reason).toBe('time_limit')
    expect(ofType(story, 'demo_available')).toHaveLength(0)
    expect(story.demos).toHaveLength(0)
    // The demo also took the story's GOTV wait with it: `series_end` follows
    // `map_end` by the two seconds and not by eight.
    const at = (type: 'map_end' | 'series_end') =>
      story.beats.find(beat => beat.event.type === type)?.atMs ?? 0
    expect(at('series_end') - at('map_end')).toBe(2_000)
  })

  it('records none for a mode that keeps nothing', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'records-c', { records: 'none' })
    expect(ofType(story, 'demo_available')).toHaveLength(0)
    expect(story.demos).toHaveLength(0)
  })

  it('still makes one per map for a mode that records a demo, said or unsaid', () => {
    const said = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'records-d', { records: 'demo' })
    const unsaid = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'records-d')
    // Absent is `demo`: a match config read off a MatchZy handoff says nothing
    // about a manifest and that server records one.
    expect(JSON.stringify(said)).toBe(JSON.stringify(unsaid))
    expect(ofType(said, 'demo_available').length).toBe(ofType(said, 'map_end').length)
    expect(said.demos.map(demo => demo.mapNumber)).toEqual(
      ofType(said, 'demo_available').map(event => event.mapNumber),
    )
  })
})

describe('the knife perk (ezpug/ezpug-iron#6)', () => {
  const perkStory = (
    knifePerk: SimKnifePerk | null,
    seed = 'knife-perk',
    overrides: Partial<MatchAssignment> = {},
  ): MatchStory =>
    buildMatchStory({
      prng: createPrng(seed),
      assignment: fixtureAssignment(overrides),
      scenario: SIMULATOR_SCENARIOS['happy-path'],
      source: SOURCE,
      bootDelayMs: 4_000,
      positionTickIntervalMs: 5_000,
      knifePerk,
    })
  const knifeKills = (story: MatchStory) =>
    ofType(story, 'player_death').filter(kill => kill.weapon === SIM_KNIFE_WEAPON)
  const perkLines = (story: MatchStory) =>
    ofType(story, 'chat_message').filter(line => line.text === SIM_KNIFE_PERK_LINE)

  it('deals one knife kill in the round asked for, and its killer says the line before the next round starts', () => {
    const story = perkStory({ round: 4, killer: 'team_b' })
    const [kill, ...moreKills] = knifeKills(story)
    const [line, ...moreLines] = perkLines(story)
    expect(moreKills).toHaveLength(0)
    expect(moreLines).toHaveLength(0)
    expect(kill?.mapNumber).toBe(1)
    expect(kill?.roundNumber).toBe(4)
    expect(kill?.killer?.team).toBe('team_b')
    expect(kill?.headshot).toBe(false)
    expect(line).toMatchObject({ scope: 'all', player: kill?.killer })

    const events = story.beats.map(beat => beat.event)
    const killAt = events.indexOf(kill as (typeof events)[number])
    const lineAt = events.indexOf(line as (typeof events)[number])
    const nextRound = events.findIndex((event, i) => i > killAt && event.type === 'round_start')
    expect(lineAt).toBeGreaterThan(killAt)
    expect(lineAt).toBeLessThan(nextRound)
    for (const event of events) expect(() => gameserverEventSchema.parse(event)).not.toThrow()
    const times = story.beats.map(beat => beat.atMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('moves nothing else: the same rounds, the same kills and the same winner as without it', () => {
    const plain = perkStory(null)
    const perked = perkStory({ round: 4, killer: 'team_b' })
    const strip = (story: MatchStory) =>
      story.beats
        .map(beat => beat.event)
        .filter(event => !(event.type === 'chat_message' && event.text === SIM_KNIFE_PERK_LINE))
        .map(event =>
          event.type === 'player_death'
            ? { ...event, weapon: 'any', headshot: false, noscope: undefined }
            : event.type === 'round_end'
              ? { ...event, players: event.players?.map(p => ({ ...p, headshotKills: 0 })) }
              : event.type === 'demo_available'
                ? { ...event, sizeBytes: 0 }
                : event,
        )
    expect(strip(perked)).toEqual(strip(plain))
  })

  it('keeps the scoreboard true: a knife kill is not a headshot', () => {
    const story = perkStory({ round: 1 }, 'knife-hs')
    const kills = ofType(story, 'player_death')
    const rounds = ofType(story, 'round_end')
    const summary = rounds[rounds.length - 1]?.players ?? []
    expect(knifeKills(story)).toHaveLength(1)
    expect(summary.reduce((sum, p) => sum + (p.headshotKills ?? 0), 0)).toBe(
      kills.filter(kill => kill.headshot).length,
    )
  })

  it('waits for a round the asked-for team kills in: a 1v1 loser kills nobody', () => {
    const story = perkStory({ round: 1, killer: 'team_a' }, 'knife-1v1', {
      teamA: { name: 'A', players: [{ steamId64: '76561198000000001', name: 'a' }] },
      teamB: { name: 'B', players: [{ steamId64: '76561198000000002', name: 'b' }] },
    })
    const [kill] = knifeKills(story)
    const won = ofType(story, 'round_end').find(round => round.winner.team === 'team_a')
    expect(kill?.killer?.steamId64).toBe('76561198000000001')
    expect(kill?.roundNumber).toBe(won?.roundNumber)
    expect(perkLines(story)).toHaveLength(1)
  })

  it('plays it on round 1 of a mode with a length, and nowhere past it', () => {
    const story = perkStory({ round: 1 }, 'knife-dm', DEATHMATCH)
    expect(knifeKills(story)).toHaveLength(1)
    expect(perkLines(story)[0]?.player).toEqual(knifeKills(story)[0]?.killer)
    expect(knifeKills(perkStory({ round: 2 }, 'knife-dm', DEATHMATCH))).toHaveLength(0)
  })
})

describe('the engine game on the record (PRD-05 T2d, ezpug/ezpug-iron#4)', () => {
  it('says competitive on server_ready and every going_live of a five-a-side series', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'])
    for (const ready of ofType(story, 'server_ready'))
      expect(ready.engine).toEqual({ gameType: 0, gameMode: 1 })
    const lives = ofType(story, 'going_live')
    expect(lives.length).toBeGreaterThan(0)
    for (const live of lives) {
      expect(live.engine).toEqual({ gameType: 0, gameMode: 1 })
      expect(live.format).toBe('competitive')
    }
  })

  it('says wingman where the assignment is, as game_mode 2', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'wingman', { wingman: true })
    const live = ofType(story, 'going_live')[0]
    expect(live?.engine).toEqual({ gameType: 0, gameMode: 2 })
    expect(live?.format).toBe('wingman')
    for (const event of story.beats.map(beat => beat.event))
      expect(gameserverEventSchema.safeParse(event).success).toBe(true)
  })

  it('draws no dice for it: the same seed plays the same match either way', () => {
    const strip = (story: MatchStory) =>
      story.beats.map(({ atMs, event }) => {
        if (event.type === 'server_ready') return { atMs, ...event, engine: undefined }
        if (event.type === 'going_live')
          return { atMs, ...event, engine: undefined, format: undefined }
        // The recording holds these beats, so its size moves by the format's name.
        if (event.type === 'demo_available') return { atMs, ...event, sizeBytes: undefined }
        return { atMs, ...event }
      })
    expect(strip(storyFor(SIMULATOR_SCENARIOS['happy-path'], 'same', { wingman: true }))).toEqual(
      strip(storyFor(SIMULATOR_SCENARIOS['happy-path'], 'same')),
    )
  })

  it('says it again on a restored server', () => {
    const story = storyFor(SIMULATOR_SCENARIOS['happy-path'], 'restore', { wingman: true })
    const resumed = resumeStory({
      story,
      assignment: fixtureAssignment({ wingman: true }),
      source: SOURCE,
      point: { mapNumber: 1, roundNumber: 3 },
      prng: createPrng('restore-2'),
      bootDelayMs: 4_000,
    })
    expect(ofType(resumed, 'server_ready')[0]?.engine).toEqual({ gameType: 0, gameMode: 2 })
    expect(ofType(resumed, 'going_live')[0]?.format).toBe('wingman')
  })
})
