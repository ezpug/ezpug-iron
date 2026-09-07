/**
 * **The shared namespace sweep** (PRD-02 T26a), against a real Postgres.
 *
 * The suites that commit — the standing orchestrator, the conformance tier,
 * the two-deployment suite — used to undo their rows from a list of ids the
 * *process* remembered, which is a list only a run that reaches `afterAll`
 * has. A red `pnpm verify` cancels its siblings mid-flight, so the next run
 * met `conflict: an API key named … already exists` on a change that had
 * nothing to do with it. `sweepNamespace` reads the residue out of the
 * database instead, by the prefix every committed key name carries, and the
 * suites call it in `beforeAll` as well.
 *
 * This file writes the whole shape a suite leaves behind — a key with a
 * webhook secret and a budget notice, a match with an event and a delivery,
 * a ledger row with its token and a leased GSLT, a node it enrolled — and
 * proves the sweep takes all of it and touches nothing next door.
 *
 * Skips loudly when the dev world is down; `EZPUG_IRON_DATABASE_TESTS=required`
 * makes that red.
 */
import { randomUUID } from 'node:crypto'
import type { MatchRequest, WebhookPayload } from '@ezpug/match-api'
import { eq, like } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  apiKeyBudgetNotices,
  apiKeys,
  apiKeyWebhookSecrets,
  gsltTokens,
  matchEvents,
  matches,
  nodes,
  servers,
  serverTokens,
  webhookDeliveries,
} from './schema'
import { sweepNamespace, useTestDatabase } from './testing'

const database = useTestDatabase()
const AT = new Date('2026-09-07T20:00:00.000Z')

/** One suite's whole residue under `namespace`, committed. */
async function leaveResidue(namespace: string): Promise<{ keyId: string; serverId: string }> {
  const { db } = database
  const keyId = randomUUID()
  const matchId = randomUUID()
  const serverId = randomUUID()
  const deliveryId = randomUUID()
  await db.insert(apiKeys).values({
    id: keyId,
    name: `${namespace}-root`,
    prefix: 'ezik_swee',
    secretHash: randomUUID().replace(/-/g, ''),
    scopes: ['matches'],
    budgetMaxConcurrentServers: 1,
    budgetMaxServerLifetimeMinutes: 60,
    budgetMonthlyCents: 0,
    createdAt: AT,
  })
  await db
    .insert(apiKeyWebhookSecrets)
    .values({ keyId, id: 'whsec-sweep', secret: 'not-a-real-one', createdAt: AT })
  await db.insert(apiKeyBudgetNotices).values({
    keyId,
    limit: 'monthlyCents',
    fraction: '0.8',
    monthStartedAt: AT,
    sentAt: AT,
  })
  await db.insert(matches).values({
    id: matchId,
    keyId,
    clientMatchId: `${namespace}-match`,
    state: 'ended',
    stateChangedAt: AT,
    game: 'cs2',
    gamemode: 'pug',
    requestJson: {} as MatchRequest,
    requestHash: 'sweep',
    expiresAt: AT,
    createdAt: AT,
    updatedAt: AT,
  })
  await db.insert(matchEvents).values({
    matchId,
    seq: 1,
    deliveryId,
    type: 'match_created',
    occurredAt: AT,
    payload: {} as WebhookPayload,
  })
  await db.insert(webhookDeliveries).values({
    deliveryId,
    matchId,
    seq: 1,
    url: 'http://127.0.0.1:9/hooks',
    secretId: 'whsec-sweep',
    status: 'delivered',
    deliveredAt: AT,
    createdAt: AT,
    updatedAt: AT,
  })
  await db.insert(servers).values({
    id: serverId,
    provider: 'sim',
    keyId,
    matchId,
    state: 'released',
    game: 'cs2',
    costHourlyCents: 0,
    expiresAt: AT,
    allocatedAt: AT,
  })
  await db
    .insert(serverTokens)
    .values({ id: randomUUID(), fleetServerId: serverId, tokenHash: randomUUID(), createdAt: AT })
  await db.insert(gsltTokens).values({
    id: randomUUID(),
    steamId: `${namespace}-steam`,
    loginToken: 'not-a-real-one',
    memo: `ezpug-iron ${namespace}`,
    leasedByServerId: serverId,
    leasedAt: AT,
    createdAt: AT,
  })
  await db
    .insert(nodes)
    .values({ id: `${namespace}-node`, region: 'saarland', enrolledByKeyId: keyId, enrolledAt: AT })
  return { keyId, serverId }
}

describe('sweepNamespace', () => {
  it('takes everything a killed run left under its prefix, and nothing next door', async () => {
    const { db } = database
    const base = `${database.namespace}-${randomUUID().slice(0, 8)}`
    const mine = `${base}-mine`
    const next = `${base}-next`
    try {
      const left = await leaveResidue(mine)
      const neighbour = await leaveResidue(next)

      await sweepNamespace(db, mine)

      expect(await db.select().from(apiKeys).where(eq(apiKeys.id, left.keyId))).toHaveLength(0)
      expect(
        await db
          .select()
          .from(apiKeyWebhookSecrets)
          .where(eq(apiKeyWebhookSecrets.keyId, left.keyId)),
      ).toHaveLength(0)
      expect(
        await db
          .select()
          .from(apiKeyBudgetNotices)
          .where(eq(apiKeyBudgetNotices.keyId, left.keyId)),
      ).toHaveLength(0)
      expect(await db.select().from(matches).where(eq(matches.keyId, left.keyId))).toHaveLength(0)
      expect(await db.select().from(servers).where(eq(servers.keyId, left.keyId))).toHaveLength(0)
      expect(
        await db.select().from(serverTokens).where(eq(serverTokens.fleetServerId, left.serverId)),
      ).toHaveLength(0)
      expect(
        await db
          .select()
          .from(nodes)
          .where(eq(nodes.id, `${mine}-node`)),
      ).toHaveLength(0)
      // The account is back in the pool rather than leased to a row that is gone.
      const [released] = await db
        .select()
        .from(gsltTokens)
        .where(eq(gsltTokens.steamId, `${mine}-steam`))
      expect(released?.leasedByServerId).toBe(null)

      // The neighbour's namespace shares this file's stem and is untouched.
      expect(await db.select().from(apiKeys).where(eq(apiKeys.id, neighbour.keyId))).toHaveLength(1)
      expect(
        await db.select().from(matches).where(eq(matches.keyId, neighbour.keyId)),
      ).toHaveLength(1)
    } finally {
      // Its own subject, on the prefix both namespaces hang off.
      await sweepNamespace(db, base)
      await db.delete(gsltTokens).where(like(gsltTokens.memo, `ezpug-iron ${base}-%`))
    }
  })

  it('is a no-op for a namespace that never committed anything', async () => {
    await expect(
      sweepNamespace(database.db, `${database.namespace}-nothing`),
    ).resolves.toBeUndefined()
  })
})
