import { defineConfig } from 'tsdown'

/**
 * Not a published build: `dist/index.js` exists so that
 * `scripts/protocol-schema.mjs` — plain Node, run by `pnpm build` — can
 * import the Zod schemas and write them out as JSON Schema. Everything
 * internal (`@ezpug/match-api`, which drags `@ezpug/core` and the manifests
 * along) is bundled; `zod` stays external so the schemas run on the one copy
 * the workspace installs.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: false,
  clean: true,
  deps: { alwaysBundle: [/^@ezpug\//] },
})
