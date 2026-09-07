import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDockerodeDocker } from './dockerode'
import type { DockerPort } from './port'

/**
 * **The adapter against the real daemon.** The fake proves the instance
 * manager; this proves the fake is a faithful stand-in for docker on the
 * one thing that cannot be faked — what the daemon actually does with a
 * create, a start, a stop, a remove and a list by label. It runs when this
 * box has a docker socket (the dev world already needs one) and skips with
 * a printed reason otherwise; `EZPUG_NODE_DOCKER_TESTS=required` makes the
 * skip a red run. A tiny image, a label unique to this run, and nothing
 * left behind.
 *
 * **And nothing left behind by a run that died either** (PRD-02 T37b). The
 * `afterAll` cleans up what this run created, but a Vitest killed mid-test
 * never reaches it — the rehearsal found three busybox containers from an
 * interrupted run 35 hours old on this box. So the suite starts by sweeping
 * every container carrying {@link SUITE_LABEL}, whatever run made it: that
 * label is on this test's containers and on nothing else, which is why the
 * sweep can be unconditional and `com.ezpug.node.managed` — a real node's
 * label — can never be swept from here.
 */

const SOCKET = process.env.EZPUG_NODE_DOCKER_SOCKET ?? '/var/run/docker.sock'
const REQUIRED = process.env.EZPUG_NODE_DOCKER_TESTS === 'required'
const IMAGE = 'busybox:1.37'
const RUN_LABEL = 'com.ezpug.node.test-run'
/** On every container this file ever creates, with the same value: what the sweep finds. */
const SUITE_LABEL = 'com.ezpug.node.test-suite'
const SUITE = 'dockerode'
const RUN_ID = randomUUID()
const NAME = `ezpug-node-test-${RUN_ID}`

async function daemonReachable(docker: DockerPort): Promise<string | null> {
  try {
    await docker.ping()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const available = existsSync(SOCKET)
if (!available && REQUIRED)
  throw new Error(`EZPUG_NODE_DOCKER_TESTS=required but there is no docker socket at ${SOCKET}`)
if (!available) console.log(`skipping the dockerode suite: no docker socket at ${SOCKET}`)

describe.skipIf(!available)('the dockerode adapter against the daemon', () => {
  const docker = createDockerodeDocker({ socketPath: SOCKET })
  const created: string[] = []

  /** Whatever an interrupted run left behind, before this one adds to it. */
  beforeAll(async () => {
    const leftovers = await docker.listContainers({ [SUITE_LABEL]: SUITE }).catch(() => [])
    for (const leftover of leftovers) {
      console.log(`sweeping a leftover from an interrupted run: ${leftover.name}`)
      await docker.removeContainer(leftover.id).catch(() => undefined)
    }
  })

  afterAll(async () => {
    for (const id of created) await docker.removeContainer(id).catch(() => undefined)
  })

  it('creates, starts, lists by label, stops and removes a container the way the port promises', async ctx => {
    const unreachable = await daemonReachable(docker)
    if (unreachable) {
      if (REQUIRED) throw new Error(unreachable)
      console.log(`skipping the dockerode suite: ${unreachable}`)
      ctx.skip()
      return
    }
    if ((await docker.imageDigest(IMAGE)) === null) {
      try {
        await docker.pullImage(IMAGE)
      } catch (error) {
        if (REQUIRED) throw error
        console.log(`skipping the dockerode suite: cannot pull ${IMAGE} (${String(error)})`)
        ctx.skip()
        return
      }
    }
    const digest = await docker.imageDigest(IMAGE)
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await docker.imageDigest('ezpug/does-not-exist:never')).toBeNull()

    const id = await docker.createContainer({
      name: NAME,
      image: IMAGE,
      env: { EZPUG_TEST: 'yes' },
      labels: { [RUN_LABEL]: RUN_ID, [SUITE_LABEL]: SUITE, 'com.ezpug.node.managed': 'true' },
      binds: [],
      tty: false,
      stopTimeoutSeconds: 1,
    })
    created.push(id)
    expect(await docker.inspectContainer(id)).toMatchObject({
      id,
      name: NAME,
      status: 'created',
      labels: { [RUN_LABEL]: RUN_ID },
    })

    // The image's default command (`sh`) exits at once without a tty, so
    // the container is `running` or already `exited` by the time it is
    // listed; either is docker's truth, and both are what the port reports.
    await docker.startContainer(id)
    await docker.startContainer(id) // 304 or a second start: nothing either way
    const listed = await docker.listContainers({ [RUN_LABEL]: RUN_ID })
    expect(listed.map(entry => entry.id)).toEqual([id])
    expect(listed[0]).toMatchObject({ name: NAME, image: IMAGE, labels: { [RUN_LABEL]: RUN_ID } })
    expect(['running', 'exited']).toContain(listed[0]?.status)

    await docker.stopContainer(id, 1)
    await docker.stopContainer(id, 1) // already stopped: nothing
    const stopped = await docker.inspectContainer(id)
    expect(stopped?.status).toBe('exited')
    expect(typeof stopped?.exitCode).toBe('number')
    const relisted = await docker.listContainers({ [RUN_LABEL]: RUN_ID })
    expect(relisted[0]?.status).toBe('exited')
    expect(typeof relisted[0]?.exitCode).toBe('number')

    await docker.removeContainer(id)
    await docker.removeContainer(id) // already gone: nothing
    await docker.stopContainer(id, 1) // gone: nothing
    expect(await docker.inspectContainer(id)).toBeNull()
    expect(await docker.listContainers({ [RUN_LABEL]: RUN_ID })).toEqual([])
    created.length = 0
  })
})
