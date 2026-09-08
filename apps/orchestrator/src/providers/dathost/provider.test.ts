import type { FakeClock } from '@ezpug/core'
import { createFakeClock } from '@ezpug/core'
import type { GamemodeManifest, MatchRequest, MatchRequestInput } from '@ezpug/match-api'
import { matchRequestSchema, SHIPPED_GAMEMODES } from '@ezpug/match-api'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Log } from '../../log'
import type { AllocationRequest, GameServerProvider, ServerConfiguration } from '../provider'
import type { FakeDathost } from './fake'
import { createFakeDathost } from './fake'
import {
  createDathostProvider,
  DATHOST_PROVIDER_ID,
  DATHOST_REQUEST_TIMEOUT_MS,
  DathostError,
  type DathostGsltPool,
  decodeTag,
  hourlyCentsOf,
  regionOfLocation,
} from './provider'

/**
 * **The Dathost provider against the fake Dathost** (PRD-02 T16). Every test
 * here runs on the in-process vendor (T15), which is validated against the
 * vendor's own OpenAPI, so "no test needs Dathost" stays true of everything
 * but the one demanded live smoke (T19) — and so the four vendor behaviours
 * the adapter would be wrong without (the sync-files caveat, a boot that
 * takes clock time, the single GET that refreshes `booting`, deletion
 * protection) bite here rather than on a Saturday.
 *
 * The three things this file is really about:
 *
 * - **Money.** An allocation that fails half-way takes its clone with it, a
 *   `duplicate` is never retried into a second server, and the template is
 *   refused by every verb.
 * - **Weather.** A 429 is backed off on the injected clock and retried; a
 *   5xx is retried only where repeating the call is safe; a console that
 *   never answers is a timeout, not a wedged process.
 * - **Secrets.** The account's password never reaches an error, a log line
 *   or `provider_meta`.
 */

const EMAIL = 'ops@ezpug.invalid'
const PASSWORD = 'not-a-real-dathost-password'
const BASE_URL = 'http://dathost.test/api/0.1'
const AUTHORIZATION = `Basic ${Buffer.from(`${EMAIL}:${PASSWORD}`).toString('base64')}`

const PUG = SHIPPED_GAMEMODES.find(mode => mode.id === 'pug') as GamemodeManifest

const MATCH_ID = '11111111-1111-4111-8111-111111111111'
const FLEET_SERVER_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

/** Bytes behind the minted RCON password, so the test can name it. */
const pinnedRandom = (seed: number) => (size: number) => Buffer.alloc(size, seed)

let clock: FakeClock
let fake: FakeDathost
let templateId: string
let lines: string[]

const log: Log = {
  info: message => lines.push(message),
  warn: message => lines.push(message),
  error: (message, error) =>
    lines.push(`${message} ${error instanceof Error ? error.message : ''}`),
}

/**
 * Run `work` while the fake clock fires the timers it is *waiting* on. Only
 * timers due within `maxJumpMs` are fired, so a backoff (≤ 9 s) advances the
 * work and a request timeout (30 s) does not fire under an in-flight call —
 * a test that wants the timeout says so by raising the jump.
 */
async function drive<T>(work: Promise<T>, maxJumpMs = 20_000): Promise<T> {
  let settled = false
  const tracked = work.then(
    value => {
      settled = true
      return value
    },
    (error: unknown) => {
      settled = true
      throw error
    },
  )
  tracked.catch(() => {})
  for (let round = 0; round < 200 && !settled; round += 1) {
    for (let tick = 0; tick < 3; tick += 1)
      await new Promise<void>(resolve => {
        setImmediate(resolve)
      })
    if (settled) break
    const deadline = clock.nextDeadline()
    if (deadline !== undefined && deadline - clock.now() <= maxJumpMs) await clock.next()
  }
  return tracked
}

async function vendor(
  method: string,
  path: string,
  form?: Record<string, string>,
): Promise<Response> {
  let body: FormData | undefined
  if (form) {
    body = new FormData()
    for (const [key, value] of Object.entries(form)) body.append(key, value)
  }
  return await fake.fetch(`${BASE_URL}${path}`, {
    method,
    headers: { authorization: AUTHORIZATION },
    ...(body && { body }),
  })
}

/** The template `scripts/dathost-image.mjs` builds (T18), as far as this suite needs it. */
async function createTemplate(): Promise<string> {
  const response = await vendor('POST', '/game-servers', {
    game: 'cs2',
    name: 'ezpug-template',
    location: 'dusseldorf',
    deletion_protection: 'true',
    'cs2_settings.enable_gotv': 'true',
    'cs2_settings.rcon': 'the-template-rcon-password',
  })
  return String(((await response.json()) as { id: string }).id)
}

/** Put a file on the template's box (not yet in the API's cache — that is `sync-files`). */
async function uploadToTemplate(path: string, content: string): Promise<void> {
  const body = new FormData()
  body.append('file', new Blob([content]), 'file')
  await fake.fetch(`${BASE_URL}/game-servers/${templateId}/files/${path}`, {
    method: 'POST',
    headers: { authorization: AUTHORIZATION },
    body,
  })
}

function provider(
  overrides: Partial<Parameters<typeof createDathostProvider>[0]> = {},
): GameServerProvider {
  return createDathostProvider({
    clock,
    log,
    email: EMAIL,
    password: PASSWORD,
    templateServerId: templateId,
    baseUrl: BASE_URL,
    fetch: fake.fetch,
    random: pinnedRandom(7),
    ...overrides,
  })
}

function allocation(overrides: Partial<AllocationRequest> = {}): AllocationRequest {
  return {
    matchId: MATCH_ID,
    fleetServerId: FLEET_SERVER_ID,
    keyId: 'key-1',
    requirements: { game: 'cs2' },
    offering: {
      capabilities: {
        games: ['cs2'],
        region: 'frankfurt',
        tickrate: 128,
        lan: false,
        workshopMaps: true,
      },
      hourlyCents: 24,
    },
    ttlMinutes: 180,
    ...overrides,
  }
}

let requests = 0
function request(overrides: Partial<MatchRequestInput> = {}): MatchRequest {
  requests += 1
  return matchRequestSchema.parse({
    clientMatchId: `dathost-${requests}`,
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'Team A', players: [] },
      teamB: { name: 'Team B', players: [] },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: 'whsec-1' },
    ttlMinutes: 120,
    ...overrides,
  })
}

function configuration(overrides: Partial<ServerConfiguration> = {}): ServerConfiguration {
  return {
    matchId: MATCH_ID,
    game: 'cs2',
    request: request(),
    gamemode: PUG,
    joinPassword: 'join-me',
    link: { url: 'wss://gs.ezpug.com/link', serverToken: 'ezis_a-server-token-for-a-test' },
    ...overrides,
  }
}

/** Allocate, configure and start one clone — the walk, in three lines. */
async function provision(adapter: GameServerProvider): Promise<{ serverId: string }> {
  const allocated = await drive(adapter.allocate(allocation()))
  await drive(adapter.configure(allocated.serverId, configuration()))
  await drive(adapter.start(allocated.serverId))
  return { serverId: allocated.serverId }
}

beforeEach(async () => {
  clock = createFakeClock()
  lines = []
  fake = createFakeDathost({ clock, email: EMAIL, password: PASSWORD, costPerHour: 0.24 })
  templateId = await createTemplate()
})

describe('the offering', () => {
  it('is one cs2 pool in Frankfurt at the template’s price', async () => {
    const offerings = await drive(provider().offerings())
    expect(offerings).toEqual([
      {
        capabilities: {
          games: ['cs2'],
          region: 'frankfurt',
          tickrate: 128,
          lan: false,
          workshopMaps: true,
        },
        hourlyCents: 24,
      },
    ])
    // Cloud capacity is not a number Dathost publishes; the budget is the wall.
    expect(offerings[0]?.available).toBeUndefined()
  })

  it('names the location’s region, and the location itself where none is mapped', () => {
    expect(regionOfLocation('dusseldorf')).toBe('frankfurt')
    expect(regionOfLocation('chicago')).toBe('chicago')
    expect(hourlyCentsOf(0.245)).toBe(25)
    expect(hourlyCentsOf(undefined)).toBe(0)
  })

  it('reads the template once per window, not once per match', async () => {
    const adapter = provider({ offeringsTtlMs: 60_000 })
    await drive(adapter.offerings())
    await drive(adapter.offerings())
    const reads = () =>
      fake.calls.filter(call => call === `GET /api/0.1/game-servers/${templateId}`)
    expect(reads()).toHaveLength(1)
    await clock.advance(60_001)
    await drive(adapter.offerings())
    expect(reads()).toHaveLength(2)
  })

  it('says which environment variable is wrong when the template is not on the account', async () => {
    const adapter = provider({ templateServerId: 'not-a-server' })
    await expect(drive(adapter.offerings())).rejects.toThrow(
      /EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID/,
    )
  })
})

describe('the health probe (T31)', () => {
  it('reads the account — the cheapest authenticated call, and no template', async () => {
    const adapter = provider()
    await drive(adapter.probe?.() ?? Promise.resolve())
    expect(fake.calls).toContain('GET /api/0.1/account')
    expect(fake.calls.some(call => call.includes(`game-servers/${templateId}`))).toBe(false)
  })

  it('throws what the probe loop turns into lastError, with no credential in it', async () => {
    const adapter = provider()
    fake.setFaults({ status: { code: 503, times: 5, only: '/account' } })
    const failure = await drive(
      (adapter.probe?.() ?? Promise.resolve()).then(
        () => null,
        (error: unknown) => error as Error,
      ),
    )
    expect(failure?.message).toContain('503')
    expect(failure?.message).not.toContain(PASSWORD)
  })
})

describe('allocation', () => {
  it('syncs the template, clones it, and plants our identity on the clone', async () => {
    const adapter = provider()
    // Uploaded after the template was made and never synced: the clone gets
    // it only because `allocate` syncs first (the vendor's caveat).
    await uploadToTemplate('cfg/ezpug/pug.cfg', 'mp_maxrounds 24')

    const allocated = await drive(adapter.allocate(allocation()))

    const clone = fake.server(allocated.serverId)
    expect(clone?.duplicateSourceServer).toBe(templateId)
    expect(clone?.files.get('cfg/ezpug/pug.cfg')).toBe('mp_maxrounds 24')
    expect(clone?.name).toBe(`ezpug ${MATCH_ID.slice(0, 8)} cs2`)
    expect(decodeTag(clone?.userData)).toEqual({
      tag: 'ezpug',
      matchId: MATCH_ID,
      fleetServerId: FLEET_SERVER_ID,
    })
    // The reaper is ours; a crash is a loss we want to see.
    expect(clone?.raw.autostop).toBe(false)
    expect(clone?.raw.reboot_on_crash).toBe(false)
    // A fresh RCON password, never the template's.
    const settings = clone?.raw.cs2_settings as Record<string, unknown>
    expect(settings.rcon).not.toBe('the-template-rcon-password')
    expect(String(settings.rcon)).toHaveLength(16)
    // The template is untouched and still protected.
    expect(fake.server(templateId)?.deletionProtection).toBe(true)
  })

  it('hands back the connect facts and the GOTV relay the clone reports', async () => {
    const allocated = await drive(provider().allocate(allocation()))
    expect(allocated.connect).toEqual({ host: 'dusseldorf.fake-dathost.invalid', port: 27_015 })
    expect(allocated.tv).toEqual({
      host: 'dusseldorf.fake-dathost.invalid',
      port: 27_020,
      delaySeconds: 90,
    })
    expect(allocated.meta).toEqual({
      location: 'dusseldorf',
      clonedFrom: templateId,
      costPerHour: 0.24,
    })
    // Nothing in the ledger's `provider_meta` is a secret.
    expect(JSON.stringify(allocated.meta)).not.toContain(PASSWORD)
  })

  it('reports no relay for a template with GOTV off', async () => {
    await vendor('PUT', `/game-servers/${templateId}`, { 'cs2_settings.enable_gotv': 'false' })
    const allocated = await drive(provider().allocate(allocation()))
    expect(allocated.tv).toBeUndefined()
  })

  it('syncs the template once per window however many matches ask', async () => {
    const adapter = provider({ templateSyncTtlMs: 600_000 })
    await drive(adapter.allocate(allocation()))
    await drive(adapter.allocate(allocation({ fleetServerId: 'bbbb' })))
    const syncs = fake.calls.filter(
      call => call === `POST /api/0.1/game-servers/${templateId}/sync-files`,
    )
    expect(syncs).toHaveLength(1)
    await clock.advance(600_001)
    await drive(adapter.allocate(allocation({ fleetServerId: 'cccc' })))
    expect(
      fake.calls.filter(call => call === `POST /api/0.1/game-servers/${templateId}/sync-files`),
    ).toHaveLength(2)
  })

  it('leases a GSLT for the ledger row and puts it in the clone’s settings', async () => {
    const leased: string[] = []
    const released: { fleetServerId: string; lost: boolean }[] = []
    const gslt: DathostGsltPool = {
      lease: fleetServerId => {
        leased.push(fleetServerId)
        return Promise.resolve('a-fake-gslt')
      },
      release: (fleetServerId, releaseOptions) => {
        released.push({ fleetServerId, lost: releaseOptions?.lost === true })
        return Promise.resolve()
      },
    }
    const adapter = provider({ gslt })
    const allocated = await drive(adapter.allocate(allocation()))
    // The lease is keyed by the row, not the clone: the row exists before
    // the clone does and outlives it (T17).
    expect(leased).toEqual([FLEET_SERVER_ID])
    const settings = fake.server(allocated.serverId)?.raw.cs2_settings as Record<string, unknown>
    expect(settings.steam_game_server_login_token).toBe('a-fake-gslt')

    await drive(adapter.deallocate(allocated.serverId))
    // The clone was there to be deleted, so nothing is still logged in with
    // the token: a clean release, and no `ResetLoginToken` at Steam.
    expect(released).toEqual([{ fleetServerId: FLEET_SERVER_ID, lost: false }])
  })

  it('releases the lease as lost when the server was already gone', async () => {
    const released: { fleetServerId: string; lost: boolean }[] = []
    const adapter = provider({
      gslt: {
        lease: () => Promise.resolve('a-fake-gslt'),
        release: (fleetServerId, releaseOptions) => {
          released.push({ fleetServerId, lost: releaseOptions?.lost === true })
          return Promise.resolve()
        },
      },
    })
    const allocated = await drive(adapter.allocate(allocation()))
    // The box vanished off the account: nothing proved it stopped, so the
    // token it carries may still be logged in somewhere.
    fake.setFaults({ vanished: [allocated.serverId] })
    await drive(adapter.deallocate(allocated.serverId))
    expect(released).toEqual([{ fleetServerId: FLEET_SERVER_ID, lost: true }])
  })

  it('says out loud, once, that a server without a GSLT is LAN only', async () => {
    const adapter = provider()
    await drive(adapter.allocate(allocation()))
    await drive(adapter.allocate(allocation({ fleetServerId: 'bbbb' })))
    expect(lines.filter(line => line.includes('LAN connections only'))).toHaveLength(1)
  })

  it('takes the clone back when the allocation fails half-way, leaving nothing behind', async () => {
    // The clone is the fake's second server: ids come off a counter. Four
    // 500s is exactly the settings `PUT` and its three retries; the teardown
    // that follows is answered normally.
    const cloneId = (2).toString(16).padStart(24, '0')
    fake.setFaults({ status: { code: 500, times: 4, only: `/game-servers/${cloneId}` } })

    await expect(drive(provider().allocate(allocation()))).rejects.toBeInstanceOf(DathostError)

    expect(fake.servers().map(server => server.id)).toEqual([templateId])
    expect(await drive(provider().list())).toEqual([])
  })

  it('leaves a clone it could not delete to the reaper, and claims it meanwhile', async () => {
    const cloneId = (2).toString(16).padStart(24, '0')
    fake.setFaults({ status: { code: 500, times: 99, only: `/game-servers/${cloneId}` } })

    await expect(drive(provider().allocate(allocation()))).rejects.toBeInstanceOf(DathostError)

    // Nothing could be written on it, so it carries no tag — but it carries
    // our template as its `duplicate_source_server`, which is the claim that
    // makes it the reaper's business rather than a silent bill.
    fake.setFaults({})
    expect(fake.servers().map(server => server.id)).toEqual([templateId, cloneId])
    expect(await drive(provider().list())).toEqual([{ serverId: cloneId }])
    await drive(provider().deallocate(cloneId))
    expect(fake.servers().map(server => server.id)).toEqual([templateId])
  })

  it('deletes the clone itself when the failure was ours, not the vendor’s', async () => {
    const cloneId = (2).toString(16).padStart(24, '0')
    const adapter = provider({
      gslt: {
        lease: () => Promise.reject(new Error('the pool is on fire')),
        release: () => Promise.resolve(),
      },
    })
    await expect(drive(adapter.allocate(allocation()))).rejects.toThrow('the pool is on fire')
    expect(fake.server(cloneId)).toBeUndefined()
  })
})

describe('configuration and the boot', () => {
  it('sets the join password and plants ezpug.json, and nothing else', async () => {
    const adapter = provider()
    const allocated = await drive(adapter.allocate(allocation()))
    await drive(adapter.configure(allocated.serverId, configuration()))

    const clone = fake.server(allocated.serverId)
    const settings = clone?.raw.cs2_settings as Record<string, unknown>
    expect(settings.password).toBe('join-me')
    // The template's slot count and its price are left alone (the ledger
    // snapshots `cost_per_hour` at allocate).
    expect(settings.slots).toBe(12)
    expect(clone?.raw.cost_per_hour).toBe(0.24)

    const sidecar = JSON.parse(clone?.files.get('ezpug.json') ?? '{}') as Record<string, string>
    expect(sidecar).toEqual({
      url: 'wss://gs.ezpug.com/link',
      token: 'ezis_a-server-token-for-a-test',
    })
  })

  it('boots on the clock: allocated, then starting, then running', async () => {
    const adapter = provider()
    const allocated = await drive(adapter.allocate(allocation()))
    expect((await drive(adapter.status(allocated.serverId))).state).toBe('allocated')

    await drive(adapter.configure(allocated.serverId, configuration()))
    await drive(adapter.start(allocated.serverId))
    expect((await drive(adapter.status(allocated.serverId))).state).toBe('starting')

    await clock.advance(30_000)
    const running = await drive(adapter.status(allocated.serverId))
    expect(running.state).toBe('running')
    expect(running.connect).toEqual({ host: 'dusseldorf.fake-dathost.invalid', port: 27_015 })
    expect(running.playerCount).toBe(0)
  })

  it('calls a stopped server stopped and a vanished one gone', async () => {
    const adapter = provider()
    const { serverId } = await provision(adapter)
    await clock.advance(30_000)

    await drive(adapter.stop(serverId))
    expect((await drive(adapter.status(serverId))).state).toBe('stopped')

    // What the recovery flow sees when a box dies (T14).
    fake.setFaults({ vanished: [serverId] })
    expect((await drive(adapter.status(serverId))).state).toBe('gone')
  })
})

describe('the ledger’s side', () => {
  it('lists only our servers, never the template, with the row they belong to', async () => {
    // Somebody else's server on the same account.
    await vendor('POST', '/game-servers', {
      game: 'cs2',
      name: 'not-ours',
      'cs2_settings.rcon': 'somebody-elses-rcon',
    })
    const adapter = provider()
    const allocated = await drive(adapter.allocate(allocation()))

    expect(await drive(adapter.list())).toEqual([
      { serverId: allocated.serverId, matchId: MATCH_ID, fleetServerId: FLEET_SERVER_ID },
    ])
  })

  it('never claims another deployment’s server, however it was cloned', async () => {
    await drive(provider({ tag: 'ezpug-prod' }).allocate(allocation()))
    // Same account, same template, a different deployment: a reaper that
    // deleted the other one's live match would be worse than a leak.
    expect(await drive(provider({ tag: 'ezpug-dev' }).list())).toEqual([])
  })

  it('deallocates by stopping and deleting, and does it again without complaint', async () => {
    const adapter = provider()
    const { serverId } = await provision(adapter)
    await clock.advance(30_000)

    await drive(adapter.deallocate(serverId))
    expect(fake.servers().map(server => server.id)).toEqual([templateId])
    expect(await drive(adapter.list())).toEqual([])
    // Idempotent: the reaper retries until it holds.
    await expect(drive(adapter.deallocate(serverId))).resolves.toBeUndefined()
  })

  it('refuses every verb on the template', async () => {
    const adapter = provider()
    await expect(adapter.deallocate(templateId)).rejects.toThrow(/refused on the template/)
    await expect(adapter.start(templateId)).rejects.toThrow(/refused on the template/)
    await expect(adapter.stop(templateId)).rejects.toThrow(/refused on the template/)
    await expect(adapter.configure(templateId, configuration())).rejects.toThrow(
      /refused on the template/,
    )
    expect(fake.server(templateId)).toBeDefined()
    expect(fake.calls.some(call => call.includes(`${templateId}/start`))).toBe(false)
  })
})

describe('the console door, before the link is up', () => {
  it('says a line, reads the backlog and answers what a command printed', async () => {
    const adapter = provider()
    const { serverId } = await provision(adapter)

    expect(await drive(adapter.announce?.(serverId, 'gl hf') ?? Promise.resolve(false))).toBe(true)
    const backlog = await drive(adapter.console?.(serverId) ?? Promise.resolve(null))
    expect(backlog?.map(line => line.line)).toEqual(['say gl hf'])
    expect(backlog?.[0]?.at).toBe(clock.date().toISOString())

    // The game answers on the console's own log, a beat after the command.
    const answer = drive(
      (adapter.rcon?.(serverId, 'status') ?? Promise.resolve(null)) as Promise<string | null>,
    )
    fake.say(serverId, 'hostname: EZPug')
    expect(await answer).toContain('hostname: EZPug')
  })

  it('answers nothing for a server that is gone', async () => {
    const adapter = provider()
    const { serverId } = await provision(adapter)
    fake.setFaults({ vanished: [serverId] })
    expect(await drive(adapter.console?.(serverId) ?? Promise.resolve(null))).toBeNull()
    expect(await drive(adapter.announce?.(serverId, 'anyone?') ?? Promise.resolve(true))).toBe(
      false,
    )
  })
})

describe('weather', () => {
  it('backs off a 429 on the clock and gets there', async () => {
    fake.setFaults({ status: { code: 429, times: 2, only: `/game-servers/${templateId}` } })
    const offerings = await drive(provider().offerings())
    expect(offerings[0]?.hourlyCents).toBe(24)
    expect(lines.some(line => line.includes('answered 429'))).toBe(true)
  })

  it('retries a 5xx where repeating the call is safe', async () => {
    fake.setFaults({ status: { code: 503, times: 2, only: `/game-servers/${templateId}` } })
    await expect(drive(provider().offerings())).resolves.toHaveLength(1)
  })

  it('never retries a duplicate into a second server', async () => {
    fake.setFaults({ status: { code: 500, times: 1, only: '/duplicate' } })
    await expect(drive(provider().allocate(allocation()))).rejects.toThrow(/answered 500/)
    expect(fake.calls.filter(call => call.includes('/duplicate'))).toHaveLength(1)
    expect(fake.servers().map(server => server.id)).toEqual([templateId])
  })

  it('gives up after four attempts and says what answered', async () => {
    fake.setFaults({ status: { code: 500, times: 99, only: `/game-servers/${templateId}` } })
    const failure = await drive(provider().offerings()).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DathostError)
    expect((failure as DathostError).status).toBe(500)
    expect(
      fake.calls.filter(call => call === `GET /api/0.1/game-servers/${templateId}`),
    ).toHaveLength(4)
  })

  it('times a console that never answers out, on the clock', async () => {
    const adapter = provider({ retryDelaysMs: [] })
    const { serverId } = await provision(adapter)
    fake.setFaults({ consoleTimeout: true })
    const failure = await drive(
      (adapter.console?.(serverId) ?? Promise.resolve(null)).catch((error: unknown) => error),
      DATHOST_REQUEST_TIMEOUT_MS,
    )
    expect(failure).toBeInstanceOf(DathostError)
    expect((failure as DathostError).message).toContain('did not answer within')
  })

  it('refuses a wrong password without retrying it, and never repeats it', async () => {
    const adapter = provider({ password: 'the-wrong-password' })
    const failure = await drive(adapter.offerings()).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DathostError)
    expect((failure as DathostError).status).toBe(401)
    expect(String((failure as Error).message)).not.toContain('the-wrong-password')
    expect(
      fake.calls.filter(call => call === `GET /api/0.1/game-servers/${templateId}`),
    ).toHaveLength(1)
    expect(lines.join('\n')).not.toContain('the-wrong-password')
  })
})

describe('the badge', () => {
  it('is the id every event from a Dathost server carries', () => {
    expect(DATHOST_PROVIDER_ID).toBe('dathost')
    expect(provider().id).toBe(DATHOST_PROVIDER_ID)
  })
})
