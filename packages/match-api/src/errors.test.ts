import { describe, expect, it } from 'vitest'
import {
  ApiError,
  errorEnvelopeSchema,
  MATCH_API_ERROR_CODES,
  MATCH_API_ERROR_STATUS,
  matchApiErrorCodeSchema,
} from './errors'
import { gameserverEventTypeSchema } from './vocabulary/naming'

describe('the error vocabulary', () => {
  it('is a closed snake_case set with one HTTP status each', () => {
    expect(new Set(MATCH_API_ERROR_CODES).size).toBe(MATCH_API_ERROR_CODES.length)
    for (const code of MATCH_API_ERROR_CODES) {
      gameserverEventTypeSchema.parse(code)
      const status = MATCH_API_ERROR_STATUS[code]
      expect(status, code).toBeGreaterThanOrEqual(400)
      expect(status, code).toBeLessThan(600)
    }
    expect(Object.keys(MATCH_API_ERROR_STATUS).sort()).toEqual([...MATCH_API_ERROR_CODES].sort())
  })

  it('names the refusals the round promises', () => {
    for (const code of [
      'no_capable_server',
      'budget_exceeded',
      'unknown_gamemode',
      'game_unsupported',
    ])
      expect(matchApiErrorCodeSchema.parse(code)).toBe(code)
  })

  it('never lets a budget refusal look retryable', () => {
    // The client retries 5xx and 429; money is neither.
    expect(MATCH_API_ERROR_STATUS.budget_exceeded).toBe(402)
    expect(MATCH_API_ERROR_STATUS.rate_limited).toBe(429)
    expect(MATCH_API_ERROR_STATUS.no_capable_server).toBe(503)
  })

  it('parses an envelope with and without details', () => {
    expect(
      errorEnvelopeSchema.parse({
        error: { code: 'validation_failed', message: 'nope', details: { path: ['maps'] } },
      }).error.details,
    ).toEqual({ path: ['maps'] })
    expect(() => errorEnvelopeSchema.parse({ error: { code: 'nope', message: 'x' } })).toThrow()
  })

  it('carries status, code and details on the thrown error', () => {
    const error = new ApiError(404, 'not_found', 'No such match.', { matchId: 'x' })
    expect(error.name).toBe('ApiError')
    expect(error.status).toBe(404)
    expect(error.details).toEqual({ matchId: 'x' })
    expect(error).toBeInstanceOf(Error)
  })
})
