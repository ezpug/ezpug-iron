import { createFakeClock } from '@ezpug/core'
import { eventually } from '@ezpug/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createRconClient, type RconClient, RconError, type RconTarget } from './client'
import { createFakeRcon, FAKE_RCON_LONG_ANSWER, type FakeRcon } from './fake-server'
import { decodeRconPackets, encodeRconPacket } from './protocol'
import { CONSOLE_REDACTED, redactConsoleLine } from './redact'

/**
 * **The framing is only right if something else reads it** (PRD-02 T20). Every
 * test here runs the client against a real TCP listener speaking the real
 * Source RCON protocol (`fake-server.ts`), so a byte in the wrong place fails
 * a test rather than a venue box at 22:00. The deadlines are the fake clock's:
 * a server that never answers is proven by moving time, never by waiting.
 */

const PASSWORD = 'not-a-real-rcon-password'
const PENDING = Symbol('pending')

let fake: FakeRcon | undefined

afterEach(async () => {
  await fake?.close()
  fake = undefined
})

interface Rig {
  client: RconClient
  target: RconTarget
  clock: ReturnType<typeof createFakeClock>
  server: FakeRcon
}

async function rig(commands: Record<string, string> = {}): Promise<Rig> {
  const server = createFakeRcon({ password: PASSWORD, commands })
  fake = server
  const port = await server.listen()
  const clock = createFakeClock()
  return {
    server,
    clock,
    client: createRconClient({ clock, connectTimeoutMs: 2_000, commandTimeoutMs: 5_000 }),
    target: { host: '127.0.0.1', port, password: PASSWORD },
  }
}

/** Run `attempt` while the fake timeline moves, and hand back however it settled. */
async function settledUnderTime(
  clock: ReturnType<typeof createFakeClock>,
  attempt: Promise<unknown>,
): Promise<unknown> {
  let outcome: unknown = PENDING
  const watched = attempt.then(
    value => {
      outcome = value
    },
    error => {
      outcome = error
    },
  )
  await eventually(async () => {
    await clock.advance(1_000)
    expect(outcome).not.toBe(PENDING)
  })
  await watched
  return outcome
}

describe('the packet', () => {
  it('round-trips, and reads two out of one chunk', () => {
    const first = encodeRconPacket({ id: 7, type: 2, body: 'status' })
    const second = encodeRconPacket({ id: 8, type: 0, body: '' })
    const { packets, rest } = decodeRconPackets(Buffer.concat([first, second]))
    expect(packets).toEqual([
      { id: 7, type: 2, body: 'status' },
      { id: 8, type: 0, body: '' },
    ])
    expect(rest).toHaveLength(0)
  })

  it('keeps a partial tail and finishes it on the next chunk', () => {
    const whole = encodeRconPacket({ id: 1, type: 3, body: 'secret' })
    const first = decodeRconPackets(whole.subarray(0, 9))
    expect(first.packets).toEqual([])
    const second = decodeRconPackets(Buffer.concat([first.rest, whole.subarray(9)]))
    expect(second.packets).toEqual([{ id: 1, type: 3, body: 'secret' }])
  })

  it('refuses a length prefix that is not a packet', () => {
    const nonsense = Buffer.alloc(8)
    nonsense.writeInt32LE(1_000_000, 0)
    expect(() => decodeRconPackets(nonsense)).toThrow(/not a packet/)
  })
})

describe('the client', () => {
  it('authenticates and hands back what the server printed', async () => {
    const { client, target, server } = await rig({ status: 'hostname: EZPug\nplayers: 2' })
    expect(await client.exec(target, 'status')).toBe('hostname: EZPug\nplayers: 2')
    expect(server.seen).toEqual(['status'])
  })

  it('stitches a multi-packet answer back together', async () => {
    const { client, target } = await rig({ status: FAKE_RCON_LONG_ANSWER })
    expect(await client.exec(target, 'status')).toBe(FAKE_RCON_LONG_ANSWER)
  })

  it('says so when the password is wrong, and never says what it sent', async () => {
    const { client, target } = await rig()
    const error = await client
      .exec({ ...target, password: 'wrong' }, 'status')
      .catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(RconError)
    expect((error as RconError).failure).toBe('auth_failed')
    expect((error as RconError).message).not.toContain('wrong')
  })

  it('gives up on a server that accepts the socket and says nothing — on the clock', async () => {
    const { client, target, clock, server } = await rig()
    server.setFaults({ silent: true })
    const outcome = await settledUnderTime(clock, client.exec(target, 'status'))
    expect(outcome).toBeInstanceOf(RconError)
    expect((outcome as RconError).failure).toBe('timeout')
  })

  it('refuses a peer that is not speaking RCON', async () => {
    const { client, target, server } = await rig()
    server.setFaults({ garbage: true })
    const error = await client.exec(target, 'status').catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(RconError)
    expect((error as RconError).failure).toBe('protocol')
  })

  it('keeps what a server said before it hung up', async () => {
    const { client, target, server } = await rig({ status: 'half a line' })
    server.setFaults({ hangUp: true })
    expect(await client.exec(target, 'status')).toBe('half a line')
  })

  it('reports a port nobody is listening on as unreachable', async () => {
    const { client, target, clock } = await rig()
    await fake?.close()
    fake = undefined
    const outcome = await settledUnderTime(clock, client.exec(target, 'status'))
    expect(outcome).toBeInstanceOf(RconError)
    expect(['unreachable', 'timeout']).toContain((outcome as RconError).failure)
  })
})

describe('what a console may not print', () => {
  it('masks the value after a password-ish cvar, quoted or bare', () => {
    expect(redactConsoleLine('rcon_password "hunter2"')).toBe(`rcon_password "${CONSOLE_REDACTED}"`)
    expect(redactConsoleLine('sv_password hunter2')).toBe(`sv_password ${CONSOLE_REDACTED}`)
    expect(redactConsoleLine('sv_setsteamaccount ABCDEF0123')).toBe(
      `sv_setsteamaccount ${CONSOLE_REDACTED}`,
    )
    expect(redactConsoleLine('matchzy_remote_log_header_value = "s3cret"')).toBe(
      `matchzy_remote_log_header_value = "${CONSOLE_REDACTED}"`,
    )
  })

  it('leaves a bare read alone and never eats the line under it', () => {
    expect(redactConsoleLine('rcon_password\nhostname EZPug')).toBe('rcon_password\nhostname EZPug')
    expect(redactConsoleLine('status')).toBe('status')
  })

  it('shortens a token of ours that somehow reached a line', () => {
    expect(redactConsoleLine('ezis_aaaaaaaabbbbbbbbcccccccc said hello')).toBe('ezis_… said hello')
  })
})
