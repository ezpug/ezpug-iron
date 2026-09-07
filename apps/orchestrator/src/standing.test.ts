/**
 * **The orchestrator, standing** (PRD-02 T2): the whole composition over a
 * real socket, a real Postgres and a real Redis — boot, `/healthz` with every
 * rail green, a key minted through the real key store and used over HTTP,
 * the drain in order, the port gone afterwards. Skips loudly when the dev
 * world is down; `EZPUG_IRON_DATABASE_TESTS=required` makes that red.
 *
 * It writes keys through the pool (the HTTP path has no transaction to roll
 * back), stamped with this file's namespace and swept by that prefix both
 * before the suite and after it (T26a) — `afterAll` is the hook a cancelled
 * run never reaches, and a leftover key would fail the next run's mint on
 * the live-name unique index.
 */

import { systemClock } from '@ezpug/core'
import { createMatchApiClient } from '@ezpug/match-api/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type OrchestratorConfig, readDatabaseConfig, readOrchestratorConfig } from './config'
import { sweepTestNamespace, testNamespace } from './db/testing'
import { loadRootEnv } from './env'
import { createMemoryLog } from './log'
import { createOrchestrator, type Orchestrator } from './orchestrator'

let orchestrator: Orchestrator | undefined
let config: OrchestratorConfig | undefined
let url = ''
let unavailable: string | undefined
const log = createMemoryLog()
const namespace = testNamespace(import.meta.url)

beforeAll(async () => {
  loadRootEnv()
  try {
    config = {
      // This suite's own deployment (T21c) — its reaper must not judge the
      // ledger rows another suite is holding open in the same test database.
      ...readOrchestratorConfig({ ...process.env, EZPUG_IRON_DEPLOYMENT: namespace }),
      database: readDatabaseConfig(process.env, { target: 'test' }),
    }
    orchestrator = createOrchestrator({ config, clock: systemClock, log })
    await orchestrator.database.ping()
    await orchestrator.redis.ping()
    const { runMigrations } = await import('./db/migrate')
    await runMigrations(orchestrator.database)
    await sweepTestNamespace(config.database, namespace)
    await orchestrator.start()
    url = (await orchestrator.listen({ port: 0, host: '127.0.0.1' })).url
  } catch (error) {
    unavailable = error instanceof Error ? error.message : String(error)
    await orchestrator?.database.close().catch(() => {})
    await orchestrator?.redis.close().catch(() => {})
    orchestrator = undefined
    if (process.env.EZPUG_IRON_DATABASE_TESTS === 'required')
      throw new Error(`the standing suite is required but ${unavailable}`)
    process.stderr.write(
      `\n[orchestrator] skipping the standing suite — ${unavailable}\n` +
        '               boot the dev world with `pnpm dev:up`.\n\n',
    )
  }
})

beforeEach(ctx => {
  if (unavailable) ctx.skip(`dev world unavailable: ${unavailable}`)
})

afterAll(async () => {
  if (!orchestrator || !config) return
  // The last test drained the orchestrator, pool included, so the rows it
  // committed are removed through a handle of the sweep's own.
  if (orchestrator.server.listening) await orchestrator.close('afterAll')
  await sweepTestNamespace(config.database, namespace)
})

describe('the orchestrator over a real socket', () => {
  it('answers /healthz 200 with the database and Redis green', async () => {
    const response = await fetch(`${url}/healthz`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      checks: { database: { ok: boolean }; redis: { ok: boolean } }
    }
    expect(body.ok).toBe(true)
    expect(body.checks.database.ok).toBe(true)
    expect(body.checks.redis.ok).toBe(true)
  })

  it('mints a key through the real store and serves the catalog to it with the published client', async () => {
    const o = orchestrator as Orchestrator
    const { secret } = await o.keys.mint({
      name: `${namespace}-root`,
      scopes: ['admin'],
      budget: { maxConcurrentServers: 1, maxServerLifetimeMinutes: 60, monthlyCents: 0 },
      webhookSecrets: [],
    })
    const client = createMatchApiClient({ baseUrl: url, apiKey: secret, clock: systemClock })
    const catalog = await client.gamemodes.list()
    expect(catalog.gamemodes.map(m => m.id)).toEqual([
      'pug',
      'flying-scoutsman',
      'retakes',
      'powerup-dm',
    ])
    const created = await client.keys.create({
      body: {
        name: `${namespace}-platform`,
        scopes: ['matches'],
        budget: { maxConcurrentServers: 1, maxServerLifetimeMinutes: 60, monthlyCents: 0 },
        webhookSecrets: [],
      },
    })
    expect(created.secret).toMatch(/^ezik_/)
    const listed = await client.keys.list()
    expect(listed.keys.some(k => k.id === created.key.id)).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(created.secret)
    // The log never carried a secret.
    expect(log.lines.join('\n')).not.toContain(secret)
    expect(log.lines.join('\n')).not.toContain(created.secret)
    expect(log.lines.some(line => /GET \/v1\/gamemodes 200 \d+ms key=ezik_/.test(line))).toBe(true)
  })

  it('drains in order and the port is gone afterwards', async () => {
    const o = orchestrator as Orchestrator
    const result = await o.close('test')
    expect(result.steps.map(step => step.name)).toEqual([
      'health',
      'listener',
      'links',
      'node-links',
      'streams',
      'requests',
      'reaper',
      'probes',
      'budgets',
      'gslt',
      'webhooks',
      'matches',
      'hub',
      'redis',
      'database',
    ])
    expect(result.code).toBe(0)
    await expect(fetch(`${url}/healthz`)).rejects.toThrow()
  })
})
