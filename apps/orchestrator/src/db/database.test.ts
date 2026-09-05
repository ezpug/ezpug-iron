/**
 * The rig, exercised against a real Postgres: connect, migrate, isolate.
 * Skips loudly when the dev world is not running (`pnpm dev:up`);
 * `EZPUG_IRON_DATABASE_TESTS=required` turns that skip into a failure.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { nodes } from './schema'
import { useTestDatabase } from './testing'

const database = useTestDatabase()

describe('connection', () => {
  it('reaches the test database, never the dev world', async () => {
    const [row] = await database.sql<{ name: string }[]>`select current_database() as name`
    expect(row?.name).toBe('ezpug_iron_test')
  })

  it('identifies itself in pg_stat_activity', async () => {
    const [row] = await database.sql<{ name: string }[]>`
      select current_setting('application_name') as name`
    expect(row?.name).toBe('ezpug-iron-test')
  })
})

describe('migrations', () => {
  it('created every table the round designed', async () => {
    const rows = await database.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`
    expect(rows.map(row => row.table_name)).toEqual([
      'api_key_budget_notices',
      'api_key_webhook_secrets',
      'api_keys',
      'backups',
      'gslt_tokens',
      'match_commands',
      'match_events',
      'matches',
      'node_enrolments',
      'nodes',
      'player_tokens',
      'server_tokens',
      'servers',
      'webhook_deliveries',
    ])
  })

  it('are idempotent — a second run changes nothing', async () => {
    const applied = async (): Promise<number> => {
      const [row] = await database.sql<{ count: string }[]>`
        select count(*) as count from drizzle.__drizzle_migrations`
      return Number(row?.count ?? -1)
    }
    const before = await applied()
    expect(before).toBeGreaterThan(0)
    const { runMigrations } = await import('./migrate')
    await runMigrations(database.handle)
    expect(await applied()).toBe(before)
  })
})

describe('rollback isolation', () => {
  it('leaves nothing behind', async () => {
    const id = `${database.namespace}-${randomUUID().slice(0, 8)}`
    await database.rollback(async tx => {
      await tx.insert(nodes).values({ id, region: 'saarland', enrolledAt: new Date(0) })
      expect(await tx.select().from(nodes).where(eq(nodes.id, id))).toHaveLength(1)
    })
    expect(await database.db.select().from(nodes).where(eq(nodes.id, id))).toHaveLength(0)
  })
})
