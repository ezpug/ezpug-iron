import { describe, expect, it } from 'vitest'
import { envelopeFixture, ORCHESTRATION_FACT_FIXTURES } from '../fixtures'
import { eventsCursor, eventsPageSchema, eventsQuerySchema, parseEventsCursor } from './events'

describe('the events replay', () => {
  it('takes a seq as its cursor and starts from nothing by default', () => {
    expect(eventsQuerySchema.parse({})).toEqual({ cursor: '0', limit: 50 })
    expect(eventsQuerySchema.parse({ cursor: '17', limit: '5' })).toEqual({
      cursor: '17',
      limit: 5,
    })
    for (const bad of ['', '-1', '007', 'abc', '1.5'])
      expect(eventsQuerySchema.safeParse({ cursor: bad }).success, bad).toBe(false)
  })

  it('round-trips a seq through the cursor', () => {
    expect(eventsCursor(0)).toBe('0')
    expect(parseEventsCursor(eventsCursor(42))).toBe(42)
    expect(() => eventsCursor(-1)).toThrow(RangeError)
    expect(() => eventsCursor(1.5)).toThrow(RangeError)
  })

  it('pages envelopes and says where to resume, or null at a terminal end', () => {
    const items = [1, 2].map(seq =>
      envelopeFixture(ORCHESTRATION_FACT_FIXTURES['match.allocated'], seq),
    )
    expect(eventsPageSchema.parse({ items, nextCursor: '2' }).nextCursor).toBe('2')
    expect(eventsPageSchema.parse({ items: [], nextCursor: null }).nextCursor).toBeNull()
  })
})
