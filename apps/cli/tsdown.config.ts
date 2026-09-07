import { defineConfig } from 'tsdown'

/**
 * **The command, bundled** (PRD-02 T33). One file a plain Node process can
 * run with no TypeScript and no workspace around it — `dist/main.mjs`, what
 * `bin/ezpug-iron.mjs` calls, and what the orchestrator image will carry when
 * this command is published into it (PRD-02 T33; `pnpm iron` is the door
 * today). The internal packages are bundled for the same reason the node
 * agent's are; `ws` stays external because it reaches for node internals.
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
