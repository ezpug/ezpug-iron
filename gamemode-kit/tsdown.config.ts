import { defineConfig } from 'tsdown'

/**
 * **The kit's tooling build.** Only the CLI is built: the runtime a widget
 * imports (`@ezpug/gamemode-kit`, `src/index.ts`) is consumed as source by
 * Vite, and the Vite preset (`./vite`) by the CLI itself. What the CLI needs
 * from this repo — the published fake for the dev harness, the manifests
 * behind it — is bundled from source (the orchestrator's arrangement), so
 * `dist/cli.mjs` runs on npm packages alone: Vite, the Vue plugin, Hono's
 * Node server and `ws` stay external.
 */
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  deps: { alwaysBundle: [/^@ezpug\//] },
})
