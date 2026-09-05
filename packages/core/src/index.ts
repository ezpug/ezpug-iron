// Determinism utilities: the injectable clock and the seeded PRNG that
// everything reproducible depends on. Zero runtime dependencies, isomorphic —
// the orchestrator, the node agent, the simulator engine, the published fake
// and every test import the same two primitives. Vitest-specific helpers live
// in `@ezpug/core/testing`, the chaos controller in `@ezpug/core/chaos`.
//
// Ported from the platform's `packages/core` on 2026-09-05 (PRD-01 T1) and kept
// structurally identical on purpose: `Clock` is the seam both repos share, so
// a clock the platform builds satisfies this repo's fake and vice versa. Fix a
// bug in both places or in neither.
export * from './clock'
export * from './prng'
