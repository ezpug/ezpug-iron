/**
 * **One writer at a time on a provider's picture** (PRD-10 T3). The watcher
 * folds a tick's readings into `game_provider_states` and the canary writes
 * its verdicts there; each reads a row and writes it back, so two of them
 * interleaved would let the slower one put back what the faster one just
 * replaced. Both go through one of these, which runs its work in the order
 * it was asked for and lets a failure be its caller's alone.
 */
export type Exclusive = <T>(work: () => Promise<T>) => Promise<T>

export function createExclusive(): Exclusive {
  let tail: Promise<unknown> = Promise.resolve()
  return work => {
    const turn = tail.then(work, work)
    tail = turn.catch(() => undefined)
    return turn
  }
}
