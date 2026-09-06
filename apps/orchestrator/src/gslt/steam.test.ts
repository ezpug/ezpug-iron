import type { FakeClock } from '@ezpug/core'
import { createFakeClock } from '@ezpug/core'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Log } from '../log'
import type { FakeSteam } from './fake-steam'
import { createFakeSteam, FAKE_GSLT_PREFIX } from './fake-steam'
import { createSteamGameServers, STEAM_REQUEST_TIMEOUT_MS, SteamError } from './steam'

/**
 * **The Steam client against the fake Steam** (PRD-02 T17). What this file
 * is about, beyond "the four calls work":
 *
 * - **A create is never retried.** A repeated `CreateAccount` is an account
 *   nobody tracks, and the pool would mint past its ceiling without ever
 *   noticing. Everything else is idempotent by SteamID and is retried.
 * - **The key is never in the story.** Not in an error, not in a log line —
 *   the same posture as the Dathost Basic header (T16).
 * - **Weather is on the clock.** A 429 backs off; a Steam that never answers
 *   is a timeout, not a wedged allocation.
 */

const API_KEY = 'fake-steam-key'
const BASE_URL = 'http://steam.test'

let clock: FakeClock
let fake: FakeSteam
let lines: string[]

const log: Log = {
  info: message => lines.push(message),
  warn: message => lines.push(message),
  error: (message, error) =>
    lines.push(`${message} ${error instanceof Error ? error.message : ''}`),
}

/** Fire the timers the work is waiting on, up to `maxJumpMs` — the Dathost suite's driver. */
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

function steam(overrides: Partial<Parameters<typeof createSteamGameServers>[0]> = {}) {
  return createSteamGameServers({
    clock,
    log,
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    fetch: fake.fetch,
    ...overrides,
  })
}

beforeEach(() => {
  clock = createFakeClock({ start: '2026-09-06T12:00:00.000Z' })
  fake = createFakeSteam({ clock, apiKey: API_KEY })
  lines = []
})

describe('the four calls', () => {
  it('creates an account for app 730 and hands back its token', async () => {
    const account = await drive(steam().createAccount('ezpug-iron dev'))
    expect(account.appId).toBe(730)
    expect(account.memo).toBe('ezpug-iron dev')
    expect(account.loginToken.startsWith(FAKE_GSLT_PREFIX)).toBe(true)
    expect(fake.accounts()).toHaveLength(1)
  })

  it('lists what the key owns', async () => {
    const client = steam()
    const first = await drive(client.createAccount('one'))
    const second = await drive(client.createAccount('two'))
    const listed = await drive(client.listAccounts())
    expect(listed.map(account => account.steamId)).toEqual([first.steamId, second.steamId])
    expect(listed.map(account => account.memo)).toEqual(['one', 'two'])
  })

  it('resets a login token to a different one', async () => {
    const client = steam()
    const account = await drive(client.createAccount('one'))
    await clock.advance(1_000)
    const reset = await drive(client.resetLoginToken(account.steamId))
    expect(reset).not.toBe(account.loginToken)
    expect(fake.accounts()[0]?.loginToken).toBe(reset)
  })

  it('deletes an account', async () => {
    const client = steam()
    const account = await drive(client.createAccount('one'))
    await drive(client.deleteAccount(account.steamId))
    expect(fake.accounts()).toEqual([])
    // Steam refuses an account it does not hold; the pool reads the throw.
    await expect(drive(client.deleteAccount(account.steamId))).rejects.toBeInstanceOf(SteamError)
  })

  it('reports an expired account as expired', async () => {
    const client = steam()
    const account = await drive(client.createAccount('one'))
    fake.expire(account.steamId)
    const [listed] = await drive(client.listAccounts())
    expect(listed?.expired).toBe(true)
  })
})

describe('weather', () => {
  it('backs a 429 off on the clock and retries a repeatable call', async () => {
    fake.setFaults({ status: { code: 429, times: 2, only: 'GetAccountList' } })
    const started = clock.now()
    const listed = await drive(steam().listAccounts())
    expect(listed).toEqual([])
    // Two refusals, so the first two backoffs (1 s + 3 s) were slept.
    expect(clock.now() - started).toBe(4_000)
    expect(fake.calls.filter(call => call === 'GetAccountList')).toHaveLength(3)
  })

  it('never sends a create again — a retried create is an account nobody tracks', async () => {
    fake.setFaults({ status: { code: 500, times: 1, only: 'CreateAccount' } })
    await expect(drive(steam().createAccount('one'))).rejects.toBeInstanceOf(SteamError)
    expect(fake.calls.filter(call => call === 'CreateAccount')).toHaveLength(1)
    expect(fake.accounts()).toEqual([])
  })

  it('gives up after four attempts', async () => {
    fake.setFaults({ status: { code: 503, times: 9, only: 'GetAccountList' } })
    await expect(drive(steam().listAccounts())).rejects.toMatchObject({
      name: 'SteamError',
      status: 503,
    })
    expect(fake.calls.filter(call => call === 'GetAccountList')).toHaveLength(4)
  })

  it('names a 403 for what it is: the key', async () => {
    const wrong = steam({ apiKey: 'a-key-that-is-not-the-fakes' })
    await expect(drive(wrong.listAccounts())).rejects.toThrow(/STEAM_WEB_API_KEY is wrong/)
    // A wrong key is a fact about us, not weather: it is asked once.
    expect(fake.calls.filter(call => call === 'GetAccountList')).toHaveLength(1)
  })

  it('times out on the clock rather than waiting for ever', async () => {
    const stuck = steam({
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    })
    await expect(
      drive(stuck.listAccounts(), STEAM_REQUEST_TIMEOUT_MS + 1_000),
    ).rejects.toBeInstanceOf(SteamError)
  })
})

describe('secrets', () => {
  it('keeps the key out of every error and every line', async () => {
    fake.setFaults({ status: { code: 500, times: 9 } })
    const error = await drive(steam().listAccounts()).catch((thrown: unknown) => thrown)
    expect(String(error)).not.toContain(API_KEY)
    expect(JSON.stringify(error)).not.toContain(API_KEY)
    expect(lines.join('\n')).not.toContain(API_KEY)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('sends the key in the body of a write, never in its URL', async () => {
    const urls: string[] = []
    const client = steam({
      fetch: (input, init) => {
        urls.push(input)
        return fake.fetch(input, init)
      },
    })
    await drive(client.createAccount('one'))
    expect(urls).toHaveLength(1)
    expect(urls[0]).not.toContain(API_KEY)
  })
})
