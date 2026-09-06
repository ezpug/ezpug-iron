import type { Clock } from '@ezpug/core'
import { createNodeAgent, type NodeAgent } from './agent'
import { type EnvRecord, type NodeConfig, readNodeConfig } from './config'
import { createDockerodeDocker } from './docker/dockerode'
import type { DockerPort } from './docker/port'
import { INSTANCE_LABELS, instanceFromContainer } from './instances'
import type { NodeLinkSocketConstructor } from './link'
import type { Log } from './log'
import { createFileStateStore, type StateStore } from './state'
import { NODE_AGENT_VERSION } from './version'

/**
 * **`ezpug-node`, the command** (PRD-02 T11). Five verbs, enough for an
 * operator who has never read the code (`docs/nodes.md`):
 *
 *     ezpug-node enrol <token>   enrol this host once, with the token the orchestrator showed once
 *     ezpug-node run             dial the orchestrator and serve (the default)
 *     ezpug-node status          what this host is: identity, docker, image, containers, the link
 *     ezpug-node forget          drop the identity after the orchestrator revoked it
 *     ezpug-node health          exit 0 iff the link was up recently — the image's HEALTHCHECK
 *
 * Every dependency is injected so the tests run the real command over the
 * fake docker and a fake endpoint; `main.ts` hands in the real ones.
 */

export const USAGE = `ezpug-node ${NODE_AGENT_VERSION} — the EZPug Iron node agent (docs/nodes.md)

Usage:
  ezpug-node enrol <token>   enrol this host once (the token from POST /v1/fleet/nodes, shown once)
  ezpug-node run             dial the orchestrator and serve (the default)
  ezpug-node status          identity, docker, image, containers, the link's last heartbeat
  ezpug-node forget          drop the identity on this host (after the orchestrator revoked it)
  ezpug-node health          exit 0 when the link was up recently (the image's HEALTHCHECK)
  ezpug-node --help | --version

Configuration is the environment (EZPUG_NODE_*), documented in .env.example:
  EZPUG_NODE_ORCHESTRATOR_URL  the orchestrator's origin (required)
  EZPUG_NODE_STATE_DIR         where node.json (the node token, 0600) lives
  EZPUG_NODE_IMAGE             the server image this host runs
  EZPUG_NODE_GAME_VOLUME       the docker volume with the game install
  EZPUG_NODE_MAX_INSTANCES     servers at once; EZPUG_NODE_WARM idle ones kept ready
  EZPUG_NODE_REGION, EZPUG_NODE_LAN, EZPUG_NODE_LABELS
`

export interface CliDependencies {
  env: EnvRecord
  clock: Clock
  log: Log
  /** Lines for the human, not the log. */
  stdout: (line: string) => void
  /** Default: dockerode over `EZPUG_NODE_DOCKER_SOCKET`. */
  docker?: (config: NodeConfig) => DockerPort
  /** Default: the file store under `EZPUG_NODE_STATE_DIR`. */
  state?: (config: NodeConfig) => StateStore
  WebSocket?: NodeLinkSocketConstructor
  /** Arm SIGTERM/SIGINT to close the agent. Default: the real process signals. */
  onSignal?: (handler: () => void) => () => void
  /** Told about the running agent, so a test can drive it. */
  onAgent?: (agent: NodeAgent) => void
}

/** How many heartbeat intervals of silence `health` tolerates before it says unhealthy. */
export const HEALTH_STALE_INTERVALS = 3

function defaultSignals(handler: () => void): () => void {
  const listener = (): void => handler()
  process.once('SIGTERM', listener)
  process.once('SIGINT', listener)
  return () => {
    process.off('SIGTERM', listener)
    process.off('SIGINT', listener)
  }
}

function compose(dependencies: CliDependencies): {
  config: NodeConfig
  agent: NodeAgent
  docker: DockerPort
  state: StateStore
} {
  const config = readNodeConfig(dependencies.env)
  const docker =
    dependencies.docker?.(config) ?? createDockerodeDocker({ socketPath: config.dockerSocket })
  const state = dependencies.state?.(config) ?? createFileStateStore(config.stateDir)
  const agent = createNodeAgent({
    config,
    clock: dependencies.clock,
    log: dependencies.log,
    docker,
    state,
    WebSocket: dependencies.WebSocket,
  })
  dependencies.onAgent?.(agent)
  return { config, agent, docker, state }
}

async function status(dependencies: CliDependencies): Promise<number> {
  const { config, docker, state } = compose(dependencies)
  const out = dependencies.stdout
  out(`ezpug-node ${NODE_AGENT_VERSION}`)
  out(`orchestrator  ${config.orchestratorUrl} (${config.linkUrl})`)
  const identity = await state.read()
  out(
    identity
      ? `identity      ${identity.nodeId}, enrolled ${identity.enrolledAt} (${state.path})`
      : `identity      not enrolled (no ${state.path}) — ezpug-node enrol <token>`,
  )
  if (identity && identity.orchestratorUrl !== config.orchestratorUrl)
    out(`              ! enrolled against ${identity.orchestratorUrl}, not the configured origin`)
  try {
    await docker.ping()
    out(`docker        ok (${config.dockerSocket})`)
  } catch (error) {
    out(`docker        ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const digest = await docker.imageDigest(config.image)
  out(
    digest
      ? `image         ${config.image} @ ${digest}`
      : `image         ${config.image} not pulled yet`,
  )
  out(
    `capacity      ${config.maxInstances} instance(s), ${config.warm} warm; volume ${config.gameVolume}`,
  )
  if (identity) {
    const containers = await docker.listContainers({
      [INSTANCE_LABELS.managed]: 'true',
      [INSTANCE_LABELS.node]: identity.nodeId,
    })
    out(`containers    ${containers.length}`)
    for (const container of containers) {
      const instance = instanceFromContainer(container)
      out(
        instance
          ? `  ${instance.id.padEnd(24)} ${instance.purpose.padEnd(5)} ${instance.state.padEnd(8)} ` +
              `${instance.ports.game}/${instance.ports.tv}` +
              `${instance.matchId ? ` match ${instance.matchId}` : ''}` +
              `${instance.error ? ` — ${instance.error}` : ''}`
          : `  ${container.name} (${container.status}) carries our labels but not an instance`,
      )
    }
  }
  const health = await state.readHealth()
  if (health) {
    const age = dependencies.clock.now() - health.lastLinkAt
    out(
      `link          ${health.connected ? 'up' : 'down'}, last heartbeat ${Math.round(age / 1000)}s ago` +
        ` (${health.instances} instance(s) reported)`,
    )
  } else out('link          never up on this host')
  return 0
}

async function health(dependencies: CliDependencies): Promise<number> {
  const { state } = compose(dependencies)
  const current = await state.readHealth()
  if (!current) {
    dependencies.stdout('unhealthy: the link has never been up')
    return 1
  }
  const age = dependencies.clock.now() - current.lastLinkAt
  const budget = HEALTH_STALE_INTERVALS * current.heartbeatIntervalMs
  if (!current.connected) {
    dependencies.stdout(`unhealthy: the link is down (last up ${Math.round(age / 1000)}s ago)`)
    return 1
  }
  if (age > budget) {
    dependencies.stdout(`unhealthy: no heartbeat for ${Math.round(age / 1000)}s`)
    return 1
  }
  dependencies.stdout(`healthy: linked as ${current.nodeId}, ${current.instances} instance(s)`)
  return 0
}

async function run(dependencies: CliDependencies): Promise<number> {
  const { agent, config } = compose(dependencies)
  const arm = dependencies.onSignal ?? defaultSignals
  const disarm = arm(() => {
    dependencies.log.info('stopping — the containers keep running; a restarted agent adopts them')
    void agent.close()
  })
  dependencies.log.info(
    `ezpug-node ${NODE_AGENT_VERSION} dialling ${config.linkUrl}; image ${config.image}`,
  )
  try {
    const outcome = await agent.run()
    if (outcome.fatal) {
      dependencies.log.error(
        `the orchestrator refused this node (${outcome.fatal.code}${outcome.fatal.reason ? ` ${outcome.fatal.reason}` : ''}). ` +
          'A revoked node needs `ezpug-node forget` and a fresh enrolment token.',
      )
      return 2
    }
    return 0
  } finally {
    disarm()
    await agent.close()
  }
}

async function enrol(dependencies: CliDependencies, token: string | undefined): Promise<number> {
  if (!token) {
    dependencies.stdout('ezpug-node enrol needs the enrolment token as its argument')
    return 64
  }
  const { agent } = compose(dependencies)
  try {
    const identity = await agent.enrol(token)
    dependencies.stdout(`enrolled as ${identity.nodeId}; now run \`ezpug-node run\``)
    return 0
  } finally {
    await agent.close()
  }
}

async function forget(dependencies: CliDependencies): Promise<number> {
  const { state } = compose(dependencies)
  const identity = await state.read()
  if (!identity) {
    dependencies.stdout('nothing to forget: this host is not enrolled')
    return 0
  }
  await state.clear()
  dependencies.stdout(
    `forgot ${identity.nodeId}. The orchestrator still lists it until DELETE /v1/fleet/nodes/${identity.nodeId}.`,
  )
  return 0
}

/** Run one command; resolves with the exit code. Throws only for a configuration the environment got wrong. */
export function runCli(argv: readonly string[], dependencies: CliDependencies): Promise<number> {
  const [command = 'run', argument] = argv
  switch (command) {
    case '--help':
    case '-h':
    case 'help':
      dependencies.stdout(USAGE)
      return Promise.resolve(0)
    case '--version':
    case '-v':
      dependencies.stdout(NODE_AGENT_VERSION)
      return Promise.resolve(0)
    case 'enrol':
    case 'enroll':
      return enrol(dependencies, argument)
    case 'run':
      return run(dependencies)
    case 'status':
      return status(dependencies)
    case 'forget':
      return forget(dependencies)
    case 'health':
      return health(dependencies)
    default:
      dependencies.stdout(`unknown command '${command}'\n\n${USAGE}`)
      return Promise.resolve(64)
  }
}
