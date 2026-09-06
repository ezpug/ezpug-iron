import { defineConfig } from 'tsdown'

/**
 * **The image's build** (PRD-02 T11). Not what `pnpm --filter @ezpug/node
 * dev` runs (that is `tsx src/main.ts`): one bundle a plain Node process can
 * start with no TypeScript and no workspace around it — `dist/main.mjs`, the
 * `ezpug-node` command. The internal packages (`@ezpug/core`,
 * `@ezpug/protocol`, and `@ezpug/match-api` behind it) are **bundled**, the
 * same reason the orchestrator's image bundles them: the runtime tree is npm
 * packages only, and `pnpm deploy --prod` lays those out. `dockerode` and
 * `ws` stay external — both reach for node internals.
 */
export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  deps: { alwaysBundle: [/^@ezpug\//] },
})
