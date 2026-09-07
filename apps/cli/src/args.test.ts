import { describe, expect, it } from 'vitest'
import { boolFlag, flag, flags, parseArgs } from './args'

/**
 * The grammar, pinned. The case that decides the design is the third one:
 * without a declared boolean set, `--json matches get X` would read `matches`
 * as the value of `--json` and the command would vanish.
 */

describe('parseArgs', () => {
  it('reads positionals, `--flag value` and `--flag=value` the same way', () => {
    const args = parseArgs(['matches', 'get', 'abc', '--url', 'http://x', '--limit=5'])
    expect(args.positionals).toEqual(['matches', 'get', 'abc'])
    expect(flag(args, 'url')).toBe('http://x')
    expect(flag(args, 'limit')).toBe('5')
  })

  it('never lets a boolean flag swallow the command after it', () => {
    const args = parseArgs(['--json', 'matches', 'get', 'abc'])
    expect(args.positionals).toEqual(['matches', 'get', 'abc'])
    expect(boolFlag(args, 'json')).toBe(true)
  })

  it('treats a flag at the end of the line, or before another flag, as true', () => {
    const args = parseArgs(['servers', 'list', '--provider', '--all'])
    expect(flag(args, 'provider')).toBe('true')
    expect(boolFlag(args, 'all')).toBe(true)
    expect(boolFlag(args, 'ticks')).toBe(false)
    expect(boolFlag(parseArgs(['--json=false']), 'json')).toBe(false)
  })

  it('keeps every occurrence of a repeated flag, in order', () => {
    const args = parseArgs(['nodes', 'enrol-token', '--label', 'a=1', '--label', 'b=2'])
    expect(flags(args, 'label')).toEqual(['a=1', 'b=2'])
    expect(flag(args, 'label')).toBe('b=2')
    expect(flags(args, 'nothing')).toEqual([])
  })

  it('ends the flags at `--`, so a dashed argument is still an argument', () => {
    const args = parseArgs(['matches', 'command', 'x', 'rcon', '--command', '--', '-status'])
    expect(args.positionals).toEqual(['matches', 'command', 'x', 'rcon', '-status'])
    expect(flag(args, 'command')).toBe('true')
  })

  it('knows the two short forms and leaves the rest as positionals', () => {
    expect(boolFlag(parseArgs(['-h']), 'help')).toBe(true)
    expect(boolFlag(parseArgs(['-v']), 'version')).toBe(true)
    expect(parseArgs(['-x']).positionals).toEqual(['-x'])
    expect(parseArgs(['-']).positionals).toEqual(['-'])
  })
})
