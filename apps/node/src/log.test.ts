import { describe, expect, it } from 'vitest'
import { createMemoryLog, redactSecrets } from './log'

describe('the log', () => {
  it('redacts every kind of token the orchestrator mints, wherever it lands in a line', () => {
    const line =
      'hello with ezin_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcdef then ezie_0123456789abcdefghij ' +
      'and a server token ezis_zzzzzzzzzzzzzzzzzzzz plus a key ezik_yyyyyyyyyyyyyyyyyyyy'
    expect(redactSecrets(line)).toBe(
      'hello with ezin_… then ezie_… and a server token ezis_… plus a key ezik_…',
    )
  })

  it('leaves a short prefix-looking word alone', () => {
    expect(redactSecrets('ezin_ is the node prefix; ezin_abc too short')).toBe(
      'ezin_ is the node prefix; ezin_abc too short',
    )
  })

  it('redacts through every writer, error detail included', () => {
    const log = createMemoryLog()
    log.info('token ezin_AbCdEfGhIjKlMnOpQrSt')
    log.warn('token ezie_AbCdEfGhIjKlMnOpQrSt')
    log.error('failed', new Error('with ezis_AbCdEfGhIjKlMnOpQrSt inside'))
    expect(log.lines).toEqual([
      'info token ezin_…',
      'warn token ezie_…',
      'error failed: with ezis_… inside',
    ])
  })
})
