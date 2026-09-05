#!/usr/bin/env node
// `docs/pins.md` is a copy for people; the homes it names are what a build
// reads. This refuses a disagreement between the two, so a bump that edits one
// and forgets the other goes red in `pnpm lint` (PRD-01 T10).
//
// Only the pins with a machine-readable home are checked. Metamod and the
// vendored plugins live in files PRD-02 writes; their rows are prose until
// then, and this script grows a case per home as one appears.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = name => readFileSync(join(repo, name), 'utf8')

const pins = read('docs/pins.md')
const rootManifest = JSON.parse(read('package.json'))
const buildProps = read('plugins/Directory.Build.props')
const globalJson = JSON.parse(read('plugins/global.json'))
const workspace = read('pnpm-workspace.yaml')

/** The one line of a `catalog:` entry, or undefined. */
const catalogVersion = name => workspace.match(new RegExp(`^\\s+"?${name}"?:\\s*(\\S+)$`, 'm'))?.[1]

const expected = [
  ['Node', rootManifest.engines.node, 'package.json engines.node'],
  ['pnpm', rootManifest.packageManager.replace('pnpm@', ''), 'package.json packageManager'],
  ['.NET SDK', globalJson.sdk.version, 'plugins/global.json'],
  [
    'CounterStrikeSharp.API',
    buildProps.match(/<CounterStrikeSharpApiVersion>([^<]+)</)?.[1],
    'plugins/Directory.Build.props',
  ],
  [
    'TargetFramework',
    buildProps.match(/<TargetFramework>([^<]+)</)?.[1],
    'plugins/Directory.Build.props',
  ],
  ...['typescript', 'vitest', 'zod', 'tsdown', 'hono', 'drizzle-orm', 'postgres', 'ioredis'].map(
    name => [name, catalogVersion(name), 'pnpm-workspace.yaml catalog'],
  ),
]

const problems = []
for (const [what, version, home] of expected) {
  if (!version) problems.push(`could not read the ${what} pin out of ${home}`)
  else if (!pins.includes(`\`${version}\``))
    problems.push(`docs/pins.md does not carry ${what} \`${version}\` (${home})`)
}

if (problems.length > 0) {
  console.error('check-pins: docs/pins.md disagrees with the files a build reads')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('Fix the home first, then the row in docs/pins.md, in the same commit.')
  process.exit(1)
}
console.log(`check-pins: docs/pins.md agrees with all ${expected.length} recorded pins`)
