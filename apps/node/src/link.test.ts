import { eventually, useFakeClock } from '@ezpug/core/testing'
import { LINK_CLOSE_CODES } from '@ezpug/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createNodeLink,
  type HelloBody,
  type LinkClosure,
  type NodeLink,
  NodeLinkClosedError,
  type NodeLinkHandler,
} from './link'
import { createMemoryLog } from './log'
import {
  createFakeNodeEndpoint,
  type FakeNodeEndpoint,
  type FakeNodeEndpointOptions,
} from './testing'

const clock = useFakeClock()

const HELLO: HelloBody = {
  version: '0.1.0',
  region: 'eu-central',
  lan: true,
  labels: { cores: '16' },
  capacity: { maxInstances: 2, warm: 1 },
  imageDigest: `sha256:${'ab'.repeat(32)}`,
  instances: [],
}

const NODE_TOKEN = 'ezin_not-a-secret_node_token_0001'

interface Rig {
  endpoint: FakeNodeEndpoint
  link: NodeLink
  log: ReturnType<typeof createMemoryLog>
  calls: string[]
  closures: { closure: LinkClosure; willRetry: boolean }[]
  fatal: LinkClosure[]
}

const rigs: Rig[] = []
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.link.close()
    await rig.endpoint.close()
  }
})

async function createRig(
  options: FakeNodeEndpointOptions & {
    tokenKind?: 'enrolment' | 'node'
    hello?: () => HelloBody
    helloTimeoutMs?: number
    handler?: Partial<NodeLinkHandler>
  } = {},
): Promise<Rig> {
  const endpoint = await createFakeNodeEndpoint(options)
  const log = createMemoryLog()
  const calls: string[] = []
  const closures: Rig['closures'] = []
  const fatal: LinkClosure[] = []
  const link = createNodeLink({
    url: endpoint.url,
    clock,
    log,
    credentials: () => ({ token: NODE_TOKEN, tokenKind: options.tokenKind ?? 'node' }),
    handler: {
      hello: options.hello ?? (() => HELLO),
      onWelcome: welcome => void calls.push(`welcome ${welcome.nodeId}`),
      onStart: spec => void calls.push(`start ${spec.id}`),
      onStop: (id, reason) => void calls.push(`stop ${id}${reason ? ` ${reason}` : ''}`),
      onDrain: () => void calls.push('drain'),
      onUndrain: () => void calls.push('undrain'),
      onHeartbeat: () => void calls.push('heartbeat'),
      onDisconnect: (closure, willRetry) => void closures.push({ closure, willRetry }),
      onFatal: closure => void fatal.push(closure),
      ...options.handler,
    },
    helloTimeoutMs: options.helloTimeoutMs,
    backoffInitialMs: 1_000,
    backoffMaxMs: 8_000,
  })
  const rig = { endpoint, link, log, calls, closures, fatal }
  rigs.push(rig)
  return rig
}

const START = {
  type: 'start' as const,
  instance: {
    id: 'devbox-1-c',
    purpose: 'match' as const,
    image: 'ghcr.io/ezpug/ezpug-iron/cs2:dev',
    serverId: 'devbox-1-c',
    serverToken: 'ezis_not-a-secret_server_token_0001',
    ports: { game: 27417, tv: 27422 },
    env: { EZPUG_IRON_URL: 'http://localhost:3430' },
  },
}

describe('the node link', () => {
  it('says hello first, with the token and its kind, and resolves on welcome', async () => {
    const rig = await createRig({ tokenKind: 'enrolment', nodeId: 'venue-1' })
    const welcome = await rig.link.connectOnce()
    expect(welcome).toMatchObject({ nodeId: 'venue-1', nodeToken: expect.stringMatching(/^ezin_/) })
    const hello = await rig.endpoint.next('hello')
    expect(hello).toEqual({
      type: 'hello',
      protocol: 1,
      token: NODE_TOKEN,
      tokenKind: 'enrolment',
      ...HELLO,
    })
    expect(rig.link.connected()).toBe(true)
    expect(rig.log.lines.join('\n')).not.toContain(NODE_TOKEN)
  })

  it('sends nothing before welcome and everything after', async () => {
    const rig = await createRig({
      onHello: () => ({ code: LINK_CLOSE_CODES.helloTimeout, reason: 'slow' }),
    })
    expect(rig.link.send({ type: 'heartbeat' })).toBe(false)
    await expect(rig.link.connectOnce()).rejects.toBeInstanceOf(NodeLinkClosedError)
    expect(rig.link.send({ type: 'heartbeat' })).toBe(false)
    expect(rig.endpoint.frames().map(frame => frame.type)).toEqual(['hello'])
  })

  it('heartbeats on the clock at the interval welcome gave, and stops when the socket goes', async () => {
    const rig = await createRig({ heartbeatIntervalMs: 5_000 })
    rig.link.run()
    await eventually(() => expect(rig.link.connected()).toBe(true))
    await clock.advance(4_999)
    expect(rig.calls.filter(call => call === 'heartbeat')).toHaveLength(0)
    await clock.advance(1)
    await clock.advance(5_000)
    expect(rig.calls.filter(call => call === 'heartbeat')).toHaveLength(2)
    await eventually(() =>
      expect(rig.endpoint.frames().map(frame => frame.type)).toEqual([
        'hello',
        'heartbeat',
        'heartbeat',
      ]),
    )
    await rig.link.close()
    await clock.advance(20_000)
    expect(rig.calls.filter(call => call === 'heartbeat')).toHaveLength(2)
    expect(clock.pending()).toBe(0)
  })

  it('applies start, stop, drain and undrain in the order they arrive', async () => {
    const rig = await createRig()
    rig.link.run()
    const session = await rig.endpoint.nextSession()
    await eventually(() => expect(rig.calls).toEqual(['welcome devbox']))
    session.send(START)
    session.send({ type: 'drain' })
    session.send({ type: 'stop', instanceId: 'devbox-1-c', reason: 'released' })
    session.send({ type: 'undrain' })
    await eventually(() =>
      expect(rig.calls).toEqual([
        'welcome devbox',
        'start devbox-1-c',
        'drain',
        'stop devbox-1-c released',
        'undrain',
      ]),
    )
  })

  it('dials again with capped, doubling backoff after the orchestrator hangs up, reset by a welcome', async () => {
    const rig = await createRig()
    rig.link.run()
    const first = await rig.endpoint.nextSession()
    await eventually(() => expect(rig.link.connected()).toBe(true))

    first.close(LINK_CLOSE_CODES.shuttingDown, 'deploy')
    await eventually(() => expect(rig.closures).toHaveLength(1))
    expect(rig.closures[0]).toEqual({ closure: { code: 4012, reason: 'deploy' }, willRetry: true })
    expect(rig.link.connected()).toBe(false)
    expect(rig.log.lines.at(-1)).toBe(
      'warn the node link closed 4012 (deploy); dialling again in 1000ms',
    )

    // The endpoint refuses (a draining orchestrator's 503) for a while: the
    // delays double — 1 s after the first loss, then 2 s, 4 s, 8 s, 8 s.
    rig.endpoint.setRefusing(true)
    const delays: number[] = []
    for (const expected of [1_000, 2_000, 4_000, 8_000, 8_000]) {
      const before = rig.closures.length
      await clock.advance(expected)
      await eventually(() => expect(rig.closures.length).toBe(before + 1))
      const line = rig.log.lines.at(-1) ?? ''
      delays.push(Number(line.match(/dialling again in (\d+)ms/)?.[1]))
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 8_000, 8_000])
    expect(
      rig.closures.slice(1).every(entry => entry.closure.code === 1006 && entry.willRetry),
    ).toBe(true)

    rig.endpoint.setRefusing(false)
    await clock.advance(8_000)
    const second = await rig.endpoint.nextSession()
    await eventually(() => expect(rig.link.connected()).toBe(true))
    expect(rig.calls.filter(call => call.startsWith('welcome'))).toHaveLength(2)

    // Reset: the next loss waits one second again.
    second.close(LINK_CLOSE_CODES.replaced, 'newer socket')
    await eventually(() =>
      expect(rig.log.lines.at(-1)).toMatch(
        /closed 4005 \(newer socket\); dialling again in 1000ms/,
      ),
    )
  })

  it('stops for good on a decision: unauthorized, protocol mismatch, malformed, revoked', async () => {
    for (const code of [
      LINK_CLOSE_CODES.unauthorized,
      LINK_CLOSE_CODES.protocolMismatch,
      LINK_CLOSE_CODES.malformed,
      LINK_CLOSE_CODES.revoked,
    ]) {
      const rig = await createRig({ onHello: () => ({ code, reason: `code ${code}` }) })
      rig.link.run()
      await eventually(() => expect(rig.fatal).toHaveLength(1))
      expect(rig.fatal[0]).toEqual({ code, reason: `code ${code}` })
      expect(rig.closures).toEqual([
        { closure: { code, reason: `code ${code}` }, willRetry: false },
      ])
      await clock.advance(60_000)
      expect(rig.endpoint.sessions).toHaveLength(1)
      expect(() => rig.link.run()).toThrow(/was closed/)
    }
  })

  it('hangs up and dials again when no welcome arrives in time', async () => {
    const rig = await createRig({ onHello: () => 'silence', helloTimeoutMs: 3_000 })
    rig.link.run()
    const session = await rig.endpoint.nextSession()
    await eventually(() => expect(session.frames).toHaveLength(1))
    await clock.advance(3_000)
    await eventually(() => expect(rig.closures).toHaveLength(1))
    expect(rig.log.lines).toContain('warn no welcome within 3000ms; hanging up to dial again')
    expect(rig.closures[0]?.closure.code).toBe(1000)
  })

  it('composes the hello afresh at every dial', async () => {
    let instances = 0
    const rig = await createRig({
      hello: () => ({ ...HELLO, instances: [], labels: { n: String(instances++) } }),
    })
    rig.link.run()
    const first = await rig.endpoint.nextSession()
    await eventually(() => expect(rig.link.connected()).toBe(true))
    first.terminate()
    await eventually(() => expect(rig.link.connected()).toBe(false))
    await clock.advance(1_000)
    await rig.endpoint.nextSession()
    await eventually(() =>
      expect(rig.endpoint.frames().filter(f => f.type === 'hello')).toHaveLength(2),
    )
    expect(rig.endpoint.frames().flatMap(f => (f.type === 'hello' ? [f.labels.n] : []))).toEqual([
      '0',
      '1',
    ])
  })

  it('closes with 1000 from the node’s side and leaves no timer armed', async () => {
    const rig = await createRig({ heartbeatIntervalMs: 1_000 })
    rig.link.run()
    const session = await rig.endpoint.nextSession()
    await eventually(() => expect(rig.link.connected()).toBe(true))
    await rig.link.close()
    expect(await session.closed).toEqual({ code: 1000, reason: 'node stopping' })
    expect(clock.pending()).toBe(0)
    expect(rig.closures).toEqual([
      { closure: { code: 1000, reason: 'node stopping' }, willRetry: false },
    ])
  })
})
