import { useFakeClock } from '@ezpug/core/testing'
import { describe, expect, it } from 'vitest'
import { mintToken } from '../tokens'
import { BOOTSTRAP_KEY_NAME, ensureBootstrapKey } from './bootstrap'
import { createMemoryKeyStore } from './memory-store'
import { createKeys, type Keys } from './service'

/**
 * **The dev bootstrap key** (PRD-02 T4): the door another project's compose
 * file walks through. What matters is that it is the *same* key every restart,
 * that changing the environment's value leaves exactly one live key, and that
 * production has no such door at all.
 */

const clock = useFakeClock()

const keys = (): Keys => createKeys({ store: createMemoryKeyStore(), clock })

describe('ensureBootstrapKey', () => {
  it('adopts the environment’s secret and authenticates with it', async () => {
    const service = keys()
    const secret = mintToken('apiKey')
    const outcome = await ensureBootstrapKey({ keys: service, secret, production: false })
    expect(outcome.created).toBe(true)
    expect(outcome.revoked).toBeNull()
    expect(outcome.key.name).toBe(BOOTSTRAP_KEY_NAME)
    expect(outcome.key.scopes).toEqual(['matches', 'fleet', 'admin'])
    expect((await service.authenticate(secret)).key.id).toBe(outcome.key.id)
  })

  it('is the same key on every restart', async () => {
    const service = keys()
    const secret = mintToken('apiKey')
    const first = await ensureBootstrapKey({ keys: service, secret, production: false })
    const second = await ensureBootstrapKey({ keys: service, secret, production: false })
    expect(second.created).toBe(false)
    expect(second.key.id).toBe(first.key.id)
    expect(await service.list()).toHaveLength(1)
  })

  it('revokes the previous one when the environment’s value changes', async () => {
    const service = keys()
    const before = mintToken('apiKey')
    const after = mintToken('apiKey')
    const first = await ensureBootstrapKey({ keys: service, secret: before, production: false })
    const second = await ensureBootstrapKey({ keys: service, secret: after, production: false })
    expect(second.created).toBe(true)
    expect(second.revoked).toBe(first.key.id)
    expect((await service.list()).filter(key => key.revokedAt === null)).toHaveLength(1)
    await expect(service.authenticate(before)).rejects.toThrow(/revoked/)
    expect((await service.authenticate(after)).key.id).toBe(second.key.id)
  })

  it('has no door in production', async () => {
    await expect(
      ensureBootstrapKey({ keys: keys(), secret: mintToken('apiKey'), production: true }),
    ).rejects.toThrow(/dev-only/)
  })
})
