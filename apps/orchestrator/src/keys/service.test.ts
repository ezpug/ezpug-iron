import { useFakeClock } from '@ezpug/core/testing'
import { ApiError } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { hashToken, mintToken } from '../tokens'
import { createMemoryKeyStore } from './memory-store'
import { createKeys, KEY_TOUCH_INTERVAL_MS } from './service'
import type { KeyStore } from './store'

const clock = useFakeClock()

const request = (name: string, scopes: ('matches' | 'fleet' | 'admin')[] = ['matches']) => ({
  name,
  scopes,
  budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
  webhookSecrets: [{ id: 'whsec-1', secret: 'a-test-secret-of-at-least-thirty-two-chars' }],
})

async function refused(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('expected an ApiError')
}

describe('createKeys', () => {
  it('mints a key whose secret is shown once and never listed', async () => {
    const store = createMemoryKeyStore()
    const keys = createKeys({ store, clock })
    const { key, secret } = await keys.mint(request('platform'))
    expect(secret).toMatch(/^ezik_/)
    expect(key.prefix).toBe(secret.slice(0, 12))
    expect(key.webhookSecretIds).toEqual(['whsec-1'])
    expect(key.createdAt).toBe(clock.date().toISOString())
    expect(JSON.stringify(await keys.list())).not.toContain(secret)
    expect((await store.findById(key.id))?.secretHash).toBe(hashToken(secret))
  })

  it('authenticates the secret and hands the handler the webhook secrets', async () => {
    const keys = createKeys({ store: createMemoryKeyStore(), clock })
    const { key, secret } = await keys.mint(request('platform'))
    const authenticated = await keys.authenticate(secret)
    expect(authenticated.key.id).toBe(key.id)
    expect(authenticated.webhookSecrets.get('whsec-1')).toBe(
      'a-test-secret-of-at-least-thirty-two-chars',
    )
  })

  it('refuses no key, a foreign shape, an unknown key and a revoked one — all unauthorized', async () => {
    const keys = createKeys({ store: createMemoryKeyStore(), clock })
    const { key, secret } = await keys.mint(request('platform'))
    expect((await refused(keys.authenticate(null))).code).toBe('unauthorized')
    expect((await refused(keys.authenticate('fake-key-abc'))).code).toBe('unauthorized')
    expect((await refused(keys.authenticate(mintToken('apiKey')))).code).toBe('unauthorized')
    const revoked = await keys.revoke(key.id)
    expect(revoked.revokedAt).toBe(clock.date().toISOString())
    const error = await refused(keys.authenticate(secret))
    expect(error.code).toBe('unauthorized')
    expect(error.status).toBe(401)
    expect(error.message).toMatch(/revoked/)
  })

  it('touches lastUsedAt once per interval, on the clock', async () => {
    const store = createMemoryKeyStore()
    const touches: Date[] = []
    const spied: KeyStore = {
      ...store,
      touch: (id, at) => {
        touches.push(at)
        return store.touch(id, at)
      },
    }
    const keys = createKeys({ store: spied, clock })
    const { key, secret } = await keys.mint(request('platform'))
    await keys.authenticate(secret)
    await keys.authenticate(secret)
    expect(touches).toHaveLength(1)
    await clock.advance(KEY_TOUCH_INTERVAL_MS)
    await keys.authenticate(secret)
    expect(touches).toHaveLength(2)
    expect((await keys.list()).find(k => k.id === key.id)?.lastUsedAt).toBe(
      clock.date().toISOString(),
    )
  })

  it('refuses a name a live key holds, and frees it on revoke', async () => {
    const keys = createKeys({ store: createMemoryKeyStore(), clock })
    const first = await keys.mint(request('platform'))
    const error = await refused(keys.mint(request('platform')))
    expect(error.code).toBe('conflict')
    expect(error.status).toBe(409)
    await keys.revoke(first.key.id)
    await expect(keys.mint(request('platform'))).resolves.toBeDefined()
  })

  it('rotates webhook secrets as a set and answers not_found for a stranger', async () => {
    const keys = createKeys({ store: createMemoryKeyStore(), clock })
    const { key, secret } = await keys.mint(request('platform'))
    const rotated = await keys.setWebhookSecrets(key.id, {
      secrets: [{ id: 'whsec-2', secret: 'another-test-secret-of-thirty-two-chars-x' }],
    })
    expect(rotated.webhookSecretIds).toEqual(['whsec-2'])
    expect([...(await keys.authenticate(secret)).webhookSecrets.keys()]).toEqual(['whsec-2'])
    const missing = await refused(
      keys.setWebhookSecrets('00000000-0000-4000-8000-000000000000', { secrets: [] }),
    )
    expect(missing.code).toBe('not_found')
    expect((await refused(keys.revoke('00000000-0000-4000-8000-000000000000'))).code).toBe(
      'not_found',
    )
  })

  it('revokes idempotently: the first moment is the one kept', async () => {
    const keys = createKeys({ store: createMemoryKeyStore(), clock })
    const { key } = await keys.mint(request('platform'))
    const first = await keys.revoke(key.id)
    await clock.advance(1_000)
    const second = await keys.revoke(key.id)
    expect(second.revokedAt).toBe(first.revokedAt)
  })
})
