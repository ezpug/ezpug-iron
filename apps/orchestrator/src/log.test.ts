import { describe, expect, it } from 'vitest'
import { createMemoryLog, redactSecrets } from './log'
import { mintToken } from './tokens'

describe('redactSecrets', () => {
  it('turns every token of ours into its prefix and an ellipsis', () => {
    const key = mintToken('apiKey')
    const server = mintToken('server')
    expect(redactSecrets(`key ${key} and server ${server} leaked`)).toBe(
      'key ezik_… and server ezis_… leaked',
    )
  })

  it('leaves everything else alone', () => {
    expect(redactSecrets('POST /v1/matches 201 12ms key=ezik_abc… rid=x')).toBe(
      'POST /v1/matches 201 12ms key=ezik_abc… rid=x',
    )
  })
})

describe('createMemoryLog', () => {
  it('keeps redacted lines with their level and an error’s message', () => {
    const log = createMemoryLog()
    log.info(`hello ${mintToken('node')}`)
    log.error('boom', new Error(`with ${mintToken('player')}`))
    expect(log.lines).toEqual(['info hello ezin_…', 'error boom: with ezip_…'])
  })
})
