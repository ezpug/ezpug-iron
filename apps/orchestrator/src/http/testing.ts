import { createFakeClock, type FakeClock } from '@ezpug/core'
import { SHIPPED_GAMEMODES } from '@ezpug/match-api'
import { createApp } from '../app'
import { createHealth, type HealthReport } from '../health'
import { createMemoryKeyStore } from '../keys/memory-store'
import { createKeys, type Keys } from '../keys/service'
import { createMemoryLog } from '../log'
import { createDispatch } from './dispatch'
import { createHandlers } from './handlers'
import { createRateLimiter } from './rate-limit'

/**
 * The HTTP rails composed over memory — what every test of the app itself
 * runs on: a fake clock, the in-memory key store, a captured log, health
 * checks a test can flip. Nothing here opens a socket or a pool; the
 * database-backed and the standing suites prove those.
 */
export interface TestApp {
  app: ReturnType<typeof createApp>
  keys: Keys
  clock: FakeClock
  log: ReturnType<typeof createMemoryLog>
  /** Flip a rail's health; both start healthy. */
  rails: { database: boolean; redis: boolean }
  draining: { value: boolean }
  /** One request through the app, in-process. */
  request: (
    path: string,
    init?: RequestInit & { key?: string; json?: unknown },
    // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever JSON came back
  ) => Promise<{ status: number; body: any; headers: Headers }>
  health: () => Promise<HealthReport>
}

export function createTestApp(options: { burst?: number; perSecond?: number } = {}): TestApp {
  const clock = createFakeClock()
  const log = createMemoryLog()
  const keys = createKeys({ store: createMemoryKeyStore(), clock })
  const rails = { database: true, redis: true }
  const draining = { value: false }
  const rail = (name: keyof typeof rails) => (): Promise<void> =>
    rails[name] ? Promise.resolve() : Promise.reject(new Error(`${name} is down`))
  const health = createHealth({ clock, database: rail('database'), redis: rail('redis') })
  const app = createApp({
    clock,
    log,
    dispatch: createDispatch(keys, createHandlers({ keys, gamemodes: SHIPPED_GAMEMODES })),
    rateLimiter: createRateLimiter({
      clock,
      burst: options.burst ?? 120,
      perSecond: options.perSecond ?? 10,
    }),
    health,
    isDraining: () => draining.value,
  })
  return {
    app,
    keys,
    clock,
    log,
    rails,
    draining,
    health,
    request: async (path, init = {}) => {
      const { key, json, ...rest } = init
      const headers = new Headers(rest.headers)
      if (key) headers.set('authorization', `Bearer ${key}`)
      if (json !== undefined) headers.set('content-type', 'application/json')
      const response = await app.request(path, {
        ...rest,
        headers,
        body: json !== undefined ? JSON.stringify(json) : rest.body,
      })
      const text = await response.text()
      return {
        status: response.status,
        body: text.length > 0 ? JSON.parse(text) : undefined,
        headers: response.headers,
      }
    },
  }
}

/** A key request with the round's default budget — what most tests mint. */
export function keyRequest(name: string, scopes: ('matches' | 'fleet' | 'admin')[] = ['matches']) {
  return {
    name,
    scopes,
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [],
  }
}
