import { describe, expect, it } from 'vitest'
import { compareBuilds, judgeNodeGame } from './node-game'
import type { NodeGame, NodeImage } from './node-link'

const PINS = { counterStrikeSharp: '1.0.378', metamod: '2.0.0-git1483' }
const game = (patchVersion: string | null): NodeGame => ({
  build: '26144732',
  patchVersion,
  sourceRevision: '11162119',
})
const image = (proven: NodeImage['proven'], pins = PINS): NodeImage => ({
  revision: '24be188',
  pins,
  proven,
})
const proof = (build: string, hud = true) => ({ build, hud, pins: PINS })

describe("a node's game against its image's proof", () => {
  it('orders dotted builds as numbers', () => {
    expect(compareBuilds('1.41.9.2', '1.41.9.2')).toBe(0)
    expect(compareBuilds('1.41.9.1', '1.41.9.2')).toBe(-1)
    expect(compareBuilds('1.41.10.0', '1.41.9.2')).toBe(1)
    expect(compareBuilds('1.41.9', '1.41.9.0')).toBe(0)
  })

  it('is green, hud too, when the volume holds the build the pins were proven on', () => {
    expect(judgeNodeGame('node devbox', game('1.41.9.2'), image(proof('1.41.9.2')))).toEqual({
      canary: { state: 'green', build: '1.41.9.2', reason: null },
      hud: { state: 'green', build: '1.41.9.2', reason: null },
    })
  })

  it('keeps the hud unproven when the proof had no hud-on row', () => {
    const verdict = judgeNodeGame('node devbox', game('1.41.9.2'), image(proof('1.41.9.2', false)))
    expect(verdict.canary.state).toBe('green')
    expect(verdict.hud).toEqual({
      state: 'unproven',
      build: '1.41.9.2',
      reason:
        'node devbox runs CS2 1.41.9.2; its image 24be188 was proven on it without the hud-on row',
    })
  })

  it('names the node and both builds when the volume is newer than the proof', () => {
    const verdict = judgeNodeGame('node devbox', game('1.41.9.3'), image(proof('1.41.9.2')))
    expect(verdict.canary).toEqual({
      state: 'unproven',
      build: '1.41.9.3',
      reason: 'node devbox runs CS2 1.41.9.3; its image 24be188 was proven on 1.41.9.2 only',
    })
    expect(verdict.hud).toEqual(verdict.canary)
  })

  it('says what to run when the volume fell behind', () => {
    expect(
      judgeNodeGame('node devbox', game('1.41.9.1'), image(proof('1.41.9.2'))).canary.reason,
    ).toBe(
      'node devbox runs CS2 1.41.9.1, older than 1.41.9.2 its image 24be188 was proven on: run `cs2:install` on node devbox',
    )
  })

  it('is unproven, by name, with no proof, a proof for other pins, no game, or an old agent', () => {
    expect(judgeNodeGame('node a', game('1.41.9.2'), image(null)).canary.reason).toBe(
      'node a runs CS2 1.41.9.2; its image 24be188 carries no dev-node canary proof',
    )
    expect(
      judgeNodeGame('node a', game('1.41.9.2'), image(proof('1.41.9.2'), { ...PINS, metamod: 'x' }))
        .canary.reason,
    ).toBe(
      'node a runs CS2 1.41.9.2; its image 24be188 carries a proof for other pins than it was built with',
    )
    expect(judgeNodeGame('node a', game(null), image(proof('1.41.9.2'))).canary).toEqual({
      state: 'unproven',
      build: null,
      reason:
        'node a cannot read its game build (no steam.inf on its volume): run `cs2:install` on node a',
    })
    expect(judgeNodeGame('node a', undefined, undefined).canary.reason).toBe(
      'node a does not state its game build (an agent older than 0.2.0)',
    )
  })
})
