import { describe, expect, it } from 'vitest'
import { createT, KIT_COPY, normaliseLocale } from './i18n'

describe('createT', () => {
  it('picks the locale’s line and fills placeholders', () => {
    const copy = { de: '{n} übrig', en: '{n} left' }
    expect(createT('de')(copy, { n: 2 })).toBe('2 übrig')
    expect(createT('en')(copy, { n: 0 })).toBe('0 left')
    expect(createT('en')({ de: 'a {x} {y}', en: 'a {x} {y}' }, { x: 'b' })).toBe('a b {y}')
  })

  it('normalises whatever a host hands over to de or en, German by default', () => {
    expect(normaliseLocale('en')).toBe('en')
    expect(normaliseLocale('en-GB')).toBe('en')
    expect(normaliseLocale('DE')).toBe('de')
    expect(normaliseLocale('fr')).toBe('de')
    expect(normaliseLocale(undefined)).toBe('de')
    expect(normaliseLocale(42)).toBe('de')
  })

  it('carries both languages for every line of its own', () => {
    for (const [name, line] of Object.entries(KIT_COPY)) {
      expect(line.de, name).not.toBe('')
      expect(line.en, name).not.toBe('')
      expect(line.de, name).not.toBe(line.en)
    }
  })
})
