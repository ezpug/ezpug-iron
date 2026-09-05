import { describe, expect, it } from 'vitest'
import { MATCH_API_SCOPES, matchApiScopesSchema, scopeAllows } from './scopes'

describe('API key scopes', () => {
  it('is the three the decisions name', () => {
    expect(MATCH_API_SCOPES).toEqual(['matches', 'fleet', 'admin'])
  })

  it('admin implies the rest; the rest imply nothing', () => {
    expect(scopeAllows(['admin'], 'matches')).toBe(true)
    expect(scopeAllows(['admin'], 'fleet')).toBe(true)
    expect(scopeAllows(['matches'], 'matches')).toBe(true)
    expect(scopeAllows(['matches'], 'fleet')).toBe(false)
    expect(scopeAllows(['fleet'], 'admin')).toBe(false)
    expect(scopeAllows([], 'matches')).toBe(false)
  })

  it('refuses an empty or repeated scope list', () => {
    expect(() => matchApiScopesSchema.parse([])).toThrow()
    expect(() => matchApiScopesSchema.parse(['fleet', 'fleet'])).toThrow()
    expect(matchApiScopesSchema.parse(['fleet', 'matches'])).toEqual(['fleet', 'matches'])
  })
})
