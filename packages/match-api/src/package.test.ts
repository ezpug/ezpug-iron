/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The published package's shape (PRD-01 T9). The deep audit — packing the
 * tarball, `publint`, `arethetypeswrong` under `node16` and `bundler` — is
 * `node scripts/release.mjs check`, which needs a build and so runs in
 * `pnpm verify:extended`. These are the rules that hold without one, checked in
 * the fast lane so a bad `exports` entry goes red the moment it is written
 * rather than on the day someone releases.
 */

const packageDir = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  name: string
  version: string
  type: string
  sideEffects: unknown
  license: string
  engines: Record<string, string>
  files: string[]
  exports: Record<string, string>
  publishConfig: { access: string; exports: Record<string, unknown> }
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
  repository: { url: string; directory: string }
}

/** The workspace resolves it; the tarball must not carry it — it imports vitest. */
const WORKSPACE_ONLY_EXPORTS = ['./fixtures/vitest']

describe('the published package', () => {
  it('is an ESM package with no side effects, on Node 22', () => {
    expect(manifest.name).toBe('@ezpug/match-api')
    expect(manifest.type).toBe('module')
    expect(manifest.sideEffects).toBe(false)
    expect(manifest.engines.node).toBe('>=22')
    expect(manifest.license).toBe('MIT')
    // `--provenance` refuses to attest a package that does not say where it is from.
    expect(manifest.repository.url).toContain('github.com/ezpug/ezpug-iron')
    expect(manifest.publishConfig.access).toBe('public')
  })

  it('carries a real version with a CHANGELOG section for it (decision 24)', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    const changelog = readFileSync(join(packageDir, 'CHANGELOG.md'), 'utf8')
    expect(changelog).toContain(`## ${manifest.version}`)
  })

  it('ships only dist, the recorded fixtures and the two documents', () => {
    expect(manifest.files).toEqual(['dist', 'fixtures', 'README.md', 'CHANGELOG.md'])
    expect(existsSync(join(packageDir, 'README.md'))).toBe(true)
    expect(existsSync(join(packageDir, 'CHANGELOG.md'))).toBe(true)
  })

  it('resolves every workspace entry point to a file that exists', () => {
    for (const [entry, target] of Object.entries(manifest.exports)) {
      if (target.includes('*')) continue
      expect(existsSync(join(packageDir, target)), `${entry} → ${target}`).toBe(true)
    }
  })

  it('publishes the same entry points, pointed at dist', () => {
    const published = manifest.publishConfig.exports
    const workspace = Object.keys(manifest.exports).filter(
      entry => !WORKSPACE_ONLY_EXPORTS.includes(entry),
    )
    expect(Object.keys(published).sort()).toEqual(workspace.sort())
    for (const entry of WORKSPACE_ONLY_EXPORTS) {
      expect(manifest.exports, entry).toHaveProperty(entry)
      expect(published, entry).not.toHaveProperty(entry)
    }

    for (const [entry, target] of Object.entries(published)) {
      if (typeof target === 'string') {
        // Only the data passthroughs stay strings: JSON has no conditions to state.
        expect(target, entry).toMatch(/^\.\/(?:fixtures\/|package\.json)/)
        continue
      }
      const conditions = target as { types?: string; import?: string }
      expect(conditions.types, entry).toMatch(/^\.\/dist\/.+\.d\.ts$/)
      expect(conditions.import, entry).toMatch(/^\.\/dist\/.+\.js$/)
      // A `types` condition that is not first is the classic silent break.
      expect(Object.keys(conditions)[0], entry).toBe('types')
    }
  })

  it('asks a consumer for nothing private', () => {
    const installed = { ...manifest.dependencies, ...manifest.peerDependencies }
    for (const name of Object.keys(installed)) {
      expect(name.startsWith('@ezpug/'), name).toBe(false)
    }
    // `@ezpug/core`, `@ezpug/gamemodes` and `@ezpug/sim` are bundled into dist by
    // tsdown, which is exactly why they are devDependencies and nothing else.
    for (const name of ['@ezpug/core', '@ezpug/gamemodes', '@ezpug/sim']) {
      expect(manifest.devDependencies, name).toHaveProperty(name)
    }
  })

  it('leans on zod and hono as peers, so the platform brings its own', () => {
    expect(manifest.peerDependencies.zod).toBeDefined()
    expect(manifest.peerDependencies.hono).toBeDefined()
  })
})

describe('the package README', () => {
  const readme = readFileSync(join(packageDir, 'README.md'), 'utf8')

  it('names every published entry point', () => {
    for (const entry of Object.keys(manifest.publishConfig.exports)) {
      if (entry === './package.json' || entry.includes('*')) continue
      const specifier = entry === '.' ? '@ezpug/match-api' : `@ezpug/match-api${entry.slice(1)}`
      expect(readme, specifier).toContain(specifier)
    }
  })

  it('says how to install it', () => {
    expect(readme).toContain('add @ezpug/match-api')
  })
})
