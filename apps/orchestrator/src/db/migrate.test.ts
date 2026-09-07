import { describe, expect, it } from 'vitest'
import { MIGRATIONS_FOLDER, resolveMigrationsFolder } from './migrate'

/**
 * **Where the SQL is** (PRD-02 T35). `MIGRATIONS_FOLDER` walks up from the
 * module, which is right in a checkout and wrong in the image: the bundle
 * lands at `/app/dist/` and the same walk resolves `/drizzle`. The first
 * production migration failed on exactly that — `Can't find meta/_journal.json
 * file` — so the environment is what says where, and this is the seam that
 * asks it.
 */
describe('resolveMigrationsFolder', () => {
  it('is the folder beside the source when the environment says nothing', () => {
    expect(resolveMigrationsFolder({})).toBe(MIGRATIONS_FOLDER)
    expect(resolveMigrationsFolder({ EZPUG_IRON_MIGRATIONS_DIR: '' })).toBe(MIGRATIONS_FOLDER)
    expect(resolveMigrationsFolder({ EZPUG_IRON_MIGRATIONS_DIR: '   ' })).toBe(MIGRATIONS_FOLDER)
  })

  it('is what the image named, when it named one', () => {
    expect(resolveMigrationsFolder({ EZPUG_IRON_MIGRATIONS_DIR: '/app/drizzle' })).toBe(
      '/app/drizzle',
    )
  })

  it('resolves to this package, not to the filesystem root', () => {
    expect(MIGRATIONS_FOLDER).toMatch(/apps[/\\]orchestrator[/\\]drizzle$/)
  })
})
