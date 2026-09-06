import { eventually, useFakeClock } from '@ezpug/core/testing'
import { LINK_CLOSE_CODES } from '@ezpug/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeAgent, type NodeAgent } from './agent'
import { readNodeConfig } from './config'
import { createFakeDocker, digestFor, type FakeDocker } from './docker/fake'
import { CONTAINER_ENV, INSTANCE_LABELS } from './instances'
import { createMemoryLog } from './log'
import { createMemoryStateStore, type NodeState } from './state'
import {
  createFakeNodeEndpoint,
  FAKE_NODE_TOKEN,
  type FakeNodeEndpoint,
  type FakeNodeEndpointOptions,
} from './testing'

const clock = useFakeClock()

const IMAGE = 'ghcr.io/ezpug/ezpug-iron/cs2:dev'
const ENROLMENT_TOKEN = 'ezie_not-a-secret_enrolment_0001'

interface Rig {
  endpoint: FakeNodeEndpoint
  docker: FakeDocker
  state: ReturnType<typeof createMemoryStateStore>
  log: ReturnType<typeof createMemoryLog>
  agent: NodeAgent
}

const rigs: Rig[] = []
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.agent.close()
    await rig.endpoint.close()
  }
})

function identityFor(endpointUrl: string): NodeState {
  return {
    nodeId: 'devbox',
    nodeToken: FAKE_NODE_TOKEN,
    orchestratorUrl: endpointUrl.replace('ws://', 'http://').replace('/node', ''),
    enrolledAt: '2026-01-01T00:00:00.000Z',
  }
}

async function createRig(
  options: FakeNodeEndpointOptions & {
    enrolled?: boolean
    env?: Record<string, string>
    imageHeld?: boolean
  } = {},
): Promise<Rig> {
  const endpoint = await createFakeNodeEndpoint(options)
  const docker = createFakeDocker()
  if (options.imageHeld ?? true) docker.addImage(IMAGE)
  const identity = identityFor(endpoint.url)
  const state = createMemoryStateStore((options.enrolled ?? true) ? identity : undefined)
  const log = createMemoryLog()
  const config = readNodeConfig({
    EZPUG_NODE_ORCHESTRATOR_URL: identity.orchestratorUrl,
    EZPUG_NODE_MAX_INSTANCES: '2',
    EZPUG_NODE_WARM: '1',
    EZPUG_NODE_LABELS: 'venue=saarlan',
    EZPUG_NODE_POLL_INTERVAL_MS: '1000',
    ...options.env,
  })
  const agent = createNodeAgent({
    config,
    clock,
    log,
    docker,
    state,
    cores: 16,
    backoffInitialMs: 1_000,
    backoffMaxMs: 8_000,
  })
  const rig = { endpoint, docker, state, log, agent }
  rigs.push(rig)
  return rig
}

const startFrame = (id: string, game: number, purpose: 'warm' | 'match' = 'warm') => ({
  type: 'start' as const,
  instance: {
    id,
    purpose,
    image: IMAGE,
    serverId: id,
    serverToken: 'ezis_not-a-secret_server_token_0001',
    ports: { game, tv: game + 5 },
    env: { EZPUG_IRON_URL: 'http://127.0.0.1:3430' },
    ...(purpose === 'match' && { matchId: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b' }),
  },
})

describe('enrolling', () => {
  it('dials once with the enrolment token, keeps the node token on disk and nowhere else, hangs up', async () => {
    const rig = await createRig({ enrolled: false, nodeId: 'venue-1' })
    const identity = await rig.agent.enrol(ENROLMENT_TOKEN)
    expect(identity).toEqual({
      nodeId: 'venue-1',
      nodeToken: FAKE_NODE_TOKEN,
      orchestratorUrl: rig.state.state()?.orchestratorUrl,
      enrolledAt: '2026-01-01T00:00:00.000Z',
    })
    expect(rig.state.state()).toEqual(identity)
    const hello = await rig.endpoint.next('hello')
    expect(hello).toMatchObject({
      token: ENROLMENT_TOKEN,
      tokenKind: 'enrolment',
      version: '0.1.0',
      region: 'eu-central',
      lan: true,
      labels: { cores: '16', venue: 'saarlan' },
      capacity: { maxInstances: 2, warm: 1 },
      imageDigest: digestFor(IMAGE),
      instances: [],
    })
    expect(await rig.endpoint.sessions[0]?.closed).toMatchObject({ code: 1000 })
    const lines = rig.log.lines.join('\n')
    expect(lines).toContain('info enrolled as venue-1')
    expect(lines).not.toContain(FAKE_NODE_TOKEN)
    expect(lines).not.toContain(ENROLMENT_TOKEN)
  })

  it('refuses to enrol twice, and reports a refused enrolment token as the close it was', async () => {
    const rig = await createRig()
    await expect(rig.agent.enrol(ENROLMENT_TOKEN)).rejects.toThrow(/already enrolled as devbox/)
    const refused = await createRig({
      enrolled: false,
      onHello: () => ({ code: LINK_CLOSE_CODES.unauthorized, reason: 'unknown enrolment token' }),
    })
    await expect(refused.agent.enrol(ENROLMENT_TOKEN)).rejects.toThrow(
      /closed 4001 \(unknown enrolment token\)/,
    )
    expect(refused.state.state()).toBeNull()
  })

  it('needs docker and the image before it will say hello, pulling the image when it can', async () => {
    const missing = await createRig({ enrolled: false, imageHeld: false })
    await expect(missing.agent.enrol(ENROLMENT_TOKEN)).rejects.toThrow(/pull access denied/)
    expect(missing.endpoint.sessions).toHaveLength(0)

    const pullable = await createRig({ enrolled: false, imageHeld: false })
    pullable.docker.registry.set(IMAGE, digestFor(IMAGE))
    await pullable.agent.enrol(ENROLMENT_TOKEN)
    expect(pullable.docker.calls).toContain(`pullImage ${IMAGE}`)
    expect((await pullable.endpoint.next('hello')).imageDigest).toBe(digestFor(IMAGE))
  })
})

describe('running', () => {
  it('refuses to run unenrolled or against another orchestrator than it enrolled with', async () => {
    const unenrolled = await createRig({ enrolled: false })
    await expect(unenrolled.agent.run()).rejects.toThrow(/not enrolled .*ezpug-node enrol/)
    const moved = await createRig({ env: { EZPUG_NODE_ORCHESTRATOR_URL: 'http://elsewhere:3430' } })
    await expect(moved.agent.run()).rejects.toThrow(
      /enrolled against .* but configured for http:\/\/elsewhere:3430/,
    )
  })

  it('links with the node token, runs what start says, reports snapshots, stops on stop', async () => {
    const rig = await createRig({ heartbeatIntervalMs: 5_000 })
    void rig.agent.run()
    const session = await rig.endpoint.nextSession()
    const hello = await rig.endpoint.next('hello')
    expect(hello).toMatchObject({ token: FAKE_NODE_TOKEN, tokenKind: 'node', instances: [] })
    await eventually(() => expect(rig.agent.connected()).toBe(true))
    expect(rig.state.health()).toMatchObject({
      nodeId: 'devbox',
      connected: true,
      heartbeatIntervalMs: 5_000,
    })

    session.send(startFrame('devbox-1-a', 27415))
    await eventually(() => expect(rig.agent.snapshot()[0]?.state).toBe('running'))
    const container = rig.docker.byName('ezpug-node-devbox-1-a')
    expect(container?.spec.env[CONTAINER_ENV.serverToken]).toBe(
      'ezis_not-a-secret_server_token_0001',
    )
    expect(container?.spec.labels[INSTANCE_LABELS.node]).toBe('devbox')
    const starting = await rig.endpoint.next('instances')
    const running = await rig.endpoint.next('instances')
    expect(starting.instances).toMatchObject([{ id: 'devbox-1-a', state: 'starting' }])
    expect(running.instances).toMatchObject([
      { id: 'devbox-1-a', state: 'running', containerId: container?.id },
    ])

    await clock.advance(5_000)
    await eventually(() =>
      expect(rig.endpoint.frames().filter(f => f.type === 'heartbeat')).toHaveLength(1),
    )
    expect(rig.state.health()).toMatchObject({
      connected: true,
      lastLinkAt: clock.now(),
      instances: 1,
    })

    session.send({ type: 'stop', instanceId: 'devbox-1-a', reason: 'released' })
    await eventually(() => expect(rig.agent.snapshot()).toEqual([]))
    expect(rig.docker.containers.size).toBe(0)
    const stopping = await rig.endpoint.next('instances')
    const gone = await rig.endpoint.next('instances')
    expect(stopping.instances).toMatchObject([{ id: 'devbox-1-a', state: 'stopping' }])
    expect(gone.instances).toEqual([])
    expect(rig.log.lines.join('\n')).not.toContain('ezis_not-a-secret')
  })

  it('drains: live instances stay, a start is refused, undrain takes work again; welcome sets it too', async () => {
    const rig = await createRig({ drained: true })
    void rig.agent.run()
    const session = await rig.endpoint.nextSession()
    await eventually(() => expect(rig.agent.connected()).toBe(true))
    expect(rig.agent.drained()).toBe(true)
    session.send(startFrame('devbox-1-a', 27415))
    await eventually(() => expect(rig.agent.snapshot()[0]?.state).toBe('failed'))
    expect(rig.agent.snapshot()[0]?.error).toBe('the node is draining and starts nothing')
    session.send({ type: 'stop', instanceId: 'devbox-1-a' })
    session.send({ type: 'undrain' })
    session.send(startFrame('devbox-1-a', 27415))
    await eventually(() => expect(rig.agent.snapshot()[0]?.state).toBe('running'))
    expect(rig.agent.drained()).toBe(false)
    session.send({ type: 'drain' })
    await eventually(() => expect(rig.agent.drained()).toBe(true))
    expect(rig.agent.snapshot()[0]?.state).toBe('running')
  })

  it('adopts the containers a previous agent left and carries them in the hello', async () => {
    const previous = await createRig()
    void previous.agent.run()
    const session = await previous.endpoint.nextSession()
    await eventually(() => expect(previous.agent.connected()).toBe(true))
    session.send(startFrame('devbox-1-a', 27415, 'match'))
    await eventually(() => expect(previous.agent.snapshot()[0]?.state).toBe('running'))
    await previous.agent.close()
    // Closing the agent did not touch the container.
    expect(previous.docker.byName('ezpug-node-devbox-1-a')?.status).toBe('running')

    const next = await createRig()
    for (const [id, container] of previous.docker.containers)
      next.docker.containers.set(id, container)
    void next.agent.run()
    const hello = await next.endpoint.next('hello')
    expect(hello.instances).toMatchObject([
      {
        id: 'devbox-1-a',
        purpose: 'match',
        state: 'running',
        matchId: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
      },
    ])
    expect(next.log.lines).toContain('info adopted 1 container(s) from a previous run')
  })

  it('reports a container that died, on the clock, as a snapshot', async () => {
    const rig = await createRig()
    void rig.agent.run()
    const session = await rig.endpoint.nextSession()
    await eventually(() => expect(rig.agent.connected()).toBe(true))
    session.send(startFrame('devbox-1-a', 27415))
    await eventually(() => expect(rig.agent.snapshot()[0]?.state).toBe('running'))
    await rig.endpoint.next('instances')
    await rig.endpoint.next('instances')
    rig.docker.exit(rig.docker.byName('ezpug-node-devbox-1-a')!.id, 139)
    await clock.advance(1_000)
    const failed = await rig.endpoint.next('instances')
    expect(failed.instances).toMatchObject([
      { id: 'devbox-1-a', state: 'failed', error: 'exited with code 139' },
    ])
  })

  it('reconnects after the orchestrator restarts, hello carrying the instances as they are', async () => {
    const rig = await createRig()
    void rig.agent.run()
    const first = await rig.endpoint.nextSession()
    await eventually(() => expect(rig.agent.connected()).toBe(true))
    first.send(startFrame('devbox-1-a', 27415))
    await eventually(() => expect(rig.agent.snapshot()[0]?.state).toBe('running'))
    first.close(LINK_CLOSE_CODES.shuttingDown, 'deploy')
    await eventually(() => expect(rig.agent.connected()).toBe(false))
    expect(rig.state.health()?.connected).toBe(false)
    await clock.advance(1_000)
    await rig.endpoint.nextSession()
    await eventually(() => expect(rig.agent.connected()).toBe(true))
    const hellos = rig.endpoint.frames().filter(f => f.type === 'hello')
    expect(hellos[1]?.instances).toMatchObject([{ id: 'devbox-1-a', state: 'running' }])
  })

  it('ends the run on a revoke and says what to do', async () => {
    const rig = await createRig()
    const outcome = rig.agent.run()
    const session = await rig.endpoint.nextSession()
    await eventually(() => expect(rig.agent.connected()).toBe(true))
    session.close(LINK_CLOSE_CODES.revoked, 'node un-enrolled')
    expect(await outcome).toEqual({ fatal: { code: 4009, reason: 'node un-enrolled' } })
    await clock.advance(60_000)
    expect(rig.endpoint.sessions).toHaveLength(1)
  })
})
