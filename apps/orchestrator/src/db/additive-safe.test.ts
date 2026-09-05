import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getTableName } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { checkMigrationSql, formatViolations } from './additive-safe'
import { MIGRATIONS_FOLDER } from './migrate'
import * as schema from './schema'

describe('checkMigrationSql', () => {
  it('passes an additive migration', () => {
    const sql = `CREATE TABLE "servers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "provider" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "hostname" text;
--> statement-breakpoint
CREATE INDEX "servers_open_idx" ON "servers" ("provider");`
    expect(checkMigrationSql(sql, '0001_servers.sql')).toEqual([])
  })

  it.each([
    ['drop-table', 'DROP TABLE "servers";'],
    ['drop-column', 'ALTER TABLE "servers" DROP COLUMN "hostname";'],
    ['drop-schema', 'DROP SCHEMA "legacy" CASCADE;'],
    ['drop-type', 'DROP TYPE "match_state";'],
    ['rename', 'ALTER TABLE "servers" RENAME COLUMN "host" TO "hostname";'],
    ['rename', 'ALTER TABLE "servers" RENAME TO "fleet";'],
    ['alter-column-type', 'ALTER TABLE "servers" ALTER COLUMN "lan" SET DATA TYPE integer;'],
    ['set-not-null', 'ALTER TABLE "servers" ALTER COLUMN "region" SET NOT NULL;'],
    ['truncate', 'TRUNCATE "servers";'],
  ])('flags %s', (rule, statement) => {
    const violations = checkMigrationSql(statement, '0002_bad.sql')
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule, line: 1, file: '0002_bad.sql' })
  })

  it('reports every offending line, not just the first', () => {
    const sql = 'DROP TABLE "a";\n--> statement-breakpoint\nDROP TABLE "b";'
    expect(checkMigrationSql(sql, 'x.sql').map(v => v.line)).toEqual([1, 3])
  })

  it('ignores destructive SQL inside comments', () => {
    expect(checkMigrationSql('-- DROP TABLE "servers" was considered here', 'x.sql')).toEqual([])
  })

  it('accepts a statement acknowledged by the contract-phase marker', () => {
    const sql = `-- ezpug:contract-phase hostname unread since the 2026-10 release
ALTER TABLE "servers" DROP COLUMN "hostname";`
    expect(checkMigrationSql(sql, 'x.sql')).toEqual([])
  })

  it('does not let one marker wave through a second, unrelated drop', () => {
    const sql = `-- ezpug:contract-phase hostname unread
ALTER TABLE "servers" DROP COLUMN "hostname";
--> statement-breakpoint
DROP TABLE "matches";`
    const violations = checkMigrationSql(sql, 'x.sql')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.rule).toBe('drop-table')
  })

  it('formats violations with file, line and rule', () => {
    const report = formatViolations(checkMigrationSql('DROP TABLE "a";', '0003_x.sql'))
    expect(report).toBe('  0003_x.sql:1 [drop-table] DROP TABLE "a";')
  })
})

describe('the committed migrations', () => {
  it('are all additive-safe', async () => {
    const files = (await readdir(MIGRATIONS_FOLDER)).filter(name => name.endsWith('.sql')).sort()
    expect(files.length).toBeGreaterThan(0)
    const violations = (
      await Promise.all(
        files.map(async name =>
          checkMigrationSql(await readFile(join(MIGRATIONS_FOLDER, name), 'utf8'), name),
        ),
      )
    ).flat()
    expect(formatViolations(violations)).toBe('')
  })

  it('create every table the round designed (PRD-02 T2), and the schema exports each', async () => {
    const files = (await readdir(MIGRATIONS_FOLDER)).filter(name => name.endsWith('.sql')).sort()
    const sql = (
      await Promise.all(files.map(name => readFile(join(MIGRATIONS_FOLDER, name), 'utf8')))
    ).join('\n')
    const created = [...sql.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map(match => match[1]).sort()
    expect(created).toEqual(
      [
        'api_keys',
        'api_key_webhook_secrets',
        'matches',
        'match_events',
        'match_commands',
        'webhook_deliveries',
        'servers',
        'server_tokens',
        'nodes',
        'node_enrolments',
        'gslt_tokens',
        'backups',
        'player_tokens',
      ].sort(),
    )
    const exported = Object.values(schema)
      .map(table => getTableName(table))
      .sort()
    expect(exported).toEqual(created)
  })
})
