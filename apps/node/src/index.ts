/**
 * `@ezpug/node` — `ezpug-node`, the agent that turns a docker host into
 * EZPug Iron capacity (decision 23). `main.ts` is the process; this is what
 * a test or a script composes instead of it.
 */
export {
  createNodeAgent,
  type NodeAgent,
  type NodeAgentOptions,
  type NodeRunOutcome,
} from './agent'
export { type CliDependencies, runCli, USAGE } from './cli'
export {
  DEFAULT_GAME_VOLUME,
  DEFAULT_IMAGE,
  type EnvRecord,
  GAME_MOUNT_PATH,
  GAMEMODES_MOUNT_PATH,
  linkUrlFor,
  type NodeConfig,
  ORCHESTRATOR_URL_VAR,
  readNodeConfig,
} from './config'
export { createDockerodeDocker } from './docker/dockerode'
export {
  type ContainerInfo,
  type ContainerSpec,
  type ContainerStatus,
  DockerError,
  type DockerPort,
} from './docker/port'
export {
  CONTAINER_ENV,
  CONTAINER_NAME_PREFIX,
  containerSpecFor,
  createInstanceManager,
  INSTANCE_LABELS,
  type InstanceManager,
  instanceFromContainer,
} from './instances'
export {
  createNodeLink,
  NODE_LINK_FATAL_CLOSE_CODES,
  type NodeLink,
  NodeLinkClosedError,
  type NodeLinkHandler,
} from './link'
export { createConsoleLog, createMemoryLog, type Log, redactSecrets } from './log'
export {
  createFileStateStore,
  createMemoryStateStore,
  type NodeHealth,
  type NodeState,
  type StateStore,
} from './state'
export { NODE_AGENT_VERSION } from './version'
