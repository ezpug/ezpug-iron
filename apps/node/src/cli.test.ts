import { eventually, useFakeClock } from '@ezpug/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import type { NodeAgent } from './agent'
import { type CliDependencies, runCli, USAGE } from './cli'
import { createFakeDocker, type FakeDocker } from './docker/fake'
import { createMemoryLog } from './log'
import { createMemoryStateStore, type NodeState } from './state'
import { createFakeNodeEndpoint, FAKE_NODE_TOKEN, type FakeNodeEndpoint } from './testing'
import { NODE_AGENT_VERSION } from './version'

const clock = useFakeClock()
const IMAGE = 'ghcr.io/ezpug/ezpug-iron/cs2:dev'

interface Rig {
  endpoint: FakeNodeEndpoint
  docker: FakeDocker
  state: ReturnType<typeof createMemoryStateStore>
  log: ReturnType<typeof createMemoryLog>
  out: string[]
  signal: () => void
  agents: NodeAgent[]
  run: (argv: string[]) => Promise<number>
}

const rigs: Rig[] = []
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    for (const agent of rig.agents) await agent.close()
    await rig.endpoint.close()
  }
})

async function createRig(options: { enrolled?: boolean } = {}): Promise<Rig> {
  const endpoint = await createFakeNodeEndpoint({ heartbeatIntervalMs: 5_000 })
  const orchestratorUrl = endpoint.url.replace('ws://', 'http://').replace('/node', '')
  const identity: NodeState = {
    nodeId: 'devbox',
    nodeToken: FAKE_NODE_TOKEN,
    orchestratorUrl,
    enrolledAt: '2026-01-01T00:00:00.000Z',
  }
  const docker = createFakeDocker()
  docker.addImage(IMAGE)
  const state = createMemoryStateStore((options.enrolled ?? true) ? identity : undefined)
  const log = createMemoryLog()
  const out: string[] = []
  const agents: NodeAgent[] = []
  let handler: () => void = () => undefined
  const dependencies: CliDependencies = {
    env: { EZPUG_NODE_ORCHESTRATOR_URL: orchestratorUrl, EZPUG_NODE_WARM: '0' },
    clock,
    log,
    stdout: line => void out.push(...line.split('\n')),
    docker: () => docker,
    state: () => state,
    onSignal: fn => {
      handler = fn
      return () => undefined
    },
    onAgent: agent => void agents.push(agent),
  }
  const rig: Rig = {
    endpoint,
    docker,
    state,
    log,
    out,
    signal: () => handler(),
    agents,
    run: argv => runCli(argv, dependencies),
  }
  rigs.push(rig)
  return rig
}

describe('ezpug-node', () => {
  it('prints usage and the version, and refuses a verb it does not know', async () => {
    const rig = await createRig()
    expect(await rig.run(['--help'])).toBe(0)
    expect(rig.out.join('\n')).toBe(USAGE)
    rig.out.length = 0
    expect(await rig.run(['--version'])).toBe(0)
    expect(rig.out).toEqual([NODE_AGENT_VERSION])
    rig.out.length = 0
    expect(await rig.run(['dance'])).toBe(64)
    expect(rig.out[0]).toBe("unknown command 'dance'")
  })

  it('enrol needs a token, prints the node id and never the token', async () => {
    const rig = await createRig({ enrolled: false })
    expect(await rig.run(['enrol'])).toBe(64)
    expect(await rig.run(['enrol', 'ezie_not-a-secret_enrolment_0001'])).toBe(0)
    expect(rig.out.at(-1)).toBe('enrolled as devbox; now run `ezpug-node run`')
    expect(rig.state.state()?.nodeToken).toBe(FAKE_NODE_TOKEN)
    expect(`${rig.out.join('\n')}\n${rig.log.lines.join('\n')}`).not.toContain(FAKE_NODE_TOKEN)
  })

  it('run serves until a signal, then stops the agent and leaves the containers', async () => {
    const rig = await createRig()
    const exit = rig.run(['run'])
    await eventually(() => expect(rig.agents[0]?.connected()).toBe(true))
    rig.endpoint.current()?.send({
      type: 'start',
      instance: {
        id: 'devbox-1-a',
        purpose: 'warm',
        image: IMAGE,
        serverId: 'devbox-1-a',
        serverToken: 'ezis_not-a-secret_server_token_0001',
        ports: { game: 27415, tv: 27420 },
        env: {},
      },
    })
    await eventually(() => expect(rig.agents[0]?.snapshot()[0]?.state).toBe('running'))
    rig.signal()
    expect(await exit).toBe(0)
    expect(rig.docker.byName('ezpug-node-devbox-1-a')?.status).toBe('running')
    expect(rig.log.lines).toContain(
      'info stopping — the containers keep running; a restarted agent adopts them',
    )
  })

  it('run exits 2 when the orchestrator revokes the node, and says what to do', async () => {
    const rig = await createRig()
    const exit = rig.run(['run'])
    const session = await rig.endpoint.nextSession()
    await eventually(() => expect(rig.agents[0]?.connected()).toBe(true))
    session.close(4009, 'un-enrolled')
    expect(await exit).toBe(2)
    expect(rig.log.lines.at(-1)).toMatch(
      /refused this node \(4009 un-enrolled\).*ezpug-node forget/,
    )
  })

  it('run without an identity fails with the enrol hint', async () => {
    const rig = await createRig({ enrolled: false })
    await expect(rig.run(['run'])).rejects.toThrow(/ezpug-node enrol <token>/)
  })

  it('status says what this host is, without a token', async () => {
    const rig = await createRig()
    await rig.docker.createContainer({
      name: 'ezpug-node-devbox-1-a',
      image: IMAGE,
      env: {},
      labels: {
        'com.ezpug.node.managed': 'true',
        'com.ezpug.node.id': 'devbox',
        'com.ezpug.node.instance': 'devbox-1-a',
        'com.ezpug.node.purpose': 'warm',
        'com.ezpug.node.server-id': 'devbox-1-a',
        'com.ezpug.node.game-port': '27415',
        'com.ezpug.node.tv-port': '27420',
      },
      binds: [],
      tty: true,
      stopTimeoutSeconds: 1,
    })
    await rig.state.writeHealth({
      nodeId: 'devbox',
      connected: true,
      lastLinkAt: clock.now() - 4_000,
      heartbeatIntervalMs: 5_000,
      instances: 1,
    })
    expect(await rig.run(['status'])).toBe(0)
    const text = rig.out.join('\n')
    expect(text).toContain('identity      devbox, enrolled 2026-01-01T00:00:00.000Z')
    expect(text).toContain('docker        ok')
    expect(text).toMatch(/image {9}ghcr.io\/ezpug\/ezpug-iron\/cs2:dev @ sha256:/)
    expect(text).toContain('containers    1')
    expect(text).toContain('  devbox-1-a               warm  starting 27415/27420')
    expect(text).toContain('link          up, last heartbeat 4s ago (1 instance(s) reported)')
    expect(text).not.toContain(FAKE_NODE_TOKEN)
  })

  it('status without docker says so and fails', async () => {
    const rig = await createRig()
    rig.docker.failNext('ping', 'docker is not reachable at /var/run/docker.sock: ENOENT')
    expect(await rig.run(['status'])).toBe(1)
    expect(rig.out.join('\n')).toContain(
      'docker        docker is not reachable at /var/run/docker.sock: ENOENT',
    )
  })

  it('health is the image’s check: up recently, or not', async () => {
    const rig = await createRig()
    expect(await rig.run(['health'])).toBe(1)
    expect(rig.out.at(-1)).toBe('unhealthy: the link has never been up')
    const write = (connected: boolean, ageMs: number) =>
      rig.state.writeHealth({
        nodeId: 'devbox',
        connected,
        lastLinkAt: clock.now() - ageMs,
        heartbeatIntervalMs: 5_000,
        instances: 2,
      })
    await write(true, 14_000)
    expect(await rig.run(['health'])).toBe(0)
    expect(rig.out.at(-1)).toBe('healthy: linked as devbox, 2 instance(s)')
    await write(true, 16_000)
    expect(await rig.run(['health'])).toBe(1)
    expect(rig.out.at(-1)).toBe('unhealthy: no heartbeat for 16s')
    await write(false, 1_000)
    expect(await rig.run(['health'])).toBe(1)
    expect(rig.out.at(-1)).toBe('unhealthy: the link is down (last up 1s ago)')
  })

  it('forget drops the identity and names the orchestrator’s half', async () => {
    const rig = await createRig()
    expect(await rig.run(['forget'])).toBe(0)
    expect(rig.out.at(-1)).toBe(
      'forgot devbox. The orchestrator still lists it until DELETE /v1/fleet/nodes/devbox.',
    )
    expect(rig.state.state()).toBeNull()
    expect(await rig.run(['forget'])).toBe(0)
    expect(rig.out.at(-1)).toBe('nothing to forget: this host is not enrolled')
  })
})
