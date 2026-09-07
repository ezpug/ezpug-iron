import { describe, expect, it } from 'vitest'
import { shippedGamemode } from '../gamemodes'
import { validatePlayerCommandArgs } from './player-command-args'

/**
 * The TypeScript half of "one document, two checks": the same corner of
 * JSON Schema the SDK's `ArgsValidator` (C#) checks, the same sentences, so
 * a widget, the simulated server and the plugin refuse the same tap the
 * same way.
 */
describe('validatePlayerCommandArgs', () => {
  const powerup = shippedGamemode('powerup-dm').commands[0]?.args

  it('accepts what the powerup-dm manifest declares and refuses what it does not', () => {
    expect(validatePlayerCommandArgs(powerup, { kind: 'haste' })).toBeNull()
    expect(validatePlayerCommandArgs(powerup, {})).toBeNull()
    expect(validatePlayerCommandArgs(powerup, undefined)).toBeNull()
    expect(validatePlayerCommandArgs(powerup, { kind: 'wings' })).toBe(
      'args.kind must be one of ["haste","armor","heal"]',
    )
    expect(validatePlayerCommandArgs(powerup, { size: 3 })).toBe('args.size is not allowed')
  })

  it('takes no arguments for a verb without a schema', () => {
    expect(validatePlayerCommandArgs(undefined, undefined)).toBeNull()
    expect(validatePlayerCommandArgs(undefined, {})).toBeNull()
    expect(validatePlayerCommandArgs(undefined, { a: 1 })).toBe('this command takes no arguments')
  })

  it('checks required, types, ranges, lengths, const and arrays like the C# does', () => {
    const schema = {
      type: 'object',
      required: ['count'],
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 5 },
        label: { type: 'string', minLength: 2, maxLength: 4 },
        flag: { type: 'boolean' },
        mode: { const: 'fast' },
        list: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'number' } },
      },
    }
    expect(validatePlayerCommandArgs(schema, { count: 3 })).toBeNull()
    expect(validatePlayerCommandArgs(schema, {})).toBe('args.count is required')
    expect(validatePlayerCommandArgs(schema, { count: 1.5 })).toBe('args.count must be an integer')
    expect(validatePlayerCommandArgs(schema, { count: 9 })).toBe('args.count must be at most 5')
    expect(validatePlayerCommandArgs(schema, { count: 0 })).toBe('args.count must be at least 1')
    expect(validatePlayerCommandArgs(schema, { count: 1, label: 'x' })).toBe(
      'args.label must be at least 2 characters',
    )
    expect(validatePlayerCommandArgs(schema, { count: 1, label: 'toolong' })).toBe(
      'args.label must be at most 4 characters',
    )
    expect(validatePlayerCommandArgs(schema, { count: 1, flag: 'yes' })).toBe(
      'args.flag must be a boolean',
    )
    expect(validatePlayerCommandArgs(schema, { count: 1, mode: 'slow' })).toBe(
      'args.mode must be "fast"',
    )
    expect(validatePlayerCommandArgs(schema, { count: 1, list: [] })).toBe(
      'args.list needs at least 1 items',
    )
    expect(validatePlayerCommandArgs(schema, { count: 1, list: [1, 2, 3] })).toBe(
      'args.list allows at most 2 items',
    )
    expect(validatePlayerCommandArgs(schema, { count: 1, list: [1, 'two'] })).toBe(
      'args.list[1] must be a number',
    )
    expect(validatePlayerCommandArgs(schema, { count: 1, extra: true })).toBeNull()
  })
})
