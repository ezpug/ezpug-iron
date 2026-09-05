import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { ApiError, errorEnvelopeSchema } from './errors'
import type { RouteHandler } from './rpc'
import { createClient, defineRoute, flattenRoutes, matchRoutePath, parseRouteInput } from './rpc'

const routes = {
  capacity: {
    get: defineRoute({
      method: 'get',
      path: '/v1/capacity',
      scope: 'matches',
      response: z.object({ providers: z.array(z.string()) }),
    }),
  },
  matches: {
    cancel: defineRoute({
      method: 'post',
      path: '/v1/matches/:matchId/cancel',
      scope: 'matches',
      params: z.object({ matchId: z.string() }),
      body: z.object({ reason: z.string().min(2) }),
      response: z.object({ state: z.string() }),
    }),
    list: defineRoute({
      method: 'get',
      path: '/v1/matches',
      scope: 'matches',
      query: z.object({ limit: z.coerce.number().int().optional() }),
      response: z.array(z.object({ id: z.string() })),
    }),
  },
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('defineRoute', () => {
  it('rejects non-kebab paths at definition time', () => {
    expect(() =>
      defineRoute({
        method: 'get',
        path: '/v1/playerTokens',
        scope: 'matches',
        response: z.object({}),
      }),
    ).toThrow()
  })

  it('refuses a route outside /v1/ — the one door has one prefix', () => {
    expect(() =>
      defineRoute({ method: 'get', path: '/gamemodes', scope: 'matches', response: z.object({}) }),
    ).toThrow(/\/v1\//)
  })

  it('requires a scope from the closed set', () => {
    expect(() =>
      defineRoute({
        method: 'get',
        path: '/v1/anything',
        scope: 'root' as never,
        response: z.object({}),
      }),
    ).toThrow()
  })

  it('requires the params schema to match the path tokens exactly', () => {
    expect(() =>
      defineRoute({
        method: 'get',
        path: '/v1/matches/:matchId',
        scope: 'matches',
        response: z.object({}),
      }),
    ).toThrow(/missing: \[matchId\]/)
    expect(() =>
      defineRoute({
        method: 'get',
        path: '/v1/matches',
        scope: 'matches',
        params: z.object({ matchId: z.string() }),
        response: z.object({}),
      }),
    ).toThrow(/extra: \[matchId\]/)
  })
})

describe('the route tree helpers', () => {
  it('flattens a tree depth first with dotted keys', () => {
    expect(flattenRoutes(routes).map(entry => entry.key)).toEqual([
      'capacity.get',
      'matches.cancel',
      'matches.list',
    ])
  })

  it('matches a request path against a pattern and decodes params', () => {
    expect(matchRoutePath('/v1/matches/:matchId/cancel', '/v1/matches/a%20b/cancel')).toEqual({
      matchId: 'a b',
    })
    expect(matchRoutePath('/v1/matches/:matchId', '/v1/matches')).toBeNull()
    expect(matchRoutePath('/v1/matches/:matchId', '/v1/matches/')).toBeNull()
  })
})

describe('createClient', () => {
  it('builds the URL, substitutes params, sends the validated body', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const client = createClient(routes, {
      baseUrl: 'https://gs.ezpug.example',
      fetch: async (input, init) => {
        seen.url = String(input)
        seen.init = init
        return jsonResponse(200, { state: 'cancelled' })
      },
    })
    const result = await client.matches.cancel({
      params: { matchId: 'm 1' },
      body: { reason: 'no show' },
    })
    expect(result.state).toBe('cancelled')
    expect(seen.url).toBe('https://gs.ezpug.example/v1/matches/m%201/cancel')
    expect(seen.init?.method).toBe('POST')
    expect(JSON.parse(String(seen.init?.body))).toEqual({ reason: 'no show' })
  })

  it('appends query params and calls no-input routes with zero args', async () => {
    let url = ''
    const client = createClient(routes, {
      baseUrl: 'https://gs.ezpug.example',
      fetch: async input => {
        url = String(input)
        return url.includes('/capacity')
          ? jsonResponse(200, { providers: [] })
          : jsonResponse(200, [])
      },
    })
    await client.matches.list({ query: { limit: 5 } })
    expect(url).toBe('https://gs.ezpug.example/v1/matches?limit=5')
    const capacity = await client.capacity.get()
    expect(capacity.providers).toEqual([])
  })

  it('rejects invalid input before any request is made', async () => {
    const client = createClient(routes, {
      baseUrl: 'https://gs.ezpug.example',
      fetch: async () => {
        throw new Error('must not fetch')
      },
    })
    await expect(
      client.matches.cancel({ params: { matchId: 'm1' }, body: { reason: 'x' } }),
    ).rejects.toThrow(z.ZodError)
  })

  it('validates the response against the contract', async () => {
    const client = createClient(routes, {
      baseUrl: 'https://gs.ezpug.example',
      fetch: async () => jsonResponse(200, { wrong: true }),
    })
    await expect(client.capacity.get()).rejects.toThrow(z.ZodError)
  })

  it('turns error envelopes into ApiError with status, code and details', async () => {
    const client = createClient(routes, {
      baseUrl: 'https://gs.ezpug.example',
      fetch: async () =>
        jsonResponse(402, {
          error: {
            code: 'budget_exceeded',
            message: 'Monthly ceiling reached.',
            details: { limit: 'monthlyCents' },
          },
        }),
    })
    const failure = await client.capacity.get().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(402)
    expect((failure as ApiError).code).toBe('budget_exceeded')
    expect((failure as ApiError).message).toBe('Monthly ceiling reached.')
    expect((failure as ApiError).details).toEqual({ limit: 'monthlyCents' })
  })

  it('falls back to the status line when the error body is not an envelope', async () => {
    const client = createClient(routes, {
      baseUrl: 'https://gs.ezpug.example',
      fetch: async () => new Response('boom', { status: 502, statusText: 'Bad Gateway' }),
    })
    const failure = await client.capacity.get().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).code).toBe('unknown_error')
    expect((failure as ApiError).status).toBe(502)
  })

  it('sends extra headers from the headers hook', async () => {
    let auth: string | null = null
    const client = createClient(routes, {
      baseUrl: 'https://gs.ezpug.example',
      headers: () => ({ authorization: 'Bearer token' }),
      fetch: async (_input, init) => {
        auth = new Headers(init?.headers).get('authorization')
        return jsonResponse(200, { providers: [] })
      },
    })
    await client.capacity.get()
    expect(auth).toBe('Bearer token')
  })
})

describe('server-side helpers', () => {
  it('parseRouteInput validates each piece against the contract', () => {
    const input = parseRouteInput(routes.matches.cancel, {
      params: { matchId: 'm1' },
      body: { reason: 'no show' },
    })
    expect(input.params.matchId).toBe('m1')
    expect(input.body.reason).toBe('no show')
    expect(input.query).toBeUndefined()
    expect(() =>
      parseRouteInput(routes.matches.cancel, { params: {}, body: { reason: 'ok' } }),
    ).toThrow()
  })

  it('RouteHandler types the implementation against the contract', () => {
    const handler: RouteHandler<typeof routes.matches.cancel> = async input => ({
      state: input.body.reason,
    })
    expectTypeOf(handler).parameter(0).toHaveProperty('body')
  })

  it('error envelope schema pins the closed code set', () => {
    expect(
      errorEnvelopeSchema.safeParse({ error: { code: 'not_found', message: 'Nope.' } }).success,
    ).toBe(true)
    expect(
      errorEnvelopeSchema.safeParse({ error: { code: 'not-found', message: 'Nope.' } }).success,
    ).toBe(false)
  })
})
