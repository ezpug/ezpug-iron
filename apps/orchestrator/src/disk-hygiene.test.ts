import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * **This repo stops filling the box** (PRD-03 T15a). The root disk hit 100 %
 * three times in September, from build cache nobody used, dangling images and
 * uncapped container logs. The owner's call was to prevent it rather than
 * alert on it, and a prevention nobody tests is one refactor away from gone.
 *
 * `scripts/docker-hygiene.sh` is run for real here against a `docker` that only
 * writes down what it was asked, so the test holds what is pruned *and* what
 * never is: a volume prune would take the 68 GB CS2 install (a stopped
 * container's volume reads as reclaimable) and other projects' data with it.
 */

const repoPath = (path: string): string =>
  fileURLToPath(new URL(`../../../${path}`, import.meta.url))
const repo = (path: string): string => readFileSync(repoPath(path), 'utf8')

const HYGIENE = repoPath('scripts/docker-hygiene.sh')

/** A PATH whose `docker` records its argv and answers the two reads the lib makes. */
function fakeDocker(options: { failPrune?: boolean } = {}): {
  env: NodeJS.ProcessEnv
  calls: () => string[]
} {
  const dir = mkdtempSync(join(tmpdir(), 'docker-hygiene-'))
  const log = join(dir, 'calls')
  writeFileSync(log, '')
  const docker = join(dir, 'docker')
  writeFileSync(
    docker,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> '${log}'`,
      `[[ $1 == info ]] && { printf '%s' '${dir}'; exit 0; }`,
      `[[ $1 == system ]] && { echo 'TYPE SIZE RECLAIMABLE'; exit 0; }`,
      options.failPrune ? `[[ $2 == prune ]] && exit 1` : '',
      'exit 0',
    ].join('\n'),
  )
  chmodSync(docker, 0o755)
  return {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
  }
}

function run(script: string, env: NodeJS.ProcessEnv) {
  return spawnSync('bash', ['-c', `set -euo pipefail; source '${HYGIENE}'; ${script}`], {
    encoding: 'utf8',
    env,
  })
}

describe('scripts/docker-hygiene.sh', () => {
  it('refuses a build below the floor, and prints df and docker’s own account while it does', () => {
    const docker = fakeDocker()
    const refused = run("require_build_space 'build a thing'", {
      ...docker.env,
      EZPUG_BUILD_MIN_FREE_GB: '999999999',
    })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('refusing to build a thing')
    expect(refused.stderr).toContain('EZPUG_BUILD_MIN_FREE_GB')
    expect(refused.stderr).toMatch(/^Filesystem/m)
    expect(refused.stderr).toContain('RECLAIMABLE')

    const allowed = run("require_build_space 'build a thing'", {
      ...docker.env,
      EZPUG_BUILD_MIN_FREE_GB: '0',
    })
    expect(allowed.status, allowed.stderr).toBe(0)
  })

  it('refuses a floor that is not a number rather than comparing against nothing', () => {
    const docker = fakeDocker()
    const result = run("require_build_space 'build'", {
      ...docker.env,
      EZPUG_BUILD_MIN_FREE_GB: 'lots',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('whole number')
  })

  it('removes dangling images and old build cache, and never a volume', () => {
    const docker = fakeDocker()
    const result = run('tidy_docker', {
      ...docker.env,
      EZPUG_BUILD_CACHE_MAX_AGE: '72h',
      EZPUG_BUILD_CACHE_MAX_SIZE: '5GB',
    })
    expect(result.status, result.stderr).toBe(0)
    const prunes = docker.calls().filter(call => call.includes('prune'))
    // `image prune` without `-a`: a tagged `:previous` and anything a container
    // uses stay; only what nothing names goes.
    expect(prunes).toEqual([
      'image prune -f',
      'builder prune -f --filter until=72h',
      'builder prune -f --max-used-space 5GB',
    ])
    expect(result.stdout).toContain('build cache older than 72h or past 5GB')
  })

  it('defaults the cache bounds to a week and 20 GB', () => {
    const docker = fakeDocker()
    run('tidy_docker', docker.env)
    expect(docker.calls()).toContain('builder prune -f --filter until=168h')
    expect(docker.calls()).toContain('builder prune -f --max-used-space 20GB')
  })

  it('warns and carries on when a prune fails: the build or the deploy already happened', () => {
    const docker = fakeDocker({ failPrune: true })
    const result = run('tidy_docker', docker.env)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('warning: removing dangling images failed')
    expect(result.stderr).toContain('warning: pruning the build cache failed')
    expect(result.stderr).toContain('warning: capping the build cache failed')
  })

  it('never prunes a volume, never touches the daemon’s config, in any script that builds', () => {
    for (const path of ['scripts/docker-hygiene.sh', 'scripts/deploy.sh', 'scripts/cs2-env.sh']) {
      const code = repo(path)
        .split('\n')
        .filter(line => !/^\s*#/.test(line))
        .join('\n')
      expect(code, path).not.toMatch(/volume\s+prune|system\s+prune|--volumes|prune\s+(-f\s+)?-a\b/)
      expect(code, path).not.toMatch(/daemon\.json|systemctl|service\s+docker/)
    }
  })
})

describe('the scripts that build', () => {
  const deploy = repo('scripts/deploy.sh')
  const cs2 = repo('scripts/cs2-env.sh')

  it('both source the lib, refuse below the floor before building and tidy after', () => {
    for (const [path, script] of [
      ['scripts/deploy.sh', deploy],
      ['scripts/cs2-env.sh', cs2],
    ] as const) {
      expect(script, path).toContain('source scripts/docker-hygiene.sh')
      expect(script, path).toContain('require_build_space')
    }
    const build = cs2.slice(cs2.indexOf('cmd_build() {'), cs2.indexOf('cmd_install() {'))
    const compose = build.indexOf('[@]}" build')
    expect(compose).toBeGreaterThan(0)
    expect(build.indexOf('require_build_space')).toBeLessThan(compose)
    expect(build.indexOf('tidy_docker')).toBeGreaterThan(compose)
  })

  it('deploys tidy only once the smoke is green, and after a `build` verb that worked', () => {
    const all = deploy.slice(deploy.indexOf('cmd_all() {'))
    expect(all.indexOf('cmd_tidy')).toBeGreaterThan(all.indexOf('cmd_smoke'))
    expect(deploy).toContain('build) cmd_preflight && cmd_build && cmd_tidy ;;')
    expect(deploy).toMatch(/^\s*tidy\) cmd_tidy ;;$/m)
    const preflight = deploy.slice(
      deploy.indexOf('cmd_preflight() {'),
      deploy.indexOf('git_revision() {'),
    )
    expect(preflight).toContain('require_build_space')
  })
})

describe('every compose service caps its json log', () => {
  for (const path of ['compose.yaml', 'compose.cs2.yaml', 'compose.prod.yaml']) {
    it(path, () => {
      const compose = repo(path)
      expect(compose).toMatch(
        /^x-logging: &logging\n {2}driver: json-file\n {2}options:\n {4}max-size: 10m\n {4}max-file: '3'$/m,
      )
      const services = compose.slice(
        compose.indexOf('\nservices:\n'),
        compose.indexOf('\nvolumes:\n'),
      )
      const blocks = services.split(/^ {2}(?=[a-z0-9-]+:$)/m).slice(1)
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks)
        expect(block, block.split(':')[0]).toContain('    logging: *logging\n')
    })
  }
})
