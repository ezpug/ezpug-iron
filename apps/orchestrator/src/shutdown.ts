/**
 * How the orchestrator process leaves — the platform's `shutdown.ts`, ported.
 *
 * A container is stopped with SIGTERM and then *waited on*: compose gives the
 * process ten seconds and then SIGKILLs it. A process with no signal handler
 * therefore costs every redeploy the full grace period, and pays for it twice
 * — once in the wait, and once in the requests and links that were mid-flight
 * when the kill landed.
 *
 * Leaving cleanly is an **order**, not a set of `close()` calls
 * (`shutdown-steps.ts` is the order). Steps run one at a time, because the
 * order is the whole guarantee: closing the database while a request is
 * still writing is not a graceful shutdown, it is a fast crash. A step that
 * throws is reported and the drain **continues** — a Redis client that
 * refuses to close must not be the reason the Postgres pool stays open — and
 * the whole drain is bounded by a deadline on the clock, so a wedged step
 * costs the budget rather than the grace period.
 */
import type { Server as HttpServer } from 'node:http'
import process from 'node:process'
import type { Clock } from '@ezpug/core'
import type { Log } from './log'

/** One named thing to close, in the order it is declared. */
export interface DrainStep {
  /** Appears in the log and in the result — this is what the order is asserted on. */
  readonly name: string
  readonly run: () => void | Promise<void>
}

export interface DrainStepResult {
  readonly name: string
  readonly ok: boolean
  /** Present exactly when `ok` is false. */
  readonly error?: unknown
}

export interface DrainResult {
  readonly signal: string
  /** Every step that ran, in the order it ran. */
  readonly steps: readonly DrainStepResult[]
  /** The deadline fired before the drain finished; the rest was abandoned. */
  readonly timedOut: boolean
  /** 0 when every step succeeded in time, 1 otherwise. */
  readonly code: number
}

/** The half of `process` this needs, injected so a test never touches the real one. */
export interface SignalSource {
  once: (signal: NodeJS.Signals, listener: () => void) => void
  off: (signal: NodeJS.Signals, listener: () => void) => void
}

export interface ShutdownOptions {
  readonly steps: readonly DrainStep[]
  /** Timers come from the clock, never from a bare `setTimeout` (CLAUDE.md). */
  readonly clock: Clock
  readonly log: Log
  /**
   * The whole drain's budget. Stays under compose's ten-second grace on
   * purpose: a drain that outlives the grace is a SIGKILL wearing a hat.
   */
  readonly timeoutMs?: number
  readonly signals?: readonly NodeJS.Signals[]
  readonly exit?: (code: number) => void
  readonly source?: SignalSource
}

export interface Shutdown {
  /** True from the first signal onwards — what `/healthz` reads (step 1). */
  readonly draining: boolean
  /** Run the drain. A second call returns the first one's promise. */
  drain: (signal: string) => Promise<DrainResult>
  /** Arm the signal handlers. The returned function disarms them. */
  listen: () => () => void
}

/** Compose waits 10 s; finish inside it or the point is lost. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 8_000

export function createShutdown(options: ShutdownOptions): Shutdown {
  const { clock, steps, log } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as const)
  const exit = options.exit ?? ((code: number) => process.exit(code))

  let draining = false
  let running: Promise<DrainResult> | undefined

  async function run(signal: string): Promise<DrainResult> {
    const startedAt = clock.now()
    const results: DrainStepResult[] = []
    let timedOut = false

    // One deadline for the whole drain rather than one per step: the budget
    // that matters is the container's, and a step that hangs has already spent
    // it. `abandoned` resolves instead of rejecting, so the winner of the race
    // is read from the flag and the loser is never an unhandled rejection.
    let abandon = (): void => {}
    const abandoned = new Promise<undefined>(resolve => {
      abandon = () => resolve(undefined)
    })
    const deadline = clock.after(timeoutMs, () => {
      timedOut = true
      abandon()
    })

    for (const step of steps) {
      if (timedOut) break
      const outcome = await Promise.race([
        (async (): Promise<DrainStepResult> => {
          try {
            await step.run()
            return { name: step.name, ok: true }
          } catch (error) {
            return { name: step.name, ok: false, error }
          }
        })(),
        abandoned,
      ])
      // The deadline won: this step is still out there, and whatever it holds
      // is the operating system's problem in a moment.
      if (!outcome) break
      results.push(outcome)
      if (outcome.ok) log.info(`drained ${outcome.name}`)
      else log.error(`drain step ${outcome.name} failed`, outcome.error)
    }

    deadline.cancel()

    const failed = results.filter(result => !result.ok).map(result => result.name)
    if (timedOut) {
      const done = results.map(result => result.name).join(', ') || 'nothing'
      log.error(`drain gave up after ${timeoutMs}ms — completed: ${done}. Exiting anyway.`)
    }
    if (failed.length > 0) log.error(`drain failures: ${failed.join(', ')}`)

    const code = timedOut || failed.length > 0 ? 1 : 0
    log.info(`${signal} drained in ${clock.now() - startedAt}ms (exit ${code})`)
    return { signal, steps: results, timedOut, code }
  }

  function drain(signal: string): Promise<DrainResult> {
    // Synchronous on purpose: `/healthz` has to be answering 503 before the
    // first `await` anywhere, and a second caller must get the *same* drain,
    // not a second one.
    draining = true
    running ??= run(signal)
    return running
  }

  return {
    get draining() {
      return draining
    },
    drain,
    listen() {
      const source: SignalSource = options.source ?? process
      const armed = signals.map(signal => {
        const listener = (): void => {
          // A second signal is an operator who is done waiting. The first drain
          // keeps running; this just stops pretending the wait is optional.
          if (running) {
            log.error(`second ${signal} while draining — exiting now`)
            exit(1)
            return
          }
          log.info(`${signal} — draining`)
          void drain(signal).then(result => {
            exit(result.code)
          })
          // Re-arm, so the *next* one is the impatient one.
          source.once(signal, listener)
        }
        source.once(signal, listener)
        return { signal, listener }
      })

      return () => {
        for (const { signal, listener } of armed) source.off(signal, listener)
      }
    },
  }
}

/**
 * The two halves of letting an HTTP server go, kept apart because they belong
 * at different points of the drain: *stop accepting* is early (nobody new gets
 * in), *wait for what is in flight* is late (after the links are gone, so the
 * wait is about requests rather than about long-lived connections).
 */
export interface HttpDrain {
  /** Close the listener and hang up idle keep-alive sockets. Returns at once. */
  stopAccepting: () => void
  /**
   * Wait for the requests that were already running to answer, then destroy
   * whatever is still holding a socket. Resolves either way — this is the last
   * stop before the pool closes.
   */
  finish: (graceMs: number) => Promise<void>
}

export function createHttpDrain(server: HttpServer, clock: Clock): HttpDrain {
  // What "in flight" means, counted rather than guessed. Waiting on the
  // server's own 'close' event instead would wait for *connections*, and a
  // client's keep-alive socket sits open between requests — which is exactly
  // the ten seconds this file is about, arrived at from the other side.
  let inFlight = 0
  const waiting: (() => void)[] = []

  server.on('request', (_request, response) => {
    inFlight += 1
    // 'close' rather than 'finish': a client that hangs up mid-response has
    // also stopped being work in progress.
    response.once('close', () => {
      inFlight -= 1
      if (inFlight === 0) for (const resolve of waiting.splice(0)) resolve()
    })
  })

  return {
    stopAccepting() {
      // Stops the listener; connections in progress keep running.
      server.close()
      // Keep-alive sockets parked between requests are not work — they are the
      // ten seconds. They go now.
      server.closeIdleConnections()
    },

    async finish(graceMs) {
      if (inFlight > 0) {
        let timer: { cancel: () => void } | undefined
        await Promise.race([
          new Promise<void>(resolve => waiting.push(resolve)),
          new Promise<void>(resolve => {
            timer = clock.after(graceMs, resolve)
          }),
        ])
        timer?.cancel()
      }
      // Whatever is still holding a socket is a keep-alive between requests or
      // a client that will not let go. Neither gets a vote.
      server.closeAllConnections()
    },
  }
}
