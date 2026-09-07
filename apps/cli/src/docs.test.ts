import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COMMAND_GROUPS, USAGE } from './cli'
import { BUDGET_USAGE } from './commands/budget'
import { DATHOST_USAGE } from './commands/dathost'
import { GAMEMODES_USAGE } from './commands/gamemodes'
import { KEYS_USAGE } from './commands/keys'
import { MATCHES_USAGE } from './commands/matches'
import { NODES_USAGE } from './commands/nodes'
import { SERVERS_USAGE } from './commands/servers'
import { API_KEY_VAR, BASE_URL_VARS } from './config'

/**
 * The runbook and the command, held against each other (the node agent's
 * `docs.test.ts` posture): every group is in `docs/operations.md`, every verb
 * the PRD named is in the usage an operator reads, and both variables the CLI
 * reads are documented in `.env.example` and in the runbook's table.
 */

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')

const operations = read('docs/operations.md')
const readme = read('README.md')
const envExample = read('.env.example')
const rootManifest = JSON.parse(read('package.json')) as { scripts: Record<string, string> }

/** The surface PRD-02 T33 asked for, verb by verb. */
const VERBS: Readonly<Record<string, readonly string[]>> = {
  keys: ['create', 'list', 'revoke'],
  gamemodes: ['list'],
  matches: ['create', 'get', 'watch', 'cancel', 'command'],
  servers: ['list', 'kill', 'console'],
  nodes: ['enrol-token', 'list', 'drain'],
  budget: [],
  dathost: ['image'],
}

const USAGES: Readonly<Record<string, string>> = {
  keys: KEYS_USAGE,
  gamemodes: GAMEMODES_USAGE,
  matches: MATCHES_USAGE,
  servers: SERVERS_USAGE,
  nodes: NODES_USAGE,
  budget: BUDGET_USAGE,
  dathost: DATHOST_USAGE,
}

describe('ezpug-iron --help is enough for an operator who never read the code', () => {
  it('names every group of the round’s surface, and no group is missing one', () => {
    expect(COMMAND_GROUPS.sort()).toEqual(Object.keys(VERBS).sort())
    for (const group of COMMAND_GROUPS) expect(USAGE).toContain(group)
  })

  it('names every verb in the group’s own usage block', () => {
    for (const [group, verbs] of Object.entries(VERBS))
      for (const verb of verbs)
        expect(USAGES[group], `${group} ${verb}`).toContain(`${group} ${verb}`)
  })

  it('says where the key comes from and where it must never come from', () => {
    expect(USAGE).toContain(API_KEY_VAR)
    expect(USAGE).toContain('never a flag')
    expect(USAGE).toContain(BASE_URL_VARS[0])
    // The four exit codes a shell script branches on.
    for (const code of ['0', '1', '64', '69']) expect(USAGE).toContain(code)
  })
})

describe('the runbook', () => {
  it('has a section for the command, and `pnpm iron` is a script', () => {
    expect(operations).toContain('## `ezpug-iron`, the command')
    expect(readme).toContain('## `ezpug-iron`, the command')
    expect(rootManifest.scripts.iron).toBe('pnpm --filter @ezpug/cli start')
    expect(operations).toContain('pnpm iron --help')
  })

  it('names every group of the command', () => {
    for (const group of COMMAND_GROUPS) expect(operations).toContain(`pnpm iron ${group}`)
  })

  it('documents both variables the CLI reads, in the runbook and in .env.example', () => {
    for (const variable of [API_KEY_VAR, BASE_URL_VARS[0]]) {
      expect(operations, `docs/operations.md lacks ${variable}`).toContain(variable)
      expect(envExample, `.env.example lacks ${variable}`).toContain(variable)
    }
  })

  it('warns about the one thing a pipe gets wrong', () => {
    // `pnpm iron … --json | jq` without --silent reads pnpm's banner first.
    expect(operations).toContain('pnpm --silent iron')
    expect(readme).toContain('pnpm --silent iron')
  })
})
