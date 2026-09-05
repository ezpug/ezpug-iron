import { defineConfig } from 'tsdown'

/**
 * The published build: one ESM bundle per entry point with its `.d.ts`.
 * `zod` stays external (a dependency and a peer, so the platform's own zod is
 * the one the schemas run on); `@ezpug/core` is *bundled* — it is private to
 * this repo, and a consumer must never need it (`turbo.json`'s `published`
 * tag says the same thing about the dependency edge).
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'client/index': 'src/client/index.ts',
    'fixtures/index': 'src/fixtures/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
  noExternal: [/^@ezpug\/core(\/.*)?$/],
})
