import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeServer, type FakeServer } from '@ezpug/protocol/fake-server'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from '../../http/testing'
import { attachServerLink, type ServerLink } from '../../link/server-link'
import { attachUpgradeRouter } from '../../stream/upgrade'
import { createFakeDathost, type FakeDathost } from './fake'
import { createDathostProvider } from './provider'

/**
 * **The live smoke, rehearsed offline** (PRD-02 T19).
 *
 * `scripts/dathost-smoke.mjs` is the one command in this repo that spends
 * money: it rents a server at dathost.net, waits for its plugin to dial the
 * link, talks to it, and gives it back. That is a script nobody gets to
 * debug on a Saturday with the meter running — so it is written to be
 * importable (`main({ fetch, env, sleep, … })`) and this file runs all nine
 * of its steps against a world made entirely of this repo's own fakes:
 *
 * - the **fake Dathost** (T15) behind a **real Dathost provider** (T16),
 *   registered in a **real orchestrator** (T2/T3) over memory;
 * - a template built by the **real image script** (T18) out of a six-file
 *   artifact tree, so the smoke's `--check` step has something true to check;
 * - the **real link** on a real port (T6), with the **fake server**
 *   (`@ezpug/protocol/fake-server`) dialling in the moment the provider's
 *   `configure` has planted `ezpug.json` on the clone — which is exactly what
 *   the core plugin does with the same file on real iron.
 *
 * The script's `sleep` is the seam that makes it deterministic: it is handed
 * a function that dials the fake server in and then advances the app's fake
 * clock, so a poll loop written for a datacentre plays out here in
 * milliseconds with no `vi.waitFor` anywhere.
 *
 * What this file cannot prove is the only thing the live lane exists for:
 * that dathost.net behaves like `fake.ts` says it does. It proves everything
 * else — that the steps are in the right order, that the release runs
 * whatever happened above, that a stray clone is deleted and reported, and
 * that no secret reaches the summary.
 */

const EMAIL = 'ops@ezpug.invalid'
const PASSWORD = 'not-a-real-dathost-password'
const VENDOR_URL = 'http://dathost.test/api/0.1'
const ORCHESTRATOR_URL = 'http://orchestrator.test'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** What the core plugin's `ezpug_status` prints, near enough for the check the script makes. */
const STATUS_OUTPUT = [
  'EZPug.Core 0.1.0 / EZPug.Sdk 0.1.0 / CounterStrikeSharp 1.0.373',
  'link: connected to orchestrator.test as dathost/server-1',
  'buffer: lastSeq 1, 0 unacked',
  'state: assigned, map de_dust2, 0 player(s)',
].join('\n')

interface SmokeScript {
  main(options: {
    argv?: string[]
    env?: Record<string, string | undefined>
    fetch?: typeof fetch
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    stdout?: (text: string) => void
    stderr?: (text: string) => void
    mintKey?: (name: string) => string
  }): Promise<number>
  SMOKE_TAG: string
}

interface ImageScript {
  main(options: Record<string, unknown>): Promise<number>
}

const smoke = (await import(join(repo, 'scripts/dathost-smoke.mjs'))) as unknown as SmokeScript
const image = (await import(join(repo, 'scripts/dathost-image.mjs'))) as unknown as ImageScript

/** The CounterStrikeSharp release the image pins — the tree has to say the same. */
const CSS_PIN = /^ARG COUNTER_STRIKE_SHARP_VERSION=(\S+)$/m.exec(
  readFileSync(join(repo, 'docker/cs2/Dockerfile'), 'utf8'),
)?.[1] as string

/** The artifact tree, in the shape the CS2 image stages it (T18's own test writes the same). */
function writeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ezpug-smoke-'))
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  write(
    'addons/counterstrikesharp/plugins/EZPug.Core/build.json',
    `${JSON.stringify({ sdk: '0.1.0', core: '0.1.0', counterStrikeSharp: CSS_PIN, commit: 'f7f1232' })}\n`,
  )
  write('addons/counterstrikesharp/plugins/EZPug.Core/EZPug.Core.dll', 'the core plugin')
  write('addons/metamod/metaplugins.ini', ';\n')
  write('cfg/MatchZy/live.cfg', 'mp_maxrounds 24\n')
  write('gamemodes/pug/cfg/ezpug/pug.cfg', 'mp_overtime_enable 1\n')
  return dir
}

interface Rig {
  app: TestApp
  fake: FakeDathost
  /** Make the vendor misbehave for the provider (not for the script itself). */
  vendor: { intercept: ((method: string, url: string) => Response | null) | null }
  templateId: string
  tree: string
  /** The script's environment: the account, and the fake vendor instead of dathost.net. */
  env: Record<string, string>
  /** One `fetch` for both worlds, routed by origin — what the script is handed. */
  fetch: typeof fetch
  /** The script's `sleep`: dial the plugin in when there is one to dial, then move time. */
  sleep: (ms: number) => Promise<void>
  bootstrapKey: string
  /** The fake server once it has dialled in, for a test that wants to look at it. */
  plugin: () => FakeServer | undefined
  /** Run the script; returns its exit code and its `--json` summary. */
  run: (argv?: string[]) => Promise<{ code: number; summary: SmokeSummary; stderr: string }>
  close: () => Promise<void>
}

interface SmokeSummary {
  ok: boolean
  steps: string[]
  account: { credits: number | null } | null
  imageCheck: { ran: boolean; ok: boolean | null; problems: string[] } | null
  provider: { id: string; healthy: boolean; drained: boolean } | null
  matchId: string | null
  finalState: string | null
  connect: { host: string; port: number; passwordSet: boolean } | null
  tv: { host: string; port: number; delaySeconds: number } | null
  status: { applied: boolean; lines: number; output: string } | null
  ledger: { rows: number; open: number; hourlyCents: number | null } | null
  clones: { before: number; afterRelease: number; deleted: number }
  problems: string[]
}

const rigs: Rig[] = []

async function createRig(options: { link?: boolean } = {}): Promise<Rig> {
  const app = createTestApp({ noProviders: true })
  const fake = createFakeDathost({ clock: app.clock, email: EMAIL, password: PASSWORD })
  const tree = writeTree()
  /**
   * The **provider's** door to the vendor, which a test can make misbehave.
   * The script keeps the plain one: the whole point of the stray-clone case
   * below is that the provider's `deallocate` failed and the script's own
   * last act still has to work.
   */
  const vendor: { intercept: ((method: string, url: string) => Response | null) | null } = {
    intercept: null,
  }
  const providerFetch = ((url: string, init?: RequestInit) => {
    const refused = vendor.intercept?.((init?.method ?? 'GET').toUpperCase(), String(url))
    return refused ? Promise.resolve(refused) : fake.fetch(url, init)
  }) as typeof fake.fetch

  // The template, built by the script that builds the real one — so the
  // smoke's `--check` compares a real manifest against a real tree.
  const built: string[] = []
  const imageCode = await image.main({
    argv: ['--tree', tree, '--json'],
    env: {
      EZPUG_IRON_DATHOST_EMAIL: EMAIL,
      EZPUG_IRON_DATHOST_PASSWORD: PASSWORD,
      EZPUG_IRON_DATHOST_API_URL: VENDOR_URL,
    },
    fetch: fake.fetch as unknown as typeof fetch,
    sleep: async () => {},
    now: () => '2026-09-06T12:00:00.000Z',
    stdout: (text: string) => built.push(text),
    stderr: () => {},
  })
  expect(imageCode, built.join('')).toBe(0)
  const templateId = String(
    (JSON.parse(built.join('')) as { templateServerId: string }).templateServerId,
  )

  app.providers.register(
    createDathostProvider({
      email: EMAIL,
      password: PASSWORD,
      templateServerId: templateId,
      clock: app.clock,
      fetch: providerFetch,
      baseUrl: VENDOR_URL,
      log: app.log,
    }),
  )

  // The link, on a real port: the fake server dials it exactly as a plugin
  // on rented hardware dials `gs.ezpug.com`.
  let server: Server | undefined
  let link: ServerLink | undefined
  let linkUrl = ''
  if (options.link !== false) {
    server = createServer()
    const router = attachUpgradeRouter(server, { log: app.log })
    link = attachServerLink({
      router,
      clock: app.clock,
      log: app.log,
      store: app.store,
      matches: app.matches,
      links: app.links,
      isDraining: () => app.draining.value,
    })
    const port = await new Promise<number>(resolve =>
      (server as Server).listen(0, '127.0.0.1', () =>
        resolve(((server as Server).address() as AddressInfo).port),
      ),
    )
    linkUrl = `ws://127.0.0.1:${port}/link`
  }

  const minted = await app.keys.mint({
    name: 'rehearsal-bootstrap',
    scopes: ['admin'],
    budget: { maxConcurrentServers: 2, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [],
  })

  let plugin: FakeServer | undefined
  /** Dial in as soon as `configure` has planted the sidecar on the clone. */
  const dialIfReady = async (): Promise<void> => {
    if (plugin || linkUrl === '') return
    const clone = fake
      .servers()
      .find(view => view.id !== templateId && view.files.has('ezpug.json'))
    if (!clone) return
    const sidecar = JSON.parse(clone.files.get('ezpug.json') as string) as { token: string }
    const dialling = createFakeServer({
      url: linkUrl,
      token: sidecar.token,
      hello: { map: 'de_dust2' },
      onCommand: command =>
        command.type === 'rcon' && command.command === 'ezpug_status'
          ? { status: 'applied', output: STATUS_OUTPUT }
          : undefined,
    })
    plugin = dialling
    const welcome = await dialling.connect()
    const assign = await dialling.next('assign')
    await dialling.emit({
      type: 'server_ready',
      matchId: assign.matchId,
      source: { provider: welcome.provider, serverId: welcome.serverId },
      map: 'de_dust2',
    })
  }

  const rig: Rig = {
    app,
    fake,
    vendor,
    templateId,
    tree,
    bootstrapKey: minted.secret,
    env: {
      EZPUG_IRON_DATHOST_EMAIL: EMAIL,
      EZPUG_IRON_DATHOST_PASSWORD: PASSWORD,
      EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID: templateId,
      EZPUG_IRON_DATHOST_API_URL: VENDOR_URL,
    },
    fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(VENDOR_URL)) return fake.fetch(url, init)
      if (url.startsWith(ORCHESTRATOR_URL)) return app.fetch(url, init)
      return Promise.reject(new Error(`the smoke asked for ${url}, which is nobody's`))
    }) as typeof fetch,
    sleep: async (ms: number) => {
      await dialIfReady()
      await app.advance(ms)
    },
    plugin: () => plugin,
    run: async (argv = []) => {
      const out: string[] = []
      const err: string[] = []
      const code = await smoke.main({
        argv: [
          '--json',
          '--base-url',
          ORCHESTRATOR_URL,
          '--key',
          minted.secret,
          '--tree',
          tree,
          ...argv,
        ],
        env: rig.env,
        fetch: rig.fetch,
        sleep: rig.sleep,
        now: () => app.clock.now(),
        stdout: text => out.push(text),
        stderr: text => err.push(text),
        mintKey: () => {
          throw new Error('the rehearsal always passes --key')
        },
      })
      return {
        code,
        summary: JSON.parse(out.join('') || '{}') as SmokeSummary,
        stderr: err.join(''),
      }
    },
    close: async () => {
      await plugin?.close().catch(() => undefined)
      await link?.close()
      await app.close()
      if (server) {
        server.closeAllConnections()
        await new Promise<void>(resolve => (server as Server).close(() => resolve()))
      }
      rmSync(tree, { recursive: true, force: true })
    },
  }
  rigs.push(rig)
  return rig
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close()
})

describe('the smoke, end to end against the fakes', () => {
  it('runs its nine steps, and the ninth is that nothing is left running', async () => {
    const rig = await createRig()
    const { code, summary, stderr } = await rig.run()
    expect(code, `${JSON.stringify(summary.problems)}\n${stderr}`).toBe(0)
    expect(summary.problems).toEqual([])
    expect(summary.ok).toBe(true)

    // The steps, in the order the money depends on: the account before the
    // template, the template before the match, the release before the two
    // assertions about what the release left.
    expect(summary.steps).toEqual([
      'GET /account',
      'dathost-image --check',
      'the orchestrator is up and Dathost is registered',
      'counted the account',
      'created the match',
      'the plugin dialled the link and the match is ready',
      'ezpug_status through the link',
      'read the connect facts',
      'the ledger row is closed',
      'the account lists no tagged server',
    ])

    expect(summary.account?.credits).toBeTypeOf('number')
    expect(summary.imageCheck).toMatchObject({ ran: true, ok: true, problems: [] })
    expect(summary.provider).toMatchObject({ id: 'dathost', drained: false })
    expect(summary.finalState).toBe('ready')
  })

  it('proves the link carries traffic both ways: ezpug_status went down it and came back', async () => {
    const rig = await createRig()
    const { summary } = await rig.run()
    expect(summary.status?.applied).toBe(true)
    expect(summary.status?.output).toContain('link: connected')
    expect(summary.status?.lines).toBeGreaterThan(1)
    // The command really travelled the link — the fake server answered it.
    expect(
      rig
        .plugin()
        ?.received()
        .some(frame => frame.type === 'command'),
    ).toBe(true)
  })

  it('reads the connect facts and the GOTV relay off the ready match', async () => {
    const rig = await createRig()
    const { summary } = await rig.run()
    expect(summary.connect).toMatchObject({ port: expect.any(Number), passwordSet: true })
    expect(summary.connect?.host).toBeTypeOf('string')
    // GOTV is the template's (`enable_gotv`), which is why the image script
    // turns it on and this reads it back rather than asking for it.
    expect(summary.tv).toMatchObject({ port: 27_020, delaySeconds: 90 })
  })

  it('closes the ledger row and hands the server back to the vendor', async () => {
    const rig = await createRig()
    const { summary } = await rig.run()
    expect(summary.ledger).toMatchObject({ rows: 1, open: 0 })
    expect(summary.ledger?.hourlyCents).toBeGreaterThan(0)
    expect(summary.clones).toEqual({ before: 0, afterRelease: 0, deleted: 0 })
    // The vendor's own truth, not the ledger's: one server on the account,
    // and it is the template.
    expect(rig.fake.servers().map(view => view.id)).toEqual([rig.templateId])
  })

  it('leaves no key behind: the one it minted for the run is revoked', async () => {
    const rig = await createRig()
    await rig.run()
    const listed = await rig.app.request('/v1/keys', { key: rig.bootstrapKey })
    const run = (listed.body.keys as { name: string; revokedAt: string | null }[]).filter(key =>
      key.name.startsWith('dathost-smoke-'),
    )
    expect(run).toHaveLength(1)
    expect(run[0]?.revokedAt).not.toBeNull()
  })
})

describe('what it refuses and what it survives', () => {
  it('refuses to start without the account, and never takes a password on a flag', async () => {
    const out: string[] = []
    const code = await smoke.main({
      argv: ['--json'],
      env: {},
      fetch: (() => Promise.reject(new Error('nothing should be called'))) as typeof fetch,
      stdout: text => out.push(text),
      stderr: () => {},
    })
    expect(code).toBe(1)
    expect((JSON.parse(out.join('')) as SmokeSummary).problems[0]).toContain('no Dathost account')
    const help = readFileSync(join(repo, 'scripts/dathost-smoke.mjs'), 'utf8')
    expect(help).not.toMatch(/--password/)
  })

  it('releases the server even when a step after the allocation blows up', async () => {
    const rig = await createRig()
    // The commands route goes down after the match is ready: step 7 throws,
    // and the release still has to happen — that is what `finally` is for.
    const original = rig.fetch
    let broken = false
    const brokenFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/commands') && !url.includes('force-end')) {
        broken = true
        return Promise.resolve(
          new Response('{"error":{"code":"internal","message":"boom"}}', { status: 500 }),
        )
      }
      return original(input, init)
    }) as typeof fetch
    rig.fetch = brokenFetch
    const { code, summary } = await rig.run()
    expect(broken).toBe(true)
    expect(code).toBe(1)
    expect(summary.problems.join(' ')).toContain('/commands')
    // …and the two things that matter anyway are still true.
    expect(summary.ledger).toMatchObject({ open: 0 })
    expect(summary.clones.afterRelease).toBe(0)
    expect(rig.fake.servers().map(view => view.id)).toEqual([rig.templateId])
  })

  it('says so, loudly, when the server never dials in', async () => {
    // No link at all: the clone boots and nothing ever says `server_ready`.
    const rig = await createRig({ link: false })
    const { code, summary } = await rig.run(['--boot-minutes', '2'])
    expect(code).toBe(1)
    expect(summary.problems.join(' ')).toMatch(/never became ready|failed/)
    // The money is still safe: released, closed, and gone from the account.
    expect(summary.ledger?.open).toBe(0)
    expect(rig.fake.servers().map(view => view.id)).toEqual([rig.templateId])
  })

  it('deletes a clone the release left behind, and calls that a problem', async () => {
    const rig = await createRig()
    // The vendor refuses the *provider's* delete: `deallocate` cannot take
    // the clone back, so the smoke's own last act does — and says it had to,
    // because a clone the release left behind is a server somebody pays for.
    let refusals = 0
    rig.vendor.intercept = method => {
      if (method !== 'DELETE') return null
      refusals += 1
      // A 403 and not a 500: the provider does not retry a refusal, and a
      // backoff on a clock only this script turns would never come round.
      return new Response('{"error":"no"}', { status: 403 })
    }
    const { code, summary } = await rig.run()
    expect(refusals).toBeGreaterThan(0)
    expect(code).toBe(1)
    expect(summary.clones.afterRelease).toBe(1)
    expect(summary.clones.deleted).toBe(1)
    expect(summary.problems.join(' ')).toContain('deleted by hand')
    // Deleted by hand or not, the account is clean when the run is over.
    expect(rig.fake.servers().map(view => view.id)).toEqual([rig.templateId])
  })
})

describe('what it says out loud', () => {
  it('is the command docs/operations.md and package.json name', () => {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['dathost:smoke']).toBe('node scripts/dathost-smoke.mjs')
    const operations = readFileSync(join(repo, 'docs/operations.md'), 'utf8')
    expect(operations).toContain('pnpm dathost:smoke')
    expect(operations).toContain('EZPUG_DATHOST_TESTS')
  })

  it('offers every flag its own help text names', () => {
    const script = readFileSync(join(repo, 'scripts/dathost-smoke.mjs'), 'utf8')
    const help = script.slice(script.indexOf('const HELP ='), script.indexOf('function parseArgs('))
    for (const flag of help.matchAll(/^ {2}--([a-z-]+)/gm))
      expect(
        script.includes(`flags.get('${flag[1]}')`) || script.includes(`flags.has('${flag[1]}')`),
        `--${flag[1]} is in --help but nothing reads it`,
      ).toBe(true)
  })

  it('puts no secret in the summary', async () => {
    const rig = await createRig()
    const { summary } = await rig.run()
    const printed = JSON.stringify(summary)
    for (const secret of [PASSWORD, rig.bootstrapKey, 'Basic ', 'ezik_'])
      expect(printed, `the summary carries ${secret}`).not.toContain(secret)
    // The join password exists and the summary says only that it exists.
    expect(summary.connect?.passwordSet).toBe(true)
    expect(printed).not.toContain('password"')
  })
})
