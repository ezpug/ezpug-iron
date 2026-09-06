import { homedir } from 'node:os'
import { join } from 'node:path'
import { NODE_LINK_PATH } from '@ezpug/protocol'
import { z } from 'zod'

/**
 * **The agent's configuration, read from the environment and validated
 * once.** Every name is `EZPUG_NODE_*` and every value has a documented home
 * in `.env.example` and `docs/nodes.md`. This module reads a plain env
 * record, never `process.env` directly, so a test hands it a literal.
 *
 * What is *not* here on purpose: the server token and the orchestrator URL
 * a container dials with. Both arrive per instance in the orchestrator's
 * `start` frame — the node writes them into the container's environment and
 * never decides them.
 */

/** Env record shape — `process.env` satisfies it. */
export type EnvRecord = Readonly<Record<string, string | undefined>>

export const ORCHESTRATOR_URL_VAR = 'EZPUG_NODE_ORCHESTRATOR_URL'

/** The image `pnpm cs2:build` tags; a venue pulls the published tag instead (`docs/pins.md`). */
export const DEFAULT_IMAGE = 'ghcr.io/ezpug/ezpug-iron/cs2:dev'

/**
 * The volume `compose.cs2.yaml` installs the game into on this box: the
 * compose project is `ezpug-iron-cs2`, the volume `cs2-data`, and docker
 * names it project-first. A venue box names its own (`docs/nodes.md`).
 */
export const DEFAULT_GAME_VOLUME = 'ezpug-iron-cs2_cs2-data'

/** Where the game lives inside a server container (`docker/cs2/entrypoint.sh`). */
export const GAME_MOUNT_PATH = '/serverdata/serverfiles'

/** Where a checkout's `gamemodes/` may be bound, read-only, so a cfg edit is a restart and not a rebuild. */
export const GAMEMODES_MOUNT_PATH = '/opt/ezpug/gamemodes'

export interface NodeConfig {
  /** The orchestrator's public origin (`http://127.0.0.1:3430`, `https://gs.ezpug.com`). */
  readonly orchestratorUrl: string
  /** The node link derived from it: `ws(s)://…/node`. */
  readonly linkUrl: string
  /** Where `node.json` (the node token, 0600) and `health.json` live. */
  readonly stateDir: string
  /** A provider region id the fleet groups by; a `lan` request matches on `lan`, not on this. */
  readonly region: string
  /** Every node is LAN capacity unless it sits in a datacentre. */
  readonly lan: boolean
  /** Free-form operator labels (`venue=saarlan`, `tickrate=128`); `cores` is filled in when absent. */
  readonly labels: Readonly<Record<string, string>>
  /** How many server containers this host runs at once. */
  readonly maxInstances: number
  /** How many idle instances the orchestrator should keep started here ahead of demand. */
  readonly warm: number
  /** The server image this node holds and reports the digest of; pulled at boot when absent. */
  readonly image: string
  /** The docker volume with the game install (~67 GB), mounted into every instance. */
  readonly gameVolume: string
  /** A checkout's `gamemodes/` to bind read-only over the image's copy, or null. */
  readonly gamemodesDir: string | null
  /** The docker daemon's unix socket. */
  readonly dockerSocket: string
  /** How often the node asks docker what its containers are doing. */
  readonly pollIntervalMs: number
  /** How long `stop` gives a server to leave before docker kills it. */
  readonly stopTimeoutSeconds: number
  /** `NODE_ENV === 'production'`. */
  readonly production: boolean
}

function numberFromEnv(fallback: number, schema = z.number().int().positive()) {
  return z.preprocess(
    value => (value === undefined || value === '' ? fallback : Number(value)),
    schema,
  )
}

function booleanFromEnv(fallback: boolean) {
  return z.preprocess(
    value =>
      value === undefined || value === ''
        ? fallback
        : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()),
    z.boolean(),
  )
}

/** `key=value,key=value` → a record; an entry without `=` is refused by name. */
const labelsFromEnv = z.preprocess(
  value => {
    if (value === undefined || value === '') return {}
    const labels: Record<string, string> = {}
    for (const entry of String(value).split(',')) {
      const trimmed = entry.trim()
      if (trimmed.length === 0) continue
      const at = trimmed.indexOf('=')
      if (at <= 0) return { [trimmed]: undefined }
      labels[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
    }
    return labels
  },
  z.record(z.string().min(1).max(64), z.string().max(256)),
)

const httpUrl = z
  .string()
  .min(1)
  .refine(value => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol)
    } catch {
      return false
    }
  }, 'must be the orchestrator’s http(s):// origin')

function fail(issues: z.core.$ZodIssue[], names: Record<string, string>): never {
  const lines = issues
    .map(issue => `${names[String(issue.path[0])] ?? String(issue.path[0])}: ${issue.message}`)
    .join('; ')
  throw new Error(`invalid ezpug-node configuration (${lines})`)
}

/** The node link's URL for an orchestrator origin: the scheme swapped, the path appended. */
export function linkUrlFor(orchestratorUrl: string): string {
  const url = new URL(orchestratorUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${NODE_LINK_PATH}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** Read the whole configuration; throws with every problem named. */
export function readNodeConfig(env: EnvRecord): NodeConfig {
  const parsed = z
    .object({
      orchestratorUrl: httpUrl,
      stateDir: z.string().min(1),
      region: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'a kebab-case region id'),
      lan: booleanFromEnv(true),
      labels: labelsFromEnv,
      maxInstances: numberFromEnv(2, z.number().int().nonnegative().max(256)),
      warm: numberFromEnv(1, z.number().int().nonnegative().max(256)),
      image: z.string().min(1),
      gameVolume: z.string().min(1),
      gamemodesDir: z.string().min(1).nullable(),
      dockerSocket: z.string().min(1),
      pollIntervalMs: numberFromEnv(2_000),
      stopTimeoutSeconds: numberFromEnv(20),
    })
    .safeParse({
      orchestratorUrl: env[ORCHESTRATOR_URL_VAR],
      stateDir: env.EZPUG_NODE_STATE_DIR || join(homedir(), '.ezpug-node'),
      region: env.EZPUG_NODE_REGION || 'eu-central',
      lan: env.EZPUG_NODE_LAN,
      labels: env.EZPUG_NODE_LABELS,
      maxInstances: env.EZPUG_NODE_MAX_INSTANCES,
      warm: env.EZPUG_NODE_WARM,
      image: env.EZPUG_NODE_IMAGE || DEFAULT_IMAGE,
      gameVolume: env.EZPUG_NODE_GAME_VOLUME || DEFAULT_GAME_VOLUME,
      gamemodesDir: env.EZPUG_NODE_GAMEMODES_DIR || null,
      dockerSocket: env.EZPUG_NODE_DOCKER_SOCKET || '/var/run/docker.sock',
      pollIntervalMs: env.EZPUG_NODE_POLL_INTERVAL_MS,
      stopTimeoutSeconds: env.EZPUG_NODE_STOP_TIMEOUT,
    })
  if (!parsed.success)
    fail(parsed.error.issues, {
      orchestratorUrl: ORCHESTRATOR_URL_VAR,
      stateDir: 'EZPUG_NODE_STATE_DIR',
      region: 'EZPUG_NODE_REGION',
      lan: 'EZPUG_NODE_LAN',
      labels: 'EZPUG_NODE_LABELS',
      maxInstances: 'EZPUG_NODE_MAX_INSTANCES',
      warm: 'EZPUG_NODE_WARM',
      image: 'EZPUG_NODE_IMAGE',
      gameVolume: 'EZPUG_NODE_GAME_VOLUME',
      gamemodesDir: 'EZPUG_NODE_GAMEMODES_DIR',
      dockerSocket: 'EZPUG_NODE_DOCKER_SOCKET',
      pollIntervalMs: 'EZPUG_NODE_POLL_INTERVAL_MS',
      stopTimeoutSeconds: 'EZPUG_NODE_STOP_TIMEOUT',
    })
  const config = parsed.data
  // A pool larger than the host would ever run is a number nobody meant.
  if (config.warm > config.maxInstances)
    throw new Error(
      `invalid ezpug-node configuration (EZPUG_NODE_WARM: ${config.warm} exceeds EZPUG_NODE_MAX_INSTANCES ${config.maxInstances})`,
    )
  const orchestratorUrl = config.orchestratorUrl.replace(/\/+$/, '')
  return {
    ...config,
    orchestratorUrl,
    linkUrl: linkUrlFor(orchestratorUrl),
    production: env.NODE_ENV === 'production',
  }
}
