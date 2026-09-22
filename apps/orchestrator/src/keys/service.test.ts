import { useFakeClock } from '@ezpug/core/testing'
import { ApiError, apiKeySchema, MATCH_API_ERROR_STATUS } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { hashToken, mintToken } from '../tokens'
import { createMemoryKeyStore } from './memory-store'
import { createKeys, KEY_TOUCH_INTERVAL_MS } from './service'
import type { KeyStore } from './store'

const clock = useFakeClock()

const request = (
  name: string,
  scopes: ('matches' | 'fleet' | 'admin' | 'simulation')[] = ['matches'],
) => ({
  name,
  scopes,
  budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
  webhookSecrets: [{ id: 'whsec-1', secret: 'a-test-secret-of-at-least-thirty-two-chars' }],
})

/** The fields a refusal names, so a test reads as the contract and not as a message. */
function issuePaths(error: ApiError): string[] {
  const issues = (error.details?.issues ?? []) as { path: (string | number)[] }[]
  return issues.map(issue => issue.path.join('.'))
}

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
      keys.setWebhookSecrets('00000000-0000-4000-8000-000000000000', {
        secrets: [{ id: 'whsec-3', secret: 'a-third-test-secret-of-thirty-two-chars-x' }],
      }),
    )
    expect(missing.code).toBe('not_found')
    expect((await refused(keys.revoke('00000000-0000-4000-8000-000000000000'))).code).toBe(
      'not_found',
    )
  })

  /**
   * PRD-04 T3. The scope edit that production's platform key needed on
   * 2026-09-21 was a hand-written `UPDATE`; this is the door it should have
   * gone through. Additive on purpose — the operator names `simulation` and
   * the key keeps `matches` and `fleet` without having to remember them.
   */
  it('grants and takes away scopes, additively, and holds the order of the enum', async () => {
    const keys = createKeys({ store: createMemoryKeyStore(), clock })
    const { key, secret } = await keys.mint(request('platform', ['matches', 'fleet']))

    const granted = await keys.setScopes(key.id, { add: ['simulation'], remove: [] })
    expect(granted.scopes).toEqual(['matches', 'fleet', 'simulation'])
    // Nothing caches a lookup: the next authentication already sees it.
    expect((await keys.authenticate(secret)).key.scopes).toContain('simulation')

    // Both lists at once, and both idempotent.
    const moved = await keys.setScopes(key.id, { add: ['simulation'], remove: ['admin'] })
    expect(moved.scopes).toEqual(['matches', 'fleet', 'simulation'])

    const taken = await keys.setScopes(key.id, { add: [], remove: ['simulation'] })
    expect(taken.scopes).toEqual(['matches', 'fleet'])
  })

  it('refuses a scope edit that would empty a key, a revoked key and a stranger', async () => {
    const keys = createKeys({ store: createMemoryKeyStore(), clock })
    const { key } = await keys.mint(request('platform', ['matches']))

    const emptied = await refused(keys.setScopes(key.id, { add: [], remove: ['matches'] }))
    expect(emptied.code).toBe('validation_failed')
    expect(emptied.message).toContain('revoke it instead')
    // And the key kept what it had.
    expect((await keys.list()).find(k => k.id === key.id)?.scopes).toEqual(['matches'])

    const contradiction = await refused(
      keys.setScopes(key.id, { add: ['fleet'], remove: ['fleet'] }),
    )
    expect(contradiction.code).toBe('validation_failed')
    expect(issuePaths(contradiction)).toEqual([''])

    const nothing = await refused(keys.setScopes(key.id, { add: [], remove: [] }))
    expect(nothing.code).toBe('validation_failed')

    expect(
      (await refused(keys.setScopes('00000000-0000-4000-8000-000000000000', { add: ['fleet'] })))
        .code,
    ).toBe('not_found')

    await keys.revoke(key.id)
    const dead = await refused(keys.setScopes(key.id, { add: ['fleet'] }))
    expect(dead.code).toBe('invalid_state')
  })

  it('revokes idempotently: the first moment is the one kept', async () => {
    const keys = createKeys({ store: createMemoryKeyStore(), clock })
    const { key } = await keys.mint(request('platform'))
    const first = await keys.revoke(key.id)
    await clock.advance(1_000)
    const second = await keys.revoke(key.id)
    expect(second.revokedAt).toBe(first.revokedAt)
  })

  /**
   * T9b (P1). `mint` is the service and not the route, so a caller that never
   * went through `http/dispatch.ts` — the bootstrap key, a test rig, the
   * conformance target — held the request's TypeScript type and none of its
   * bounds. On 2026-09-20 that put six names of up to 71 characters in
   * `ezpug_iron_test`, and `GET /v1/keys` then answered `internal` for every
   * caller of that database, because `apiKeySchema` could not parse them
   * back. The row is forever; the refusal is one call.
   */
  describe('the contract at the write, not only at the door', () => {
    const tooLong = 't-conformance-extended-test-975158-reprovision-before-live-25-puppeteer'

    it('refuses a name longer than the contract carries, and writes nothing', async () => {
      const store = createMemoryKeyStore()
      const keys = createKeys({ store, clock })
      expect(tooLong.length).toBeGreaterThan(64)
      const error = await refused(keys.mint(request(tooLong)))
      expect(error.code).toBe('validation_failed')
      expect(error.status).toBe(MATCH_API_ERROR_STATUS.validation_failed)
      expect(issuePaths(error)).toContain('name')
      expect(await keys.list()).toEqual([])
    })

    it('refuses an empty name, an unknown scope and a budget out of range', async () => {
      const keys = createKeys({ store: createMemoryKeyStore(), clock })
      const empty = await refused(keys.mint(request('')))
      expect(issuePaths(empty)).toContain('name')

      const scope = await refused(
        keys.mint({ ...request('platform'), scopes: ['everything'] as never }),
      )
      expect(issuePaths(scope)).toContain('scopes.0')

      const budget = await refused(
        keys.mint({
          ...request('platform'),
          budget: { maxConcurrentServers: -1, maxServerLifetimeMinutes: 0, monthlyCents: 1.5 },
        }),
      )
      expect(issuePaths(budget)).toEqual([
        'budget.maxConcurrentServers',
        'budget.maxServerLifetimeMinutes',
        'budget.monthlyCents',
      ])
      expect(await keys.list()).toEqual([])
    })

    it('refuses the same off the adopt path, where the dev bootstrap comes in', async () => {
      const keys = createKeys({ store: createMemoryKeyStore(), clock })
      const secret = mintToken('apiKey')
      const error = await refused(keys.adopt(secret, request(tooLong)))
      expect(error.code).toBe('validation_failed')
      expect(await keys.list()).toEqual([])
      // And the refused secret adopted nothing: it is still unknown.
      expect((await refused(keys.authenticate(secret))).code).toBe('unauthorized')
    })

    it('refuses a budget patch and a fleet webhook the contract cannot carry', async () => {
      const keys = createKeys({ store: createMemoryKeyStore(), clock })
      const { key } = await keys.mint(request('platform'))
      expect((await refused(keys.setBudget(key.id, {}))).code).toBe('validation_failed')
      expect((await refused(keys.setBudget(key.id, { monthlyCents: -1 }))).code).toBe(
        'validation_failed',
      )
      expect(
        (
          await refused(
            keys.setFleetWebhook(key.id, {
              fleetWebhook: { url: 'not-a-url', secretId: 'whsec-1' },
            }),
          )
        ).code,
      ).toBe('validation_failed')
      expect((await keys.list())[0]?.budget.monthlyCents).toBe(0)
    })

    it('everything it does mint, the Match API can list', async () => {
      const keys = createKeys({ store: createMemoryKeyStore(), clock })
      await keys.mint(request('platform'))
      await keys.mint(request('a'.repeat(64), ['admin']))
      // The very parse `GET /v1/keys` does on the way out (`http/dispatch.ts`).
      expect(z.array(apiKeySchema).parse(await keys.list())).toHaveLength(2)
    })
  })
})
