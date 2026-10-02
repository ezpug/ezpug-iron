import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  for (const part of ['addoninfo.txt', 'layout', 'styles', 'images', 'banners', 'dist'])
    cpSync(join(HUD, part), join(dir, part), { recursive: true })
  return dir
}

describe('hud/dist/', () => {
  it('is what hud/ compiles to, and agrees with itself (`pnpm hud:build` after any edit in hud/)', () => {
    expect(verifyDist(HUD)).toEqual([])
  })

  it('is stale the moment a source changes', () => {
    const dir = copy()
    appendFileSync(join(dir, 'styles/ezpug_welcome.css'), '\n.x { width: 1px; }\n')
    expect(verifyDist(dir)).toEqual([expect.stringMatching(/styles\/ezpug_welcome\.css changed/)])
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

  it('refuses a pack that is not the loose files', () => {
    const dir = copy()
    appendFileSync(join(dir, 'dist/ezpug_hud.vpk'), 'x')
    expect(verifyDist(dir).join('\n')).toMatch(/ezpug_hud\.vpk/)
  })
})
