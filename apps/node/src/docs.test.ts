import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { USAGE } from './cli'

/**
 * The runbook and the code, held against each other (PRD-02 T11, ahead of
 * T38's rule that every doc naming a variable, a command or a version is
 * checked by a test): every `EZPUG_NODE_*` variable the config reads is in
 * `docs/nodes.md` and `.env.example`, every verb the CLI has is in the
 * runbook, and the image runs the verbs the runbook says it does.
 */

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')

const config = read('apps/node/src/config.ts')
const nodesDoc = read('docs/nodes.md')
const envExample = read('.env.example')
const dockerfile = read('docker/node/Dockerfile')
const orchestratorDockerfile = read('docker/orchestrator/Dockerfile')

const variables = [...new Set(config.match(/EZPUG_NODE_[A-Z_]+/g))].sort()
const verbs = ['enrol', 'run', 'status', 'forget', 'health']

describe('docs/nodes.md', () => {
  it('names every variable the config reads, and so does .env.example', () => {
    expect(variables.length).toBeGreaterThanOrEqual(13)
    for (const variable of variables) {
      expect(nodesDoc, `docs/nodes.md lacks ${variable}`).toContain(variable)
      expect(envExample, `.env.example lacks ${variable}`).toContain(variable)
    }
  })

  it('names every verb the CLI has, and the CLI’s usage does too', () => {
    for (const verb of verbs) {
      expect(nodesDoc).toMatch(new RegExp(`ezpug-node ${verb}|\`${verb}\``))
      expect(USAGE).toContain(`ezpug-node ${verb}`)
    }
  })

  it('describes the image the Dockerfile builds: the state volume, the verbs, the user', () => {
    expect(dockerfile).toContain('EZPUG_NODE_STATE_DIR=/var/lib/ezpug-node')
    expect(dockerfile).toContain('VOLUME /var/lib/ezpug-node')
    expect(nodesDoc).toContain('/var/lib/ezpug-node')
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*"health"\]/)
    expect(dockerfile).toMatch(/ENTRYPOINT \["node", "dist\/main.mjs"\]\nCMD \["run"\]/)
    expect(dockerfile).toContain('USER node')
    expect(nodesDoc).toContain('--group-add "$(stat -c %g /var/run/docker.sock)"')
  })

  it('runs on the same Node the orchestrator image does', () => {
    const from = (text: string) => text.match(/^FROM node:(\S+) AS base$/m)?.[1]
    expect(from(dockerfile)).toBe(from(orchestratorDockerfile))
  })
})
