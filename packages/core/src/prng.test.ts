import { describe, expect, it } from 'vitest'
import { createPrng } from './prng'

describe('createPrng', () => {
  it('is deterministic for a seed and independent per instance', () => {
    const a = createPrng('seed:queue')
    const b = createPrng('seed:queue')
    const drawsA = Array.from({ length: 20 }, () => a.next())
    const drawsB = Array.from({ length: 20 }, () => b.next())

    expect(drawsA).toEqual(drawsB)
    expect(createPrng('seed:other').next()).not.toBe(drawsA[0])
  })

  it('treats a numeric seed as its string form', () => {
    expect(createPrng(42).next()).toBe(createPrng('42').next())
    expect(createPrng(42).seed).toBe('42')
  })

  // Golden vectors: sfc32 + cyrb128 is a wire format of sorts — a seeded world
  // must look identical on every machine and every Node version. If these
  // change, every fixture, screenshot and bug report referencing a seed moved.
  it('matches its golden vectors', () => {
    const prng = createPrng('ezpug')
    expect(Array.from({ length: 4 }, () => prng.uint32())).toEqual([
      2017954817, 2041605067, 1724571694, 822782076,
    ])

    const floats = createPrng('saarlan')
    expect(Array.from({ length: 3 }, () => floats.next().toFixed(9))).toEqual([
      '0.126277738',
      '0.854094811',
      '0.878177767',
    ])

    expect(createPrng('match-42').uuid()).toBe('740f2f52-5f3b-42c1-bd9b-9c074821ea62')
    expect(
      createPrng('veto').shuffle(['de_mirage', 'de_inferno', 'de_nuke', 'de_ancient']),
    ).toEqual(['de_nuke', 'de_mirage', 'de_ancient', 'de_inferno'])
  })

  // A range check over a large sample is a *scan*, not one assertion per draw:
  // `expect()` costs ~13 µs a call, so five of them inside the loop spent the
  // whole runtime on ceremony — and under `verify:extended`, where a Nuxt build
  // runs beside the matrix, that ceremony grew past vitest's default deadline
  // and went red on the number while the behaviour was fine. Same class as the
  // waits `waitfor-budget.grit` forbids, one layer down. Collect the first
  // offender in plain JS and assert once: the sample is 20× bigger than the one
  // that timed out, the test is an order of magnitude cheaper, and a failure
  // reads as the draw that broke the range instead of a loop index.
  it('produces floats in [0, 1) and uint32s in range', () => {
    const prng = createPrng('range')
    let offender: { draw: number; kind: 'float' | 'uint32'; value: number } | undefined

    for (let draw = 0; draw < 100_000 && !offender; draw++) {
      const value = prng.next()
      if (!(value >= 0 && value < 1)) offender = { draw, kind: 'float', value }

      const word = prng.uint32()
      if (!Number.isInteger(word) || word < 0 || word > 0xffffffff)
        offender = { draw, kind: 'uint32', value: word }
    }

    expect(offender).toBeUndefined()
  })

  it('spreads roughly evenly across buckets', () => {
    const prng = createPrng('distribution')
    const buckets = Array.from({ length: 10 }, () => 0)
    for (let i = 0; i < 100_000; i++) buckets[prng.int(0, 10)]!++

    for (const count of buckets) {
      expect(count).toBeGreaterThan(9_000)
      expect(count).toBeLessThan(11_000)
    }
  })

  it('int stays inside its half-open range and rejects bad ones', () => {
    const prng = createPrng('int')
    const seen = new Set<number>()
    for (let i = 0; i < 1_000; i++) seen.add(prng.int(5, 8))

    expect([...seen].sort()).toEqual([5, 6, 7])
    expect(() => prng.int(3, 3)).toThrow(RangeError)
    expect(() => prng.int(5, 1)).toThrow(RangeError)
    expect(() => prng.int(0, 1.5)).toThrow(RangeError)
  })

  it('bool honours its probability', () => {
    const prng = createPrng('bool')
    let hits = 0
    for (let i = 0; i < 10_000; i++) {
      if (prng.bool(0.25)) hits++
    }

    expect(hits).toBeGreaterThan(2_200)
    expect(hits).toBeLessThan(2_800)
    expect(createPrng('always').bool(1)).toBe(true)
    expect(createPrng('never').bool(0)).toBe(false)
  })

  it('picks from a non-empty array only', () => {
    const prng = createPrng('pick')
    const maps = ['de_dust2', 'de_mirage', 'de_nuke'] as const
    for (let i = 0; i < 100; i++) expect(maps).toContain(prng.pick(maps))

    expect(() => prng.pick([])).toThrow(RangeError)
  })

  it('shuffles into a permutation without mutating the input', () => {
    const prng = createPrng('shuffle')
    const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const shuffled = prng.shuffle(input)

    expect(shuffled).not.toBe(input)
    expect([...shuffled].sort((a, b) => a - b)).toEqual([...input])
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // ...and it actually shuffles: 10 elements agreeing in order is 1 in 3.6M.
    expect(shuffled).not.toEqual([...input])
  })

  it('samples distinct elements and refuses impossible draws', () => {
    const prng = createPrng('sample')
    const players = ['a', 'b', 'c', 'd', 'e']
    const drawn = prng.sample(players, 3)

    expect(drawn).toHaveLength(3)
    expect(new Set(drawn).size).toBe(3)
    for (const player of drawn) expect(players).toContain(player)

    expect(() => prng.sample(players, 6)).toThrow(RangeError)
    expect(() => prng.sample(players, -1)).toThrow(RangeError)
    expect(prng.sample(players, 0)).toEqual([])
  })

  it('emits well-formed, unique, deterministic v4-shaped uuids', () => {
    const prng = createPrng('uuid')
    const ids = Array.from({ length: 500 }, () => prng.uuid())

    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    expect(new Set(ids).size).toBe(500)
    expect(createPrng('uuid').uuid()).toBe(ids[0])
  })

  it('forks independent streams that do not shift each other', () => {
    const root = createPrng('world')
    const players = root.fork('players')
    const matches = root.fork('matches')

    expect(players.next()).not.toBe(matches.next())
    expect(players.seed).toBe('world#players')

    // Order independence: drawing from one fork (or adding a new one) leaves
    // the others' streams untouched — a seed world stays stable as it grows.
    const fresh = createPrng('world')
    fresh.fork('players').next()
    fresh.fork('newcomer').next()
    expect(fresh.fork('matches').next()).toBe(createPrng('world').fork('matches').next())
  })

  it('clones at the current position', () => {
    const prng = createPrng('clone')
    prng.next()
    prng.next()

    const branch = prng.clone()
    const continued = Array.from({ length: 5 }, () => prng.next())
    const branched = Array.from({ length: 5 }, () => branch.next())

    expect(branched).toEqual(continued)
    expect(branch.seed).toBe('clone')
  })
})
