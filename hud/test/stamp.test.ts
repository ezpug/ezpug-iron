import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STAMP_PLACEHOLDER,
  stampedLayouts,
  stampLayouts,
  stampOf,
  stampProblems,
  stampsWritten,
} from '../src/stamp.ts'

const HUD = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let copies: string[] = []
afterEach(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true })
  copies = []
})

/** hud/'s sources, somewhere they can be changed. */
function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ezpug-hud-stamp-'))
  copies.push(dir)
  for (const part of ['addoninfo.txt', 'layout', 'styles', 'images', 'banners', 'art'])
    cpSync(join(HUD, part), join(dir, part), { recursive: true })
  return dir
}

describe('the build stamp', () => {
  it('is seven hex characters, carried by the welcome and the moment layouts', () => {
    expect(stampOf(HUD)).toMatch(/^[0-9a-f]{7}$/)
    expect(stampedLayouts(HUD)).toEqual(['layout/ezpug_moment.xml', 'layout/ezpug_welcome.xml'])
  })

  it('is written into every stamp label, and written again it is the same (a fixed point)', () => {
    const dir = copy()
    const stamp = stampLayouts(dir)
    expect(stampsWritten(dir)).toEqual([
      { layout: 'layout/ezpug_moment.xml', stamp },
      { layout: 'layout/ezpug_welcome.xml', stamp },
    ])
    expect(stampOf(dir)).toBe(stamp)
    expect(stampLayouts(dir)).toBe(stamp)
    expect(stampProblems(dir)).toEqual([])
  })

  it('does not depend on what the label says, so a stale stamp is found and not believed', () => {
    const dir = copy()
    const stamp = stampLayouts(dir)
    const layout = join(dir, 'layout/ezpug_welcome.xml')
    writeFileSync(
      layout,
      readFileSync(layout, 'utf8').replace(
        /(class="ezpug-welcome-stamp"[^>]*text=")[^"]*/,
        '$1abcdef0',
      ),
    )
    expect(stampOf(dir)).toBe(stamp)
    expect(stampProblems(dir)).toEqual([
      expect.stringMatching(/ezpug_welcome\.xml is stamped abcdef0, the sources stamp [0-9a-f]{7}/),
    ])
  })

  it('changes with any other byte of any source: a stylesheet, a layout, a picture', () => {
    const dir = copy()
    const stamp = stampLayouts(dir)
    writeFileSync(join(dir, 'styles/ezpug_unbox.css'), '\n.x { width: 1px; }\n', { flag: 'a' })
    const after = stampOf(dir)
    expect(after).not.toBe(stamp)
    const layout = join(dir, 'layout/ezpug_moment.xml')
    writeFileSync(
      layout,
      readFileSync(layout, 'utf8').replace('ezpug-unbox-call', 'ezpug-unbox-call '),
    )
    expect(stampOf(dir)).not.toBe(after)
    writeFileSync(join(dir, 'art/empty.png'), 'x', { flag: 'a' })
    expect(stampOf(dir)).not.toBe(after)
  })

  it('is the placeholder nowhere a build has run', () => {
    expect(STAMP_PLACEHOLDER).toMatch(/^[0-9a-f]{7}$/)
    for (const { stamp } of stampsWritten(HUD)) expect(stamp).not.toBe(STAMP_PLACEHOLDER)
  })
})
