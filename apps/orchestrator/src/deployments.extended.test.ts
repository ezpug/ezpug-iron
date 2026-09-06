/**
 * **Two deployments, one database** (PRD-02 T21c) — the reproduction of the
 * P1 and the wall that keeps it fixed.
 *
 * The reaper reads the ledger and holds it against what its providers say is
 * running. Both halves used to be read at different scopes: the rows were
 * *every* open row in the database, the providers were only this process's.
 * So a second orchestrator on the same database — dev beside production, or,
 * every time `pnpm verify` runs, this suite's neighbour standing an
 * orchestrator of its own — read rows whose servers its own `sim` had never
 * heard of, called each one lost, and failed a match somebody else was
 * playing: `provider_error: server lost before going live: sim no longer
 * lists server sim-1`. It needed no load and no starvation, only a
 * reconciliation pass landing inside a neighbour's match, which is why the
 * conformance tier was green alone and red under a whole verify.
 *
 * The reaper was the sharpest edge, not the only one. Everything a process
 * does *on its own initiative* used to read the whole database: the boot's
 * `resume()` re-armed every open match's deadlines and restarted the walks
 * that died with a process — including a match another process was in the
 * middle of, which is two machines on one row and a second server allocated
 * for a match that already has one — and the webhook worker POSTed every due
 * delivery, including a neighbour's.
 *
 * Every match and every ledger row now carries the deployment that opened it
 * and each of those three reads asks only for its own (`src/deployment.ts`).
 * This file proves the directions that matter: a neighbour leaves the match
 * alone, and the owner still finds its own losses.
 *
 * Skips loudly when the dev world is down; `EZPUG_IRON_DATABASE_TESTS=required`
 * (what `pnpm verify:extended` sets) makes that red.
 */

import { randomUUID } from 'node:crypto'
import { systemClock } from '@ezpug/core'
import { createMatchApiClient } from '@ezpug/match-api/client'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type OrchestratorConfig, readDatabaseConfig, readOrchestratorConfig } from './config'
import { createDatabase } from './db/client'
import {
  apiKeys,
  apiKeyWebhookSecrets,
  backups,
  matchCommands,
  matchEvents,
  matches,
  servers,
  serverTokens,
  webhookDeliveries,
} from './db/schema'
import { testNamespace } from './db/testing'
import { loadRootEnv } from './env'
import { createMemoryLog } from './log'
import { createOrchestrator, type Orchestrator } from './orchestrator'

const namespace = testNamespace(import.meta.url)
const SECRET_ID = 'whsec-deployments'
const SECRET = 'orchestrator-deployments-webhook-secret-not-a-real-one-0123456789'

let mine: Orchestrator | undefined
let neighbour: Orchestrator | undefined
let config: OrchestratorConfig | undefined
let url = ''
let unavailable: string | undefined
const log = createMemoryLog()
const minted: string[] = []

/** The same composition twice, differing only in which deployment it is. */
function stand(deployment: string): Orchestrator {
  return createOrchestrator({
    config: {
      ...(config as OrchestratorConfig),
      deployment,
    },
    clock: systemClock,
    log,
    // Slow enough that the match is still `configuring` when the neighbour
    // reconciles — this file is about the ledger, not about the story.
    sim: { timeScale: 1, positionTickIntervalMs: 60_000 },
  })
}

beforeAll(async () => {
  loadRootEnv()
  try {
    config = {
      ...readOrchestratorConfig({ ...process.env, EZPUG_IRON_PROVIDERS: 'sim' }),
      database: readDatabaseConfig(process.env, { target: 'test' }),
    }
    mine = stand(`${namespace}-a`)
    neighbour = stand(`${namespace}-b`)
    await mine.database.ping()
    await mine.redis.ping()
    const { runMigrations } = await import('./db/migrate')
    await runMigrations(mine.database)
    await sweep()
    await mine.start()
    await neighbour.start()
    url = (await mine.listen({ port: 0, host: '127.0.0.1' })).url
  } catch (error) {
    unavailable = error instanceof Error ? error.message : String(error)
    for (const o of [mine, neighbour]) {
      await o?.database.close().catch(() => {})
      await o?.redis.close().catch(() => {})
    }
    mine = undefined
    neighbour = undefined
    if (process.env.EZPUG_IRON_DATABASE_TESTS === 'required')
      throw new Error(`the two-deployment suite is required but ${unavailable}`)
    process.stderr.write(
      `\n[orchestrator] skipping the two-deployment suite — ${unavailable}\n` +
        '               boot the dev world with `pnpm dev:up`.\n\n',
    )
  }
}, 60_000)

beforeEach(ctx => {
  if (unavailable) ctx.skip(`dev world unavailable: ${unavailable}`)
})

/** Everything this file committed, through a handle of its own. */
async function sweep(): Promise<void> {
  if (!config || minted.length === 0) return
  const cleanup = createDatabase(config.database, { applicationName: 'ezpug-iron-test-cleanup' })
  try {
    const { db } = cleanup
    const rows = await db
      .select({ id: matches.id })
      .from(matches)
      .where(inArray(matches.keyId, minted))
    const ids = rows.map(row => row.id)
    if (ids.length > 0) {
      await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.matchId, ids))
      await db.delete(matchEvents).where(inArray(matchEvents.matchId, ids))
      await db.delete(matchCommands).where(inArray(matchCommands.matchId, ids))
      await db.delete(backups).where(inArray(backups.matchId, ids))
    }
    const owned = await db
      .select({ id: servers.id })
      .from(servers)
      .where(inArray(servers.keyId, minted))
    if (owned.length > 0)
      await db.delete(serverTokens).where(
        inArray(
          serverTokens.fleetServerId,
          owned.map(row => row.id),
        ),
      )
    await db.delete(servers).where(inArray(servers.keyId, minted))
    await db.delete(matches).where(inArray(matches.keyId, minted))
    for (const id of minted) {
      await db.delete(apiKeyWebhookSecrets).where(eq(apiKeyWebhookSecrets.keyId, id))
      await db.delete(apiKeys).where(eq(apiKeys.id, id))
    }
  } finally {
    await cleanup.close()
  }
}

afterAll(async () => {
  if (mine?.server.listening) await mine.close('afterAll')
  await neighbour?.close('afterAll').catch(() => {})
  await sweep()
}, 60_000)

/** A match on `mine`, left `configuring` with an open ledger row. */
async function startMatch(name: string) {
  const o = mine as Orchestrator
  const { key, secret } = await o.keys.mint({
    name: `${namespace}-${name}`,
    scopes: ['matches'],
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [{ id: SECRET_ID, secret: SECRET }],
  })
  minted.push(key.id)
  const client = createMatchApiClient({
    baseUrl: url,
    apiKey: secret,
    clock: systemClock,
    retry: false,
  })
  const created = await client.matches.create({
    body: {
      clientMatchId: `${namespace}-${name}-${randomUUID().slice(0, 8)}`,
      game: 'cs2',
      gamemode: 'pug',
      teams: { teamA: { name: 'A', players: [] }, teamB: { name: 'B', players: [] } },
      maps: [{ map: 'de_mirage', sides: 'ct' }],
      callbacks: { webhookUrl: 'http://127.0.0.1:9/hooks', webhookSecretId: SECRET_ID },
      ttlMinutes: 120,
    },
  })
  await o.matches.settle()
  return { client, matchId: created.id }
}

describe('a reaper only judges its own deployment’s ledger rows', () => {
  it('leaves the neighbour’s match running, and its row out of the neighbour’s fleet', async () => {
    const other = neighbour as Orchestrator
    const { client, matchId } = await startMatch('kept')
    const before = await client.matches.get({ params: { matchId } })
    expect(before.fleetServerId).not.toBeNull()

    // The neighbour reconciles: its own `sim` has never heard of this server.
    const report = await other.reaper.reconcile()
    await other.matches.settle()
    await (mine as Orchestrator).matches.settle()

    expect(report.lost).toEqual([])
    expect(report.reaped).toEqual([])
    expect(report.expired).toEqual([])
    expect(report.failures).toEqual([])
    // The one line that used to read `failed`.
    const after = await client.matches.get({ params: { matchId } })
    expect([after.state, JSON.stringify(after.endedReason)]).toEqual([before.state, 'null'])
    // And "what is running" is per deployment too, so the neighbour's own
    // gate ("left no server running") cannot be failed by somebody else.
    expect(await other.fleet.servers()).toEqual([])
    expect((await (mine as Orchestrator).fleet.servers()).map(row => row.id)).toContain(
      before.fleetServerId,
    )
  }, 60_000)

  it('resumes and delivers only its own — a neighbour’s boot adopts nothing', async () => {
    const other = neighbour as Orchestrator
    const o = mine as Orchestrator
    const { client, matchId } = await startMatch('resume')
    const before = await client.matches.get({ params: { matchId } })

    // The two reads a process acts on by itself, at the neighbour's scope.
    // These are the wall: unscoped, both answered with this match.
    expect(await other.store.listOpenMatches()).toEqual([])
    const anHourOn = new Date(systemClock.now() + 3_600_000)
    expect(await other.store.listDueDeliveries(anHourOn, 100)).toEqual([])
    // …and the same two, at the owner's, are not empty — the scope narrows
    // the reads, it does not switch them off.
    expect((await o.store.listOpenMatches()).map(row => row.id)).toContain(matchId)
    expect((await o.store.listDeliveries(matchId)).length).toBeGreaterThan(0)

    // A neighbour booting is a `resume()`; it must adopt nothing.
    await other.matches.resume()
    await other.matches.settle()
    await o.matches.settle()
    const after = await client.matches.get({ params: { matchId } })
    expect([after.state, after.provider, after.serverId, after.fleetServerId]).toEqual([
      before.state,
      before.provider,
      before.serverId,
      before.fleetServerId,
    ])
    expect(await other.fleet.servers()).toEqual([])
  }, 60_000)

  it('still finds its own loss — the scope narrows the reaper, it does not blind it', async () => {
    const o = mine as Orchestrator
    const { client, matchId } = await startMatch('lost')
    const before = await client.matches.get({ params: { matchId } })
    expect(before.serverId).not.toBeNull()

    // The server goes away behind the ledger's back; this deployment's own
    // pass is the one that must notice.
    await o.providers.get('sim')?.deallocate(before.serverId as string)
    const report = await o.reaper.reconcile()
    await o.matches.settle()

    expect(report.lost.map(row => row.serverId)).toEqual([before.serverId])
    const after = await client.matches.get({ params: { matchId } })
    expect(after.state).toBe('failed')
    expect(after.endedReason?.kind).toBe('provider_error')
  }, 60_000)
})
