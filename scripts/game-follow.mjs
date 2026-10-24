#!/usr/bin/env node
// `pnpm game:follow` — a pin bump as one verb, and the policy of a patch
// (PRD-10 T5, decision 39).
//
//   pnpm game:follow css@1.0.378 metamod@1483 mam@1.7   bump the homes, prove the build, commit
//   pnpm game:follow mam@1.7.1 --dry-run                 print the plan and the diff, touch nothing
//   pnpm game:follow --auto --env-file .env.production   what the box's timer runs every 30 min
//   node scripts/game-follow.mjs --help
//
// On 2026-10-23 a CS2 update killed every Dathost server and the fix was a
// Dockerfile edited by hand at the table (#13). A bump is now a verb with
// named phases, each printed as it runs: the homes (`docker/cs2/Dockerfile`'s
// `ARG`s with their shas fetched and verified, `plugins/Directory.Build.props`,
// the orchestrator's `GAME_PINS`, the `docs/pins.md` rows rewritten from a
// template with the release's title and date) → `check-pins` → `pnpm verify`
// → `pnpm cs2:build` → `pnpm cs2:canary` (the image, on the dev node) →
// `pnpm dathost:image` and `--check` (the template) → the orchestrator's own
// canary (`POST /v1/fleet/game/canary`), waited for → `chore(pins): …`
// committed, never pushed → a comment on the build's issue.
//
// **What stops it, by name**, leaving the tree at the last green commit: a
// dirty tree, a lane held past `--lock-wait`, a download whose sha is not the
// release page's, a red verify, a red canary, a template whose `--check` was
// red *before* the push (somebody's hand on it, like #13). Metamod is never
// followed alone: `metamod@NNNN` must be the build the named CounterStrikeSharp
// release builds against (its `libraries/metamod-source` submodule), and the
// drop's binary says which build it is.
//
// **The policy** (`EZPUG_IRON_GAME_FOLLOW=off|patch`, default `off`): `--auto`
// reads the watcher's picture off the orchestrator (`GET /v1/fleet/game`) and
// follows a release unattended only when it is a *patch* exactly as decision
// 39 spells it; anything else is a "waiting for a human" comment on the
// build's issue and nothing moved. Unattended, the image's proof (the dev-node
// canary) may be refused by the box — the lane, no dev orchestrator, a volume
// Steam will not update — and then the follow goes onto the **template**
// alone, says so, and the image waits for a human (open question 2).
//
// Secrets: the orchestrator's key and the GitHub token are read out of the
// env file into this process and put on a request; they appear in no log
// line, no plan, no commit message and no issue comment.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import {
  describeLaneLock,
  LANE_LOCK_PATH,
  readLaneLock,
  refreshLaneLock,
  releaseLaneLock,
  takeLaneLock,
  wallClock,
} from './cs2-lane-lock.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// What a follow knows about the world
// ---------------------------------------------------------------------------

/** `EZPUG_IRON_GAME_FOLLOW`: `off` (the default) or `patch`. */
export const FOLLOW_POLICIES = ['off', 'patch']
/** What a follow proves: the Dathost template, the CS2 image for LAN nodes, or both. */
export const TARGETS = ['template', 'image', 'both']
/** The phases, in order; each is printed as it runs and names a stop. */
export const PHASES = [
  'preflight',
  'resolve',
  'template-check',
  'homes',
  'check-pins',
  'verify',
  'lane',
  'cs2:build',
  'cs2:canary',
  'dathost:image',
  'canary',
  'commit',
  'issue',
]
/** The files a bump writes, and the only ones its commit may carry. */
export const HOMES = [
  'docker/cs2/Dockerfile',
  'plugins/Directory.Build.props',
  'apps/orchestrator/src/game/pins.ts',
  'docs/pins.md',
]
/** How long one canary on the orchestrator may take to decide: the key's ten minutes, and a margin. */
export const CANARY_WAIT_MS = 14 * 60_000
/** A hold longer than the lock's 90-minute corpse age refreshes its stamp this often. */
export const LANE_REFRESH_MS = 20 * 60_000
/** The rows `pnpm cs2:canary` plays for a follow when none are named. */
export const DEFAULT_ROWS = ['retakes', 'pug-2v1']
/** The marker a "waiting for a human" comment carries, so a second `--auto` finds it and says nothing twice. */
export const WAITING_MARKER = 'game:follow waiting'

/**
 * **The upstreams a spec names**, by the short name a human types
 * (`css@1.0.378`, `metamod@1483`, `mam@1.7`), and where each lives: the
 * Dockerfile `ARG`s that are its home, the `docs/pins.md` rows that carry it,
 * the GitHub repository and the artifact the image downloads.
 */
export const UPSTREAMS = {
  css: {
    key: 'counterStrikeSharp',
    name: 'CounterStrikeSharp',
    repo: 'roflmuffin/CounterStrikeSharp',
    versionArg: 'COUNTER_STRIKE_SHARP_VERSION',
    shaArg: 'COUNTER_STRIKE_SHARP_SHA256',
    rows: ['CounterStrikeSharp.API', 'CounterStrikeSharp (the release)'],
    tag: version => `v${version}`,
    asset: version => `counterstrikesharp-with-runtime-linux-${version}.zip`,
    url: version =>
      `https://github.com/roflmuffin/CounterStrikeSharp/releases/download/v${version}/counterstrikesharp-with-runtime-linux-${version}.zip`,
  },
  metamod: {
    key: 'metamod',
    name: 'Metamod:Source',
    repo: 'alliedmodders/metamod-source',
    versionArg: 'METAMOD_VERSION',
    shaArg: 'METAMOD_SHA256',
    rows: ['Metamod:Source'],
    tag: null,
    asset: version => `mmsource-${version}-linux.tar.gz`,
    url: version => `https://mms.alliedmods.net/mmsdrop/2.0/mmsource-${version}-linux.tar.gz`,
  },
  mam: {
    key: 'multiAddonManager',
    name: 'MultiAddonManager',
    repo: 'Source2ZE/MultiAddonManager',
    versionArg: 'MULTIADDONMANAGER_VERSION',
    shaArg: 'MULTIADDONMANAGER_SHA256',
    rows: ['MultiAddonManager'],
    tag: version => `v${version}`,
    asset: version => `MultiAddonManager-v${version}-steamrt3.tar.gz`,
    url: version =>
      `https://github.com/Source2ZE/MultiAddonManager/releases/download/v${version}/MultiAddonManager-v${version}-steamrt3.tar.gz`,
  },
  matchzy: {
    key: 'matchzy',
    name: 'MatchZy-Enhanced',
    repo: 'ezpug/MatchZy-Enhanced',
    versionArg: 'MATCHZY_VERSION',
    shaArg: 'MATCHZY_SHA256',
    rows: [],
    tag: version => `v${version}`,
    asset: null,
    url: null,
  },
}

/** The spec name of an upstream `owner/repo`, as the orchestrator's `GET /v1/fleet/game` names it. */
export const SPEC_OF_REPO = Object.fromEntries(
  Object.entries(UPSTREAMS).map(([spec, upstream]) => [upstream.repo, spec]),
)

const HELP = `game:follow — bump a server-side pin, prove it, commit it (PRD-10 T5, decision 39)

  pnpm game:follow <spec>… [flags]      css@1.0.378 metamod@1483 mam@1.7
  pnpm game:follow --auto [flags]       follow what the watcher saw, under the policy

  --dry-run              print the plan and the diff, touch nothing
  --target <t>           template | image | both (default both): what the bump is proven on
  --rows <a,b>           lane rows cs2:canary plays; default ${DEFAULT_ROWS.join(',')}; 'none'
  --boots <n>            boots cs2:canary makes; its default otherwise
  --hud                  also play the orchestrator's hud canary (the loader on the server)
  --lock-token <token>   run inside a hold of the CS2 lane somebody else has
  --lock-wait <minutes>  how long to queue for the lane; default 45
  --orchestrator <url>   the orchestrator whose canary proves the template;
                         default the env file's EZPUG_IRON_PUBLIC_URL, then
                         EZPUG_IRON_BASE_URL, then http://127.0.0.1:3430
  --env-file <path>      where EZPUG_IRON_GAME_FOLLOW, EZPUG_IRON_API_KEY and
                         EZPUG_IRON_GITHUB_TOKEN are read from; default .env
                         (only those names are read; nothing is exported)
  --trailer <line>       a trailer line for the chore(pins) commit (repeatable)
  --json                 print the report as JSON
  --help

Exit 0 followed or nothing to do, 1 stopped (by name), 2 usage.`

// ---------------------------------------------------------------------------
// Versions and the policy
// ---------------------------------------------------------------------------

/** A stop that names its phase: the verb prints it and exits 1. */
export class Stop extends Error {
  constructor(phase, message) {
    super(message)
    this.phase = phase
  }
}

/** `1.0.378` → `[1, 0, 378]`; `1.7` → `[1, 7, 0]`; null for anything that is not numbers and dots. */
export function versionTriple(version) {
  if (typeof version !== 'string' || !/^\d+(\.\d+){1,2}$/.test(version)) return null
  const parts = version.split('.').map(Number)
  while (parts.length < 3) parts.push(0)
  return parts
}

/** The build out of `2.0.0-git1483`, `git1483` or `1483`; null otherwise. */
export function metamodBuild(spec) {
  const match = String(spec).match(/^(?:2\.0\.0-)?(?:git)?(\d{3,5})$/)
  return match ? Number(match[1]) : null
}

/** The Dockerfile's spelling of a Metamod build: `1483` → `2.0.0-git1483`. */
export function metamodVersion(spec) {
  const build = metamodBuild(spec)
  return build === null ? null : `2.0.0-git${build}`
}

/**
 * What one version is to another: `patch` when the first two numbers are
 * unchanged and the third moved up, `minor`, `major`, `same`, `older`, or
 * `unknown` when either is not a dotted number.
 */
export function bumpKind(from, to) {
  const a = versionTriple(from)
  const b = versionTriple(to)
  if (a === null || b === null) return 'unknown'
  if (a[0] !== b[0]) return b[0] > a[0] ? 'major' : 'older'
  if (a[1] !== b[1]) return b[1] > a[1] ? 'minor' : 'older'
  if (a[2] !== b[2]) return b[2] > a[2] ? 'patch' : 'older'
  return 'same'
}

/** The first CS2 version a release names (`1.41.9.2`), or null. */
export function gameVersionNamed(release) {
  const text = `${release?.name ?? ''}\n${release?.body ?? ''}`
  return text.match(/\b(\d+\.\d+\.\d+\.\d+)\b/)?.[1] ?? null
}

/**
 * Whether a CounterStrikeSharp release's title or notes allow a patch to
 * follow (decision 39): they name the CS2 version it fixes or contain
 * "fix", and say nothing of "breaking", "migration" or an API removal.
 */
export function notesAllowPatch(release) {
  const text = `${release?.name ?? ''}\n${release?.body ?? ''}`
  if (/\bbreaking\b/i.test(text)) return { ok: false, why: 'the notes say "breaking"' }
  if (/\bmigrat(?:e|es|ed|ion|ions|ing)\b/i.test(text))
    return { ok: false, why: 'the notes say "migration"' }
  if (/\bremov\w*\b[^\n]{0,80}\bAPIs?\b|\bAPIs?\b[^\n]{0,80}\bremov\w*/i.test(text))
    return { ok: false, why: 'the notes remove something from the API' }
  const game = gameVersionNamed(release)
  const fix = /\bfix(?:es|ed|ing)?\b/i.test(text)
  if (game === null && !fix)
    return { ok: false, why: 'the notes neither name a CS2 version nor say "fix"' }
  return {
    ok: true,
    why: game !== null ? `the notes name CS2 ${game}` : 'the notes say "fix"',
  }
}

/**
 * **"Patch" is decided exactly so** (decision 39): for CounterStrikeSharp the
 * first two numbers unchanged and the third moved, with notes that name the
 * CS2 version fixed or say "fix" and carry no "breaking", "migration" or API
 * removal; for MultiAddonManager the third number alone; Metamod only as the
 * build CounterStrikeSharp names; MatchZy-Enhanced never. Answers whether the
 * bump may follow unattended, and why, in one sentence a comment can carry.
 */
export function patchPolicy(spec, pinned, candidate, release = null) {
  const upstream = UPSTREAMS[spec]
  if (!upstream) return { allowed: false, kind: 'unknown', why: `no upstream is called ${spec}` }
  if (spec === 'matchzy')
    return {
      allowed: false,
      kind: 'never',
      why: "MatchZy-Enhanced is never followed: a fork rebase is a human's work (PRD-09 T6)",
    }
  if (spec === 'metamod')
    return {
      allowed: false,
      kind: 'never',
      why: 'Metamod:Source is never followed alone: it moves to the build the CounterStrikeSharp release builds against',
    }
  const kind = bumpKind(pinned, candidate)
  const move = `${upstream.name} ${pinned} → ${candidate}`
  if (kind === 'same') return { allowed: false, kind, why: `${move} is no move` }
  if (kind === 'older') return { allowed: false, kind, why: `${move} goes backwards` }
  if (kind === 'unknown')
    return {
      allowed: false,
      kind,
      why: `${move}: one of the two is not a version this policy reads`,
    }
  if (kind !== 'patch')
    return {
      allowed: false,
      kind,
      why: `${move} is a ${kind}: the ${kind === 'major' ? 'first' : 'second'} number moved, and a ${kind} waits for a human`,
    }
  if (spec === 'css') {
    const notes = notesAllowPatch(release)
    if (!notes.ok)
      return { allowed: false, kind, why: `${move} moves the third number, but ${notes.why}` }
    return {
      allowed: true,
      kind,
      why: `${move} is a patch: the first two numbers unchanged, the third moved, ${notes.why}, and no "breaking", "migration" or API removal in them`,
    }
  }
  return { allowed: true, kind, why: `${move} is a patch: the third number alone moved` }
}

/** One line that says what a release is: its title unless that is just the tag, else its first bullet. */
export function releaseHeadline(release) {
  if (!release) return null
  const strip = line =>
    line
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\(\s*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  const name = (release.name ?? '').trim()
  if (name && name !== release.tag_name && !/^v?\d+(\.\d+)+$/.test(name)) return strip(name)
  const bullets = String(release.body ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s+/.test(line))
    .map(line => strip(line.replace(/^[-*]\s+/, '')))
    .filter(Boolean)
  // The line about the game first: a fix that names a CS2 version, a rebuild
  // for an update; else the first bullet.
  const game = bullets.find(line => /\bfix/i.test(line) && /\b\d+\.\d+\.\d+\.\d+\b/.test(line))
  const update = bullets.find(line => /\b(?:game|cs2) update\b/i.test(line))
  return (game ?? update ?? bullets[0] ?? name ?? null)?.slice(0, 140) ?? null
}

/** `2026-10-23` out of a release's `published_at`, or null. */
export function releaseDay(release) {
  const at = release?.published_at
  return typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(at) ? at.slice(0, 10) : null
}

/** Version and tag out of a Dockerfile text: every `ARG NAME=value`. */
export function readDockerArgs(dockerfile) {
  const args = {}
  for (const match of dockerfile.matchAll(/^ARG ([A-Z0-9_]+)=(\S+)$/gm)) args[match[1]] = match[2]
  return args
}

/** The pins as the tree carries them now, by spec name. */
export function currentPins(tree) {
  const args = readDockerArgs(tree.dockerfile)
  return {
    css: args.COUNTER_STRIKE_SHARP_VERSION ?? null,
    metamod: args.METAMOD_VERSION ?? null,
    mam: args.MULTIADDONMANAGER_VERSION ?? null,
    matchzy: args.MATCHZY_VERSION ?? null,
    cssApi: tree.props.match(/<CounterStrikeSharpApiVersion>([^<]+)</)?.[1] ?? null,
  }
}

/**
 * What a Metamod drop's binary says about itself: the NUL-delimited strings
 * `2.0.0-dev+1483` and the short commit `170058a`. A drop names its build in
 * its file name and its commit nowhere else, so the binary is how
 * `metamod@NNNN` is held to the CounterStrikeSharp release's submodule.
 */
export function metamodBinaryFacts(buffer) {
  const facts = { build: null, commits: [] }
  const text = buffer.toString('latin1')
  for (const part of text.split('\0')) {
    const build = part.match(/^2\.0\.0-dev\+(\d+)$/)
    if (build) facts.build = Number(build[1])
    else if (/^[0-9a-f]{7,8}$/.test(part)) facts.commits.push(part)
  }
  return facts
}

/**
 * Why a `css@…` / `metamod@…` pair is refused, or null when the Metamod
 * build is the one the CounterStrikeSharp release builds against: its
 * `libraries/metamod-source` submodule commit must be the commit the drop's
 * binary carries, and the binary's build must be the one named.
 */
export function metamodPairProblem({ cssVersion, submoduleSha, metamodVersion: version, binary }) {
  const build = metamodBuild(version)
  if (build === null) return `${version} is not a Metamod build (2.0.0-gitNNNN)`
  if (!submoduleSha)
    return `CounterStrikeSharp v${cssVersion} names no libraries/metamod-source submodule commit on its tag`
  if (binary.build !== null && binary.build !== build)
    return `the drop mmsource-${version} says it is build ${binary.build}, not ${build}`
  const short = submoduleSha.slice(0, 7)
  if (!binary.commits.some(commit => submoduleSha.startsWith(commit)))
    return (
      `CounterStrikeSharp v${cssVersion} builds against metamod-source ${short}, and the drop ` +
      `mmsource-${version} was built from ${binary.commits[0] ?? 'a commit it does not name'}: ` +
      'Metamod is never followed alone, and this is not the pair'
    )
  return null
}

// ---------------------------------------------------------------------------
// The homes, rewritten
// ---------------------------------------------------------------------------

/** One `ARG NAME=value` line, replaced; a Dockerfile without it is a stop. */
export function rewriteDockerArg(dockerfile, name, value) {
  const pattern = new RegExp(`^ARG ${name}=\\S+$`, 'm')
  if (!pattern.test(dockerfile))
    throw new Stop('homes', `docker/cs2/Dockerfile has no ARG ${name}= line to rewrite`)
  return dockerfile.replace(pattern, `ARG ${name}=${value}`)
}

/** `<CounterStrikeSharpApiVersion>…</…>` in `plugins/Directory.Build.props`. */
export function rewriteProps(props, version) {
  const pattern = /<CounterStrikeSharpApiVersion>[^<]+<\/CounterStrikeSharpApiVersion>/
  if (!pattern.test(props))
    throw new Stop('homes', 'plugins/Directory.Build.props has no <CounterStrikeSharpApiVersion>')
  return props.replace(
    pattern,
    `<CounterStrikeSharpApiVersion>${version}</CounterStrikeSharpApiVersion>`,
  )
}

/** One key of `GAME_PINS` in `apps/orchestrator/src/game/pins.ts`. */
export function rewriteGamePin(source, key, version) {
  const pattern = new RegExp(`^(\\s+${key}: )'[^']+',$`, 'm')
  if (!pattern.test(source))
    throw new Stop('homes', `apps/orchestrator/src/game/pins.ts has no ${key} in GAME_PINS`)
  return source.replace(pattern, `$1'${version}',`)
}

/**
 * One row of a `docs/pins.md` table, by its `What` cell: the pin cell's
 * `` `from` `` becomes `` `to` ``, and the sentence (when there is one) is
 * appended to the "Why this one" cell in the table's voice. The row's
 * history stays: a bump adds a sentence, it does not rewrite the past.
 */
export function rewritePinsRow(markdown, what, { from, to, sentence = null }) {
  const lines = markdown.split('\n')
  const index = lines.findIndex(line => line.startsWith(`| ${what} | `))
  if (index === -1) throw new Stop('homes', `docs/pins.md has no row "${what}"`)
  const line = lines[index]
  if (!line.endsWith(' |'))
    throw new Stop('homes', `docs/pins.md's row "${what}" has an unexpected shape`)
  const cells = line.slice(2, -2).split(' | ')
  if (cells.length < 3)
    throw new Stop('homes', `docs/pins.md's row "${what}" has fewer than three cells`)
  if (from !== to) {
    if (!cells[1].includes(`\`${from}\``))
      throw new Stop(
        'homes',
        `docs/pins.md's row "${what}" does not carry \`${from}\` in its pin cell`,
      )
    cells[1] = cells[1].replace(`\`${from}\``, `\`${to}\``)
  }
  if (sentence) {
    const last = cells.length - 1
    cells[last] = `${cells[last].replace(/\.?\s*$/, '')}. ${sentence.replace(/\.\s*$/, '')}`
  }
  lines[index] = `| ${cells.join(' | ')} |`
  return lines.join('\n')
}

/**
 * **The sentence a bump adds to a row**, from a template with the release's
 * title and date; `proof` is appended once the canaries have spoken, so the
 * row says what the build was proven on.
 */
export function rowSentence(spec, ctx) {
  const { to, release, day, proof } = ctx
  const verb = `followed by \`pnpm game:follow\` on ${day}${proof ? ` — ${proof}` : ''}`
  if (spec === 'css') {
    const game = gameVersionNamed(release)
    const headline = releaseHeadline(release)
    const parts = [releaseDay(release), headline ? `"${headline}"` : null]
      .filter(Boolean)
      .join(', ')
    return `${to}${parts ? ` (${parts})` : ''} is upstream's ${game ? `fix for CS2 ${game}` : 'next patch'}, ${verb}`
  }
  if (spec === 'metamod') {
    const build = metamodBuild(to)
    return (
      `For ${ctx.cssVersion} that is commit \`${ctx.submoduleSha.slice(0, 8)}\`, which is git${build} ` +
      `(the binary says \`2.0.0-dev+${build}\`), ${verb}`
    )
  }
  if (spec === 'mam') {
    const published = releaseDay(release)
    const headline = releaseHeadline(release)
    return `${to}${published ? ` (${published})` : ''} is ${headline ? `"${headline}"` : "upstream's next patch"}, ${verb}`
  }
  return `${to}, ${verb}`
}

/**
 * Every home as it would read after the bumps: the Dockerfile `ARG`s with
 * their shas, the props, `GAME_PINS`, the `docs/pins.md` rows. Pure: it
 * takes the four texts and answers four texts, so a dry run and a test see
 * exactly what a real run writes.
 */
export function planHomes(tree, bumps, { day, proof = null }) {
  let { dockerfile, props, pinsTs, pinsMd } = tree
  const cssBump = bumps.find(b => b.spec === 'css')
  for (const bump of bumps) {
    const upstream = UPSTREAMS[bump.spec]
    dockerfile = rewriteDockerArg(dockerfile, upstream.versionArg, bump.to)
    dockerfile = rewriteDockerArg(dockerfile, upstream.shaArg, bump.sha256)
    pinsTs = rewriteGamePin(pinsTs, upstream.key, bump.to)
    if (bump.spec === 'css') props = rewriteProps(props, bump.to)
    const ctx = {
      to: bump.to,
      release: bump.release,
      day,
      proof,
      cssVersion: cssBump?.to ?? null,
      submoduleSha: bump.submoduleSha ?? '',
    }
    for (const [i, what] of upstream.rows.entries()) {
      // The API row of CounterStrikeSharp carries the number and nothing of the release.
      const sentence = bump.spec === 'css' && i === 0 ? null : rowSentence(bump.spec, ctx)
      pinsMd = rewritePinsRow(pinsMd, what, { from: bump.from, to: bump.to, sentence })
    }
  }
  return [
    { path: 'docker/cs2/Dockerfile', before: tree.dockerfile, after: dockerfile },
    { path: 'plugins/Directory.Build.props', before: tree.props, after: props },
    { path: 'apps/orchestrator/src/game/pins.ts', before: tree.pinsTs, after: pinsTs },
    { path: 'docs/pins.md', before: tree.pinsMd, after: pinsMd },
  ]
}

/** The lines that differ, `-`/`+` pairs by line; what a dry run prints. */
export function lineDiff(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const out = []
  if (a.length !== b.length) {
    out.push(`  (${a.length} → ${b.length} lines)`)
    return out
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    out.push(`  @@ line ${i + 1}`)
    out.push(`  - ${a[i].length > 300 ? `${a[i].slice(0, 300)}…` : a[i]}`)
    out.push(`  + ${b[i].length > 300 ? `${b[i].slice(0, 300)}…` : b[i]}`)
  }
  return out
}

/** The plan, byte-stable: no clock, no path of the box, so two dry runs print the same text. */
export function renderPlan(plan) {
  const lines = []
  lines.push(`game:follow plan (target ${plan.target}${plan.dryRun ? ', dry run' : ''})`)
  for (const bump of plan.bumps) {
    const upstream = UPSTREAMS[bump.spec]
    lines.push(
      `  ${upstream.name}: ${bump.from} → ${bump.to}` +
        `${bump.release?.published_at ? ` (released ${bump.release.published_at})` : ''}` +
        `${bump.policy ? ` — ${bump.policy.why}` : ''}`,
    )
    lines.push(`    ${upstream.asset ? upstream.asset(bump.to) : bump.to} sha256 ${bump.sha256}`)
    if (bump.spec === 'metamod' && bump.submoduleSha)
      lines.push(
        `    the build CounterStrikeSharp names: metamod-source ${bump.submoduleSha.slice(0, 8)}`,
      )
  }
  for (const note of plan.notes) lines.push(`  note: ${note}`)
  lines.push('  homes:')
  for (const home of plan.homes) {
    const diff = lineDiff(home.before, home.after)
    lines.push(`  ${home.path}${diff.length === 0 ? ' (unchanged)' : ''}`)
    lines.push(...diff)
  }
  lines.push('  phases:')
  for (const phase of plan.phases) lines.push(`    ${phase}`)
  return `${lines.join('\n')}\n`
}

/** The phases a run with these options goes through, in order. */
export function phasesFor(options) {
  return PHASES.filter(phase => {
    if (phase === 'cs2:canary') return options.target !== 'template'
    if (phase === 'dathost:image' || phase === 'canary' || phase === 'template-check')
      return options.target !== 'image'
    return true
  })
}

// ---------------------------------------------------------------------------
// The flags
// ---------------------------------------------------------------------------

/** `css@1.0.378` → `{ spec: 'css', version: '1.0.378' }`; Metamod's build is spelled out. */
export function parseSpec(text) {
  const match = text.match(/^([a-z]+)@(\S+)$/)
  if (!match) throw new Stop('usage', `${text} is not a <spec>@<version>`)
  const [, spec, version] = match
  if (!UPSTREAMS[spec]) throw new Stop('usage', `no upstream is called ${spec} (css, metamod, mam)`)
  if (spec === 'matchzy')
    throw new Stop('usage', "MatchZy-Enhanced is never followed: a fork rebase is a human's work")
  if (spec === 'metamod') {
    const full = metamodVersion(version)
    if (full === null) throw new Stop('usage', `${version} is not a Metamod build (metamod@1483)`)
    return { spec, version: full }
  }
  if (versionTriple(version) === null)
    throw new Stop('usage', `${version} is not a version (1.0.378)`)
  return { spec, version }
}

/** The flags, checked; throws a `Stop('usage', …)` for anything it cannot use. */
export function parseArgs(argv) {
  const options = {
    specs: {},
    auto: false,
    dryRun: false,
    target: 'both',
    rows: DEFAULT_ROWS,
    boots: null,
    hud: false,
    lockToken: null,
    lockWaitMs: 45 * 60_000,
    orchestrator: null,
    envFile: '.env',
    trailers: [],
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Stop('usage', `${flag} needs a value`)
      return next
    }
    if (flag === '--auto') options.auto = true
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--target') {
      options.target = value()
      if (!TARGETS.includes(options.target))
        throw new Stop('usage', `--target is ${TARGETS.join(', ')}`)
    } else if (flag === '--rows') {
      const rows = value()
      options.rows = rows === 'none' ? [] : rows.split(',').filter(Boolean)
    } else if (flag === '--boots') {
      options.boots = Number(value())
      if (!Number.isInteger(options.boots) || options.boots < 1)
        throw new Stop('usage', '--boots is a whole number')
    } else if (flag === '--hud') options.hud = true
    else if (flag === '--lock-token') options.lockToken = value()
    else if (flag === '--lock-wait') options.lockWaitMs = Number(value()) * 60_000
    else if (flag === '--orchestrator') options.orchestrator = value().replace(/\/+$/, '')
    else if (flag === '--env-file') options.envFile = value()
    else if (flag === '--trailer') options.trailers.push(value())
    else if (flag === '--json') options.json = true
    else if (flag === '--help' || flag === '-h') options.help = true
    else if (flag.startsWith('-')) throw new Stop('usage', `unknown flag ${flag}`)
    else {
      const { spec, version } = parseSpec(flag)
      if (options.specs[spec]) throw new Stop('usage', `${spec} is named twice`)
      options.specs[spec] = version
    }
  }
  if (options.help) return options
  if (options.auto && Object.keys(options.specs).length > 0)
    throw new Stop('usage', '--auto decides the specs itself; name one or the other')
  if (!options.auto && Object.keys(options.specs).length === 0)
    throw new Stop('usage', 'name a spec (css@1.0.378 metamod@1483, mam@1.7) or --auto')
  if (options.specs.metamod && !options.specs.css)
    throw new Stop(
      'usage',
      'Metamod is never followed alone: name the CounterStrikeSharp release it builds against (css@…)',
    )
  return options
}

/**
 * The few names a follow reads out of an env file — never the whole file
 * into the process, because the subprocesses it runs (`pnpm verify`,
 * `cs2:build`, the image script) read the checkout's `.env` themselves and
 * a production database URL must not reach a test.
 */
export function readFollowEnv(text) {
  const env = parseEnv(text ?? '')
  const pick = name => (env[name]?.trim() ? env[name].trim() : null)
  return {
    policy: pick('EZPUG_IRON_GAME_FOLLOW') ?? 'off',
    apiKey: pick('EZPUG_IRON_API_KEY'),
    publicUrl: pick('EZPUG_IRON_PUBLIC_URL'),
    baseUrl: pick('EZPUG_IRON_BASE_URL'),
    githubToken: pick('EZPUG_IRON_GITHUB_TOKEN'),
    githubRepo: pick('EZPUG_IRON_GITHUB_REPO') ?? 'ezpug/ezpug-iron',
  }
}

// ---------------------------------------------------------------------------
// `--auto`: what the watcher saw, under the policy
// ---------------------------------------------------------------------------

/**
 * **What an unattended run does with the watcher's picture.** `game` is
 * `GET /v1/fleet/game`; `releaseOf(spec, version)` answers the release JSON
 * (null for Metamod's drop). Under `off` nothing; under `patch` every
 * upstream whose newest release the policy allows becomes a spec, and every
 * one it refuses becomes a "waiting for a human" line for the issue. A newer
 * Metamod drop alone waits: it moves with CounterStrikeSharp.
 */
export async function autoDecision({ policy, game, releaseOf }) {
  if (policy !== 'patch')
    return {
      action: 'off',
      specs: {},
      waiting: [],
      why: `EZPUG_IRON_GAME_FOLLOW=${policy}: nothing is followed unattended`,
    }
  const specs = {}
  const waiting = []
  for (const upstream of game?.upstream ?? []) {
    const spec = SPEC_OF_REPO[upstream.repo]
    if (!spec || upstream.latest === null || upstream.latest === upstream.pinned) continue
    const release = spec === 'metamod' ? null : await releaseOf(spec, upstream.latest)
    const verdict = patchPolicy(spec, upstream.pinned, upstream.latest, release)
    if (verdict.allowed) specs[spec] = upstream.latest
    else if (verdict.kind !== 'older' && verdict.kind !== 'same')
      waiting.push({ spec, repo: upstream.repo, version: upstream.latest, why: verdict.why })
  }
  // A newer Metamod drop rides along with a CounterStrikeSharp that follows; it waits only alone.
  const waits = specs.css ? waiting.filter(wait => wait.spec !== 'metamod') : waiting
  return {
    action: Object.keys(specs).length > 0 ? 'follow' : 'nothing',
    specs,
    waiting: waits,
    why:
      Object.keys(specs).length > 0
        ? `the policy allows ${Object.entries(specs)
            .map(([spec, version]) => `${spec}@${version}`)
            .join(' ')}`
        : 'nothing the watcher saw is a patch the policy allows',
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const specLine = specs =>
  Object.entries(specs)
    .map(([spec, version]) => `${spec}@${spec === 'metamod' ? metamodBuild(version) : version}`)
    .join(' ')

/** The bumps, resolved against the world: release JSON, download, sha, the Metamod pair. */
async function resolveBumps(specs, current, deps) {
  const bumps = []
  const notes = []
  /** Downloaded, hashed, held to the release page's digest when it carries one. */
  const artifact = async (spec, version, release) => {
    const upstream = UPSTREAMS[spec]
    const asset = upstream.asset(version)
    const downloaded = await deps.download(upstream.url(version))
    const digest = release?.assets?.find(a => a.name === asset)?.digest ?? null
    if (digest !== null && digest !== `sha256:${downloaded.sha256}`)
      throw new Stop(
        'resolve',
        `${asset} downloaded with sha256 ${downloaded.sha256}, and the release page says ${digest}`,
      )
    return downloaded
  }

  if (specs.css) {
    const upstream = UPSTREAMS.css
    const release = await deps.github.release(upstream.repo, upstream.tag(specs.css))
    if (!release)
      throw new Stop('resolve', `${upstream.repo} has no release ${upstream.tag(specs.css)}`)
    const submoduleSha = await deps.github.submoduleSha(
      upstream.repo,
      'libraries/metamod-source',
      upstream.tag(specs.css),
    )
    if (!submoduleSha)
      throw new Stop(
        'resolve',
        `CounterStrikeSharp v${specs.css} names no libraries/metamod-source submodule commit on its tag; Metamod cannot be paired`,
      )
    let metamod = specs.metamod ?? null
    if (metamod === null) {
      // Not named: the drop's newest build, which must be the one the release builds against.
      metamod = await deps.github.metamodLatest()
      if (metamod === null)
        throw new Stop('resolve', "Metamod's drop did not answer; name metamod@NNNN")
      notes.push(
        `metamod@${metamodBuild(metamod)} is the drop's newest build; held to the release's submodule below`,
      )
    }
    // The pair is checked whether or not the Metamod build moves: the binary
    // in the drop names its commit, and it must be the release's submodule.
    const drop = await artifact('metamod', metamod, null)
    const problem = metamodPairProblem({
      cssVersion: specs.css,
      submoduleSha,
      metamodVersion: metamod,
      binary: deps.metamodFacts(drop.path),
    })
    if (problem) throw new Stop('resolve', problem)
    const css = specs.css === current.css ? null : await artifact('css', specs.css, release)
    bumps.push({
      spec: 'css',
      from: current.css,
      to: specs.css,
      release,
      submoduleSha,
      sha256: css?.sha256 ?? null,
      policy: patchPolicy('css', current.css, specs.css, release),
    })
    bumps.push({
      spec: 'metamod',
      from: current.metamod,
      to: metamod,
      release: null,
      submoduleSha,
      sha256: drop.sha256,
      policy: null,
    })
  }
  if (specs.mam) {
    const upstream = UPSTREAMS.mam
    const release = await deps.github.release(upstream.repo, upstream.tag(specs.mam))
    if (!release)
      throw new Stop('resolve', `${upstream.repo} has no release ${upstream.tag(specs.mam)}`)
    const mam = specs.mam === current.mam ? null : await artifact('mam', specs.mam, release)
    bumps.push({
      spec: 'mam',
      from: current.mam,
      to: specs.mam,
      release,
      sha256: mam?.sha256 ?? null,
      policy: patchPolicy('mam', current.mam, specs.mam, release),
    })
  }

  // Nothing to do for a home already there; said per home, as the task asks.
  const moving = []
  for (const bump of bumps) {
    if (bump.from === bump.to)
      notes.push(`${UPSTREAMS[bump.spec].name} is already ${bump.to}: nothing to do`)
    else moving.push(bump)
  }
  return { bumps: moving, notes }
}

/** Poll the orchestrator for the verdict fact of one canary run. */
async function waitForVerdict(deps, run, label) {
  const { clock, orchestrator, say } = deps
  const until = clock.now() + CANARY_WAIT_MS
  for (;;) {
    const game = await orchestrator.game()
    const verdict = game?.recent?.find(
      fact => fact.type === 'game.canary_verdict' && fact.matchId === run.matchId,
    )
    if (verdict) return verdict
    if (clock.now() >= until)
      throw new Stop(
        'canary',
        `the ${label} (match ${run.matchId}, attempt ${run.attempt}) gave no verdict within ${CANARY_WAIT_MS / 60_000} minutes`,
      )
    say(`${label}: playing (match ${run.matchId}, attempt ${run.attempt})…`)
    await clock.sleep(10_000)
  }
}

/** The one line a canary verdict adds to a proof. */
const canaryProof = (label, verdict) =>
  `${label} ${verdict.state} on build ${verdict.build} (attempt ${verdict.attempt})` +
  (verdict.reason ? `: ${verdict.reason}` : '')

/**
 * **The follow, with every hand on the box injected.** `deps`:
 *
 * - `clock`: `{ now(), sleep(ms) }`; `every(ms, fn)` → a stop function; `say(line)`
 * - `tree`: `{ status(), read(path), write(path, text), restore(paths), commit(paths, message) → sha }`
 * - `github`: `{ release(repo, tag), submoduleSha(repo, path, ref), metamodLatest(),
 *   issueFor(titlePrefix) → { number, url } | null, comments(number) → string[],
 *   comment(number, body) → boolean, enabled }`
 * - `download(url)` → `{ sha256, path }`; `metamodFacts(path)` → `{ build, commits }`
 * - `run(label, command, args, { capture })` → `{ code, stdout }`
 * - `lane`: `{ read(), take({ waitMs, what }), refresh(token), release(token) }`
 * - `orchestrator`: `{ game(), canary(provider, hud) }`
 * - `day`: today, `YYYY-MM-DD`, for the rows and the commit
 *
 * Resolves with the report; throws a `Stop` naming the phase.
 */
export async function runFollow(options, deps) {
  const { say } = deps
  const report = {
    action: 'nothing',
    specs: { ...options.specs },
    target: options.target,
    phases: [],
    plan: null,
    bumps: [],
    proof: [],
    template: 'untouched',
    image: 'untouched',
    commit: null,
    issue: null,
    notes: [],
  }
  const phase = name => {
    report.phases.push(name)
    say(`phase ${name}`)
  }

  phase('preflight')
  const dirty = deps.tree.status().trim()
  if (dirty) {
    const count = dirty.split('\n').length
    if (!options.dryRun)
      throw new Stop(
        'preflight',
        `the tree is dirty (${count} path${count === 1 ? '' : 's'}); the verb leaves the tree at the last green commit and cannot on a dirty one — commit or stash first`,
      )
    report.notes.push(
      `the tree is dirty (${count} path${count === 1 ? '' : 's'}); a real run would stop here`,
    )
  }
  const tree = {
    dockerfile: deps.tree.read('docker/cs2/Dockerfile'),
    props: deps.tree.read('plugins/Directory.Build.props'),
    pinsTs: deps.tree.read('apps/orchestrator/src/game/pins.ts'),
    pinsMd: deps.tree.read('docs/pins.md'),
  }
  const current = currentPins(tree)

  phase('resolve')
  const { bumps, notes } = await resolveBumps(options.specs, current, deps)
  report.notes.push(...notes)
  report.bumps = bumps.map(b => ({
    spec: b.spec,
    from: b.from,
    to: b.to,
    sha256: b.sha256 ?? null,
  }))
  const phases = phasesFor(options)
  if (bumps.length === 0) {
    say(`nothing to do: ${notes.join('; ') || 'every home already carries what was named'}`)
    report.plan = renderPlan({
      target: options.target,
      dryRun: options.dryRun,
      bumps: [],
      notes: report.notes,
      homes: [],
      phases,
    })
    return report
  }
  const homes = planHomes(tree, bumps, { day: deps.day })
  report.plan = renderPlan({
    target: options.target,
    dryRun: options.dryRun,
    bumps,
    notes: report.notes,
    homes,
    phases,
  })
  if (options.dryRun) {
    report.action = 'dry-run'
    return report
  }

  // The template must be what this tree says it is *before* anything moves:
  // a red check now is somebody's hand on it (#13), not this bump's work.
  if (options.target !== 'image') {
    phase('template-check')
    const check = await deps.run('dathost:image --check', 'node', [
      'scripts/dathost-image.mjs',
      '--check',
    ])
    if (check.code !== 0)
      throw new Stop(
        'template-check',
        'the template disagrees with this tree before the push — somebody’s hand is on it (like #13); ' +
          'read `pnpm dathost:image --check`, settle it, then run again',
      )
  }

  phase('homes')
  let wrote = false
  let token = options.lockToken
  let owned = false
  let stopRefreshing = null
  let target = options.target
  try {
    for (const home of homes) if (home.before !== home.after) deps.tree.write(home.path, home.after)
    wrote = true
    say(
      `homes written: ${homes
        .filter(h => h.before !== h.after)
        .map(h => h.path)
        .join(', ')}`,
    )

    phase('check-pins')
    if ((await deps.run('check-pins', 'node', ['scripts/check-pins.mjs'])).code !== 0)
      throw new Stop('check-pins', 'docs/pins.md and the homes disagree after the rewrite')

    phase('verify')
    if ((await deps.run('pnpm verify', 'pnpm', ['verify'])).code !== 0)
      throw new Stop('verify', `pnpm verify is red with ${specLine(options.specs)}`)

    phase('lane')
    if (token) {
      const held = deps.lane.read()
      if (held?.token !== token)
        throw new Stop(
          'lane',
          `told the CS2 lane is held for this run, and it is ${held === null ? 'free' : `held by ${describeLaneLock(held)}`}`,
        )
      say(`inside a hold of the CS2 lane (${describeLaneLock(held)})`)
    } else {
      let taken
      try {
        taken = await deps.lane.take({
          waitMs: options.lockWaitMs,
          what: `game:follow ${specLine(options.specs)} (PRD-10 T5)`,
        })
      } catch (error) {
        throw new Stop('lane', error instanceof Error ? error.message : String(error))
      }
      token = taken.entry.token
      owned = true
      say('took the CS2 lane')
      stopRefreshing = deps.every(LANE_REFRESH_MS, () => deps.lane.refresh(token))
    }

    phase('cs2:build')
    if ((await deps.run('cs2:build', 'pnpm', ['cs2:build'])).code !== 0)
      throw new Stop('cs2:build', 'the CS2 image did not build')
    report.image = 'rebuilt'

    if (target !== 'template') {
      phase('cs2:canary')
      const args = ['scripts/cs2-canary.mjs', '--json', '--lock-token', token]
      if (options.rows.length === 0) args.push('--rows', 'none')
      else args.push('--rows', options.rows.join(','))
      if (options.boots !== null) args.push('--boots', String(options.boots))
      const canary = await deps.run('cs2:canary', 'node', args, { capture: true })
      const lastLine = canary.stdout.trim().split('\n').pop() ?? ''
      if (canary.code === 0 || canary.code === 1) {
        let verdict = null
        try {
          verdict = JSON.parse(canary.stdout.trim())
        } catch {
          verdict = null
        }
        const boots = verdict?.boots ?? []
        const ready = boots.map(b => b.readyMs).filter(ms => ms !== null)
        const rows = Object.entries(verdict?.rows ?? {})
          .map(([id, state]) => `${id} ${state}`)
          .join(', ')
        const line =
          `cs2:canary ${verdict?.state ?? (canary.code === 0 ? 'green' : 'red')} on CS2 ${verdict?.build ?? '?'} with image ${verdict?.image ?? '?'}: ` +
          `${boots.length} boots` +
          (ready.length > 0
            ? ` (server_ready ${(Math.min(...ready) / 1000).toFixed(1)}–${(Math.max(...ready) / 1000).toFixed(1)} s)`
            : '') +
          (rows ? `; rows ${rows}` : '') +
          (verdict?.reason ? ` — ${verdict.reason}` : '')
        if (canary.code !== 0) throw new Stop('cs2:canary', line)
        report.proof.push(line)
        report.image = 'proven'
      } else {
        const refusal =
          lastLine.replace(/^cs2:canary refused \([^)]*\): /, '') || 'cs2:canary refused'
        if (!options.auto)
          throw new Stop('cs2:canary', `the dev-node canary judged nothing: ${refusal}`)
        // Unattended, the template is what players sit on tonight (open question 2).
        target = 'template'
        report.target = target
        report.notes.push(
          `the dev node could not prove the image, so the follow is the template's alone: ${refusal}`,
        )
        say(`cs2:canary refused (${refusal}); following onto the template alone`)
      }
    }

    if (owned) {
      stopRefreshing?.()
      stopRefreshing = null
      if (deps.lane.release(token)) say('released the CS2 lane')
      owned = false
    }

    if (target !== 'image') {
      phase('dathost:image')
      if ((await deps.run('dathost:image', 'node', ['scripts/dathost-image.mjs'])).code !== 0)
        throw new Stop(
          'dathost:image',
          'the template refresh failed; read `pnpm dathost:image` and `--check`',
        )
      report.template = 'refreshed'
      if (
        (await deps.run('dathost:image --check', 'node', ['scripts/dathost-image.mjs', '--check']))
          .code !== 0
      )
        throw new Stop('dathost:image', 'the template was refreshed and `--check` is still red')

      phase('canary')
      const plain = await deps.orchestrator.canary('dathost', false)
      const plainVerdict = await waitForVerdict(deps, plain, 'canary')
      report.proof.push(canaryProof('Dathost canary', plainVerdict))
      if (plainVerdict.state !== 'green')
        throw new Stop('canary', canaryProof('the Dathost canary is', plainVerdict))
      if (options.hud) {
        const hud = await deps.orchestrator.canary('dathost', true)
        const hudVerdict = await waitForVerdict(deps, hud, 'hud canary')
        report.proof.push(canaryProof('Dathost hud canary', hudVerdict))
        if (hudVerdict.state !== 'green')
          throw new Stop('canary', canaryProof('the Dathost hud canary is', hudVerdict))
      }
      report.template = 'proven'
    }

    phase('commit')
    const proof =
      report.proof.length > 0
        ? report.proof.join('; ') +
          (target === 'template' && options.target !== 'template'
            ? '; Dathost-proven, unproven for LAN nodes'
            : '')
        : 'no canary played'
    const proven = planHomes(tree, bumps, { day: deps.day, proof })
    for (const home of proven)
      if (home.before !== home.after) deps.tree.write(home.path, home.after)
    const message = commitMessage({
      bumps,
      specs: options.specs,
      proof: report.proof,
      target,
      day: deps.day,
      notes: report.notes,
      trailers: options.trailers,
    })
    report.commit = deps.tree.commit(HOMES, message)
    report.action = 'followed'
    say(`committed ${report.commit}`)
  } catch (error) {
    if (wrote && report.commit === null) {
      deps.tree.restore(HOMES)
      say('the homes are back at the last commit')
    }
    if (report.template === 'refreshed' || report.template === 'proven')
      say(
        'the template was refreshed with the new pins before the stop and now disagrees with the tree: ' +
          '`pnpm cs2:build && pnpm dathost:image` from this tree puts the committed pins back',
      )
    throw error
  } finally {
    stopRefreshing?.()
    if (owned && deps.lane.release(token)) say('released the CS2 lane')
  }

  phase('issue')
  const game = await deps.orchestrator.game().catch(() => null)
  const build = game?.build?.id ?? null
  report.issue = await commentOnBuildIssue(
    deps,
    build,
    followComment({
      bumps,
      specs: options.specs,
      commit: report.commit,
      proof: report.proof,
      target,
      notes: report.notes,
    }),
  )
  return report
}

/** The `chore(pins): …` message: the subject names what moved, the body says why and how it was proven. */
export function commitMessage({ bumps, specs, proof, target, day, notes, trailers }) {
  const subject = `chore(pins): ${bumps.map(b => `${UPSTREAMS[b.spec].name} ${b.to}`).join(', ')}`
  const lines = [
    subject,
    '',
    `Followed by \`pnpm game:follow ${specLine(specs)}\` on ${day} (PRD-10 T5, decision 39), target ${target}.`,
    '',
  ]
  for (const bump of bumps) {
    const upstream = UPSTREAMS[bump.spec]
    const headline = releaseHeadline(bump.release)
    lines.push(
      `- ${upstream.name} ${bump.from} → ${bump.to}` +
        (bump.release?.published_at
          ? ` (${upstream.repo} ${upstream.tag?.(bump.to) ?? bump.to}, ${bump.release.published_at})`
          : '') +
        (headline ? `: "${headline}"` : '') +
        (bump.policy
          ? ` — ${bump.policy.allowed ? 'a patch by the policy' : `not a patch by the policy (${bump.policy.why})`}`
          : '') +
        (bump.spec === 'metamod' && bump.submoduleSha
          ? ` — the build CounterStrikeSharp names (metamod-source ${bump.submoduleSha.slice(0, 8)})`
          : ''),
    )
  }
  if (proof.length > 0) {
    lines.push('', 'Proof:')
    for (const line of proof) lines.push(`- ${line}`)
  }
  for (const note of notes) lines.push(`- ${note}`)
  if (trailers.length > 0) lines.push('', ...trailers)
  return `${lines.join('\n')}\n`
}

/** The issue comment a finished follow leaves on the build's issue. */
export function followComment({ bumps, specs, commit, proof, target, notes }) {
  const lines = [
    `**Followed:** \`pnpm game:follow ${specLine(specs)}\` committed \`${commit}\` (target ${target}).`,
    '',
  ]
  for (const bump of bumps) {
    const upstream = UPSTREAMS[bump.spec]
    lines.push(
      `- ${upstream.name} \`${bump.from}\` → \`${bump.to}\`${bump.release?.html_url ? ` (${bump.release.html_url})` : ''}${bump.policy ? ` — ${bump.policy.why}` : ''}`,
    )
  }
  if (proof.length > 0) {
    lines.push('', '**Proof:**')
    for (const line of proof) lines.push(`- ${line}`)
  }
  for (const note of notes) lines.push(`- ${note}`)
  lines.push(
    '',
    '_Left by `pnpm game:follow` (PRD-10 T5, decision 39). Not pushed: the loop or a human pushes._',
  )
  return lines.join('\n')
}

/** The "waiting for a human" comment, with the marker a second run finds. */
export function waitingComment({ repo, version, why }) {
  return `**Waiting for a human:** ${repo} \`${version}\` — ${why}.\n\n_\`pnpm game:follow --auto\` (PRD-10 T5, decision 39) follows a patch alone; this one is yours._\n<!-- ${WAITING_MARKER} ${repo}@${version} -->`
}

/** Find the build's issue and comment, or say by name why not. */
async function commentOnBuildIssue(deps, build, body) {
  if (!deps.github.enabled) {
    deps.say('no issue comment: no EZPUG_IRON_GITHUB_TOKEN')
    return { commented: false, why: 'no EZPUG_IRON_GITHUB_TOKEN' }
  }
  if (build === null) {
    deps.say('no issue comment: the orchestrator names no build')
    return { commented: false, why: 'the orchestrator names no build' }
  }
  const issue = await deps.github.issueFor(`CS2 build ${build}`)
  if (!issue) {
    deps.say(`no issue comment: no open issue titled "CS2 build ${build}"`)
    return { commented: false, why: `no open issue titled "CS2 build ${build}"` }
  }
  const ok = await deps.github.comment(issue.number, body)
  deps.say(ok ? `commented on ${issue.url}` : `could not comment on ${issue.url}`)
  return { commented: ok, number: issue.number, url: issue.url }
}

/**
 * **`--auto`.** Reads the orchestrator's picture, decides under the policy,
 * comments once per refusal, and follows what is allowed with `runFollow`.
 */
export async function runAuto(options, deps) {
  const decision = await autoDecision({
    policy: deps.env.policy,
    game: await deps.orchestrator.game(),
    releaseOf: (spec, version) =>
      deps.github.release(UPSTREAMS[spec].repo, UPSTREAMS[spec].tag(version)),
  })
  deps.say(`auto: ${decision.why}`)
  const report = {
    action: decision.action,
    specs: decision.specs,
    waiting: decision.waiting,
    why: decision.why,
    follow: null,
  }
  if (decision.action === 'off') return report
  if (decision.waiting.length > 0 && !options.dryRun) {
    const game = await deps.orchestrator.game().catch(() => null)
    const build = game?.build?.id ?? null
    const issue =
      deps.github.enabled && build !== null
        ? await deps.github.issueFor(`CS2 build ${build}`)
        : null
    const existing = issue ? await deps.github.comments(issue.number) : []
    for (const wait of decision.waiting) {
      const marker = `${WAITING_MARKER} ${wait.repo}@${wait.version}`
      if (existing.some(body => body.includes(marker))) {
        deps.say(`waiting for a human: ${wait.repo} ${wait.version} (already on the issue)`)
        continue
      }
      deps.say(`waiting for a human: ${wait.repo} ${wait.version} — ${wait.why}`)
      if (issue) await deps.github.comment(issue.number, waitingComment(wait))
      else
        deps.say(
          `no issue comment: ${deps.github.enabled ? `no open issue titled "CS2 build ${build}"` : 'no EZPUG_IRON_GITHUB_TOKEN'}`,
        )
    }
  } else
    for (const wait of decision.waiting)
      deps.say(`waiting for a human: ${wait.repo} ${wait.version} — ${wait.why}`)
  if (decision.action !== 'follow') return report
  report.follow = await runFollow({ ...options, specs: decision.specs, target: 'both' }, deps)
  return report
}

// ---------------------------------------------------------------------------
// The real box
// ---------------------------------------------------------------------------

function sh(command, args, options = {}) {
  return spawnSync(command, args, { cwd: repo, encoding: 'utf8', ...options })
}

function realDeps(options) {
  const clock = wallClock
  const say = line => process.stderr.write(`\x1b[35m[game:follow]\x1b[0m ${line}\n`)
  const envPath = join(repo, options.envFile)
  const env = readFollowEnv(existsSync(envPath) ? readFileSync(envPath, 'utf8') : '')
  const orchestratorUrl = (
    options.orchestrator ??
    env.publicUrl ??
    env.baseUrl ??
    'http://127.0.0.1:3430'
  ).replace(/\/+$/, '')
  // The box's own gh login stands in for the token (open question 1), never printed.
  const githubToken =
    env.githubToken ??
    (() => {
      const result = sh('gh', ['auth', 'token'])
      return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null
    })()
  const scratch = mkdtempSync(join(tmpdir(), 'game-follow-'))
  process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

  const githubHeaders = {
    accept: 'application/vnd.github+json',
    'user-agent': 'ezpug-iron',
    'x-github-api-version': '2022-11-28',
    ...(githubToken !== null && { authorization: `Bearer ${githubToken}` }),
  }
  const githubGet = async path => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: githubHeaders,
      signal: AbortSignal.timeout(20_000),
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Stop('resolve', `GitHub answered ${response.status} on ${path}`)
    return response.json()
  }

  let orchestratorCall = null
  const orchestrator = (method, path, body) => {
    if (orchestratorCall === null) {
      if (!env.apiKey)
        throw new Stop(
          'canary',
          `no EZPUG_IRON_API_KEY in ${options.envFile}: the orchestrator at ${orchestratorUrl} cannot be asked for its canary`,
        )
      const key = env.apiKey
      orchestratorCall = async (m, p, b) => {
        const response = await fetch(`${orchestratorUrl}${p}`, {
          method: m,
          headers: {
            authorization: `Bearer ${key}`,
            ...(b !== undefined && { 'content-type': 'application/json' }),
          },
          ...(b !== undefined && { body: JSON.stringify(b) }),
          signal: AbortSignal.timeout(30_000),
        })
        const text = await response.text()
        const json = text ? JSON.parse(text) : null
        if (!response.ok)
          throw new Stop(
            'canary',
            `${m} ${p} on ${orchestratorUrl} → ${response.status} ${json?.error?.message ?? text.slice(0, 200)}`,
          )
        return json
      }
    }
    return orchestratorCall(method, path, body)
  }

  return {
    clock,
    say,
    env,
    day: new Date(clock.now()).toISOString().slice(0, 10),
    every: (ms, fn) => {
      // biome-ignore lint/plugin: the lane lock is wall-clock by nature (cs2-lane-lock.mjs)
      const timer = setInterval(fn, ms)
      return () => clearInterval(timer)
    },
    tree: {
      status: () => sh('git', ['status', '--porcelain']).stdout ?? '',
      read: path => readFileSync(join(repo, path), 'utf8'),
      write: (path, text) => writeFileSync(join(repo, path), text),
      restore: paths => sh('git', ['checkout', '--', ...paths]),
      commit: (paths, message) => {
        const added = sh('git', ['add', '--', ...paths])
        if (added.status !== 0) throw new Stop('commit', `git add: ${added.stderr.trim()}`)
        const committed = sh('git', ['commit', '--quiet', '-F', '-'], { input: message })
        if (committed.status !== 0)
          throw new Stop('commit', `git commit: ${committed.stderr.trim()}`)
        return sh('git', ['rev-parse', '--short', 'HEAD']).stdout.trim()
      },
    },
    github: {
      enabled: githubToken !== null,
      release: (repoName, tag) => githubGet(`/repos/${repoName}/releases/tags/${tag}`),
      submoduleSha: async (repoName, path, ref) => {
        const entry = await githubGet(
          `/repos/${repoName}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        )
        return entry?.type === 'submodule' && typeof entry.sha === 'string' ? entry.sha : null
      },
      metamodLatest: async () => {
        const response = await fetch(
          'https://mms.alliedmods.net/mmsdrop/2.0/mmsource-latest-linux',
          {
            signal: AbortSignal.timeout(20_000),
          },
        )
        if (!response.ok) return null
        return (
          (await response.text())
            .trim()
            .match(/^mmsource-(\d+\.\d+\.\d+-git\d+)-linux\.tar\.gz$/)?.[1] ?? null
        )
      },
      issueFor: async prefix => {
        const issues = await githubGet(`/repos/${env.githubRepo}/issues?state=open&per_page=100`)
        const found = (issues ?? []).find(
          issue => !issue.pull_request && String(issue.title).startsWith(prefix),
        )
        return found ? { number: found.number, url: found.html_url } : null
      },
      comments: async number => {
        const comments = await githubGet(
          `/repos/${env.githubRepo}/issues/${number}/comments?per_page=100`,
        )
        return (comments ?? []).map(comment => String(comment.body ?? ''))
      },
      comment: async (number, body) => {
        const response = await fetch(
          `https://api.github.com/repos/${env.githubRepo}/issues/${number}/comments`,
          {
            method: 'POST',
            headers: { ...githubHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ body }),
            signal: AbortSignal.timeout(20_000),
          },
        )
        return response.ok
      },
    },
    download: async url => {
      say(`downloading ${url}`)
      const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) })
      if (!response.ok) throw new Stop('resolve', `${url} answered ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const path = join(scratch, `${sha256.slice(0, 16)}-${url.split('/').pop()}`)
      writeFileSync(path, bytes)
      return { sha256, path }
    },
    metamodFacts: path => {
      const dir = `${path}.d`
      mkdirSync(dir, { recursive: true })
      const extracted = sh('tar', [
        '-xzf',
        path,
        '-C',
        dir,
        'addons/metamod/bin/linuxsteamrt64/metamod.2.cs2.so',
      ])
      if (extracted.status !== 0)
        throw new Stop(
          'resolve',
          `the Metamod drop ${path.split('/').pop()} carries no metamod.2.cs2.so`,
        )
      return metamodBinaryFacts(
        readFileSync(join(dir, 'addons/metamod/bin/linuxsteamrt64/metamod.2.cs2.so')),
      )
    },
    run: (label, command, args, { capture = false } = {}) =>
      new Promise(resolve => {
        say(`$ ${command} ${args.filter(a => !/^[0-9a-f-]{36}$/.test(a)).join(' ')}`)
        const child = spawn(command, args, {
          cwd: repo,
          stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
        })
        let stdout = ''
        if (capture) {
          child.stdout.on('data', chunk => {
            stdout += chunk.toString()
            process.stderr.write(chunk)
          })
        }
        child.on('close', code => resolve({ code, stdout }))
        child.on('error', error => {
          say(`${label}: ${error.message}`)
          resolve({ code: 127, stdout })
        })
      }),
    lane: {
      read: () => readLaneLock(),
      take: ({ waitMs, what }) => takeLaneLock({ what, waitMs, clock }),
      refresh: token => refreshLaneLock(LANE_LOCK_PATH, token, { clock }),
      release: token => releaseLaneLock(LANE_LOCK_PATH, token),
    },
    orchestrator: {
      game: () => orchestrator('GET', '/v1/fleet/game'),
      canary: (provider, hud) => orchestrator('POST', '/v1/fleet/game/canary', { provider, hud }),
    },
  }
}

/** One `--auto` at a time on a box: the pid file under `.cache/`. */
function holdSingleInstance() {
  const path = join(repo, '.cache', 'game-follow.pid')
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8').trim())
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch {
      alive = false
    }
    if (alive && pid !== process.pid)
      throw new Stop('preflight', `another game:follow is running (pid ${pid})`)
  }
  writeFileSync(path, `${process.pid}\n`)
  return () => {
    try {
      if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path)
    } catch {
      // Already gone.
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`game:follow: ${error.message}\n${HELP}\n`)
    return 2
  }
  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  const deps = realDeps(options)
  let release = () => {}
  try {
    if (!options.dryRun) release = holdSingleInstance()
    const report = options.auto ? await runAuto(options, deps) : await runFollow(options, deps)
    const follow = options.auto ? report.follow : report
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else if (follow?.plan) process.stdout.write(follow.plan)
    if (follow?.action === 'followed')
      process.stdout.write(
        `game:follow: committed ${follow.commit}${follow.proof.length ? ` — ${follow.proof.join('; ')}` : ''}\n`,
      )
    else if (!options.json && !follow?.plan)
      process.stdout.write(`game:follow: ${report.why ?? 'nothing to do'}\n`)
    return 0
  } catch (error) {
    if (error instanceof Stop) {
      process.stdout.write(`game:follow stopped (${error.phase}): ${error.message}\n`)
      return error.phase === 'usage' ? 2 : 1
    }
    throw error
  } finally {
    release()
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main()
}
