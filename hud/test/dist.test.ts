import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyDist } from '../src/dist.ts'

const HUD = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let copies: string[] = []
afterEach(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true })
  copies = []
})

/** hud/ without its tests and package files, somewhere it can be broken. */
function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ezpug-hud-'))
  copies.push(dir)
  for (const part of ['addoninfo.txt', 'layout', 'styles', 'images', 'banners', 'art', 'dist'])
    cpSync(join(HUD, part), join(dir, part), { recursive: true })
  return dir
}

describe('hud/dist/', () => {
  it('is what hud/ compiles to, and agrees with itself (`pnpm hud:build` after any edit in hud/)', () => {
    expect(verifyDist(HUD)).toEqual([])
  })

  it('is stale the moment a source changes, and so is the stamp the layouts carry', () => {
    const dir = copy()
    appendFileSync(join(dir, 'styles/ezpug_welcome.css'), '\n.x { width: 1px; }\n')
    const problems = verifyDist(dir)
    expect(problems).toContainEqual(expect.stringMatching(/styles\/ezpug_welcome\.css changed/))
    expect(problems).toContainEqual(
      expect.stringMatching(/ezpug_moment\.xml is stamped [0-9a-f]{7}, the sources stamp/),
    )
    expect(problems).toHaveLength(3)
  })

  it('is stale when a source is added', () => {
    const dir = copy()
    writeFileSync(join(dir, 'layout/ezpug_new.xml'), '<root />')
    expect(verifyDist(dir).join('\n')).toMatch(/layout\/ezpug_new\.xml is new/)
  })

  it('refuses a compiled file edited by hand, and one nobody compiled', () => {
    const dir = copy()
    appendFileSync(join(dir, 'dist/panorama/layout/custom_game/ezpug_welcome.vxml_c'), 'x')
    writeFileSync(join(dir, 'dist/panorama/layout/custom_game/stray.vxml_c'), 'x')
    const problems = verifyDist(dir).join('\n')
    expect(problems).toMatch(/ezpug_welcome\.vxml_c does not match its hash/)
    expect(problems).toMatch(/stray\.vxml_c is not in the manifest/)
  })

  it('is stale when a layout says a stamp the sources do not', () => {
    const dir = copy()
    const layout = join(dir, 'layout/ezpug_moment.xml')
    writeFileSync(
      layout,
      readFileSync(layout, 'utf8').replace(
        /(class="ezpug-unbox-stamp"[^>]*text=")[^"]*/,
        '$1abcdef0',
      ),
    )
    expect(verifyDist(dir).join('\n')).toMatch(/ezpug_moment\.xml is stamped abcdef0/)
  })

  it('refuses a pack that is not the loose files', () => {
    const dir = copy()
    appendFileSync(join(dir, 'dist/ezpug_hud.vpk'), 'x')
    expect(verifyDist(dir).join('\n')).toMatch(/ezpug_hud\.vpk/)
  })
})
