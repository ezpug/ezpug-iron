import { defineConfig } from 'tsdown'

/**
 * The published build: one ESM bundle per entry point with its `.d.ts`.
 * `zod` and `hono` stay external (dependencies and peers, so the platform's
 * own copies are the ones the schemas and the fake's app run on; `ws` and
 * `@hono/node-server` are optional and loaded on demand by `listen()`).
 * `@ezpug/core`, `@ezpug/gamemodes` (the manifests, as data) and `@ezpug/sim`
 * (the engine inside the fake) are *bundled* — they are private to this repo,
 * and a consumer must never need them (`turbo.json`'s `published` tag says
 * the same thing about the dependency edge).
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'client/index': 'src/client/index.ts',
    'webhooks/index': 'src/webhooks/index.ts',
    'fixtures/index': 'src/fixtures/index.ts',
    'fake/index': 'src/fake/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  // `eager`: emit every declaration with the TypeScript compiler up front, so
  // the bundled packages' `export *` re-exports resolve in the `.d.ts` too.
  dts: { eager: true },
  sourcemap: true,
  clean: true,
  deps: { alwaysBundle: [/^@ezpug\/(?:core|gamemodes|sim)(\/.*)?$/] },
})
