import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * **The deploy, held against itself** (PRD-02 T35). `./scripts/deploy.sh` is
 * the whole deploy and its smoke is what "deployed" means, but the facts it
 * stands on are written in five files that a change can move apart while
 * nobody is looking: the stack (`compose.prod.yaml`), the front door
 * (`docker/traefik/ezpug-iron.yml`), the values (`.env.production.example`),
 * the runbook (`ralph/DEPLOY.md`) and the reference (`docs/operations.md`).
 * Drift between the hostname and the route, or between the published port and
 * the service Traefik dials, is a 404 that reads like an outage — and the
 * deploy's own preflight catches it only on the box that has a
 * `.env.production`. This is the same check in `pnpm verify`, against the
 * template every box copies.
 *
 * It reads files, not docker: bringing the stack up is `./scripts/deploy.sh`,
 * not a unit test.
 */

const repo = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')

const compose = repo('compose.prod.yaml')
const route = repo('docker/traefik/ezpug-iron.yml')
const template = repo('.env.production.example')
const deploy = repo('scripts/deploy.sh')
const runbook = repo('ralph/DEPLOY.md')
const operations = repo('docs/operations.md')
const pins = repo('docs/pins.md')

/** The value of `NAME=value` in the env template, commented lines ignored. */
const setting = (name: string): string | undefined =>
  template.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]

/** The docker bridge gateway, the only address production publishes on. */
const BRIDGE = '172.17.0.1'

describe('.env.production.example', () => {
  it('is production, and names the origin and the port the box was given', () => {
    expect(setting('NODE_ENV')).toBe('production')
    expect(setting('EZPUG_IRON_PUBLIC_URL')).toBe('https://gs.ezpug.com')
    expect(setting('EZPUG_IRON_HOST_PORT')).toBe('3431')
  })

  it('names a deployment of its own, so it never reaps the dev world’s servers', () => {
    expect(setting('EZPUG_IRON_DEPLOYMENT')).toBeTruthy()
    expect(setting('EZPUG_IRON_DEPLOYMENT')).not.toBe('ezpug')
  })

  it('points the rails at compose services, which is where they actually run', () => {
    expect(setting('EZPUG_IRON_DATABASE_URL')).toMatch(/@postgres:5432\//)
    expect(setting('EZPUG_IRON_REDIS_URL')).toBe('redis://redis:6379')
  })

  it('holds no secret of its own — every one of them is a placeholder', () => {
    for (const name of [
      'EZPUG_IRON_POSTGRES_PASSWORD',
      'EZPUG_IRON_API_KEY',
      'EZPUG_IRON_DATHOST_EMAIL',
      'EZPUG_IRON_DATHOST_PASSWORD',
      'EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID',
      'STEAM_WEB_API_KEY',
    ])
      expect(setting(name), name).toBe('CHANGE_ME')
    expect(setting('EZPUG_IRON_DATABASE_URL')).toContain('CHANGE_ME')
  })

  it('sets no dev door, and preflight refuses a file that does', () => {
    for (const door of [
      'EZPUG_IRON_BOOTSTRAP_API_KEY',
      'EZPUG_IRON_TRACE_FILE',
      'EZPUG_IRON_CHAOS',
      'EZPUG_IRON_STEAM_FAKE_TOKENS',
    ]) {
      expect(setting(door), door).toBeUndefined()
      expect(deploy).toContain(door)
    }
  })
})

describe('compose.prod.yaml', () => {
  it('publishes the orchestrator on the bridge and nothing else anywhere', () => {
    const published = [...compose.matchAll(/^ {6}- '([^']*:\d+)'$/gm)].map(match => match[1])
    expect(published).toEqual([`${BRIDGE}:\${EZPUG_IRON_HOST_PORT:-3431}:3430`])
  })

  it('is its own project, its own containers and its own volumes', () => {
    expect(compose).toMatch(/^name: ezpug-iron$/m)
    for (const container of ['postgres', 'redis', 'orchestrator'])
      expect(compose).toContain(`container_name: ezpug-iron-prod-${container}`)
    expect(compose).toMatch(/^volumes:\n {2}postgres-data:\n {2}redis-data:$/m)
  })

  it('runs no game server: nodes are elsewhere, and this box has none', () => {
    expect(compose).not.toMatch(/\bcs2\b/)
  })

  it('migrates before the orchestrator starts, and can mint the first key', () => {
    expect(compose).toContain("command: ['node', 'dist/migrate.mjs']")
    expect(compose).toContain("entrypoint: ['node', 'dist/mint-key.mjs']")
    expect(compose).toMatch(/migrate:\n {8}condition: service_completed_successfully/)
  })

  it('takes the image from the same variable the platform pins with', () => {
    expect(compose).toContain(`\${EZPUG_IRON_IMAGE:-ezpug-iron/orchestrator:latest}`)
    expect(pins).toContain('EZPUG_IRON_IMAGE')
  })

  it('writes its dumps on the host, where `compose down -v` cannot reach them', () => {
    expect(compose).toContain(`\${EZPUG_IRON_BACKUP_DIR:-/var/backups/ezpug-iron}:/backups`)
  })
})

describe('docker/traefik/ezpug-iron.yml', () => {
  it('routes the origin the env template names, at the port it publishes', () => {
    const host = (setting('EZPUG_IRON_PUBLIC_URL') ?? '').replace('https://', '')
    expect(route).toContain(`Host(\`${host}\`)`)
    expect(route).toContain(`url: "http://${BRIDGE}:${setting('EZPUG_IRON_HOST_PORT')}"`)
  })

  it('names its redirect middleware after this project, not after a neighbour', () => {
    // The file provider merges every file in /opt/traefik/routes into one
    // namespace, so `redirect-to-https` (half the box) or `ezpug-redirect`
    // (the platform's) would be a collision waiting for the next edit.
    expect(route).toContain('ezpug-iron-redirect:')
    expect(route).not.toMatch(/^ {4}(redirect-to-https|ezpug-redirect):$/m)
  })

  it('asks Let’s Encrypt for the certificate, like every neighbouring file', () => {
    expect(route).toContain('certResolver: letsencrypt')
  })
})

describe('scripts/deploy.sh', () => {
  const verbs = [
    'preflight',
    'build',
    'backup',
    'migrate',
    'up',
    'routes',
    'smoke',
    'key',
    'rollback',
  ]

  it('dispatches every verb the runbook and the reference name', () => {
    for (const verb of verbs) {
      expect(deploy, verb).toMatch(new RegExp(`^\\s*${verb}\\)`, 'm'))
      expect(runbook, verb).toContain(verb)
    }
    expect(operations).toContain('./scripts/deploy.sh')
    expect(runbook).toContain('./scripts/deploy.sh')
  })

  it('installs the route file this repo owns, and only that one', () => {
    expect(deploy).toContain('ROUTE_SOURCE=docker/traefik/ezpug-iron.yml')
    expect(deploy).toContain('ROUTE_TARGET=/opt/traefik/routes/ezpug-iron.yml')
  })

  it('smokes /healthz and /v1/capacity, with a key and without one', () => {
    expect(deploy).toContain('/healthz')
    expect(deploy).toContain('/v1/capacity')
    expect(deploy).toMatch(/expect_status 401 "\$base\/v1\/capacity"/)
  })

  it('never puts the operator key in argv', () => {
    // `curl --config -` reads the header off stdin, so the secret is not in
    // `ps`, not in /proc/*/cmdline and not in the shell's history — the rule
    // `ezpug-iron` holds itself to when it refuses a key as a flag.
    expect(deploy).toContain('curl --config -')
    expect(deploy).not.toMatch(/curl[^\n|]*-H "authorization/)
  })

  it('backs up before it migrates', () => {
    const migrate = deploy.slice(deploy.indexOf('cmd_migrate() {'))
    expect(migrate.indexOf('cmd_backup')).toBeLessThan(migrate.indexOf('run --rm migrate'))
  })
})
