#!/usr/bin/env node
/**
 * The release tool for `@ezpug/match-api` (PRD-01 T9, decision 24).
 *
 * A change to a schema is a semver release with a changelog line, never a silent
 * edit — so releasing is a script, not a habit:
 *
 *   node scripts/release.mjs version 0.1.0   # bump + roll the CHANGELOG, print the tag
 *   node scripts/release.mjs check           # build, pack, and audit the tarball
 *   node scripts/release.mjs publish         # verify:extended, check, publish, smoke
 *   node scripts/release.mjs smoke           # what the registry actually serves
 *
 * `check` is the gate: it packs the package exactly the way a publish would and
 * refuses anything a consumer would trip over — an unresolved `catalog:` or
 * `workspace:` range, a file outside the whitelist, an entry point whose target
 * is not in the tarball, a `dist` that still imports a private workspace package,
 * a CHANGELOG without this version's section — then hands the tarball to
 * `publint` and `arethetypeswrong` (`node16` and `bundler` both, `esm-only`
 * because the package ships no CJS on purpose).
 *
 * Packing goes through **pnpm**, never `npm pack`: only pnpm resolves the
 * workspace's `catalog:` versions and applies `publishConfig.exports` (the
 * published entry points point at `dist/`, the workspace's at `src/`). Publishing
 * that tarball then goes through **npm**, because `--provenance` is npm's.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The one package this repo publishes. A second one gets a second entry here. */
const PACKAGE = {
  name: '@ezpug/match-api',
  dir: join(REPO, 'packages', 'match-api'),
  /** `git tag` name — the tag `.github/workflows/release.yml` fires on. */
  tagPrefix: 'match-api@',
  /** Nothing outside these may reach the registry (mirrors `files`). */
  allowedRoots: ['dist', 'fixtures', 'README.md', 'CHANGELOG.md', 'package.json'],
  /** Entry points the workspace has but the tarball must not: they import vitest. */
  unpublishedExports: ['./fixtures/vitest'],
}

const NPM_REGISTRY = 'https://registry.npmjs.org'

// ---------------------------------------------------------------------------
// shell helpers
// ---------------------------------------------------------------------------

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? REPO,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ...options.env },
  })
}

function capture(command, args, options = {}) {
  return run(command, args, { ...options, capture: true }).trim()
}

function step(message) {
  process.stdout.write(`\n→ ${message}\n`)
}

class ReleaseError extends Error {}

function fail(message) {
  throw new ReleaseError(message)
}

// ---------------------------------------------------------------------------
// the package's own files
// ---------------------------------------------------------------------------

const manifestPath = join(PACKAGE.dir, 'package.json')
const changelogPath = join(PACKAGE.dir, 'CHANGELOG.md')

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

// ---------------------------------------------------------------------------
// version: bump the manifest, roll the CHANGELOG
// ---------------------------------------------------------------------------

function commandVersion(argv) {
  const version = argv[0]
  if (!version) fail('usage: release.mjs version <semver>')
  if (!SEMVER.test(version)) fail(`not a version: ${version}`)

  const manifest = readManifest()
  if (manifest.version === version) fail(`${PACKAGE.name} is already ${version}`)

  // The manifest is written by hand everywhere else; touch only the one line, so
  // the diff of a release is a version and a changelog heading.
  const source = readFileSync(manifestPath, 'utf8')
  const bumped = source.replace(
    `"version": ${JSON.stringify(manifest.version)}`,
    `"version": ${JSON.stringify(version)}`,
  )
  if (bumped === source) fail('could not find the version line in package.json')
  writeFileSync(manifestPath, bumped)

  // A release happens once, at a real moment, by a human, and the CHANGELOG records the
  // day it happened — the one line in this repo that must *not* reproduce.
  // biome-ignore lint/plugin: the CHANGELOG's date is the wall clock, deliberately.
  const today = new Date().toISOString().slice(0, 10)
  const changelog = readFileSync(changelogPath, 'utf8')
  if (!changelog.includes('\n## Unreleased\n')) {
    fail('CHANGELOG.md has no "## Unreleased" section to release')
  }
  writeFileSync(
    changelogPath,
    changelog.replace(
      '\n## Unreleased\n',
      `\n## Unreleased\n\n_Nothing yet._\n\n## ${version} — ${today}\n`,
    ),
  )

  step(`${PACKAGE.name} ${manifest.version} → ${version}`)
  process.stdout.write(
    [
      `  ${manifestPath}`,
      `  ${changelogPath}`,
      '',
      'Commit both, then tag and let CI publish:',
      `  git tag ${PACKAGE.tagPrefix}${version}`,
      `  git push origin ${PACKAGE.tagPrefix}${version}`,
      '',
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// check: build, pack, audit the tarball
// ---------------------------------------------------------------------------

/** Packs the package the way a publish would and returns `{tarball, dir, manifest, files}`. */
function packPackage(destination, { build = true } = {}) {
  if (build) {
    step(`building ${PACKAGE.name}`)
    run('pnpm', ['--filter', PACKAGE.name, 'build'])
  }

  step('packing (pnpm, so `catalog:` and `publishConfig` are resolved)')
  const output = capture('pnpm', ['pack', '--pack-destination', destination], { cwd: PACKAGE.dir })
  const tarball = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.endsWith('.tgz'))
    .pop()
  if (!tarball || !existsSync(tarball)) fail(`pnpm pack produced no tarball:\n${output}`)

  const dir = join(destination, 'unpacked')
  mkdirSync(dir, { recursive: true })
  run('tar', ['-xzf', tarball, '-C', dir])
  const files = capture('tar', ['-tzf', tarball])
    .split('\n')
    .map(line => line.replace(/^package\//, ''))
    .filter(line => line.length > 0 && !line.endsWith('/'))

  return {
    tarball,
    dir: join(dir, 'package'),
    manifest: JSON.parse(readFileSync(join(dir, 'package', 'package.json'), 'utf8')),
    files,
  }
}

/** Every hygiene rule the tarball has to satisfy, as named checks (PRD-01 T9). */
function auditTarball(packed, expectedVersion) {
  const { manifest, files, dir } = packed
  const problems = []
  const check = (ok, message) => {
    if (!ok) problems.push(message)
  }

  check(manifest.name === PACKAGE.name, `name is ${manifest.name}, not ${PACKAGE.name}`)
  check(SEMVER.test(manifest.version), `version ${manifest.version} is not a plain semver`)
  if (expectedVersion) {
    check(
      manifest.version === expectedVersion,
      `tarball is ${manifest.version}, expected ${expectedVersion}`,
    )
  }
  check(manifest.type === 'module', '"type" is not "module"')
  check(manifest.sideEffects === false, '"sideEffects" is not false')
  check(typeof manifest.license === 'string', 'no "license"')
  check(typeof manifest.repository?.url === 'string', 'no "repository.url" (provenance needs it)')
  check(
    typeof manifest.engines?.node === 'string' && manifest.engines.node.includes('22'),
    `"engines.node" is ${JSON.stringify(manifest.engines?.node)}, expected a >= 22 range`,
  )

  // A version range npm cannot install. pnpm rewrites these when it packs — if one
  // survived, the tarball is broken for every consumer.
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      check(
        !/^(?:catalog:|workspace:|link:|file:)/.test(range),
        `${field}.${name} is "${range}" — an unresolved workspace protocol`,
      )
    }
  }
  // The private packages are bundled into `dist`, so a consumer must never be told
  // about them at all.
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      check(
        !name.startsWith('@ezpug/'),
        `${field}.${name} — a private package escaped into the tarball`,
      )
    }
  }

  for (const file of files) {
    const root = file.split('/')[0]
    check(PACKAGE.allowedRoots.includes(root), `${file} is outside the "files" whitelist`)
  }
  for (const required of ['README.md', 'CHANGELOG.md', 'package.json']) {
    check(files.includes(required), `${required} is missing from the tarball`)
  }

  // Every published entry point resolves to a file that is actually in the tarball.
  const exports = manifest.exports ?? {}
  check(Object.keys(exports).length > 0, 'no "exports"')
  for (const [entry, target] of Object.entries(exports)) {
    check(
      !PACKAGE.unpublishedExports.includes(entry),
      `"${entry}" must not be published (it imports a test runner)`,
    )
    const targets = typeof target === 'string' ? [target] : Object.values(target)
    for (const path of targets) {
      if (path.includes('*')) continue
      check(
        existsSync(join(dir, path)),
        `"${entry}" points at ${path}, which is not in the tarball`,
      )
    }
    if (typeof target === 'object' && target !== null) {
      check(typeof target.types === 'string', `"${entry}" has no "types" condition`)
      check(typeof target.import === 'string', `"${entry}" has no "import" condition`)
    }
  }

  // `publishConfig` swapped `src` for `dist` — nothing published may reach back.
  for (const file of files) {
    check(!file.startsWith('src/'), `${file} — source escaped into the tarball`)
  }
  // The bundler was told to inline `@ezpug/core`, `@ezpug/gamemodes` and `@ezpug/sim`;
  // a surviving import would be an unresolvable specifier on a consumer's disk.
  for (const file of files) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue
    const source = readFileSync(join(dir, file), 'utf8')
    const leak = source.match(/from ['"](@ezpug\/[^'"]+)['"]/)
    check(leak === null, `${file} imports ${leak?.[1]} — it should have been bundled`)
  }

  const changelog = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
  check(
    new RegExp(`^## ${manifest.version.replace(/\./g, '\\.')}\\b`, 'm').test(changelog),
    `CHANGELOG.md has no "## ${manifest.version}" section (decision 24: a release is a line)`,
  )

  if (problems.length > 0) {
    fail(`the tarball is not publishable:\n${problems.map(p => `  ✗ ${p}`).join('\n')}`)
  }
  process.stdout.write(
    `  ✓ ${files.length} files, every entry point resolves, no leaked specifier\n`,
  )
}

function commandCheck(argv) {
  const expected = readManifest().version
  const scratch = mkdtempSync(join(tmpdir(), 'ezpug-release-'))
  try {
    const packed = packPackage(scratch, { build: !argv.includes('--no-build') })

    step('auditing the tarball')
    auditTarball(packed, expected)

    step('publint')
    run('pnpm', ['exec', 'publint', packed.tarball, '--strict'])

    // `esm-only`: the package ships no CJS and no `main` on purpose, so `node10`
    // failing is the design, not a defect. `node16` and `bundler` must be green.
    step('arethetypeswrong (node16 + bundler)')
    run('pnpm', ['exec', 'attw', '--pack', packed.tarball, '--profile', 'esm-only'])

    step(`${PACKAGE.name}@${expected} is publishable`)
    return { ...packed, version: expected, scratch }
  } finally {
    if (!argv.includes('--keep')) rmSync(scratch, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

/** The message T9 owes the round if nobody can talk to the registry. */
function authInstructions(version) {
  return [
    `Nothing here can publish ${PACKAGE.name}@${version}: npm is not logged in on this box`,
    'and no NPM_TOKEN reached the environment. Either:',
    '',
    '  # locally, as the owner of the @ezpug scope',
    '  npm login',
    `  node scripts/release.mjs publish`,
    '',
    '  # or from CI: add an automation token as the NPM_TOKEN repository secret, then',
    `  git tag ${PACKAGE.tagPrefix}${version} && git push origin ${PACKAGE.tagPrefix}${version}`,
    '',
    `Smoke afterwards: npm view ${PACKAGE.name} version`,
  ].join('\n')
}

function canPublish() {
  if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN) return true
  try {
    capture('npm', ['whoami', '--registry', NPM_REGISTRY])
    return true
  } catch {
    return false
  }
}

function commandPublish(argv) {
  const dryRun = argv.includes('--dry-run')

  if (!argv.includes('--allow-dirty')) {
    const dirty = capture('git', ['status', '--porcelain'])
    if (dirty) fail(`the working tree is dirty — commit first:\n${dirty}`)
  }

  const version = readManifest().version
  const tag = `${PACKAGE.tagPrefix}${version}`

  // A tag push is what triggers CI, so the tag has to name the version being packed —
  // otherwise `match-api@0.1.0` could quietly publish whatever `main` last bumped to.
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== tag) {
    fail(
      `the tag is ${process.env.GITHUB_REF_NAME}, but package.json is ${version} (expected ${tag})`,
    )
  }

  // "No publish of a 0.x the conformance suite has not passed" (PRD-01 working rules).
  if (!argv.includes('--no-verify')) {
    step('pnpm verify:extended (the conformance suite is the gate)')
    run('pnpm', ['verify:extended'])
  }

  // `--keep` because the tarball has to outlive the audit — it is what gets published.
  const packed = commandCheck(['--keep'])
  try {
    if (!dryRun && !canPublish()) fail(authInstructions(version))

    step(
      dryRun
        ? `dry run: would publish ${PACKAGE.name}@${version}`
        : `publishing ${PACKAGE.name}@${version}`,
    )
    const args = ['publish', packed.tarball, '--access', 'public']
    // Provenance is an attestation signed by the CI run that built the tarball; npm
    // refuses the flag anywhere else.
    if (process.env.GITHUB_ACTIONS === 'true') args.push('--provenance')
    if (dryRun) args.push('--dry-run')
    run('npm', args)
  } finally {
    rmSync(packed.scratch, { recursive: true, force: true })
  }

  if (dryRun) return
  step('smoke')
  commandSmoke([version])
  process.stdout.write(`\nTag it if the tag is not what got you here:\n  git tag ${tag}\n\n`)
}

// ---------------------------------------------------------------------------
// smoke: what the registry serves
// ---------------------------------------------------------------------------

function commandSmoke(argv) {
  const expected = argv[0] ?? readManifest().version
  let published
  try {
    published = capture('npm', ['view', PACKAGE.name, 'version', '--registry', NPM_REGISTRY])
  } catch (error) {
    fail(`npm view ${PACKAGE.name} version failed — nothing is published yet?\n${error.message}`)
  }
  if (published !== expected) {
    fail(`the registry serves ${PACKAGE.name}@${published}, expected ${expected}`)
  }
  process.stdout.write(`  ✓ npm view ${PACKAGE.name} version → ${published}\n`)
}

// ---------------------------------------------------------------------------

const COMMANDS = {
  version: commandVersion,
  check: commandCheck,
  publish: commandPublish,
  smoke: commandSmoke,
}

const [verb, ...rest] = process.argv.slice(2)
const command = COMMANDS[verb]
if (!command) {
  process.stderr.write(`usage: release.mjs <${Object.keys(COMMANDS).join(' | ')}> [args]\n`)
  process.exit(2)
}
try {
  command(rest)
} catch (error) {
  if (error instanceof ReleaseError) {
    process.stderr.write(`\nrelease: ${error.message}\n\n`)
    process.exit(1)
  }
  throw error
}
