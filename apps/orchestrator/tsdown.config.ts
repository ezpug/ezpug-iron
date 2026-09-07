import { defineConfig } from 'tsdown'

/**
 * **The image's build** (PRD-02 T4). Not a published artifact and not what
 * `pnpm dev` runs (that is `tsx src/main.ts`): three bundles a plain Node
 * process can start with no TypeScript and no workspace around it —
 * `dist/main.mjs` (the service), `dist/migrate.mjs` (the migration step the
 * deploy runs before it) and `dist/mint-key.mjs` (the *first* API key of a
 * deployment, PRD-02 T35).
 *
 * The third one is here because production has no other door to a key:
 * `EZPUG_IRON_BOOTSTRAP_API_KEY` is refused under `NODE_ENV=production` by
 * design, and `ezpug-iron keys create` needs an `admin` key to already
 * exist. `pnpm --filter @ezpug/orchestrator keys:mint` is that door on a dev
 * box, where there is a checkout and a published database port; on the box
 * behind `gs.ezpug.com` there is neither, so the image carries the same
 * script as a bundle and `./scripts/deploy.sh key` runs it once.
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
  entry: {
    main: 'src/main.ts',
    migrate: 'scripts/migrate.ts',
    'mint-key': 'scripts/mint-key.ts',
  },
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  deps: { alwaysBundle: [/^@ezpug\//] },
})
