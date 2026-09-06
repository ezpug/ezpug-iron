import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileStateStore, createMemoryStateStore, HEALTH_FILE, STATE_FILE } from './state'

const IDENTITY = {
  nodeId: 'devbox',
  nodeToken: 'ezin_not-a-secret_node_token_0001',
  orchestratorUrl: 'http://127.0.0.1:3430',
  enrolledAt: '2026-01-01T00:00:00.000Z',
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function freshDir(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'ezpug-node-')), 'state')
  dirs.push(dir)
  return dir
}

describe('the file state store', () => {
  it('reads nothing before enrolment and the identity after, owner-only', async () => {
    const dir = await freshDir()
    const store = createFileStateStore(dir)
    expect(await store.read()).toBeNull()
    await store.write(IDENTITY)
    expect(await store.read()).toEqual(IDENTITY)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, STATE_FILE))).mode & 0o777).toBe(0o600)
    // Written whole by rename: no temporary file survives a write.
    await expect(stat(join(dir, `${STATE_FILE}.tmp`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('forgets on clear, and clearing twice is nothing', async () => {
    const store = createFileStateStore(await freshDir())
    await store.write(IDENTITY)
    await store.clear()
    await store.clear()
    expect(await store.read()).toBeNull()
  })

  it('keeps health beside the identity, world-readable, with no token in it', async () => {
    const dir = await freshDir()
    const store = createFileStateStore(dir)
    expect(await store.readHealth()).toBeNull()
    const health = {
      nodeId: 'devbox',
      connected: true,
      lastLinkAt: 1_767_225_600_000,
      heartbeatIntervalMs: 10_000,
      instances: 1,
    }
    await store.writeHealth(health)
    expect(await store.readHealth()).toEqual(health)
    expect((await stat(join(dir, HEALTH_FILE))).mode & 0o777).toBe(0o644)
    expect(await readFile(join(dir, HEALTH_FILE), 'utf8')).not.toContain('ezin_')
  })

  it('refuses a file another version wrote rather than reading a half identity', async () => {
    const dir = await freshDir()
    const store = createFileStateStore(dir)
    await store.write(IDENTITY)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, STATE_FILE), '{"nodeId":"devbox"}\n')
    await expect(store.read()).rejects.toThrow(/not a file this version of ezpug-node wrote/)
  })
})

describe('the memory state store', () => {
  it('behaves like the file one without a disk', async () => {
    const store = createMemoryStateStore()
    expect(await store.read()).toBeNull()
    await store.write(IDENTITY)
    expect(store.state()).toEqual(IDENTITY)
    await store.clear()
    expect(await store.read()).toBeNull()
  })
})
