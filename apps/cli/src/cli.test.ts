/// <reference types="node" />
import { eventually } from '@ezpug/core/testing'
import type { ApiKeyCreated, Budget, Match, NodeEnrolment } from '@ezpug/match-api'
import { afterEach, describe, expect, it } from 'vitest'
import { API_KEY_VAR } from './config'
import { EXIT } from './exit'
import { type CliHarness, createCliHarness, pugRequest, revealedSecret } from './testing'

/**
 * **The CLI, run.** Every verb of every group against the fake orchestrator
 * over a real port, driven through `runCli` exactly as a terminal drives it.
 * What is asserted is what an operator would have seen — the two streams and
 * the exit code — plus the one thing no eye would catch: that the API key the
 * command authenticated with never appears in either stream, in any run, ever
 * (`the secret sweep` at the bottom, which reads everything every test wrote).
 */

let harness: CliHarness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function setup(): Promise<CliHarness> {
  harness = await createCliHarness()
  return harness
}

/** A match, allocated and booted: the state every fleet verb needs to exist. */
async function liveMatch(h: CliHarness): Promise<Match> {
  const created = await h.run('matches create --file - --json', {
    stdin: JSON.stringify(pugRequest()),
  })
  expect(created.code).toBe(EXIT.ok)
  const match = created.json<Match>()
  await h.clock.advance(10_000)
  return match
}

describe('ezpug-iron, the shape of it', () => {
  it('prints the map with no arguments, and says so with 64', async () => {
    const h = await setup()
    const bare = await h.run('')
    expect(bare.code).toBe(EXIT.usage)
    for (const group of ['keys', 'gamemodes', 'matches', 'servers', 'nodes', 'budget', 'dathost'])
      expect(bare.out).toContain(group)
    expect((await h.run('--help')).code).toBe(EXIT.ok)
    expect((await h.run('--version')).out.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('gives a group its own usage on --help, and refuses an unknown one', async () => {
    const h = await setup()
    const matches = await h.run('matches --help')
    expect(matches.code).toBe(EXIT.ok)
    expect(matches.out).toContain('matches watch')
    const unknown = await h.run('wat')
    expect(unknown.code).toBe(EXIT.usage)
    expect(unknown.err).toContain("unknown command 'wat'")
    const verb = await h.run('matches teleport')
    expect(verb.code).toBe(EXIT.usage)
    expect(verb.err).toContain("unknown verb 'matches teleport'")
  })

  it('demands the API key from the environment and never from a flag', async () => {
    const h = await setup()
    const naked = await h.run('gamemodes list', { env: { EZPUG_IRON_CLI_URL: h.listener.url } })
    expect(naked.code).toBe(EXIT.usage)
    expect(naked.err).toContain(API_KEY_VAR)
    // `--api-key` is not a flag: it lands among the positionals and the verb
    // still refuses for want of a key, rather than quietly authenticating.
    const flagged = await h.run(`gamemodes list --api-key ${h.admin.secret}`, {
      env: { EZPUG_IRON_CLI_URL: h.listener.url },
    })
    expect(flagged.code).toBe(EXIT.usage)
  })

  it('turns an orchestrator that is not there into 69, not into a refusal', async () => {
    const h = await setup()
    const away = await h.run('gamemodes list', {
      env: { [API_KEY_VAR]: h.admin.secret, EZPUG_IRON_CLI_URL: 'http://127.0.0.1:1' },
    })
    expect(away.code).toBe(EXIT.unavailable)
  })

  it('turns a refusal into 1 and prints the error code first', async () => {
    const h = await setup()
    const missing = await h.run('matches get 6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b --json')
    expect(missing.code).toBe(EXIT.refused)
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('not_found')
  })
})

describe('gamemodes', () => {
  it('lists the catalog bilingually, and serves the whole manifests as JSON', async () => {
    const h = await setup()
    const table = await h.run('gamemodes list')
    expect(table.code).toBe(EXIT.ok)
    expect(table.out).toContain('title (de)')
    expect(table.out).toContain('title (en)')
    expect(table.out).toContain('pug')

    const one = await h.run('gamemodes list --locale de')
    expect(one.out).toContain('title (de)')
    expect(one.out).not.toContain('title (en)')
    expect((await h.run('gamemodes list --locale fr')).code).toBe(EXIT.usage)

    const json = await h.run('gamemodes list --json')
    const { gamemodes } = json.json<{ gamemodes: { id: string; sdkVersion: string }[] }>()
    expect(gamemodes.length).toBeGreaterThan(0)
    expect(gamemodes[0]?.sdkVersion).toBeTruthy()
    // The machine channel is the only thing on stdout under --json.
    expect(json.out.trimStart().startsWith('{')).toBe(true)
  })
})

describe('keys', () => {
  it('mints, shows the secret once, lists only the prefix, revokes', async () => {
    const h = await setup()
    const created = await h.run(
      'keys create --name platform --scopes matches,fleet --max-concurrent 2 --monthly-cents 5000',
    )
    expect(created.code).toBe(EXIT.ok)
    expect(created.out).toContain('The secret, once:')
    expect(created.out).toContain('€50.00 a month')

    const secret = revealedSecret(created.out)
    expect(secret, 'the mint prints the secret in full, exactly once').toBeTruthy()
    expect(created.out.split(secret!).length - 1).toBe(1)

    const listed = await h.run('keys list')
    expect(listed.out).toContain('platform')
    expect(listed.out).not.toContain(secret!)

    const asJson = await h.run('keys list --json')
    const { keys } = asJson.json<{ keys: { id: string; name: string }[] }>()
    const key = keys.find(candidate => candidate.name === 'platform')!
    expect(JSON.stringify(keys)).not.toContain(secret!)

    const revoked = await h.run(`keys revoke ${key.id}`)
    expect(revoked.code).toBe(EXIT.ok)
    expect(revoked.out).toContain('revoked')
  })

  it('mints with the same defaults the orchestrator’s keys:mint script uses', async () => {
    const h = await setup()
    const created = await h.run('keys create --name defaults --json')
    const { key } = created.json<ApiKeyCreated>()
    expect(key.scopes).toEqual(['matches'])
    expect(key.budget).toEqual({
      maxConcurrentServers: 4,
      maxServerLifetimeMinutes: 240,
      monthlyCents: 0,
    })
  })

  it('refuses a name it was not given and a scope that is not one', async () => {
    const h = await setup()
    expect((await h.run('keys create --scopes admin')).code).toBe(EXIT.usage)
    expect((await h.run('keys create --name x --scopes wizard')).code).toBe(EXIT.usage)
    expect((await h.run('keys revoke')).code).toBe(EXIT.usage)
  })
})

describe('matches', () => {
  it('creates from a document on stdin, reads it back, lists it, cancels it', async () => {
    const h = await setup()
    const created = await h.run('matches create --file - --client-match-id cli-1 --json', {
      stdin: JSON.stringify(pugRequest()),
    })
    expect(created.code).toBe(EXIT.ok)
    const match = created.json<Match>()
    expect(match.clientMatchId).toBe('cli-1')

    const read = await h.run(`matches get ${match.id}`)
    expect(read.out).toContain(match.id)
    expect(read.out).toContain('gamemode      pug on cs2')

    const listed = await h.run('matches list --state allocating')
    expect(listed.out).toContain(match.id)
    expect((await h.run('matches list --state wat')).code).toBe(EXIT.usage)

    const cancelled = await h.run(`matches cancel ${match.id}`)
    expect(cancelled.code).toBe(EXIT.ok)
    expect(cancelled.out).toContain('cancelled')
  })

  it('names the field a bad request document got wrong, before anything goes out', async () => {
    const h = await setup()
    const bad = await h.run('matches create --file -', {
      stdin: JSON.stringify({ ...pugRequest(), ttlMinutes: -5 }),
    })
    expect(bad.code).toBe(EXIT.usage)
    expect(bad.err).toContain('ttlMinutes')
    const notJson = await h.run('matches create --file -', { stdin: 'not json' })
    expect(notJson.code).toBe(EXIT.usage)
    expect(notJson.err).toContain('is not JSON')
    expect((await h.run('matches create')).code).toBe(EXIT.usage)
  })

  it('commands a live match and hands back what the server said', async () => {
    const h = await setup()
    const match = await liveMatch(h)

    const announced = await h.run(`matches command ${match.id} announce --text 'gl hf'`)
    expect(announced.code).toBe(EXIT.ok)
    expect(announced.out).toMatch(/announce (applied|accepted)/)

    const speed = await h.run(`matches command ${match.id} sim.speed --time-scale 4 --json`)
    expect(speed.code).toBe(EXIT.ok)
    expect(speed.json<{ type: string; status: string }>().type).toBe('sim.speed')

    // A rejected command is a 200 on the wire and a 1 in the shell: a script
    // that pauses a match and carries on regardless is a bug.
    const rcon = await h.run(`matches command ${match.id} rcon --command status`)
    expect(rcon.code).toBe(EXIT.refused)
    expect(rcon.out).toContain('rejected')

    expect((await h.run(`matches command ${match.id} teleport`)).code).toBe(EXIT.usage)
    expect((await h.run(`matches command ${match.id} announce`)).code).toBe(EXIT.usage)
  })

  it('watches the stream and says which close code ended it', async () => {
    const h = await setup()
    const match = await liveMatch(h)

    const runs: Promise<{ code: number; out: string; ndjson: () => unknown[] }>[] = []
    runs.push(h.run(`matches watch ${match.id} --json`))
    // The socket must have said hello before the story runs, or the frames it
    // wants are already history — the stream never replays (`stream/frames.ts`).
    await eventually(() => expect(h.everything.join('')).toContain('"type":"hello"'))
    await h.fake.playOut()
    const watched = await runs[0]!
    expect(watched.code).toBe(EXIT.ok)
    const frames = watched.ndjson() as {
      type: string
      envelope?: { payload: { type: string } }
    }[]
    expect(frames[0]?.type).toBe('hello')
    expect(frames.some(frame => frame.type === 'event')).toBe(true)
    // Position ticks are the ephemeral tier and are hidden unless asked for.
    expect(frames.some(frame => frame.type === 'tick')).toBe(false)
    // Under --json the pipe carries stream frames and nothing else: the close
    // is the exit code's to report, so a consumer never has to skip a line
    // that is not a frame.
    expect(frames.at(-1)?.envelope?.payload.type).toBe('match.ended')
    expect(watched.out).not.toContain('stream closed')
  })

  it('says which close code ended the stream, for a human', async () => {
    const h = await setup()
    const match = await liveMatch(h)
    const run = h.run(`matches watch ${match.id}`)
    await eventually(() => expect(h.everything.join('')).toContain('hello '))
    await h.fake.playOut()
    const watched = await run
    expect(watched.code).toBe(EXIT.ok)
    expect(watched.out).toContain('stream closed 4000')
    expect(watched.out).toContain('the match reached a terminal state')
  })

  it('refuses to watch a match that is not there, with 1', async () => {
    const h = await setup()
    const watched = await h.run('matches watch 6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b')
    expect(watched.code).toBe(EXIT.refused)
    expect(watched.out).toContain('4004')
  })
})

describe('servers', () => {
  it('lists the open rows, the whole ledger, the console, and kills one', async () => {
    const h = await setup()
    const match = await liveMatch(h)

    const open = await h.run('servers list --json')
    const { servers } = open.json<{
      servers: { id: string; serverId: string; provider: string }[]
    }>()
    expect(servers).toHaveLength(1)
    const row = servers[0]!
    expect(row.provider).toBe('sim')

    const table = await h.run('servers list')
    expect(table.out).toContain(row.id)
    expect(table.out).toContain('€0.42')

    const ledger = await h.run('servers list --all --provider sim --json')
    expect(ledger.json<{ items: unknown[] }>().items.length).toBeGreaterThan(0)
    expect((await h.run('servers list --all --state wat')).code).toBe(EXIT.usage)

    // Either id addresses a row; the provider's handle is what a fake and a
    // real orchestrator both take (`fleet/service.ts` resolves both).
    const console_ = await h.run(`servers console ${row.serverId}`)
    expect(console_.code).toBe(EXIT.ok)

    const killed = await h.run(`servers kill ${row.serverId} --reason 'burning money'`)
    expect(killed.code).toBe(EXIT.ok)
    expect(killed.out).toContain(row.id)
    expect(
      (await h.run('servers list --json')).json<{ servers: unknown[] }>().servers,
    ).toHaveLength(0)

    expect((await h.run('servers kill')).code).toBe(EXIT.usage)
    void match
  })
})

describe('nodes', () => {
  it('mints an enrolment token once, lists, drains and undrains', async () => {
    const h = await setup()
    const enrolled = await h.run(
      'nodes enrol-token --id saarlan-1 --region eu-central --label venue=saarlan --label rack=2',
    )
    expect(enrolled.code).toBe(EXIT.ok)
    expect(enrolled.out).toContain('The enrolment token, once:')
    expect(enrolled.out).toContain('ezpug-node enrol <token>')
    const token = revealedSecret(enrolled.out)
    expect(token).toBeTruthy()

    const listed = await h.run('nodes list')
    expect(listed.out).toContain('saarlan-1')
    expect(listed.out).toContain('venue=saarlan,rack=2')
    expect(listed.out).not.toContain(token!)

    const drained = await h.run('nodes drain saarlan-1')
    expect(drained.out).toContain('draining')
    const back = await h.run('nodes drain saarlan-1 --undrain')
    expect(back.out).toContain('takes matches again')

    expect((await h.run('nodes enrol-token --id x')).code).toBe(EXIT.usage)
    expect((await h.run('nodes enrol-token --id x --region eu --label nope')).code).toBe(EXIT.usage)
    expect((await h.run('nodes drain')).code).toBe(EXIT.usage)
  })

  it('emits the enrolment whole under --json, because that is the one-time reveal', async () => {
    const h = await setup()
    const enrolled = await h.run('nodes enrol-token --id saarlan-2 --region eu-central --json')
    const enrolment = enrolled.json<NodeEnrolment>()
    expect(enrolment.node.id).toBe('saarlan-2')
    expect(enrolment.token.length).toBeGreaterThan(16)
  })
})

describe('budget', () => {
  it('prints the three ceilings and this month against them', async () => {
    const h = await setup()
    const budget = await h.run('budget')
    expect(budget.code).toBe(EXIT.ok)
    expect(budget.out).toContain('€1000.00')
    expect(budget.out).toContain('servers       0 of')
    const json = (await h.run('budget --json')).json<Budget>()
    expect(json.limits.maxServerLifetimeMinutes).toBeGreaterThan(0)
  })
})

describe('dathost image', () => {
  it('hands every flag but its own to scripts/dathost-image.mjs', async () => {
    const h = await setup()
    h.dathost.stdout = '{"ok":true,"verb":"check"}\n'
    const checked = await h.run('dathost image --check --json --template abc')
    expect(checked.code).toBe(EXIT.ok)
    expect(h.dathost.calls[0]?.argv).toEqual(['--check', '--json', '--template=abc'])
    // The script's own document reaches the pipe; `--json` must not swallow it.
    expect(checked.out).toContain('"ok":true')

    h.dathost.calls.length = 0
    const built = await h.run('dathost image --build --dry-run')
    expect(built.code).toBe(EXIT.ok)
    expect(h.dathost.calls[0]?.argv).toEqual(['--dry-run'])
  })

  it('needs a verb, needs one of the two, and reports the script’s failure as 1', async () => {
    const h = await setup()
    expect((await h.run('dathost')).code).toBe(EXIT.usage)
    expect((await h.run('dathost template')).code).toBe(EXIT.usage)
    expect((await h.run('dathost image')).code).toBe(EXIT.usage)
    expect((await h.run('dathost image --check --build')).code).toBe(EXIT.usage)
    h.dathost.code = 1
    expect((await h.run('dathost image --check')).code).toBe(EXIT.refused)
  })

  it('needs no API key: it talks to Dathost, not to the orchestrator', async () => {
    const h = await setup()
    const run = await h.run('dathost image --check', { env: {} })
    expect(run.code).toBe(EXIT.ok)
  })
})

describe('the secret sweep', () => {
  it('never wrote the API key it authenticated with, on any stream, in any run', async () => {
    const h = await setup()
    // One of everything, on top of what every other test in this file wrote.
    const match = await liveMatch(h)
    await h.run('gamemodes list')
    await h.run('keys list')
    await h.run(`matches get ${match.id}`)
    await h.run('servers list')
    await h.run('nodes list')
    await h.run('budget')
    await h.run('matches list --json')

    const everything = h.everything.join('')
    expect(everything.length).toBeGreaterThan(0)
    expect(everything).not.toContain(h.admin.secret)
  })
})
