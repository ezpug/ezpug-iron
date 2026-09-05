import { afterEach, describe, expect, it } from 'vitest'
import { errorEnvelopeSchema, matchSchema } from '../index'
import { createHarness, type Harness, pugRequest } from './testing'

/**
 * The same fake through its HTTP door, without a socket: Hono's `request()`
 * runs the app against a `Request` and hands back the `Response`.
 */

let harness: Harness | undefined
afterEach(() => {
  harness?.fake.close()
  harness = undefined
})

function setup(): Harness {
  harness = createHarness()
  return harness
}

function call(h: Harness, method: string, path: string, body?: unknown, apiKey?: string | null) {
  const headers: Record<string, string> = {}
  if (apiKey !== null) headers.authorization = `Bearer ${apiKey ?? h.platform.secret}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return h.fake.handler.request(path, {
    method,
    headers,
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
}

describe('the fake over HTTP', () => {
  it('serves the routes with the declared statuses and the one error envelope', async () => {
    const h = setup()
    const created = await call(h, 'POST', '/v1/matches', pugRequest())
    expect(created.status).toBe(201)
    const match = matchSchema.parse(await created.json())
    expect(match.state).toBe('allocating')

    const again = await call(h, 'POST', '/v1/matches', pugRequest())
    expect(again.status).toBe(200)
    expect(matchSchema.parse(await again.json()).id).toBe(match.id)

    const fetched = await call(h, 'GET', `/v1/matches/${match.id}`)
    expect(fetched.status).toBe(200)
    expect(matchSchema.parse(await fetched.json()).id).toBe(match.id)

    await h.fake.playOut()
    const events = await call(h, 'GET', `/v1/matches/${match.id}/events?cursor=0&limit=5`)
    expect(events.status).toBe(200)
    const page = (await events.json()) as { items: unknown[]; nextCursor: string | null }
    expect(page.items).toHaveLength(5)
    expect(page.nextCursor).toBe('5')

    const noKey = await call(h, 'GET', '/v1/gamemodes', undefined, null)
    expect(noKey.status).toBe(401)
    expect(errorEnvelopeSchema.parse(await noKey.json()).error.code).toBe('unauthorized')

    const wrongScope = await call(h, 'GET', '/v1/fleet/servers')
    expect(wrongScope.status).toBe(403)
    expect(errorEnvelopeSchema.parse(await wrongScope.json()).error.code).toBe('forbidden')

    const invalid = await call(h, 'POST', '/v1/matches', { clientMatchId: 'x' })
    expect(invalid.status).toBe(400)
    const envelope = errorEnvelopeSchema.parse(await invalid.json())
    expect(envelope.error.code).toBe('validation_failed')
    expect(Array.isArray(envelope.error.details?.issues)).toBe(true)

    const notJson = await call(h, 'POST', '/v1/matches', '{not json')
    expect(notJson.status).toBe(400)

    const missing = await call(h, 'GET', '/v1/matches/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b')
    expect(missing.status).toBe(404)
    expect(errorEnvelopeSchema.parse(await missing.json()).error.code).toBe('not_found')

    const noRoute = await call(h, 'GET', '/v1/nothing')
    expect(noRoute.status).toBe(404)
    expect(errorEnvelopeSchema.parse(await noRoute.json()).error.code).toBe('not_found')

    const money = await call(
      h,
      'POST',
      '/v1/matches',
      pugRequest({ clientMatchId: 'ttl', ttlMinutes: 1440 }),
    )
    expect(money.status).toBe(402)

    const stream = await call(h, 'GET', `/v1/matches/${match.id}/stream`)
    expect(stream.status).toBe(400)
    expect(errorEnvelopeSchema.parse(await stream.json()).error.message).toMatch(/WebSocket/)
  })

  it('answers the admin routes for the admin key', async () => {
    const h = setup()
    const keys = await call(h, 'GET', '/v1/keys', undefined, h.fake.admin.secret)
    expect(keys.status).toBe(200)
    const enrol = await call(
      h,
      'POST',
      '/v1/fleet/nodes',
      { id: 'rack-1', region: 'saarlan' },
      h.fake.admin.secret,
    )
    expect(enrol.status).toBe(201)
    const revoke = await call(h, 'DELETE', '/v1/fleet/nodes/rack-1', undefined, h.fake.admin.secret)
    expect(revoke.status).toBe(200)
    expect(await revoke.json()).toEqual({ ok: true })
  })
})
