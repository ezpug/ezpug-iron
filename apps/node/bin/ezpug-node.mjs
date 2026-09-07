#!/usr/bin/env node
// The `ezpug-node` command (PRD-02 T11). The bundle `pnpm build` writes is the
// program; this file only exists so `pnpm iron`-style bins and the image's
// `CMD` have one stable name to call.
import '../dist/main.mjs'
