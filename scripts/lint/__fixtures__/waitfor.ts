// Two known waiting-budget violations: both take vitest's one-second default,
// which is what goes red when a build runs beside the test matrix.

declare const vi: {
  waitFor: (assertion: () => unknown) => Promise<unknown>
  waitUntil: (assertion: () => unknown) => Promise<unknown>
  advanceTimersByTime: (ms: number) => void
}
declare const eventually: (assertion: () => unknown) => Promise<unknown>
declare const isLive: () => boolean

export async function waitsOneSecond(): Promise<unknown> {
  return vi.waitFor(() => isLive())
}

export async function waitsUntilOneSecond(): Promise<unknown> {
  return vi.waitUntil(() => isLive())
}

/** The shape the guard asks for — and vi's other verbs stay untouched. */
export async function waitsLongEnough(): Promise<unknown> {
  vi.advanceTimersByTime(0)
  return eventually(() => isLive())
}
