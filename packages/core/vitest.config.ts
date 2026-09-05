import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Core is where `eventually()` and its 15 s budget are *defined*, and
    // `testing/index.test.ts` waits on real wall time to prove it — so this
    // package needs the same deadline it tells every other suite to take
    // (`EVENTUALLY_TIMEOUT_MS`, `src/testing/index.ts`). The rest is pure
    // compute that runs in milliseconds; the point of a number this far above
    // it is that a red run here is always the assertion's own diff, never a
    // loaded box.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
