import { afterEach, describe, expect, it, vi } from 'vitest'
import { harnessPort } from './dev'

/**
 * **The port is `.env.example`'s to decide** (CLAUDE.md; PRD-02 T40 found the
 * kit hard-coding it while that file claimed to own it). Only the number's
 * provenance is asserted here — a harness that actually listens needs Vite, a
 * built widget and a fake orchestrator, and that is what `build.test.ts` and
 * the widget suites cover.
 */
describe('the harness port', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is what the environment names', () => {
    vi.stubEnv('EZPUG_IRON_WIDGET_HARNESS_PORT', '3499')
    expect(harnessPort()).toBe(3499)
  })

  it('falls back to 3432 when nothing names one', () => {
    vi.stubEnv('EZPUG_IRON_WIDGET_HARNESS_PORT', undefined)
    expect(harnessPort()).toBe(3432)
  })

  it('ignores a value that is not a port rather than obeying it', () => {
    for (const bad of ['', 'three-thousand', '0', '-1', '70000', '3432.5']) {
      vi.stubEnv('EZPUG_IRON_WIDGET_HARNESS_PORT', bad)
      expect(harnessPort(), bad).toBe(3432)
    }
  })
})
