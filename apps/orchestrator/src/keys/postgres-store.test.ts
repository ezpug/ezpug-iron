import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { useTestDatabase } from '../db/testing'
import { hashToken, mintToken } from '../tokens'
import { createPostgresKeyStore } from './postgres-store'
import { KeyNameTakenError } from './store'

const database = useTestDatabase()

const at = new Date('2026-09-05T18:00:00.000Z')

function input(name: string) {
  const secret = mintToken('apiKey')
  return {
    secret,
    row: {
      id: randomUUID(),
      name,
      prefix: secret.slice(0, 12),
      secretHash: hashToken(secret),
      scopes: ['matches', 'fleet'] as const,
      budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 100 },
      webhookSecrets: [{ id: 'whsec-1', secret: 'a-test-secret-of-at-least-thirty-two-chars' }],
      createdAt: at,
    },
  }
}

describe('createPostgresKeyStore', () => {
  it('inserts and reads a key back by id and by hash, secrets included', async () => {
    await database.rollback(async tx => {
      const store = createPostgresKeyStore(tx)
      const { row } = input(`${database.namespace}-a`)
      const inserted = await store.insert(row)
      expect(inserted.key).toMatchObject({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        scopes: ['matches', 'fleet'],
        budget: row.budget,
        webhookSecretIds: ['whsec-1'],
        createdAt: at.toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      })
      expect(inserted.secretHash).toBe(row.secretHash)
      expect(inserted.webhookSecrets.get('whsec-1')).toBe(row.webhookSecrets[0]?.secret)
      expect((await store.findById(row.id))?.key.id).toBe(row.id)
      expect((await store.findBySecretHash(row.secretHash))?.key.id).toBe(row.id)
      expect(await store.findBySecretHash(hashToken(mintToken('apiKey')))).toBeUndefined()
    })
  })

  it('refuses a live name twice and frees it after a revoke', async () => {
    await database.rollback(async tx => {
      const store = createPostgresKeyStore(tx)
      const first = input(`${database.namespace}-b`)
      await store.insert(first.row)
      await expect(store.insert(input(first.row.name).row)).rejects.toBeInstanceOf(
        KeyNameTakenError,
      )
      await store.revoke(first.row.id, at)
      await expect(store.insert(input(first.row.name).row)).resolves.toBeDefined()
    })
  })

  it('revokes once, touches forward only, and replaces secrets as a set', async () => {
    await database.rollback(async tx => {
      const store = createPostgresKeyStore(tx)
      const { row } = input(`${database.namespace}-c`)
      await store.insert(row)
      const later = new Date(at.getTime() + 60_000)
      await store.touch(row.id, later)
      await store.touch(row.id, at)
      expect((await store.findById(row.id))?.key.lastUsedAt).toBe(later.toISOString())
      expect((await store.revoke(row.id, at))?.key.revokedAt).toBe(at.toISOString())
      expect((await store.revoke(row.id, later))?.key.revokedAt).toBe(at.toISOString())
      const rotated = await store.replaceWebhookSecrets(
        row.id,
        [{ id: 'whsec-2', secret: 'another-test-secret-of-thirty-two-chars-x' }],
        later,
      )
      expect([...(rotated?.webhookSecrets.keys() ?? [])]).toEqual(['whsec-2'])
      expect(await store.revoke(randomUUID(), at)).toBeUndefined()
      expect(await store.replaceWebhookSecrets(randomUUID(), [], at)).toBeUndefined()
    })
  })

  it('rotates a secret, moves one ceiling and forgets the notices with it (T5)', async () => {
    await database.rollback(async tx => {
      const store = createPostgresKeyStore(tx)
      const { row, secret } = input(`${database.namespace}-e`)
      await store.insert(row)
      const next = mintToken('apiKey')
      const rotated = await store.rotateSecret(
        row.id,
        { prefix: next.slice(0, 12), secretHash: hashToken(next) },
        at,
      )
      expect(rotated?.key.prefix).toBe(next.slice(0, 12))
      expect((await store.findBySecretHash(hashToken(next)))?.key.id).toBe(row.id)
      expect(await store.findBySecretHash(hashToken(secret))).toBeUndefined()
      // The webhook secrets came along untouched — a rotation is about one credential.
      expect([...(rotated?.webhookSecrets.keys() ?? [])]).toEqual(['whsec-1'])
      expect(await store.rotateSecret(randomUUID(), { prefix: 'x', secretHash: 'y' }, at)).toBe(
        undefined,
      )

      const month = new Date('2026-09-01T00:00:00.000Z')
      const notice = { keyId: row.id, limit: 'monthlyCents', fraction: 0.8, monthStartedAt: month }
      expect(await store.markBudgetNotice(notice, at)).toBe(true)
      expect(await store.markBudgetNotice(notice, at)).toBe(false)
      expect(await store.markBudgetNotice({ ...notice, fraction: 0.95 }, at)).toBe(true)
      // A different month is a different crossing.
      expect(
        await store.markBudgetNotice(
          { ...notice, monthStartedAt: new Date('2026-10-01T00:00:00.000Z') },
          at,
        ),
      ).toBe(true)

      const patched = await store.setBudget(row.id, { monthlyCents: 999 }, at)
      expect(patched?.key.budget).toEqual({ ...row.budget, monthlyCents: 999 })
      // The ceiling moved, so the crossing is new again.
      expect(await store.markBudgetNotice(notice, at)).toBe(true)
      await store.clearBudgetNotices(row.id)
      expect(await store.markBudgetNotice(notice, at)).toBe(true)
      expect(await store.setBudget(randomUUID(), { monthlyCents: 1 }, at)).toBeUndefined()
    })
  })

  it('lists newest first, revoked included', async () => {
    await database.rollback(async tx => {
      const store = createPostgresKeyStore(tx)
      const older = input(`${database.namespace}-d1`)
      const newer = input(`${database.namespace}-d2`)
      await store.insert(older.row)
      await store.insert({ ...newer.row, createdAt: new Date(at.getTime() + 1) })
      await store.revoke(older.row.id, at)
      const mine = (await store.list()).filter(record =>
        record.key.name.startsWith(database.namespace),
      )
      expect(mine.map(record => record.key.name)).toEqual([newer.row.name, older.row.name])
    })
  })
})
