import { describe, expect, it } from 'vitest'
import { createOutput, euros, orDash, redactSecrets, renderTable } from './output'

/**
 * The writer, and the one rule that matters about it: a token that reaches
 * the human channel by accident leaves as its prefix and an ellipsis, and the
 * deliberate reveal is the only unredacted door.
 */

function capture(json: boolean) {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    output: createOutput({ json, stdout: text => out.push(text), stderr: text => err.push(text) }),
  }
}

describe('createOutput', () => {
  it('writes prose for a human and nothing for a machine', () => {
    const human = capture(false)
    human.output.say('minted')
    human.output.emit({ minted: true })
    expect(human.out.join('')).toBe('minted\n')

    const machine = capture(true)
    machine.output.say('minted')
    machine.output.emit({ minted: true })
    expect(machine.out.join('')).toBe('{\n  "minted": true\n}\n')
  })

  it('warns on stderr in both modes, so a pipe stays one document', () => {
    for (const json of [false, true]) {
      const channel = capture(json)
      channel.output.warn('careful')
      expect(channel.out).toEqual([])
      expect(channel.err.join('')).toBe('careful\n')
    }
  })

  it('redacts a token that reached the human channel, and never the reveal', () => {
    const channel = capture(false)
    channel.output.say('connect with ezik_abcdefghijklmnop')
    channel.output.warn('key ezin_abcdefghijklmnop was refused')
    channel.output.reveal('once:', 'ezik_abcdefghijklmnop', 'put it somewhere')
    expect(channel.out.join('')).toContain('ezik_…')
    expect(channel.err.join('')).toContain('ezin_…')
    // The mint's own line, in full, exactly once.
    expect(channel.out.join('').split('ezik_abcdefghijklmnop').length - 1).toBe(1)
  })

  it('emits one JSON document per line for a stream, and nothing for a human', () => {
    const machine = capture(true)
    machine.output.emitLine({ type: 'hello' })
    machine.output.emitLine({ type: 'tick' })
    expect(machine.out).toEqual(['{"type":"hello"}\n', '{"type":"tick"}\n'])
    const human = capture(false)
    human.output.emitLine({ type: 'hello' })
    expect(human.out).toEqual([])
  })

  it('passes another program’s stdout through in both modes', () => {
    for (const json of [false, true]) {
      const channel = capture(json)
      channel.output.raw('{"ok":true}\n')
      expect(channel.out.join('')).toBe('{"ok":true}\n')
    }
  })
})

describe('the small formatters', () => {
  it('renders a table padded to its widest cell, and says so when empty', () => {
    expect(renderTable(['id', 'state'], [])).toEqual(['(none)'])
    const lines = renderTable(
      ['id', 'state'],
      [
        ['a', 'live'],
        ['longer', 'ended'],
      ],
    )
    expect(lines[0]).toBe('id      state')
    expect(lines[2]).toBe('a       live')
    // The last column is never padded: no trailing spaces in a pipe.
    expect(lines.every(line => line === line.trimEnd())).toBe(true)
  })

  it('turns nothing into a dash and cents into euros', () => {
    expect(orDash(null)).toBe('—')
    expect(orDash(undefined)).toBe('—')
    expect(orDash('')).toBe('—')
    expect(orDash(0)).toBe('0')
    expect(euros(0)).toBe('€0.00')
    expect(euros(4299)).toBe('€42.99')
  })

  it('redacts every token grammar the orchestrator mints', () => {
    expect(redactSecrets('ezik_aaaaaaaaaaaa ezis_bbbbbbbbbbbb ezin_cccccccccccc')).toBe(
      'ezik_… ezis_… ezin_…',
    )
    expect(redactSecrets('nothing to hide')).toBe('nothing to hide')
  })
})
