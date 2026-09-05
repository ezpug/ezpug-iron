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
