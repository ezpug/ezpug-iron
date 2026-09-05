import { defineConfig } from 'tsdown'

/**
 * **The image's build** (PRD-02 T4). Not a published artifact and not what
 * `pnpm dev` runs (that is `tsx src/main.ts`): two bundles a plain Node
 * process can start with no TypeScript and no workspace around it —
 * `dist/main.mjs` (the service) and `dist/migrate.mjs` (the migration step
 * the deploy runs before it).
 *
 * Everything internal is **bundled** (`@ezpug/core`, `@ezpug/match-api`,
 * `@ezpug/protocol`, `@ezpug/sim`, `@ezpug/gamemodes`), so the runtime tree
 * is npm packages only — the same reason the platform's `api` image bundles
 * its workspace dependencies and then `pnpm deploy --prod`s the rest. The
 * npm dependencies stay external: `postgres`, `ioredis` and `ws` reach for
 * node internals and are not worth inlining, and Drizzle resolves its
 * dialects at runtime.
 *
 * The SQL files are not code and cannot ride a bundle: `db/migrate.ts`
 * resolves them one level above the bundle (`dist/../../drizzle`), and the
 * image says where they are with `EZPUG_IRON_MIGRATIONS_DIR` instead.
 */
export default defineConfig({
  entry: { main: 'src/main.ts', migrate: 'scripts/migrate.ts' },
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  deps: { alwaysBundle: [/^@ezpug\//] },
})
