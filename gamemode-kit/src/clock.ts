/**
 * **The widget's clock.** A widget runs in a browser, where nothing injects
 * `@ezpug/core`'s clock — so the kit carries the two methods it needs
 * (`now`, `after`) as an interface a `FakeClock` satisfies structurally, and
 * the one implementation that may read the wall clock. Every deadline in the
 * kit (reconnect backoff, the tap timeout, the host's silence, cooldown
 * countdowns) is armed here, which is what lets the tests drive them.
 */

export interface WidgetTimer {
  cancel: () => void
}

export interface WidgetClock {
  /** Epoch milliseconds. */
  now: () => number
  /** Fire `fn` after `delayMs`; the handle cancels it. */
  after: (delayMs: number, fn: () => void) => WidgetTimer
}

/** Real time and real timers — the browser's. The only place the kit reads the wall clock. */
export const browserClock: WidgetClock = {
  // biome-ignore lint/plugin: a browser has no injected clock; this is the one sanctioned reading, and the tests inject a fake through `WidgetClock`
  now: () => Date.now(),
  after(delayMs, fn) {
    // biome-ignore lint/plugin: the browser's timer behind the kit's own `WidgetClock`; every deadline is armed through this seam so a test can fast-forward it
    const handle = setTimeout(fn, Math.max(0, delayMs))
    return { cancel: () => clearTimeout(handle) }
  },
}
