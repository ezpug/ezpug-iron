/**
 * Chaos toggles (Primitives §5): artificially drop, delay and duplicate
 * deliveries so resync and idempotency are *proven* instead of assumed —
 * "venue Wi-Fi is the production environment".
 *
 * It lives in `@ezpug/core` because the seams that need it may not import
 * each other: the simulator engine (event delivery over the server link), the
 * fake orchestrator's webhook and stream delivery, later the real
 * orchestrator's. Each takes a {@link ChaosDeliverer} and wraps its outbound
 * deliveries in one call; with no controller injected there is no call at all.
 *
 * Two modes, on purpose:
 *
 * - **scripted** — "drop the next delta on `wall:main`". Deterministic, no
 *   dice: this is what the conformance harness drives.
 * - **probabilistic** — "5% of socket deliveries vanish". What a dev flips on
 *   via `EZPUG_IRON_CHAOS` to shake a feature. Still deterministic given a seed,
 *   because the draws come from the injected PRNG.
 *
 * Nothing here reaches for real time: delays are armed on the injected clock,
 * so a fake clock replays them instantly.
 *
 * This is a dev/test instrument. Production never constructs a controller —
 * the orchestrator only builds one outside `NODE_ENV=production`.
 */
import type { Clock } from './clock'
import type { Prng } from './prng'
import { createPrng } from './prng'

/** What can go wrong to a delivery. `delay` also reorders, which is the point. */
export type ChaosFault = 'drop' | 'delay' | 'duplicate'

export const CHAOS_FAULTS: readonly ChaosFault[] = ['drop', 'delay', 'duplicate']

/** Default delay for a `delay` fault — long enough to arrive out of order. */
export const CHAOS_DEFAULT_DELAY_MS = 250

/** Probabilistic mode: each fault's chance per delivery, 0..1. */
export interface ChaosProfile {
  drop?: number
  delay?: number
  duplicate?: number
  /** How long a delayed delivery waits. Default {@link CHAOS_DEFAULT_DELAY_MS}. */
  delayMs?: number
}

/** Scripted mode: exactly this fault, to the next matching delivery. */
export interface ChaosScriptStep {
  fault: ChaosFault
  /** Only bite deliveries with this key (a channel name, an event name…). */
  key?: string
  /** Override the wait for a `delay` step. */
  delayMs?: number
  /** Apply to this many consecutive matching deliveries. Default 1. */
  times?: number
}

/**
 * One outbound delivery, described by its call site.
 *
 * `target` is dot-scoped (`socket.delta`, `bus.ephemeral`) so a profile
 * configured for `socket` covers every socket call site; the most specific
 * configured scope wins.
 */
export interface ChaosDelivery {
  target: string
  /** What is being delivered: a channel name, an event name, a consumer. */
  key?: string
  /**
   * Faults this call site tolerates. Defaults to all three. A durable enqueue
   * passes `['delay', 'duplicate']`: at-least-once means duplicates are legal
   * and a dropped job is not a fault we are allowed to fake — chaos must
   * break assumptions, never the guarantees themselves.
   */
  faults?: readonly ChaosFault[]
}

/** The one thing a call site needs. Injected as an option, never ambient. */
export interface ChaosDeliverer {
  /**
   * Run `send` — or drop it, delay it, or run it twice. Resolves as soon as
   * the caller is free to continue: a delayed delivery is armed on the clock
   * and awaited only by {@link ChaosController.settled}.
   */
  deliver: (delivery: ChaosDelivery, send: () => void | Promise<void>) => Promise<void>
}

/** A fault as it happened — the inspector's and the logger's view. */
export interface ChaosEvent {
  target: string
  key: string | undefined
  fault: ChaosFault
  /** Set for `delay`. */
  delayMs?: number
  /** `script` when a scripted step fired, `profile` when the dice did. */
  source: 'script' | 'profile'
}

export interface ChaosState {
  /** Profiles by target scope. */
  profiles: Record<string, ChaosProfile>
  /** Remaining scripted steps by target scope. */
  script: Record<string, ChaosScriptStep[]>
  /** Faults applied since the last {@link ChaosController.reset}. */
  applied: Record<ChaosFault, number>
  /** Deliveries that passed through untouched. */
  delivered: number
  /** Delayed deliveries still waiting on the clock. */
  pending: number
}

export interface ChaosController extends ChaosDeliverer {
  /** True while anything is configured — an inert controller is a pass-through. */
  enabled: () => boolean
  /** Set (or clear, with `null`) the probabilistic profile for a target scope. */
  configure: (target: string, profile: ChaosProfile | null) => void
  /** Queue deterministic steps for a target scope; replaces the current queue. */
  script: (target: string, steps: readonly ChaosScriptStep[]) => void
  /** Drop every profile, script and counter. Pending delays still fire. */
  reset: () => void
  describe: () => ChaosState
  /** Resolves once every delayed delivery has run. */
  settled: () => Promise<void>
}

export interface CreateChaosControllerOptions {
  /** Delays are armed here — never a bare `setTimeout`. */
  clock: Clock
  /** Draws for probabilistic mode. Defaults to one seeded from `seed`. */
  prng?: Prng
  /** Seed for the default PRNG, so a chaotic dev session is reproducible. */
  seed?: string
  /** Every applied fault, for logging and the channel inspector (T24). */
  onFault?: (event: ChaosEvent) => void
  /** A delayed or duplicated `send` that threw. Default: `console.error`. */
  onError?: (error: unknown, delivery: ChaosDelivery) => void
}

export function createChaosController(options: CreateChaosControllerOptions): ChaosController {
  const { clock } = options
  const prng = options.prng ?? createPrng(options.seed ?? 'chaos')
  const onFault = options.onFault ?? ((): void => {})
  const onError =
    options.onError ??
    ((error: unknown, delivery: ChaosDelivery) => {
      console.error(`[chaos] ${delivery.target} delivery failed:`, error)
    })

  const profiles = new Map<string, ChaosProfile>()
  const scripts = new Map<string, ChaosScriptStep[]>()
  const pending = new Set<Promise<void>>()
  let delivered = 0
  const applied: Record<ChaosFault, number> = { drop: 0, delay: 0, duplicate: 0 }

  /** `socket.delta` → ['socket.delta', 'socket']: most specific scope wins. */
  function scopesOf(target: string): string[] {
    const parts = target.split('.')
    return parts.map((_, index) => parts.slice(0, parts.length - index).join('.'))
  }

  function nextStep(delivery: ChaosDelivery): { scope: string; step: ChaosScriptStep } | null {
    for (const scope of scopesOf(delivery.target)) {
      const queue = scripts.get(scope)
      const step = queue?.[0]
      if (!queue || !step) continue
      // A step aimed at another key lets this delivery through untouched and
      // stays at the head — "drop the next delta on wall:main" must not be
      // spent by presence traffic passing by.
      if (step.key !== undefined && step.key !== delivery.key) continue
      return { scope, step }
    }
    return null
  }

  function consumeStep(scope: string): void {
    const queue = scripts.get(scope)
    const step = queue?.[0]
    if (!queue || !step) return
    const remaining = (step.times ?? 1) - 1
    if (remaining > 0) queue[0] = { ...step, times: remaining }
    else queue.shift()
    if (queue.length === 0) scripts.delete(scope)
  }

  function profileOf(target: string): ChaosProfile | undefined {
    for (const scope of scopesOf(target)) {
      const profile = profiles.get(scope)
      if (profile) return profile
    }
    return undefined
  }

  /** One draw decides, in a fixed order, so a seed reproduces a run exactly. */
  function rollFault(profile: ChaosProfile): ChaosFault | null {
    const roll = prng.next()
    let threshold = 0
    for (const fault of CHAOS_FAULTS) {
      threshold += profile[fault] ?? 0
      if (roll < threshold) return fault
    }
    return null
  }

  function schedule(delivery: ChaosDelivery, send: () => void | Promise<void>, ms: number): void {
    let settle: () => void = () => {}
    const waiting = new Promise<void>(resolve => {
      settle = resolve
    })
    pending.add(waiting)
    clock.after(ms, () => {
      void (async () => {
        try {
          await send()
        } catch (error) {
          onError(error, delivery)
        } finally {
          pending.delete(waiting)
          settle()
        }
      })()
    })
  }

  async function runTwice(
    delivery: ChaosDelivery,
    send: () => void | Promise<void>,
  ): Promise<void> {
    await send()
    try {
      await send()
    } catch (error) {
      // The first copy went out; the caller must not learn about the second.
      onError(error, delivery)
    }
  }

  return {
    enabled: () => profiles.size > 0 || scripts.size > 0,

    configure(target, profile) {
      if (profile === null) profiles.delete(target)
      else profiles.set(target, profile)
    },

    script(target, steps) {
      if (steps.length === 0) scripts.delete(target)
      else
        scripts.set(
          target,
          steps.map(step => ({ ...step })),
        )
    },

    reset() {
      profiles.clear()
      scripts.clear()
      delivered = 0
      applied.drop = 0
      applied.delay = 0
      applied.duplicate = 0
    },

    describe: () => ({
      profiles: Object.fromEntries([...profiles].map(([scope, p]) => [scope, { ...p }])),
      script: Object.fromEntries([...scripts].map(([scope, q]) => [scope, q.map(s => ({ ...s }))])),
      applied: { ...applied },
      delivered,
      pending: pending.size,
    }),

    settled: async () => {
      while (pending.size > 0) await Promise.all([...pending])
    },

    async deliver(delivery, send) {
      const allowed = delivery.faults ?? CHAOS_FAULTS
      const scripted = nextStep(delivery)
      let fault: ChaosFault | null = null
      let delayMs = CHAOS_DEFAULT_DELAY_MS
      let source: ChaosEvent['source'] = 'script'

      if (scripted && allowed.includes(scripted.step.fault)) {
        fault = scripted.step.fault
        delayMs = scripted.step.delayMs ?? CHAOS_DEFAULT_DELAY_MS
        consumeStep(scripted.scope)
      } else if (!scripted) {
        const profile = profileOf(delivery.target)
        if (profile) {
          const rolled = rollFault(profile)
          if (rolled && allowed.includes(rolled)) {
            fault = rolled
            delayMs = profile.delayMs ?? CHAOS_DEFAULT_DELAY_MS
            source = 'profile'
          }
        }
      }

      if (fault === null) {
        delivered += 1
        await send()
        return
      }

      applied[fault] += 1
      onFault({
        target: delivery.target,
        key: delivery.key,
        fault,
        source,
        ...(fault === 'delay' ? { delayMs } : {}),
      })

      if (fault === 'drop') return
      if (fault === 'delay') return schedule(delivery, send, delayMs)
      await runTwice(delivery, send)
    },
  }
}

/**
 * Parse the `EZPUG_IRON_CHAOS` env spec: a comma-separated list of
 * `target:fault=probability[@delayMs]` entries, e.g.
 *
 *   `socket:drop=0.05,socket.delta:delay=0.2@400,bus.ephemeral:duplicate=0.1`
 *
 * Throws on anything it does not understand — a typo that silently disables
 * chaos would be worse than no chaos at all.
 */
export function parseChaosSpec(spec: string): Record<string, ChaosProfile> {
  const profiles: Record<string, ChaosProfile> = {}

  for (const raw of spec.split(',')) {
    const entry = raw.trim()
    if (entry === '') continue

    const match =
      /^([a-z0-9-]+(?:\.[a-z0-9-]+)*):(drop|delay|duplicate)=([0-9.]+)(?:@(\d+))?$/.exec(entry)
    if (!match) {
      throw new Error(
        `chaos: cannot parse "${entry}" — expected target:fault=probability[@delayMs], ` +
          'e.g. socket.delta:delay=0.2@400',
      )
    }
    const [, target, fault, chance, delayMs] = match as unknown as [
      string,
      string,
      ChaosFault,
      string,
      string | undefined,
    ]
    const probability = Number(chance)
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`chaos: probability for "${entry}" must be between 0 and 1`)
    }

    const profile = profiles[target] ?? {}
    profile[fault] = probability
    if (delayMs !== undefined) profile.delayMs = Number(delayMs)
    profiles[target] = profile
  }

  return profiles
}
