import { useFakeClock } from '@ezpug/core/testing'
import { apiKeyCreateRequestSchema } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { mintToken } from '../tokens'
import { BOOTSTRAP_KEY_NAME, bootstrapKeyRequest, ensureBootstrapKey } from './bootstrap'
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

  /**
   * T9b: the bootstrap mint is checked for the same reach as the keys door.
   * The request it builds is a literal, so what it carries today the contract
   * carries — but the name is an option, and nothing between here and the row
   * used to read `apiKeySchema`.
   */
  it('mints a request the Match API can carry, name and all', () => {
    expect(() => apiKeyCreateRequestSchema.parse(bootstrapKeyRequest())).not.toThrow()
    expect(BOOTSTRAP_KEY_NAME.length).toBeLessThanOrEqual(64)
  })

  it('refuses a name the contract cannot carry rather than writing it', async () => {
    const service = keys()
    await expect(
      ensureBootstrapKey({
        keys: service,
        secret: mintToken('apiKey'),
        production: false,
        name: 'b'.repeat(65),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' })
    expect(await service.list()).toEqual([])
  })
})
