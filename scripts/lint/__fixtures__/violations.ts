// Fixtures for the determinism guard's self-test (scripts/lint/guard-selftest.sh).
// Every line below must be flagged; this file is excluded from the repo lint run.

export const stamp = Date.now()
export const now = new Date()
export const roll = Math.random()

export function armed(): void {
  setTimeout(() => {}, 1000)
  setInterval(() => {}, 1000)
  globalThis.setTimeout(() => {}, 1000)
  window.setTimeout(() => {}, 1000)
}
