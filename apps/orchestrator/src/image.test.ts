import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readOrchestratorConfig } from './config'

/**
 * **The dev contract, held against the file that implements it** (PRD-02
 * T4). Another project's compose pulls this image and relies on a handful of
 * facts: the port, the user, where the migrations are, that it migrates
 * before it listens. They live in the Dockerfile as `ENV` lines and in
 * `docs/operations.md` as a table, and this is what keeps the two from
 * drifting apart while nobody is looking. It reads files, not docker: the
 * build itself is `pnpm image:build`, not a unit test.
 */

const repo = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')

const dockerfile = repo('docker/orchestrator/Dockerfile')
const operations = repo('docs/operations.md')

describe('the orchestrator image', () => {
  it('binds every interface, exposes the documented port and never runs as root', () => {
    expect(dockerfile).toMatch(/EZPUG_IRON_HOST=0\.0\.0\.0/)
    expect(dockerfile).toMatch(/EZPUG_IRON_PORT=3430/)
    expect(dockerfile).toMatch(/^EXPOSE 3430$/m)
    expect(dockerfile).toMatch(/^USER node$/m)
    expect(dockerfile).toMatch(/^HEALTHCHECK /m)
    expect(dockerfile).toMatch(/CMD \["node", "dist\/main\.mjs"\]/)
  })

  it('carries the migrations it applies before the port opens', () => {
    expect(dockerfile).toMatch(/EZPUG_IRON_MIGRATE_ON_BOOT=true/)
    expect(dockerfile).toMatch(/EZPUG_IRON_MIGRATIONS_DIR=\/app\/drizzle/)
    expect(dockerfile).toMatch(/COPY --from=build .*\/apps\/orchestrator\/drizzle \/app\/drizzle/)
  })

  it('defaults to production, which is what makes the bootstrap key a dev-only door', () => {
    expect(dockerfile).toMatch(/NODE_ENV=production/)
    expect(() =>
      readOrchestratorConfig({
        EZPUG_IRON_DATABASE_URL: 'postgres://u:p@127.0.0.1:5443/db',
        EZPUG_IRON_REDIS_URL: 'redis://127.0.0.1:6383',
        NODE_ENV: 'production',
        EZPUG_IRON_BOOTSTRAP_API_KEY: `ezik_${'a'.repeat(43)}`,
      }),
    ).toThrow(/NODE_ENV=production/)
    // …and the doc says so where a consumer will read it.
    expect(operations).toMatch(/NODE_ENV.*`development`/)
  })

  it('is documented by the name a consumer pulls', () => {
    expect(operations).toContain('ghcr.io/ezpug/ezpug-iron/orchestrator')
    for (const variable of [
      'EZPUG_IRON_PUBLIC_URL',
      'EZPUG_IRON_PROVIDERS',
      'EZPUG_IRON_BOOTSTRAP_API_KEY',
      'EZPUG_IRON_MIGRATE_ON_BOOT',
      'EZPUG_IRON_MIGRATIONS_DIR',
    ])
      expect(operations).toContain(variable)
  })
})
