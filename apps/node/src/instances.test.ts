import { useFakeClock } from '@ezpug/core/testing'
import type { InstanceSpec, NodeInstance } from '@ezpug/protocol'
import { describe, expect, it } from 'vitest'
import { GAME_MOUNT_PATH, GAMEMODES_MOUNT_PATH } from './config'
import { createFakeDocker, digestFor, type FakeDocker } from './docker/fake'
import {
  CONTAINER_ENV,
  containerSpecFor,
  createInstanceManager,
  INSTANCE_LABELS,
  type InstanceManager,
  instanceFromContainer,
} from './instances'
import { createMemoryLog } from './log'

const IMAGE = 'ghcr.io/ezpug/ezpug-iron/cs2:dev'
const MATCH_ID = '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b'

function spec(overrides: Partial<InstanceSpec> = {}): InstanceSpec {
  return {
    id: 'devbox-1-a',
    purpose: 'warm',
    image: IMAGE,
    serverId: 'devbox-1-a',
    serverToken: 'ezis_not-a-secret_server_token_0001',
    ports: { game: 27415, tv: 27420 },
    env: { EZPUG_IRON_URL: 'http://127.0.0.1:3430' },
    ...overrides,
  }
}

interface Rig {
  docker: FakeDocker
  manager: InstanceManager
  log: ReturnType<typeof createMemoryLog>
  snapshots: NodeInstance[][]
}

const clock = useFakeClock()

function rig(
  options: { nodeId?: string | null; maxInstances?: number; gamemodesDir?: string | null } = {},
): Rig {
  const docker = createFakeDocker()
  docker.addImage(IMAGE)
  const log = createMemoryLog()
  const snapshots: NodeInstance[][] = []
  const manager = createInstanceManager({
    docker,
    clock,
    log,
    nodeId: () => (options.nodeId === undefined ? 'devbox' : options.nodeId),
    maxInstances: options.maxInstances ?? 2,
    gameVolume: 'ezpug-iron-cs2_cs2-data',
    gamemodesDir: options.gamemodesDir ?? null,
    stopTimeoutSeconds: 20,
    pollIntervalMs: 2_000,
    onChange: snapshot => void snapshots.push(snapshot),
  })
  return { docker, manager, log, snapshots }
}

const states = (snapshots: NodeInstance[][]): string[] =>
  snapshots.map(snapshot => snapshot.map(i => `${i.id}:${i.state}`).join(',') || '-')

describe('containerSpecFor', () => {
  it('is the container the server image expects: host env, labels, the game volume, a tty', () => {
    const container = containerSpecFor(spec({ purpose: 'match', matchId: MATCH_ID }), {
      nodeId: 'devbox',
      gameVolume: 'cs2',
      gamemodesDir: '/srv/gamemodes',
      stopTimeoutSeconds: 15,
    })
    expect(container).toEqual({
      name: 'ezpug-node-devbox-1-a',
      image: IMAGE,
      env: {
        EZPUG_IRON_URL: 'http://127.0.0.1:3430',
        [CONTAINER_ENV.serverToken]: 'ezis_not-a-secret_server_token_0001',
        [CONTAINER_ENV.gamePort]: '27415',
        [CONTAINER_ENV.tvPort]: '27420',
      },
      labels: {
        [INSTANCE_LABELS.managed]: 'true',
        [INSTANCE_LABELS.node]: 'devbox',
        [INSTANCE_LABELS.instance]: 'devbox-1-a',
        [INSTANCE_LABELS.purpose]: 'match',
        [INSTANCE_LABELS.serverId]: 'devbox-1-a',
        [INSTANCE_LABELS.matchId]: MATCH_ID,
        [INSTANCE_LABELS.gamePort]: '27415',
        [INSTANCE_LABELS.tvPort]: '27420',
      },
      binds: [`cs2:${GAME_MOUNT_PATH}`, `/srv/gamemodes:${GAMEMODES_MOUNT_PATH}:ro`],
      tty: true,
      stopTimeoutSeconds: 15,
    })
  })

  it('round-trips through the labels a container carries', () => {
    const container = containerSpecFor(spec({ purpose: 'match', matchId: MATCH_ID }), {
      nodeId: 'devbox',
      gameVolume: 'cs2',
      gamemodesDir: null,
      stopTimeoutSeconds: 15,
    })
    expect(
      instanceFromContainer({
        id: 'abc',
        name: container.name,
        image: IMAGE,
        labels: container.labels,
        status: 'running',
      }),
    ).toEqual({
      id: 'devbox-1-a',
      purpose: 'match',
      state: 'running',
      serverId: 'devbox-1-a',
      containerId: 'abc',
      ports: { game: 27415, tv: 27420 },
      matchId: MATCH_ID,
    })
    expect(
      instanceFromContainer({ id: 'x', name: 'y', image: IMAGE, labels: {}, status: 'running' }),
    ).toBeNull()
  })
})

describe('the instance manager', () => {
  it('starts a container the way the image expects and reports starting, then running', async () => {
    const { docker, manager, snapshots } = rig()
    await manager.start(spec())
    const container = docker.byName('ezpug-node-devbox-1-a')
    expect(container?.status).toBe('running')
    expect(container?.spec.env[CONTAINER_ENV.serverToken]).toBe(
      'ezis_not-a-secret_server_token_0001',
    )
    expect(container?.spec.binds).toEqual([`ezpug-iron-cs2_cs2-data:${GAME_MOUNT_PATH}`])
    expect(states(snapshots)).toEqual(['devbox-1-a:starting', 'devbox-1-a:running'])
    expect(manager.snapshot()).toEqual([
      {
        id: 'devbox-1-a',
        purpose: 'warm',
        state: 'running',
        serverId: 'devbox-1-a',
        containerId: container?.id,
        ports: { game: 27415, tv: 27420 },
      },
    ])
    expect(docker.calls).toEqual([
      `imageDigest ${IMAGE}`,
      'createContainer ezpug-node-devbox-1-a',
      `startContainer ${container?.id}`,
    ])
  })

  it('pulls an image it does not hold, and fails the instance when it cannot', async () => {
    const { docker, manager, snapshots } = rig()
    const other = 'ghcr.io/ezpug/ezpug-iron/cs2:0.2.0'
    docker.registry.set(other, digestFor(other))
    await manager.start(spec({ image: other }))
    expect(docker.calls).toContain(`pullImage ${other}`)
    expect(manager.snapshot()[0]?.state).toBe('running')

    await manager.start(
      spec({ id: 'devbox-1-b', image: 'nowhere/cs2:9', ports: { game: 27416, tv: 27421 } }),
    )
    expect(manager.snapshot().find(i => i.id === 'devbox-1-b')).toMatchObject({
      state: 'failed',
      error: 'image nowhere/cs2:9: pull access denied for nowhere/cs2:9: not found',
    })
    expect(states(snapshots).at(-1)).toBe('devbox-1-a:running,devbox-1-b:failed')
  })

  it('refuses past capacity, on a port another instance holds, and while drained — as failed instances', async () => {
    const { manager } = rig({ maxInstances: 1 })
    await manager.start(spec())
    await manager.start(spec({ id: 'devbox-1-b', ports: { game: 27416, tv: 27421 } }))
    expect(manager.snapshot().find(i => i.id === 'devbox-1-b')).toMatchObject({
      state: 'failed',
      error: 'capacity: 1 of 1 instances in use',
    })
    await manager.stop('devbox-1-b')

    const roomy = rig({ maxInstances: 4 })
    await roomy.manager.start(spec())
    await roomy.manager.start(spec({ id: 'devbox-1-c', ports: { game: 27420, tv: 27425 } }))
    expect(roomy.manager.snapshot().find(i => i.id === 'devbox-1-c')).toMatchObject({
      state: 'failed',
      error: 'port 27420/27425 is in use by instance devbox-1-a',
    })

    roomy.manager.drain()
    await roomy.manager.start(spec({ id: 'devbox-1-d', ports: { game: 27430, tv: 27435 } }))
    expect(roomy.manager.snapshot().find(i => i.id === 'devbox-1-d')).toMatchObject({
      state: 'failed',
      error: 'the node is draining and starts nothing',
    })
    roomy.manager.undrain()
    await roomy.manager.stop('devbox-1-d')
    await roomy.manager.start(spec({ id: 'devbox-1-d', ports: { game: 27430, tv: 27435 } }))
    expect(roomy.manager.snapshot().find(i => i.id === 'devbox-1-d')?.state).toBe('running')
  })

  it('refuses everything before enrolment', async () => {
    const { manager, docker } = rig({ nodeId: null })
    await manager.start(spec())
    expect(manager.snapshot()[0]).toMatchObject({
      state: 'failed',
      error: 'the node is not enrolled',
    })
    expect(docker.calls).toEqual([])
  })

  it('reports a docker failure honestly and starts again on the next start', async () => {
    const { docker, manager } = rig()
    docker.failNext('createContainer', 'Conflict. The container name is already in use', 409)
    await manager.start(spec())
    expect(manager.snapshot()[0]).toMatchObject({
      state: 'failed',
      error: 'create: Conflict. The container name is already in use',
    })
    docker.failNext('startContainer', 'port 27415 is in use', 500)
    await manager.start(spec())
    expect(manager.snapshot()[0]).toMatchObject({
      state: 'failed',
      error: 'start: port 27415 is in use',
    })
    // The failed container is removed before the retry; the name is free.
    await manager.start(spec())
    expect(manager.snapshot()[0]?.state).toBe('running')
    expect(docker.containers.size).toBe(1)
  })

  it('ignores a start for an instance that already runs', async () => {
    const { docker, manager, log } = rig()
    await manager.start(spec())
    const calls = docker.calls.length
    await manager.start(spec())
    expect(docker.calls.length).toBe(calls)
    expect(log.lines).toContain('info instance devbox-1-a is already running; start ignored')
  })

  it('stops with the configured grace, removes, and forgets; stopping the unknown is nothing', async () => {
    const { docker, manager, snapshots } = rig()
    await manager.start(spec())
    const id = docker.byName('ezpug-node-devbox-1-a')?.id
    await manager.stop('devbox-1-a', 'released')
    expect(docker.containers.size).toBe(0)
    expect(docker.calls.slice(-2)).toEqual([`stopContainer ${id} t=20`, `removeContainer ${id}`])
    expect(states(snapshots).slice(-2)).toEqual(['devbox-1-a:stopping', '-'])
    const calls = docker.calls.length
    await manager.stop('devbox-1-a')
    await manager.stop('never-existed')
    expect(docker.calls.length).toBe(calls)
  })

  it('keeps an instance docker would not let go of, failed, for the next stop', async () => {
    const { docker, manager } = rig()
    await manager.start(spec())
    docker.failNext('removeContainer', 'device or resource busy', 500)
    await manager.stop('devbox-1-a')
    expect(manager.snapshot()[0]).toMatchObject({
      state: 'failed',
      error: 'stop: device or resource busy',
    })
    await manager.stop('devbox-1-a')
    expect(manager.snapshot()).toEqual([])
  })

  it('notices on the clock that a container exited, and that one vanished', async () => {
    const { docker, manager, snapshots, log } = rig({ maxInstances: 4 })
    await manager.start(spec())
    await manager.start(spec({ id: 'devbox-1-b', ports: { game: 27416, tv: 27421 } }))
    manager.watch()
    const [a, b] = [...docker.containers.keys()]
    docker.exit(a!, 137)
    docker.vanish(b!)
    expect(manager.snapshot().every(i => i.state === 'running')).toBe(true)
    await clock.advance(2_000)
    expect(manager.snapshot()).toMatchObject([
      { id: 'devbox-1-a', state: 'failed', error: 'exited with code 137' },
      { id: 'devbox-1-b', state: 'failed', error: 'container vanished' },
    ])
    expect(log.lines).toContain('warn instance devbox-1-a: exited with code 137')
    expect(log.lines).toContain('warn instance devbox-1-b: its container vanished')
    const published = snapshots.length
    await clock.advance(6_000)
    // Nothing changed, nothing published; the poll re-arms itself.
    expect(snapshots.length).toBe(published)
    expect(docker.calls.filter(call => call === 'listContainers').length).toBe(4)
    await manager.close()
    await clock.advance(10_000)
    expect(docker.calls.filter(call => call === 'listContainers').length).toBe(4)
  })

  it('adopts the containers a previous agent left, from their labels', async () => {
    const first = rig({ maxInstances: 4 })
    await first.manager.start(spec({ purpose: 'match', matchId: MATCH_ID }))
    await first.manager.start(spec({ id: 'devbox-1-b', ports: { game: 27416, tv: 27421 } }))
    const stray = await first.docker.createContainer({
      name: 'not-ours',
      image: IMAGE,
      env: {},
      labels: { [INSTANCE_LABELS.managed]: 'true', [INSTANCE_LABELS.node]: 'devbox' },
      binds: [],
      tty: false,
      stopTimeoutSeconds: 1,
    })
    first.docker.exit([...first.docker.containers.keys()][1]!, 1)

    const second = rig({ maxInstances: 4 })
    // The same daemon, a fresh agent.
    for (const [id, container] of first.docker.containers)
      second.docker.containers.set(id, container)
    expect(await second.manager.adopt()).toBe(2)
    expect(second.manager.snapshot()).toMatchObject([
      { id: 'devbox-1-a', purpose: 'match', state: 'running', matchId: MATCH_ID },
      { id: 'devbox-1-b', purpose: 'warm', state: 'failed', error: 'exited with code 1' },
    ])
    expect(second.log.lines).toContain(
      'warn container not-ours carries our labels but not an instance; left alone',
    )
    expect(second.docker.containers.has(stray)).toBe(true)
    // Adopted instances count against capacity and ports like any other.
    await second.manager.start(spec({ id: 'devbox-1-c', ports: { game: 27415, tv: 27499 } }))
    expect(second.manager.snapshot().find(i => i.id === 'devbox-1-c')?.error).toMatch(
      /in use by instance devbox-1-a/,
    )
  })

  it('applies a start and the stop for the same id in the order they arrived', async () => {
    const { manager, docker } = rig()
    const started = manager.start(spec())
    const stopped = manager.stop('devbox-1-a')
    await Promise.all([started, stopped])
    expect(manager.snapshot()).toEqual([])
    expect(docker.containers.size).toBe(0)
  })
})
