import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_ART, DEFAULT_BANNER, hudKeys, KEYS_MODULE, renderKeysModule } from '../src/keys.ts'

const HUD = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(HUD, '..')

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

/** A hud/ with the given pictures and nothing else. */
function hud(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ezpug-hud-keys-'))
  dirs.push(dir)
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), '')
  }
  return dir
}

describe('the keys the contract lists', () => {
  it('are the pictures in hud/banners/ and hud/art/ (`pnpm hud:keys` after adding one)', () => {
    expect(readFileSync(join(REPO, KEYS_MODULE), 'utf8')).toBe(renderKeysModule(hudKeys(HUD)))
  })

  it('hold the house banner and the platform’s drop pictures, each under its own key', () => {
    const keys = hudKeys(HUD)
    expect(keys.banners).toContain(DEFAULT_BANNER)
    expect(keys.art).toHaveLength(26)
    expect(keys.art).toContain(DEFAULT_ART)
    expect(keys.art.filter(key => key.startsWith('category-'))).toEqual([
      'category-catering',
      'category-gift-card',
      'category-merch',
      'category-prize',
    ])
  })

  it('are sorted, one per file', () => {
    const dir = hud([
      'banners/default.png',
      'banners/saarlan-2026.png',
      'art/empty.png',
      'art/b.png',
    ])
    expect(hudKeys(dir)).toEqual({ banners: ['default', 'saarlan-2026'], art: ['b', 'empty'] })
  })

  it('refuse a name the contract’s grammar cannot carry, and a file that is not a picture', () => {
    expect(() => hudKeys(hud(['banners/default.png', 'art/empty.png', 'art/Big_Bag.png']))).toThrow(
      /kebab-case/,
    )
    expect(() => hudKeys(hud(['banners/default.png', 'art/empty.png', 'art/a.webp']))).toThrow(
      /\.png/,
    )
  })

  it('refuse a folder without the picture every unknown key falls back to', () => {
    expect(() => hudKeys(hud(['art/empty.png']))).toThrow(/banners\/default\.png/)
    expect(() => hudKeys(hud(['banners/default.png']))).toThrow(/art\/empty\.png/)
  })
})
