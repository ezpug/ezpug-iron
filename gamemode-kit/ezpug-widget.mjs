#!/usr/bin/env node
// The `ezpug-widget` bin. A shim, committed, so `pnpm install` can link the
// bin before the kit has been built; the CLI itself is `src/cli.ts`, bundled
// by `tsdown` into `dist/cli.mjs` with the fake orchestrator the dev harness
// runs (Turbo builds the kit before anything that depends on it).
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const built = new URL('./dist/cli.mjs', import.meta.url)
if (!existsSync(fileURLToPath(built))) {
  console.error(
    'ezpug-widget: the kit is not built — run `pnpm --filter @ezpug/gamemode-kit build` (or `pnpm build`) first',
  )
  process.exit(1)
}
await import(built.href)
