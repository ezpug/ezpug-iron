#!/usr/bin/env node
// `docs/pins.md` is a copy for people; the homes it names are what a build
// reads. This refuses a disagreement between the two, so a bump that edits one
// and forgets the other goes red in `pnpm lint` (PRD-01 T10).
//
// Only the pins with a machine-readable home are checked. This script grows a
// case per home as one appears; the vendored plugins that are still source
// nobody has taken yet (cs2-retakes, the WeaponPaints fork) are prose until
// PRD-02 T23 and T28 give them one.
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
const orchestratorImage = read('docker/orchestrator/Dockerfile')
const nodeImage = read('docker/node/Dockerfile')
const cs2Image = read('docker/cs2/Dockerfile')

/** The value of an `ARG NAME=value` line in a Dockerfile, or undefined. */
const dockerArg = (dockerfile, name) =>
  dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1]

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
  [
    'Node (the image)',
    orchestratorImage.match(/^FROM node:(\S+) AS base$/m)?.[1],
    'docker/orchestrator/Dockerfile',
  ],
  // The node agent's image runs on the same Node as the orchestrator's: one
  // row, two homes, and this is the second.
  [
    'Node (the node image)',
    nodeImage.match(/^FROM node:(\S+) AS base$/m)?.[1],
    'docker/node/Dockerfile',
  ],
  // The server image: everything it downloads is a version *and* a checksum,
  // so a row here is two numbers and both have to be in the table.
  ['Metamod:Source', dockerArg(cs2Image, 'METAMOD_VERSION'), 'docker/cs2/Dockerfile'],
  [
    'CounterStrikeSharp (the release)',
    dockerArg(cs2Image, 'COUNTER_STRIKE_SHARP_VERSION'),
    'docker/cs2/Dockerfile',
  ],
  ['MatchZy', dockerArg(cs2Image, 'MATCHZY_VERSION'), 'docker/cs2/Dockerfile'],
  [
    'steamrt sniper (the base image)',
    // Tag plus the first eight of the digest, which is how the table writes
    // it — a full sha256 in a prose table is unreadable and nobody would ever
    // check it by eye. The Dockerfile carries the whole thing.
    cs2Image
      .match(/^FROM registry\.gitlab\.steamos\.cloud\/\S+:(\S+)@sha256:(\w{8})/m)
      ?.slice(1, 3)
      .join('@sha256:'),
    'docker/cs2/Dockerfile',
  ],
  ...[
    'typescript',
    'vitest',
    'zod',
    'tsdown',
    'hono',
    'drizzle-orm',
    'postgres',
    'ioredis',
    'dockerode',
  ].map(name => [name, catalogVersion(name), 'pnpm-workspace.yaml catalog']),
]

const problems = []
for (const [what, version, home] of expected) {
  if (!version) problems.push(`could not read the ${what} pin out of ${home}`)
  else if (!pins.includes(`\`${version}\``))
    problems.push(`docs/pins.md does not carry ${what} \`${version}\` (${home})`)
}

// The one pin that lives in two homes and *must* agree with itself: the API a
// plugin is compiled against and the CounterStrikeSharp release that loads it.
// A mismatch here is the failure this whole table exists to prevent, and it is
// invisible until a server boots with half its plugins missing.
const compiledAgainst = buildProps.match(/<CounterStrikeSharpApiVersion>([^<]+)</)?.[1]
const shippedInTheImage = dockerArg(cs2Image, 'COUNTER_STRIKE_SHARP_VERSION')
if (compiledAgainst !== shippedInTheImage)
  problems.push(
    `the plugins compile against CounterStrikeSharp.API ${compiledAgainst} ` +
      `(plugins/Directory.Build.props) but the server image ships ${shippedInTheImage} ` +
      '(docker/cs2/Dockerfile COUNTER_STRIKE_SHARP_VERSION)',
  )

if (problems.length > 0) {
  console.error('check-pins: docs/pins.md disagrees with the files a build reads')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('Fix the home first, then the row in docs/pins.md, in the same commit.')
  process.exit(1)
}
console.log(`check-pins: docs/pins.md agrees with all ${expected.length} recorded pins`)
