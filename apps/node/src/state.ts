import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * **What the node keeps on disk.** Two small files under the state
 * directory (`EZPUG_NODE_STATE_DIR`):
 *
 * - `node.json` — the identity `welcome` handed over after the one
 *   enrolment: the node id and **the node token**, which the orchestrator
 *   never shows again (it holds only the hash). Written `0600` inside a
 *   `0700` directory, by rename so a crash mid-write leaves the old file,
 *   and never logged — `ezpug-node status` prints the id and not the token.
 * - `health.json` — when the link was last known up, for the image's
 *   `HEALTHCHECK` and for an operator with `docker ps`. No secret in it.
 *
 * Nothing about instances is kept: the containers themselves carry labels
 * the node reads back at boot (`instances.ts`), so a restarted agent finds
 * its warm pool and its live matches where it left them.
 */

export const nodeStateSchema = z.object({
  nodeId: z.string().min(1),
  nodeToken: z.string().min(16),
  /** The orchestrator this identity is for; a different URL at boot is refused, not silently reused. */
  orchestratorUrl: z.string().min(1),
  enrolledAt: z.string().min(1),
})
export type NodeState = z.infer<typeof nodeStateSchema>

export const nodeHealthSchema = z.object({
  nodeId: z.string().min(1),
  connected: z.boolean(),
  /** Epoch ms of the last moment the link was known up (a welcome or a heartbeat). */
  lastLinkAt: z.number().int().nonnegative(),
  heartbeatIntervalMs: z.number().int().positive(),
  instances: z.number().int().nonnegative(),
})
export type NodeHealth = z.infer<typeof nodeHealthSchema>

export interface StateStore {
  /** Where `node.json` lives — for messages, never for reading the token back out. */
  readonly path: string
  read: () => Promise<NodeState | null>
  write: (state: NodeState) => Promise<void>
  /** Forget the identity (`ezpug-node forget`); the orchestrator's revoke is the other half. */
  clear: () => Promise<void>
  readHealth: () => Promise<NodeHealth | null>
  writeHealth: (health: NodeHealth) => Promise<void>
}

export const STATE_FILE = 'node.json'
export const HEALTH_FILE = 'health.json'

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const parsed = schema.safeParse(JSON.parse(text))
  if (!parsed.success) throw new Error(`${path} is not a file this version of ezpug-node wrote`)
  return parsed.data
}

/** Write by rename: the file is whole or it is the previous one. */
async function writeJson(path: string, value: unknown, mode: number): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'w' })
  await rename(temporary, path)
}

export function createFileStateStore(dir: string): StateStore {
  const statePath = join(dir, STATE_FILE)
  const healthPath = join(dir, HEALTH_FILE)
  const ensureDir = () => mkdir(dir, { recursive: true, mode: 0o700 })
  return {
    path: statePath,
    read: () => readJson(statePath, nodeStateSchema),
    write: async state => {
      await ensureDir()
      await writeJson(statePath, nodeStateSchema.parse(state), 0o600)
    },
    clear: () => rm(statePath, { force: true }),
    readHealth: () => readJson(healthPath, nodeHealthSchema),
    writeHealth: async health => {
      await ensureDir()
      await writeJson(healthPath, nodeHealthSchema.parse(health), 0o644)
    },
  }
}

/** A store that forgets on exit — for tests. */
export function createMemoryStateStore(initial?: NodeState): StateStore & {
  state: () => NodeState | null
  health: () => NodeHealth | null
} {
  let state: NodeState | null = initial ?? null
  let health: NodeHealth | null = null
  return {
    path: '<memory>/node.json',
    read: () => Promise.resolve(state),
    write: next => {
      state = nodeStateSchema.parse(next)
      return Promise.resolve()
    },
    clear: () => {
      state = null
      return Promise.resolve()
    },
    readHealth: () => Promise.resolve(health),
    writeHealth: next => {
      health = nodeHealthSchema.parse(next)
      return Promise.resolve()
    },
    state: () => state,
    health: () => health,
  }
}
