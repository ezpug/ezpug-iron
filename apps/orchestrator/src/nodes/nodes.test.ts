import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPrng } from '@ezpug/core'
import type { MatchRequest, MatchRequestInput } from '@ezpug/match-api'
import { matchRequestSchema } from '@ezpug/match-api'
import { LINK_CLOSE_CODES, NODE_LINK_PATH } from '@ezpug/protocol'
import { createFakeNode, type FakeNode, LinkClosedError } from '@ezpug/protocol/fake-node'
import { createFakeServer, type FakeServer } from '@ezpug/protocol/fake-server'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from '../http/testing'
import type { AuthenticatedKey } from '../keys/service'
import { attachNodeLink, type NodeLink } from '../link/node-link'
import { attachServerLink, type ServerLink } from '../link/server-link'
import { createNodesProvider, type NodesProvider } from '../providers/nodes/provider'
import { attachUpgradeRouter } from '../stream/upgrade'

/**
 * **A node, end to end** (PRD-02 T12): the orchestrator composed over memory
 * on a fake clock, `/node` and `/link` on a real port, the fake node from
 * `@ezpug/protocol/fake-node` dialling in as an `ezpug-node` agent would and
 * the fake server dialling in as the containers it starts. Everything below
 * is what an operator does — enrol, watch capacity appear, run a `lan` match,
 * drain, un-enrol — and what happens to the ledger while they do it.
 */

const IMAGE = 'ghcr.io/ezpug/ezpug-iron/cs2:test'
const SECRET_ID = 'whsec-1'
const SECRET = 'a-test-secret-of-at-least-thirty-two-chars'

const tk = { steamId64: '76561198279375306', name: 'tk', locale: 'de' } as const
const maex = { steamId64: '76561198279375307', name: 'maex', locale: 'en' } as const

/** One `clientMatchId` per request in a file — the replay check is per key, not per test. */
const clientMatchIds = createPrng('nodes-test')

function request(overrides: Partial<MatchRequestInput> = {}): MatchRequest {
  return matchRequestSchema.parse({
    clientMatchId: `platform-${clientMatchIds.int(1, 1_000_000_000)}`,
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'Team tk', players: [tk] },
      teamB: { name: 'Team maex', players: [maex] },
    },
    maps: [{ map: 'de_mirage', sides: 'knife' }],
    requirements: { lan: true },
    callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: SECRET_ID },
    ttlMinutes: 120,
    ...overrides,
  })
}

interface NodeRig {
  app: TestApp
  provider: NodesProvider
  link: ServerLink
  nodeLink: NodeLink
  url: string
  key: AuthenticatedKey
  secret: string
  /** Enrol a node through the route and dial it in; resolves once it is welcomed. */
  enrol: (
    id?: string,
    hello?: Parameters<typeof createFakeNode>[0]['hello'],
    options?: { autoStart?: boolean; refuseStarts?: string },
  ) => Promise<FakeNode>
  /** The one-time token, without dialling. */
  enrolmentToken: (id?: string, region?: string) => Promise<string>
  /** A container's plugin, dialling `/link` with the token a `start` carried. */
  dial: (token: string) => FakeServer
  settle: () => Promise<void>
  close: () => Promise<void>
}

const rigs: NodeRig[] = []
const fakes: { close: () => unknown }[] = []

async function createNodeRig(): Promise<NodeRig> {
  const holder: { link?: NodeLink } = {}
  const app = createTestApp({
    noProviders: true,
    disconnectNode: (nodeId, code, reason) =>
      holder.link?.disconnect(nodeId, code, reason) ?? false,
  })
  const server: Server = createServer()
  const router = attachUpgradeRouter(server, { log: app.log })
  const nodeLink = attachNodeLink({
    router,
    clock: app.clock,
    log: app.log,
    store: app.store,
    registry: app.nodeRegistry,
  })
  holder.link = nodeLink
  const link = attachServerLink({
    router,
    clock: app.clock,
    log: app.log,
    store: app.store,
    matches: app.matches,
    links: app.links,
  })
  const provider = createNodesProvider({
    clock: app.clock,
    log: app.log,
    store: app.store,
    registry: app.nodeRegistry,
    image: IMAGE,
    baseUrl: 'http://localhost:3430',
    link: () => link,
    facts: { emit: (matchId, fact) => app.matches.emit(matchId, fact) },
  })
  app.providers.register(provider)
  const port = await new Promise<number>(resolve =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  )
  const minted = await app.keys.mint({
    name: 'operator',
    scopes: ['matches', 'fleet', 'admin'],
    budget: { maxConcurrentServers: 8, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [{ id: SECRET_ID, secret: SECRET }],
  })
  const key = (await app.keys.get(minted.key.id)) as AuthenticatedKey

  /**
   * Everything this rig can still be doing: the match machine and its
   * deliveries, the two links' tracked writes, and the provider's own
   * deferred work (a warm top-up, an assignment sent off the walk's chain).
   * What crosses a socket is awaited by the frame a test expects, never by
   * this — a barrier cannot hurry the network.
   */
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 5; round += 1) {
      await provider.settle()
      await nodeLink.settle()
      await link.settle()
      await app.settle()
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  const rig: NodeRig = {
    app,
    provider,
    link,
    nodeLink,
    url: `ws://127.0.0.1:${port}${NODE_LINK_PATH}`,
    key,
    secret: minted.secret,
    enrolmentToken: async (id = 'devbox', region = 'saarland') => {
      const enrolment = await app.nodes.enrol(
        { id, region, labels: { address: '10.0.0.9' } },
        key.key.id,
      )
      return enrolment.token
    },
    enrol: async (id = 'devbox', hello, options) => {
      const token = await rig.enrolmentToken(id)
      const node = createFakeNode({
        url: rig.url,
        token,
        tokenKind: 'enrolment',
        ...(hello && { hello }),
        ...(options?.autoStart !== undefined && { autoStart: options.autoStart }),
        ...(options?.refuseStarts !== undefined && { refuseStarts: options.refuseStarts }),
      })
      fakes.push({ close: () => void node.close() })
      await node.connect()
      await settle()
      return node
    },
    dial: token => {
      const fake = createFakeServer({ url: `ws://127.0.0.1:${port}/link`, token })
      fakes.push({ close: () => void fake.close() })
      return fake
    },
    settle,
    close: async () => {
      provider.close()
      await nodeLink.close()
      await link.close()
      await app.close()
      await new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
  rigs.push(rig)
  return rig
}

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close()
  for (const rig of rigs.splice(0)) await rig.close()
})

const openRows = (rig: NodeRig) => rig.app.store.rows.servers.filter(row => row.releasedAt === null)

describe('enrolment', () => {
  it('hands the node token over exactly once, on the hello that spends the enrolment', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol()
    expect(node.nodeId()).toBe('devbox')
    expect(node.nodeToken()).toMatch(/^ezin_/)
    const row = await rig.app.store.findNode('devbox')
    expect(row?.connected).toBe(true)
    expect(row?.version).toBe('0.1.0')
    expect(row?.tokenHash).toBeTruthy()
    // The node token is a hash here and nowhere else in clear.
    expect(row?.tokenHash).not.toBe(node.nodeToken())
  })

  it('refuses a one-time token a second time, and welcomes the node token it bought', async () => {
    const rig = await createNodeRig()
    const token = await rig.enrolmentToken()
    const first = createFakeNode({ url: rig.url, token, tokenKind: 'enrolment' })
    fakes.push({ close: () => void first.close() })
    const welcome = await first.connect()
    const nodeToken = welcome.nodeToken as string
    await first.close()

    const replay = createFakeNode({ url: rig.url, token, tokenKind: 'enrolment' })
    fakes.push({ close: () => void replay.close() })
    await expect(replay.connect()).rejects.toBeInstanceOf(LinkClosedError)
    await expect(replay.connect().catch((error: LinkClosedError) => error.closure)).resolves

    const back = createFakeNode({ url: rig.url, token: nodeToken })
    fakes.push({ close: () => void back.close() })
    await expect(back.connect()).resolves.toMatchObject({ nodeId: 'devbox' })
    // A returning node is handed no token: it already has one.
    expect(back.nodeToken()).toBeUndefined()
  })

  it('refuses a token nobody minted, with the code that stops an agent dialling', async () => {
    const rig = await createNodeRig()
    const stranger = createFakeNode({ url: rig.url, token: 'ezin_not-a-real-node-token-at-all' })
    fakes.push({ close: () => void stranger.close() })
    const closure = await stranger.connect().catch((error: LinkClosedError) => error.closure)
    expect(closure).toMatchObject({ code: LINK_CLOSE_CODES.unauthorized })
  })

  it('revoking closes the socket, kills the token and takes the node off the list', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol()
    const nodeToken = node.nodeToken() as string
    await rig.app.nodes.revoke('devbox')
    expect((await node.closed()).code).toBe(LINK_CLOSE_CODES.revoked)
    expect(await rig.app.nodes.list()).toEqual([])

    const back = createFakeNode({ url: rig.url, token: nodeToken })
    fakes.push({ close: () => void back.close() })
    const closure = await back.connect().catch((error: LinkClosedError) => error.closure)
    expect(closure).toMatchObject({ code: LINK_CLOSE_CODES.unauthorized })
  })

  it('re-enrolling an existing node hangs up on the agent holding the old token', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol()
    await rig.enrolmentToken()
    expect((await node.closed()).code).toBe(LINK_CLOSE_CODES.revoked)
  })

  it('serves the node over the fleet route, with what the socket says and what the ledger knows', async () => {
    const rig = await createNodeRig()
    await rig.enrol('devbox', {
      capacity: { maxInstances: 3, warm: 0 },
      labels: { venue: 'saarlan' },
    })
    const answer = await rig.app.request('/v1/fleet/nodes', { key: rig.secret })
    expect(answer.status).toBe(200)
    expect(answer.body.nodes).toHaveLength(1)
    expect(answer.body.nodes[0]).toMatchObject({
      id: 'devbox',
      region: 'saarland',
      connected: true,
      drained: false,
      capacity: { total: 3, inUse: 0, warm: 0 },
      currentMatches: [],
    })
    expect(JSON.stringify(answer.body)).not.toContain('ezin_')
  })
})

describe('capacity', () => {
  it('offers what a connected node can still run, and zero — never nothing — for one that is away', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol('devbox', { capacity: { maxInstances: 2, warm: 0 } })
    expect(await rig.provider.offerings()).toEqual([
      {
        capabilities: {
          games: ['cs2'],
          region: 'saarland',
          tickrate: 128,
          lan: true,
          workshopMaps: true,
        },
        hourlyCents: 0,
        available: 2,
      },
    ])
    await node.close()
    await rig.settle()
    const away = await rig.provider.offerings()
    expect(away).toHaveLength(1)
    expect(away[0]?.available).toBe(0)
  })

  it('a drained node offers nothing and is told so on the wire', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol()
    await rig.app.nodes.setDrained('devbox', true)
    await rig.settle()
    expect(node.drained()).toBe(true)
    expect((await rig.provider.offerings())[0]?.available).toBe(0)
    await rig.app.nodes.setDrained('devbox', false)
    await rig.settle()
    expect(node.drained()).toBe(false)
    expect((await rig.provider.offerings())[0]?.available).toBeGreaterThan(0)
  })
})

describe('a cold match', () => {
  it('starts a container with the walk’s token, and that container is the match’s server', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol('devbox', { capacity: { maxInstances: 2, warm: 0 } })
    const { match } = await rig.app.matches.create(rig.key, request())
    await rig.settle()

    expect(node.starts()).toHaveLength(1)
    const spec = node.starts()[0]
    if (!spec) throw new Error('the node was never told to start anything')
    expect(spec.purpose).toBe('match')
    expect(spec.image).toBe(IMAGE)
    expect(spec.matchId).toBe(match.id)
    expect(spec.env).toEqual({ EZPUG_IRON_URL: 'http://localhost:3430' })
    expect(spec.ports).toEqual({ game: 27_415, tv: 27_416 })

    // The row the walk opened points at the container, on the node, for free.
    const row = openRows(rig).find(candidate => candidate.matchId === match.id)
    expect(row).toMatchObject({
      provider: 'nodes',
      nodeId: 'devbox',
      serverId: spec.id,
      costHourlyCents: 0,
      lan: true,
      keyId: rig.key.key.id,
    })
    // No `address` label in the hello, so the peer address the socket came
    // from is what players are told — which on this box is loopback.
    expect(row?.address).toEqual({ host: '127.0.0.1', port: 27_415 })

    // And the container's plugin dials in with exactly that token.
    const server = rig.dial(spec.serverToken)
    await server.connect()
    const assign = await server.next('assign')
    expect(assign.matchId).toBe(match.id)
  })

  it('refuses the request at the door when every connected node is full', async () => {
    const rig = await createNodeRig()
    await rig.enrol('devbox', { capacity: { maxInstances: 0, warm: 0 } })
    await expect(rig.app.matches.create(rig.key, request())).rejects.toMatchObject({
      code: 'no_capable_server',
    })
    expect(rig.app.store.rows.servers).toEqual([])
  })

  it('tells players the address a node labelled itself with, over the socket’s own', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol('devbox', {
      capacity: { maxInstances: 2, warm: 0 },
      labels: { address: 'saarlan-1.ezpug.invalid' },
    })
    const { match } = await rig.app.matches.create(rig.key, request())
    await rig.settle()
    await node.next('start')
    const row = openRows(rig).find(candidate => candidate.matchId === match.id)
    expect(row?.address).toEqual({ host: 'saarlan-1.ezpug.invalid', port: 27_415 })
  })
})

describe('the warm pool', () => {
  it('keeps what the node advertises running, each one a ledger row of the enrolling key', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol('devbox', { capacity: { maxInstances: 2, warm: 1 } })
    expect(node.starts()).toHaveLength(1)
    const spec = node.starts()[0]
    if (!spec) throw new Error('nothing was warmed')
    expect(spec.purpose).toBe('warm')
    expect(spec.matchId).toBeUndefined()

    const warm = openRows(rig)
    expect(warm).toHaveLength(1)
    expect(warm[0]).toMatchObject({
      provider: 'nodes',
      nodeId: 'devbox',
      serverId: spec.id,
      matchId: null,
      costHourlyCents: 0,
      keyId: rig.key.key.id,
    })
    // Idempotent: a second snapshot does not warm a second container.
    node.report()
    await rig.settle()
    expect(node.starts()).toHaveLength(1)
  })

  it('a match claims the warm container: no second start, the warm row closes, the assignment goes down the socket it already holds', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol('devbox', { capacity: { maxInstances: 2, warm: 1 } })
    const spec = node.starts()[0]
    if (!spec) throw new Error('nothing was warmed')
    const warmRowId = openRows(rig)[0]?.id

    // The container dials in under its warm row and sits idle.
    const server = rig.dial(spec.serverToken)
    await server.connect()
    await rig.settle()
    expect(server.assignment()).toBeUndefined()

    const { match } = await rig.app.matches.create(rig.key, request())
    await rig.settle()

    // Nothing new was started; the same container took the match.
    expect(node.starts()).toHaveLength(1)
    const assign = await server.next('assign')
    expect(assign.matchId).toBe(match.id)

    // One open row for one container, charged to the match's key; the warm
    // row it booted with is closed and says by whom.
    const open = openRows(rig)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      matchId: match.id,
      keyId: rig.key.key.id,
      serverId: spec.id,
      nodeId: 'devbox',
    })
    expect(open[0]?.id).not.toBe(warmRowId)
    const closed = rig.app.store.rows.servers.find(row => row.id === warmRowId)
    expect(closed).toMatchObject({
      state: 'released',
      releasedReason: `claimed by match ${match.id}`,
    })

    // The events the container speaks now belong to the match it was given.
    const [ack] = await server.emit({
      type: 'server_ready',
      matchId: match.id,
      source: { provider: 'nodes', serverId: spec.id },
      map: 'de_mirage',
    })
    expect(ack?.status).toBe('accepted')
  })

  it('refills after the match that claimed it is over', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol('devbox', { capacity: { maxInstances: 2, warm: 1 } })
    const spec = node.starts()[0]
    if (!spec) throw new Error('nothing was warmed')
    const server = rig.dial(spec.serverToken)
    await server.connect()
    await rig.settle()

    const { match } = await rig.app.matches.create(rig.key, request())
    await rig.settle()
    await rig.app.matches.cancel(rig.key, match.id)
    await rig.settle()

    expect(node.stops()).toContain(spec.id)
    // A fresh warm container took its place.
    const warmed = node.starts().filter(start => start.purpose === 'warm')
    expect(warmed).toHaveLength(2)
    expect(warmed[1]?.id).not.toBe(spec.id)
  })

  it('warms nothing on a node whose enrolling key is gone, and says why once', async () => {
    const rig = await createNodeRig()
    const token = await rig.enrolmentToken('devbox')
    // A ledger row is always somebody's; without a key there is nobody to be.
    await rig.app.store.updateNode('devbox', { enrolledByKeyId: null })
    const node = createFakeNode({
      url: rig.url,
      token,
      tokenKind: 'enrolment',
      hello: { capacity: { maxInstances: 2, warm: 1 } },
    })
    fakes.push({ close: () => void node.close() })
    await node.connect()
    await rig.settle()
    await rig.provider.topUp()
    expect(node.starts()).toEqual([])
    expect(rig.app.log.lines.filter(line => line.includes('no enrolling key'))).toHaveLength(1)
  })
})

describe('a node that goes away', () => {
  it('says fleet.node_disconnected into every match it was holding', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol('devbox', { capacity: { maxInstances: 2, warm: 0 } })
    const { match } = await rig.app.matches.create(rig.key, request())
    await rig.settle()
    await node.close()
    await rig.settle()

    const events = await rig.app.matches.events(rig.key, match.id, 0, 100)
    const fact = events.items.find(item => item.payload.type === 'fleet.node_disconnected')
    expect(fact?.payload).toMatchObject({ type: 'fleet.node_disconnected', node: 'devbox' })
    const row = await rig.app.store.findNode('devbox')
    expect(row?.connected).toBe(false)
  })

  it('keeps listing its containers so the reaper does not call a live match lost', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol('devbox', { capacity: { maxInstances: 2, warm: 0 } })
    await rig.app.matches.create(rig.key, request())
    await rig.settle()
    const before = await rig.provider.list()
    await node.close()
    await rig.settle()
    expect(await rig.provider.list()).toEqual(before)
    const report = await rig.app.reaper.reconcile()
    expect(report.lost).toEqual([])
    expect(report.reaped).toEqual([])
  })

  it('reports its servers gone once it has been away longer than the window', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol('devbox', { capacity: { maxInstances: 2, warm: 0 } })
    await rig.app.matches.create(rig.key, request())
    await rig.settle()
    const serverId = (await rig.provider.list())[0]?.serverId as string
    await node.close()
    await rig.settle()
    expect(await rig.provider.status(serverId)).toMatchObject({ state: 'running' })
    await rig.app.clock.advance(120_000)
    expect(await rig.provider.status(serverId)).toMatchObject({ state: 'gone' })
  })

  it('adopts the containers it already owns when the agent dials back', async () => {
    const rig = await createNodeRig()
    const node = await rig.enrol('devbox', { capacity: { maxInstances: 2, warm: 0 } })
    await rig.app.matches.create(rig.key, request())
    await rig.settle()
    const before = await rig.provider.list()
    await node.close()
    await rig.settle()
    await node.connect()
    await rig.settle()
    expect(await rig.provider.list()).toEqual(before)
    // Adoption is not a second start.
    expect(node.starts().filter(start => start.purpose === 'match')).toHaveLength(1)
  })
})
