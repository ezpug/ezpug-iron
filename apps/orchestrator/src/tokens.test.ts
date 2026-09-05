import { describe, expect, it } from 'vitest'
import {
  apiKeyPrefix,
  hashToken,
  looksLikeToken,
  mintToken,
  TOKEN_KINDS,
  TOKEN_PREFIXES,
} from './tokens'

describe('mintToken', () => {
  it('mints every kind with its greppable prefix and 43 base64url characters', () => {
    for (const kind of Object.keys(TOKEN_KINDS) as (keyof typeof TOKEN_KINDS)[]) {
      const token = mintToken(kind)
      expect(token).toMatch(new RegExp(`^${TOKEN_KINDS[kind]}_[A-Za-z0-9_-]{43}$`))
      expect(looksLikeToken(kind, token)).toBe(true)
    }
  })

  it('never mints the same token twice', () => {
    expect(new Set(Array.from({ length: 100 }, () => mintToken('apiKey'))).size).toBe(100)
  })

  it('takes an injected random source, for a fixture that must not move', () => {
    const token = mintToken('server', size => Buffer.alloc(size, 7))
    expect(token).toBe(`ezis_${Buffer.alloc(32, 7).toString('base64url')}`)
  })
})

describe('hashToken', () => {
  it('is sha256 hex, and the same twice', () => {
    const token = mintToken('apiKey')
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).not.toBe(hashToken(mintToken('apiKey')))
  })
})

describe('looksLikeToken', () => {
  it('refuses another kind, whitespace and the implausibly long', () => {
    expect(looksLikeToken('apiKey', mintToken('server'))).toBe(false)
    expect(looksLikeToken('apiKey', 'ezik_with space')).toBe(false)
    expect(looksLikeToken('apiKey', `ezik_${'x'.repeat(200)}`)).toBe(false)
  })
})

describe('the prefixes', () => {
  it('are what a fixture scrub greps for, one per kind, none a prefix of another', () => {
    expect(TOKEN_PREFIXES).toHaveLength(Object.keys(TOKEN_KINDS).length)
    for (const a of TOKEN_PREFIXES)
      for (const b of TOKEN_PREFIXES) if (a !== b) expect(a.startsWith(b)).toBe(false)
  })

  it('shows twelve characters of an API key and no more', () => {
    const secret = mintToken('apiKey')
    expect(apiKeyPrefix(secret)).toHaveLength(12)
    expect(secret.startsWith(apiKeyPrefix(secret))).toBe(true)
  })
})
