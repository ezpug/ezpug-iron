#!/usr/bin/env node
// The fault-injection tier, on the seed of your choice (PRD-02 T32).
//
//   pnpm faults                      the fifty on the suite's own seed
//   pnpm faults --seed nacht-zwei    the same fifty, a different night
//   pnpm faults --seed abc -- -t budget   …and whatever else vitest takes
//
// The suite (`apps/orchestrator/src/faults.extended.test.ts`) plays fifty
// matches across the simulator, the fake Dathost and a fake node with faults
// injected, then asserts what the night left behind. Everything it draws
// comes from one seed, so a red run reproduces here by name; this script is
// only the door, and sets `EZPUG_IRON_FAULT_SEED` for the vitest it spawns.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    'usage: pnpm faults [--seed <seed>] [-- <vitest args>]\n\n' +
      '  --seed <seed>  the night to play; the default is the suite’s own\n' +
      '  everything after `--` is handed to vitest as it is\n',
  )
  process.exit(0)
}

const seedAt = argv.findIndex(arg => arg === '--seed' || arg.startsWith('--seed='))
let seed = process.env.EZPUG_IRON_FAULT_SEED
const rest = [...argv]
if (seedAt !== -1) {
  const arg = rest[seedAt]
  if (arg.startsWith('--seed=')) {
    seed = arg.slice('--seed='.length)
    rest.splice(seedAt, 1)
  } else {
    seed = rest[seedAt + 1]
    rest.splice(seedAt, 2)
  }
  if (!seed) {
    process.stderr.write('faults: --seed wants a value\n')
    process.exit(2)
  }
}

const run = spawnSync(
  'pnpm',
  [
    '--filter',
    '@ezpug/orchestrator',
    'exec',
    'vitest',
    'run',
    'src/faults.extended.test.ts',
    ...rest.filter(arg => arg !== '--'),
  ],
  {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, ...(seed && { EZPUG_IRON_FAULT_SEED: seed }) },
  },
)
process.exit(run.status ?? 1)
