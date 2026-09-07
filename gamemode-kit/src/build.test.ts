import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildWidget, checkWidgetBundle, findWidgets } from './build'
import { widgetPaths } from './vite'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'gamemodes')
const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the library preset', () => {
  it('builds a widget into exactly one ES module with the element inside and nothing that fetches', async () => {
    const paths = widgetPaths(join(FIXTURES, 'test-mode'))
    expect(paths).not.toBeNull()
    const outDir = mkdtempSync(join(tmpdir(), 'ezpug-widget-'))
    cleanups.push(outDir)
    const built = await buildWidget({ ...(paths as NonNullable<typeof paths>), outDir })
    expect(readdirSync(outDir)).toEqual(['widget.js'])
    expect(built.file).toBe(join(outDir, 'widget.js'))
    expect(built.sha256).toMatch(/^[0-9a-f]{64}$/)
    const source = readFileSync(built.file, 'utf8')
    expect(source).not.toMatch(/^import\s/m)
    expect(source).toContain('ezpug-widget')
    expect(source).toContain('ezpug.widget.ready')
    expect(source).toContain('Fixture-Widget')
    expect(source).toContain('Fixture widget')
    expect(source).toContain('color: var(--ui-text)')
    expect(checkWidgetBundle(source)).toEqual([])
    expect(built.bytes).toBeLessThan(200 * 1024)
  })

  it('finds the modes with a widget and names a mode that does not exist', () => {
    expect(findWidgets(FIXTURES).map(p => p.id)).toEqual(['test-mode'])
    expect(findWidgets(FIXTURES, ['test-mode']).map(p => p.id)).toEqual(['test-mode'])
    expect(() => findWidgets(FIXTURES, ['nope'])).toThrow(/no gamemode nope/)
    expect(existsSync(join(FIXTURES, 'test-mode', 'dist'))).toBe(false)
  })
})

describe('checkWidgetBundle', () => {
  it('names every way out of the frame but the socket', () => {
    expect(checkWidgetBundle('const a = fetch("/x")')).toEqual(['fetch()'])
    expect(checkWidgetBundle('new XMLHttpRequest()')).toEqual(['XMLHttpRequest'])
    expect(checkWidgetBundle('await import("./chunk.js")')).toEqual(['a dynamic import()'])
    expect(checkWidgetBundle('navigator.sendBeacon(u)')).toEqual(['navigator.sendBeacon'])
    expect(checkWidgetBundle('new WebSocket(url); const prefetch = 1; importance')).toEqual([])
  })
})
