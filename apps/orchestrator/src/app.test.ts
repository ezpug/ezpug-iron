import { flattenRoutes, MATCH_API_ERROR_STATUS, matchApiRoutes } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { createTestApp, keyRequest } from './http/testing'
import { mintToken } from './tokens'

describe('/healthz', () => {
  it('answers 200 with every rail, and 503 naming the one that is down', async () => {
    const t = createTestApp()
    const healthy = await t.request('/healthz')
    expect(healthy.status).toBe(200)
    expect(healthy.body).toMatchObject({
      ok: true,
      service: 'orchestrator',
      checks: { database: { ok: true }, redis: { ok: true }, providers: {} },
    })
    t.rails.redis = false
    const sick = await t.request('/healthz')
    expect(sick.status).toBe(503)
    expect(sick.body.ok).toBe(false)
    expect(sick.body.checks.redis).toMatchObject({ ok: false, error: 'redis is down' })
  })

  it('answers 503 draining once the drain has begun', async () => {
    const t = createTestApp()
    t.draining.value = true
    const response = await t.request('/healthz')
    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ ok: false, state: 'draining' })
  })

  it('needs no key', async () => {
    const t = createTestApp()
    expect((await t.request('/healthz')).status).toBe(200)
  })
})

describe('authentication and scopes', () => {
  it('refuses a request without a key as unauthorized, in the one envelope', async () => {
    const t = createTestApp()
    const response = await t.request('/v1/gamemodes')
    expect(response.status).toBe(401)
    expect(response.body.error).toMatchObject({ code: 'unauthorized' })
    expect(response.body.error.details.requestId).toEqual(expect.any(String))
    expect(response.headers.get('x-request-id')).toBe(response.body.error.details.requestId)
  })

  it('refuses an unknown key and a revoked key', async () => {
    const t = createTestApp()
    expect((await t.request('/v1/gamemodes', { key: mintToken('apiKey') })).status).toBe(401)
    const { key, secret } = await t.keys.mint(keyRequest('platform'))
    expect((await t.request('/v1/gamemodes', { key: secret })).status).toBe(200)
    await t.keys.revoke(key.id)
    expect((await t.request('/v1/gamemodes', { key: secret })).status).toBe(401)
  })

  it('gates every route on its declared scope: forbidden without it, admin implies all', async () => {
    const t = createTestApp()
    const matches = (await t.keys.mint(keyRequest('matches-only', ['matches']))).secret
    const fleet = (await t.keys.mint(keyRequest('fleet-only', ['fleet']))).secret
    const admin = (await t.keys.mint(keyRequest('root', ['admin']))).secret
    const forbidden = await t.request('/v1/keys', { key: matches })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.error).toMatchObject({ code: 'forbidden', details: { scope: 'admin' } })
    expect((await t.request('/v1/gamemodes', { key: fleet })).status).toBe(403)
    expect((await t.request('/v1/keys', { key: admin })).status).toBe(200)
    expect((await t.request('/v1/gamemodes', { key: admin })).status).toBe(200)
  })

  it('echoes a plausible request id and mints one otherwise', async () => {
    const t = createTestApp()
    const echoed = await t.request('/healthz', { headers: { 'x-request-id': 'platform-req-0001' } })
    expect(echoed.headers.get('x-request-id')).toBe('platform-req-0001')
    const minted = await t.request('/healthz', { headers: { 'x-request-id': 'bad id!' } })
    expect(minted.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('the catalog', () => {
  it('serves the four shipped manifests, pug first, and one by id', async () => {
    const t = createTestApp()
    const key = (await t.keys.mint(keyRequest('platform'))).secret
    const list = await t.request('/v1/gamemodes', { key })
    expect(list.status).toBe(200)
    expect(list.body.gamemodes.map((m: { id: string }) => m.id)).toEqual([
      'pug',
      'flying-scoutsman',
      'retakes',
      'powerup-dm',
    ])
    const one = await t.request('/v1/gamemodes/retakes', { key })
    expect(one.status).toBe(200)
    expect(one.body.id).toBe('retakes')
    const missing = await t.request('/v1/gamemodes/arena', { key })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not_found')
  })
})

describe('the keys routes', () => {
  it('mint a key shown once, list it without the secret, revoke it, rotate its secrets', async () => {
    const t = createTestApp()
    const admin = (await t.keys.mint(keyRequest('root', ['admin']))).secret
    const created = await t.request('/v1/keys', {
      method: 'POST',
      key: admin,
      json: {
        name: 'platform',
        scopes: ['matches', 'fleet'],
        budget: { maxConcurrentServers: 2, maxServerLifetimeMinutes: 120, monthlyCents: 5000 },
        webhookSecrets: [{ id: 'whsec-a', secret: 'a-test-secret-of-at-least-thirty-two-chars' }],
      },
    })
    expect(created.status).toBe(201)
    expect(created.body.secret).toMatch(/^ezik_/)
    expect(created.body.key).toMatchObject({
      name: 'platform',
      scopes: ['matches', 'fleet'],
      webhookSecretIds: ['whsec-a'],
      revokedAt: null,
    })
    const listed = await t.request('/v1/keys', { key: admin })
    expect(JSON.stringify(listed.body)).not.toContain(created.body.secret)
    expect(JSON.stringify(listed.body)).not.toContain('a-test-secret-of-at-least')
    expect(listed.body.keys.map((k: { name: string }) => k.name)).toEqual(['platform', 'root'])

    const rotated = await t.request(`/v1/keys/${created.body.key.id}/webhook-secrets`, {
      method: 'PUT',
      key: admin,
      json: { secrets: [{ id: 'whsec-b', secret: 'another-test-secret-of-thirty-two-chars-x' }] },
    })
    expect(rotated.status).toBe(200)
    expect(rotated.body.webhookSecretIds).toEqual(['whsec-b'])

    const revoked = await t.request(`/v1/keys/${created.body.key.id}`, {
      method: 'DELETE',
      key: admin,
    })
    expect(revoked.status).toBe(200)
    expect(revoked.body.revokedAt).toBe(t.clock.date().toISOString())
    expect((await t.request('/v1/gamemodes', { key: created.body.secret })).status).toBe(401)
  })

  it('answer conflict for a taken name and validation_failed with issues for a bad body', async () => {
    const t = createTestApp()
    const admin = (await t.keys.mint(keyRequest('root', ['admin']))).secret
    const taken = await t.request('/v1/keys', {
      method: 'POST',
      key: admin,
      json: keyRequest('root'),
    })
    expect(taken.status).toBe(409)
    expect(taken.body.error.code).toBe('conflict')
    const bad = await t.request('/v1/keys', {
      method: 'POST',
      key: admin,
      json: { name: 'x', scopes: ['root'] },
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatchObject({ code: 'validation_failed' })
    expect(bad.body.error.details.issues.length).toBeGreaterThan(0)
    const notJson = await t.request('/v1/keys', {
      method: 'POST',
      key: admin,
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(notJson.status).toBe(400)
    expect(notJson.body.error.message).toBe('the body is not JSON')
  })
})

describe('the routes a later task serves', () => {
  it('exist, authenticate, gate and validate, then say honestly which task serves them', async () => {
    const t = createTestApp()
    const key = (await t.keys.mint(keyRequest('platform', ['matches', 'fleet']))).secret
    const unauthenticated = await t.request('/v1/capacity')
    expect(unauthenticated.status).toBe(401)
    const unserved = await t.request('/v1/capacity', { key })
    expect(unserved.status).toBe(500)
    expect(unserved.body.error).toMatchObject({
      code: 'internal',
      message: expect.stringContaining('PRD-02 T3'),
      details: { task: 'T3' },
    })
    const invalid = await t.request('/v1/matches/not-a-uuid', { key })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('validation_failed')
  })

  it('cover the whole route table — no path is unregistered', async () => {
    const t = createTestApp()
    const key = (await t.keys.mint(keyRequest('root', ['admin']))).secret
    for (const { route } of flattenRoutes(matchApiRoutes)) {
      const path = route.path
        .replace(':matchId', '00000000-0000-4000-8000-000000000000')
        .replace(':keyId', '00000000-0000-4000-8000-000000000000')
        .replace(/:[a-zA-Z]+/g, 'x')
      const response = await t.request(path, { method: route.method.toUpperCase(), key })
      // A registered route answers with its own verdict (a `not_found` for an
      // unknown gamemode is one); an unregistered path says `no route`.
      expect(response.body?.error?.message ?? '', `${route.method} ${route.path}`).not.toMatch(
        /^no route/,
      )
      expect(response.status, `${route.method} ${route.path}`).toBeLessThanOrEqual(500)
    }
  })

  it('answer not_found for a path outside the table', async () => {
    const t = createTestApp()
    const response = await t.request('/v1/nothing')
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })
})

describe('rate limiting', () => {
  it('answers rate_limited with Retry-After once a key’s bucket is empty, per key', async () => {
    const t = createTestApp({ burst: 3, perSecond: 1 })
    const a = (await t.keys.mint(keyRequest('a'))).secret
    const b = (await t.keys.mint(keyRequest('b'))).secret
    for (let i = 0; i < 3; i += 1)
      expect((await t.request('/v1/gamemodes', { key: a })).status).toBe(200)
    const refused = await t.request('/v1/gamemodes', { key: a })
    expect(refused.status).toBe(MATCH_API_ERROR_STATUS.rate_limited)
    expect(refused.body.error.code).toBe('rate_limited')
    expect(refused.headers.get('retry-after')).toBe('1')
    expect((await t.request('/v1/gamemodes', { key: b })).status).toBe(200)
    await t.clock.advance(1_000)
    expect((await t.request('/v1/gamemodes', { key: a })).status).toBe(200)
  })

  it('limits strangers on one shared bucket, before any lookup', async () => {
    const t = createTestApp({ burst: 2, perSecond: 1 })
    expect((await t.request('/v1/gamemodes')).status).toBe(401)
    expect((await t.request('/v1/gamemodes')).status).toBe(401)
    expect((await t.request('/v1/gamemodes')).status).toBe(429)
  })
})

describe('the request log', () => {
  it('writes one line per request with the key’s prefix and never the key or the query string', async () => {
    const t = createTestApp()
    const { secret } = await t.keys.mint(keyRequest('platform'))
    await t.request(`/v1/gamemodes?token=${mintToken('player')}`, { key: secret })
    const line = t.log.lines.at(-1) ?? ''
    expect(line).toMatch(/^info GET \/v1\/gamemodes 200 \d+ms key=ezik_/)
    expect(line).not.toContain(secret)
    expect(line).not.toContain('token=')
    expect(line).not.toContain('ezip_')
  })
})
