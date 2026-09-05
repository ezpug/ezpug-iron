/**
 * The seeded PRNG. Anything that must reproduce — the simulator engine, the
 * fake orchestrator, recorded fixtures, chaos toggles, property tests — draws
 * from here and never from `Math.random()` (CLAUDE.md "Determinism").
 *
 * Algorithm: sfc32 (128-bit state, small, fast, passes PractRand) seeded by
 * cyrb128 over the seed string. Pure uint32 arithmetic, so the same seed
 * yields the same stream on every Node version and in the browser — the
 * golden-vector tests in `prng.test.ts` pin that.
 */

export interface Prng {
  /** The seed string this stream was derived from — carry it into bug reports and screenshots. */
  readonly seed: string
  /** Uniform float in [0, 1). */
  next: () => number
  /** Uniform unsigned 32-bit integer. */
  uint32: () => number
  /** Uniform integer in [minInclusive, maxExclusive). */
  int: (minInclusive: number, maxExclusive: number) => number
  /** `true` with the given probability (default 0.5). */
  bool: (probability?: number) => boolean
  /** One element of a non-empty array. */
  pick: <T>(items: readonly T[]) => T
  /** `count` distinct elements, in draw order. Throws when the array is too small. */
  sample: <T>(items: readonly T[], count: number) => T[]
  /** A shuffled copy (Fisher–Yates); the input is never mutated. */
  shuffle: <T>(items: readonly T[]) => T[]
  /** A deterministic UUID-v4-shaped id — seeded ids for fixtures, never for production entities. */
  uuid: () => string
  /**
   * An independent child stream, derived from seed + label. Order-independent:
   * adding a new consumer never shifts the numbers another consumer draws, so
   * a seed world stays stable as it grows.
   */
  fork: (label: string) => Prng
  /** A copy positioned at this stream's current state — for "what if" branches. */
  clone: () => Prng
}

/** cyrb128: seed string → four well-mixed uint32 words. */
function hashSeed(seed: string): [number, number, number, number] {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762

  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }

  return [
    (Math.imul(h3 ^ (h1 >>> 18), 597399067) ^ Math.imul(h4 ^ (h2 >>> 22), 2869860233)) >>> 0,
    (Math.imul(h4 ^ (h2 >>> 22), 951274213) ^ Math.imul(h1 ^ (h3 >>> 17), 2716044179)) >>> 0,
    (Math.imul(h1 ^ (h3 >>> 17), 597399067) ^ Math.imul(h2 ^ (h4 >>> 19), 2869860233)) >>> 0,
    (Math.imul(h2 ^ (h4 >>> 19), 951274213) ^ Math.imul(h3 ^ (h1 >>> 18), 2716044179)) >>> 0,
  ]
}

interface Sfc32State {
  a: number
  b: number
  c: number
  d: number
}

function step(state: Sfc32State): number {
  const t = (((state.a + state.b) | 0) + state.d) | 0
  state.d = (state.d + 1) | 0
  state.a = state.b ^ (state.b >>> 9)
  state.b = (state.c + (state.c << 3)) | 0
  state.c = (state.c << 21) | (state.c >>> 11)
  state.c = (state.c + t) | 0
  return t >>> 0
}

const HEX = '0123456789abcdef'

function createFrom(seed: string, state: Sfc32State): Prng {
  const prng: Prng = {
    seed,
    uint32: () => step(state),
    // 2**32; the low bit of the mantissa is not worth the extra draw at our scale.
    next: () => step(state) / 4294967296,

    int(minInclusive, maxExclusive) {
      if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive))
        throw new RangeError(`prng.int expects integers, got [${minInclusive}, ${maxExclusive})`)
      if (maxExclusive <= minInclusive)
        throw new RangeError(
          `prng.int expects a non-empty range, got [${minInclusive}, ${maxExclusive})`,
        )
      return minInclusive + Math.floor(prng.next() * (maxExclusive - minInclusive))
    },

    bool: (probability = 0.5) => prng.next() < probability,

    pick(items) {
      if (items.length === 0) throw new RangeError('prng.pick expects a non-empty array')
      return items[prng.int(0, items.length)] as (typeof items)[number]
    },

    sample(items, count) {
      if (count < 0 || count > items.length)
        throw new RangeError(`prng.sample: cannot draw ${count} of ${items.length}`)
      return prng.shuffle(items).slice(0, count)
    },

    shuffle(items) {
      const copy = [...items]
      for (let i = copy.length - 1; i > 0; i--) {
        const j = prng.int(0, i + 1)
        const swap = copy[i] as (typeof copy)[number]
        copy[i] = copy[j] as (typeof copy)[number]
        copy[j] = swap
      }
      return copy
    },

    uuid() {
      let out = ''
      for (let i = 0; i < 32; i++) {
        // Version 4 nibble, then the RFC 4122 variant nibble (8/9/a/b).
        if (i === 12) out += '4'
        else if (i === 16) out += HEX[8 + prng.int(0, 4)] as string
        else out += HEX[prng.int(0, 16)] as string

        if (i === 7 || i === 11 || i === 15 || i === 19) out += '-'
      }
      return out
    },

    fork: label => createPrng(`${seed}#${label}`),
    clone: () => createFrom(seed, { ...state }),
  }

  return prng
}

/**
 * A deterministic stream. Seeds are strings by convention (`'seed:queue'`,
 * `'match-42'`) so they read in test names and screenshots; numbers are
 * accepted and stringified.
 */
export function createPrng(seed: string | number): Prng {
  const key = String(seed)
  const [a, b, c, d] = hashSeed(key)
  const state: Sfc32State = { a, b, c, d }
  // sfc32 warm-up: discard the first draws so short seeds do not correlate.
  for (let i = 0; i < 12; i++) step(state)
  return createFrom(key, state)
}
