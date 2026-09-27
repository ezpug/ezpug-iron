import { createPrng } from '@ezpug/core'
import type { RushRoomId, SimTowerEnding, TeamSide } from '@ezpug/match-api'
import { RUSH_ROOM_IDS } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import {
  drawTowerLine,
  isTowerMap,
  planTowerWalk,
  TOWER_LONG_ROUND_MS,
  TOWER_MAPS,
  TOWER_ROUND_MS,
  type TowerWalk,
  walkTower,
} from './tower'

const LINE: RushRoomId[] = ['401', '207', '203', '104', '211', '201', '301']
const repeat = (side: TeamSide, count: number): TeamSide[] => Array(count).fill(side)

const scoreOf = (walk: TowerWalk): Record<TeamSide, number> => ({
  t: walk.rounds.filter(round => round.winner === 't').length,
  ct: walk.rounds.filter(round => round.winner === 'ct').length,
})

describe('the line (PRD-06 T2)', () => {
  it('draws a castle at each end, a start room in the middle and four different mid rooms', () => {
    for (let seed = 0; seed < 50; seed++) {
      const line = drawTowerLine(createPrng(`line-${seed}`))
      expect(line).toHaveLength(7)
      expect(line[0]).toBe('401')
      expect(line[6]).toBe('301')
      expect(['101', '102', '103', '104']).toContain(line[3])
      const mids = [line[1], line[2], line[4], line[5]]
      expect(new Set(mids).size).toBe(4)
      for (const mid of mids) expect(mid).toMatch(/^2(0[1-9]|1[0-2])$/)
      for (const room of line) expect(RUSH_ROOM_IDS).toContain(room)
    }
  })

  it('knows rush_001 as a tower map played under game_type 0 / game_mode 6', () => {
    expect(isTowerMap('rush_001')).toBe(true)
    expect(isTowerMap('de_mirage')).toBe(false)
    expect(isTowerMap('toString')).toBe(false)
    expect(TOWER_MAPS.rush_001).toEqual({ gameType: 0, gameMode: 6 })
  })
})

describe('walkTower: the script’s rules', () => {
  it('starts in the start room held by CT, and a T win walks towards the CT castle', () => {
    const walk = walkTower(LINE, repeat('t', 4))
    expect(walk.rounds.map(round => [round.index, round.roomId, round.heldBy])).toEqual([
      [3, '104', 'ct'],
      [4, '211', 'ct'],
      [5, '201', 'ct'],
      [6, '301', 'ct'],
    ])
    expect(walk.ending).toBe('castle')
    expect(walk.winner).toBe('t')
    expect(walk.rounds.map(round => round.clockMs)).toEqual([
      TOWER_ROUND_MS,
      TOWER_ROUND_MS,
      TOWER_ROUND_MS,
      TOWER_LONG_ROUND_MS,
    ])
  })

  it('walks a CT win towards the T castle, into rooms the T side holds', () => {
    const walk = walkTower(LINE, repeat('ct', 4))
    expect(walk.rounds.map(round => [round.index, round.heldBy])).toEqual([
      [3, 'ct'],
      [2, 't'],
      [1, 't'],
      [0, 't'],
    ])
    expect(walk.ending).toBe('castle')
    expect(walk.winner).toBe('ct')
  })

  it('leaves a room with its last winner, so walking back in finds them holding it', () => {
    // T takes the start room, CT wins the next one back, and the start room is T's now.
    const walk = walkTower(LINE, ['t', 'ct', 'ct', 't', 't', 't', 't', 't'])
    expect(walk.rounds[0]).toMatchObject({ index: 3, heldBy: 'ct', winner: 't' })
    expect(walk.rounds[1]).toMatchObject({ index: 4, heldBy: 'ct', winner: 'ct' })
    expect(walk.rounds[2]).toMatchObject({ index: 3, heldBy: 't', winner: 'ct' })
    expect(walk.rounds[3]).toMatchObject({ index: 2, heldBy: 't', winner: 't' })
    expect(walk.rounds[4]).toMatchObject({ index: 3, heldBy: 'ct', winner: 't' })
  })

  it('ends at eight round wins, and swaps the next room for Convoy at 7–7', () => {
    const alternating: TeamSide[] = Array.from({ length: 14 }, (_, i) => (i % 2 ? 'ct' : 't'))
    const walk = walkTower(LINE, [...alternating, 'ct'])
    const convoy = walk.rounds[14]
    expect(convoy).toMatchObject({ index: 3, roomId: 'convoy', clockMs: TOWER_LONG_ROUND_MS })
    expect(walk.rounds.slice(0, 14).every(round => round.roomId !== 'convoy')).toBe(true)
    expect(walk.ending).toBe('rounds')
    expect(scoreOf(walk)).toEqual({ t: 7, ct: 8 })
  })

  it('refuses a round played past the end of the map', () => {
    expect(() => walkTower(LINE, repeat('t', 5))).toThrow(/past its end/)
    expect(() => walkTower(LINE, ['t'])).toThrow(/never ends/)
  })
})

describe('planTowerWalk', () => {
  const plan = (seed: string, winner: TeamSide, forced?: SimTowerEnding) =>
    planTowerWalk(createPrng(seed), LINE, winner, forced)

  it('always ends in the planned winner’s favour, within fifteen rounds', () => {
    const endings = new Set<string>()
    for (let seed = 0; seed < 200; seed++) {
      const winner: TeamSide = seed % 2 ? 't' : 'ct'
      const walk = plan(`walk-${seed}`, winner)
      const score = scoreOf(walk)
      expect(walk.winner).toBe(winner)
      expect(walk.rounds[walk.rounds.length - 1]?.winner).toBe(winner)
      expect(score[winner]).toBeGreaterThan(score[winner === 't' ? 'ct' : 't'])
      expect(walk.rounds.length).toBeLessThanOrEqual(15)
      endings.add(walk.ending)
      if (walk.rounds.some(round => round.roomId === 'convoy')) endings.add('convoy')
    }
    // Left to the dice, both endings happen.
    expect([...endings].sort()).toEqual(expect.arrayContaining(['castle', 'rounds']))
  })

  it('castle: over in the loser’s castle before either side has eight', () => {
    for (let seed = 0; seed < 50; seed++) {
      for (const winner of ['t', 'ct'] as const) {
        const walk = plan(`castle-${seed}`, winner, 'castle')
        const last = walk.rounds[walk.rounds.length - 1]
        expect(walk.ending).toBe('castle')
        expect(last?.index).toBe(winner === 't' ? 6 : 0)
        expect(scoreOf(walk)[winner]).toBeLessThan(8)
      }
    }
  })

  it('clinch: eight wins, nobody at a castle ending, no Convoy', () => {
    for (let seed = 0; seed < 50; seed++) {
      const walk = plan(`clinch-${seed}`, 'ct', 'clinch')
      expect(walk.ending).toBe('rounds')
      expect(scoreOf(walk).ct).toBe(8)
      expect([5, 6]).toContain(scoreOf(walk).t)
      expect(walk.rounds.some(round => round.roomId === 'convoy')).toBe(false)
    }
  })

  it('convoy: 7–7, then the winner takes the decider in the start room’s place', () => {
    for (let seed = 0; seed < 50; seed++) {
      const walk = plan(`convoy-${seed}`, 't', 'convoy')
      expect(walk.rounds).toHaveLength(15)
      expect(walk.rounds[14]).toMatchObject({ index: 3, roomId: 'convoy', winner: 't' })
      expect(scoreOf(walk)).toEqual({ t: 8, ct: 7 })
      expect(walk.ending).toBe('rounds')
    }
  })
})
