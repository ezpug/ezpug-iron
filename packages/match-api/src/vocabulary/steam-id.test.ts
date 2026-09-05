import { describe, expect, it } from 'vitest'
import { steamId64Schema } from './steam-id'

describe('steamId64Schema', () => {
  it('accepts a 17-digit string', () => {
    expect(steamId64Schema.parse('76561198000000001')).toBe('76561198000000001')
  })

  it.each([
    ['a number, which is how JSON would round it into somebody else', 76561198000000000],
    ['too short', '7656119800000000'],
    ['too long', '765611980000000012'],
    ['not decimal', '7656119800000000x'],
  ])('rejects %s', (_label, value) => {
    expect(() => steamId64Schema.parse(value)).toThrow()
  })
})
