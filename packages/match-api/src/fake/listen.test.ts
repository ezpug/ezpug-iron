/// <reference types="node" />
import { eventually } from '@ezpug/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createMatchApiClient } from '../client'
import { STREAM_CLOSE_CODES, streamFrameSchema } from '../index'
import { createHarness, type FakeListener, type Harness, pugRequest } from './testing'

/**
 * The fake on a real port: the published HTTP client against it, and the
 * stream as a `ws` upgrade with both credentials. The server is closed in
 * `afterEach` — nothing outlives the test.
 */

let harness: Harness | undefined
let listener: FakeListener | undefined
afterEach(async () => {
  await listener?.close()
  listener = undefined
  harness?.fake.close()
  harness = undefined
})

async function setup() {
  harness = createHarness()
  listener = await harness.fake.listen()
  return { h: harness, listener }
}

function open(url: string, headers?: Record<string, string>) {
  const socket = new WebSocket(url, { headers })
  const frames: unknown[] = []
  const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)))
  socket.on('message', data => frames.push(JSON.parse(String(data))))
  return { socket, frames, closed }
}

describe('the fake on a socket', () => {
  it('serves the published client and upgrades the stream for a key and for a player token', async () => {
    const { h, listener } = await setup()
    expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const client = createMatchApiClient({ baseUrl: listener.url, apiKey: h.platform.secret })
    const match = await client.matches.create({ body: pugRequest() })
    expect(match.state).toBe('allocating')
    expect((await client.gamemodes.list()).gamemodes).toHaveLength(4)

    const wsUrl = `${listener.url.replace('http', 'ws')}/v1/matches/${match.id}/stream`
    const byKey = open(wsUrl, { authorization: `Bearer ${h.platform.secret}` })
    await eventually(() => expect(byKey.frames).toHaveLength(1))
    expect(streamFrameSchema.parse(byKey.frames[0])).toEqual({
      type: 'hello',
      matchId: match.id,
      seq: 0,
      state: 'allocating',
    })
    // The socket mirrors what the clock produces.
    await h.clock.advance(6_000)
    await eventually(() => expect(byKey.frames.length).toBeGreaterThan(2))
    for (const frame of byKey.frames) streamFrameSchema.parse(frame)
    byKey.socket.close()

    const steamId64 = pugRequest().teams.teamA.players[0]?.steamId64 as string
    const token = await client.matches.mintPlayerToken({
      params: { matchId: match.id },
      body: { steamId64 },
    })
    const byToken = open(`${wsUrl}?token=${encodeURIComponent(token.token)}`)
    await eventually(() => expect(byToken.frames).toHaveLength(1))
    expect((byToken.frames[0] as { type: string }).type).toBe('hello')
    byToken.socket.close()

    const refused = open(wsUrl, { authorization: 'Bearer fake-key-nope' })
    expect(await refused.closed).toBe(STREAM_CLOSE_CODES.unauthorized)
    const other = open(
      `${listener.url.replace('http', 'ws')}/v1/matches/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b/stream`,
      {
        authorization: `Bearer ${h.platform.secret}`,
      },
    )
    expect(await other.closed).toBe(STREAM_CLOSE_CODES.notFound)

    // The match ends: the open socket hears the final event, then 4000.
    const watching = open(wsUrl, { authorization: `Bearer ${h.platform.secret}` })
    await eventually(() => expect(watching.frames).toHaveLength(1))
    await h.fake.playOut()
    expect(await watching.closed).toBe(STREAM_CLOSE_CODES.matchEnded)
    const last = watching.frames.at(-1) as {
      type: string
      envelope?: { payload: { type: string } }
    }
    expect(last.type).toBe('event')
    expect(last.envelope?.payload.type).toBe('match.ended')
  })
})
