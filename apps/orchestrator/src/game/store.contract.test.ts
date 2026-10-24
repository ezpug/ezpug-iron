import { randomUUID } from 'node:crypto'
import type { GameFact } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { useTestDatabase } from '../db/testing'
import { createMemoryGameStore } from './memory-store'
import { createPostgresGameStore } from './postgres-store'
import type { GameStore } from './store'

/**
 * **The game store's contract, over both implementations** (PRD-10 T2): the
 * memory store always, Postgres inside a rolled-back transaction when the
 * dev world is up. The watcher is proven over memory; this is what makes
 * that proof worth something.
 */
const database = useTestDatabase()
const at = (offsetMs = 0) => new Date(Date.parse('2026-10-24T12:00:00.000Z') + offsetMs)

const moved = (from: string | null, to: string, observedAt: Date): GameFact => ({
  type: 'game.build_moved',
  from,
  to,
  observedAt: observedAt.toISOString(),
  steamBuildId: null,
  sourceRevision: null,
  pins: { a: '1' },
})

const released = (repo: string, version: string, observedAt: Date): GameFact => ({
  type: 'game.upstream_released',
  repo,
  version,
  publishedAt: null,
  pinned: '0',
  observedAt: observedAt.toISOString(),
})

const unproven = (build: string | null, since: Date | null) => ({
  state: 'unproven' as const,
  build,
  since: since?.toISOString() ?? null,
  reason: null,
})

async function contract(store: GameStore): Promise<void> {
  // Facts: appended, listed newest first, by type when asked.
  await store.appendFact({ id: randomUUID(), at: at(0), build: '1', fact: moved(null, '1', at(0)) })
  await store.appendFact({
    id: randomUUID(),
    at: at(1000),
    build: '1',
    fact: released('a/b', '2', at(1000)),
  })
  await store.appendFact({
    id: randomUUID(),
    at: at(2000),
    build: '2',
    fact: moved('1', '2', at(2000)),
  })
  const all = await store.listFacts(10)
  expect(all.map(row => row.fact.type)).toEqual([
    'game.build_moved',
    'game.upstream_released',
    'game.build_moved',
  ])
  expect(all[0]?.build).toBe('2')
  expect(await store.listFacts(1)).toHaveLength(1)
  expect((await store.listFacts(10, 'game.upstream_released')).map(row => row.fact.type)).toEqual([
    'game.upstream_released',
  ])

  // Builds: written once, found, the newest read, the issue taken later.
  expect(await store.latestBuild()).toBeUndefined()
  const row = {
    build: '1.41.9.2',
    steamBuildId: null,
    sourceRevision: null,
    observedAt: at(0),
    issueNumber: null,
    issueUrl: null,
  }
  await store.insertBuild(row)
  await store.insertBuild({ ...row, steamBuildId: 'ignored-second-insert' })
  expect(await store.findBuild('1.41.9.2')).toEqual(row)
  await store.updateBuild('1.41.9.2', {
    steamBuildId: '26144732',
    issueNumber: 7,
    issueUrl: 'https://github.com/ezpug/ezpug-iron/issues/7',
  })
  expect(await store.findBuild('1.41.9.2')).toMatchObject({
    steamBuildId: '26144732',
    issueNumber: 7,
    issueUrl: 'https://github.com/ezpug/ezpug-iron/issues/7',
  })
  await store.insertBuild({ ...row, build: '1.41.9.3', observedAt: at(60_000) })
  expect((await store.latestBuild())?.build).toBe('1.41.9.3')
  expect(await store.findBuild('nope')).toBeUndefined()
  await store.updateBuild('nope', { issueNumber: 1 })

  // Provider pictures: one row each, rewritten, in provider order.
  expect(await store.listProviderStates()).toEqual([])
  const sim = {
    provider: 'sim',
    build: '1.41.9.2',
    buildSince: at(0),
    stack: null,
    canary: unproven('1.41.9.2', at(0)),
    hud: unproven('1.41.9.2', at(0)),
    updatedAt: at(0),
  }
  await store.upsertProviderState({ ...sim, provider: 'rented' })
  await store.upsertProviderState(sim)
  await store.upsertProviderState({
    ...sim,
    stack: 'abc',
    canary: { state: 'green', build: '1.41.9.2', since: at(5000).toISOString(), reason: null },
    updatedAt: at(5000),
  })
  const states = await store.listProviderStates()
  expect(states.map(state => state.provider)).toEqual(['rented', 'sim'])
  expect(states[1]).toMatchObject({
    stack: 'abc',
    canary: { state: 'green' },
    hud: unproven('1.41.9.2', at(0)),
    updatedAt: at(5000),
  })
}

describe('the game store contract', () => {
  it('holds over memory', async () => {
    await contract(createMemoryGameStore())
  })

  it('holds over Postgres', async () => {
    await database.rollback(async tx => {
      await contract(createPostgresGameStore(tx, { deployment: database.namespace }))
    })
  })
})
