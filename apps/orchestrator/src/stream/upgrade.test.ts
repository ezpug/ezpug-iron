import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createFakeClock } from '@ezpug/core'
import { eventually } from '@ezpug/core/testing'
import { matchRequestSchema, type StreamFrame } from '@ezpug/match-api'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createMemoryKeyStore } from '../keys/memory-store'
import { createKeys } from '../keys/service'
import { createMemoryLog } from '../log'
import { requestHash } from '../match/machine'
import { createMemoryMatchStore } from '../match/memory-store'
import type { MatchRow, MatchStore } from '../match/store'
import { createStreamHub, type StreamHub } from './hub'
import { attachStreamUpgrade, attachUpgradeRouter } from './upgrade'

/**
 * **The stream's upgrade, on its own** (PRD-02 T3, hardened in T5): the one
 * ordering promise `docs/match-api.md` makes about the socket — *the first
 * frame is a `hello`* — held against the window that used to break it. The
 * subscription is taken before the match is read (so nothing published in
 * between is missed); anything that arrives while the read is in flight has
 * to wait behind the greeting rather than overtake it.
 */

const at = new Date('2026-09-05T18:00:00.000Z')
const request = matchRequestSchema.parse({
  clientMatchId: 'stream-1',
  game: 'cs2',
  gamemode: 'pug',
  teams: { teamA: { name: 'A', players: [] }, teamB: { name: 'B', players: [] } },
  maps: [{ map: 'de_mirage', sides: 'ct' }],
  callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: 'whsec-1' },
  ttlMinutes: 60,
})

function matchRow(id: string, keyId: string): MatchRow {
  return {
    id,
    keyId,
    clientMatchId: request.clientMatchId,
    state: 'allocating',
    stateChangedAt: at,
    game: 'cs2',
    gamemode: 'pug',
    provider: null,
    serverId: null,
    fleetServerId: null,
    connect: null,
    tv: null,
    seq: 3,
    requestJson: request,
    requestHash: requestHash(request),
    endedReason: null,
    sim: null,
    expiresAt: new Date(at.getTime() + 3_600_000),
    readyAt: null,
    liveAt: null,
    endedAt: null,
    webhooksStoppedAt: null,
    createdAt: at,
    updatedAt: at,
  }
}

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const MATCH_ID = '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b'

/**
 * A world whose `findMatch` — the read the hello is built from — is held
 * open by the test, so the window between subscribing and greeting is as
 * wide as the assertion needs.
 */
async function world() {
  const clock = createFakeClock({ start: at.toISOString() })
  const log = createMemoryLog()
  const keys = createKeys({ store: createMemoryKeyStore(), clock })
  const minted = await keys.mint({
    name: 'platform',
    scopes: ['matches'],
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [],
  })
  const memory = createMemoryMatchStore()
  await memory.insertMatch(matchRow(MATCH_ID, minted.key.id))
  // The upgrade reads the match twice: once to authorise, once to build the
  // hello. Only the second one is the window under test.
  let reads = 0
  let holdFrom = Number.POSITIVE_INFINITY
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const store: MatchStore = {
    ...memory,
    findMatch: async id => {
      reads += 1
      if (reads >= holdFrom) await gate
      return memory.findMatch(id)
    },
  }
  const hub = createStreamHub({ clock, log })
  await hub.start()
  const server = createServer((_request, response) => response.end())
  const router = attachUpgradeRouter(server, { log })
  const wss = attachStreamUpgrade({ router, clock, log, keys, store, hub })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  closers.push(async () => {
    for (const client of wss.clients) client.close()
    await hub.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return {
    hub,
    secret: minted.secret,
    url: `ws://127.0.0.1:${port}/v1/matches/${MATCH_ID}/stream`,
    subscribers: () => hub.size(MATCH_ID),
    /** Hold the hello's read — the second one — until `letGo`. */
    hold: () => {
      holdFrom = 2
    },
    letGo: () => release?.(),
  }
}

function collect(url: string, secret: string) {
  const frames: StreamFrame[] = []
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${secret}` } })
  socket.on('message', data => frames.push(JSON.parse(String(data)) as StreamFrame))
  return {
    frames,
    open: new Promise<void>(resolve => socket.on('open', () => resolve())),
    until: async (count: number) => {
      await eventually(() => expect(frames.length).toBeGreaterThanOrEqual(count))
      return frames
    },
    close: () => socket.close(),
  }
}

describe('the stream upgrade', () => {
  it('greets first even when the match publishes while the hello is being read', async () => {
    const w = await world()
    w.hold()
    const client = collect(w.url, w.secret)
    await client.open
    // The subscription is already taken; the greeting is not written yet.
    // This is the exact window a walk publishes `match.allocated` into.
    await eventually(() => expect(w.subscribers()).toBe(1))
    w.hub.publish(MATCH_ID, {
      type: 'presence',
      players: [{ steamId64: '76561198000000001', name: 'a' }],
    })
    // Nothing may reach the socket before the greeting, however long we look.
    await expect(
      eventually(() => expect(client.frames.length).toBeGreaterThan(0), { timeout: 200 }),
    ).rejects.toThrow()
    w.letGo()
    const frames = await client.until(2)
    expect(frames[0]).toEqual({ type: 'hello', matchId: MATCH_ID, seq: 3, state: 'allocating' })
    // Held, not dropped: the frame published in the window arrives next.
    expect(frames[1]?.type).toBe('presence')
    client.close()
  })

  it('drops a held event the greeting already covers and keeps the one after it', async () => {
    const w = await world()
    w.hold()
    const client = collect(w.url, w.secret)
    await client.open
    await eventually(() => expect(w.subscribers()).toBe(1))
    // The machine appends before it publishes: an event with the row's own seq
    // (3) can land in the window, and one past it (4) can too.
    const event = (seq: number): Parameters<StreamHub['publish']>[1] =>
      ({
        type: 'event',
        envelope: { deliveryId: `d-${seq}`, matchId: MATCH_ID, seq, type: 'match.allocated' },
      }) as unknown as Parameters<StreamHub['publish']>[1]
    w.hub.publish(MATCH_ID, event(3))
    w.hub.publish(MATCH_ID, event(4))
    w.hub.publish(MATCH_ID, {
      type: 'presence',
      players: [{ steamId64: '76561198000000001', name: 'a' }],
    })
    w.letGo()
    const frames = await client.until(3)
    expect(frames[0]).toEqual({ type: 'hello', matchId: MATCH_ID, seq: 3, state: 'allocating' })
    // Seq 3 is the hello's own cursor — replaying from it starts after it — so the frame is dropped; 4 and the presence follow.
    expect(
      frames.slice(1).map(f => (f.type === 'event' ? `event:${f.envelope.seq}` : f.type)),
    ).toEqual(['event:4', 'presence'])
    await expect(
      eventually(() => expect(client.frames.length).toBeGreaterThan(3), { timeout: 200 }),
    ).rejects.toThrow()
    client.close()
  })

  it('greets first in the ordinary case and keeps publishing afterwards', async () => {
    const w = await world()
    const client = collect(w.url, w.secret)
    await client.open
    await client.until(1)
    w.hub.publish(MATCH_ID, {
      type: 'presence',
      players: [{ steamId64: '76561198000000001', name: 'a' }],
    })
    const frames = await client.until(2)
    expect(frames.map(f => f.type)).toEqual(['hello', 'presence'])
    client.close()
  })
})
