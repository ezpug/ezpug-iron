import { describe, expect, it } from 'vitest'
import {
  envelopeFixture,
  GAMESERVER_EVENT_FIXTURES,
  ORCHESTRATION_FACT_FIXTURES,
} from '../fixtures'
import { createDeliveryDeduper, createMemoryDeliveryStore, deliveryKey, factKey } from './deduper'

const live = envelopeFixture(GAMESERVER_EVENT_FIXTURES.going_live, 7)
const ended = envelopeFixture(ORCHESTRATION_FACT_FIXTURES['match.ended'], 8)

describe('createDeliveryDeduper', () => {
  it('lets a fact through once and calls its retry a duplicate delivery', async () => {
    const deduper = createDeliveryDeduper(createMemoryDeliveryStore())
    expect(await deduper.check(live)).toBeNull()
    expect(await deduper.check(live)).toBe('duplicate_delivery')
    expect(await deduper.check(ended)).toBeNull()
  })

  it('catches the same fact under a new delivery id — the stream frame and the replay', async () => {
    const deduper = createDeliveryDeduper(createMemoryDeliveryStore())
    expect(await deduper.check(live)).toBeNull()
    const redelivered = { ...live, deliveryId: '0d3c1e2f-4a5b-4c6d-8e9f-000000000999' }
    expect(await deduper.check(redelivered)).toBe('duplicate_fact')
    // Its own retries are cheap after that: the new id was recorded too.
    expect(await deduper.check(redelivered)).toBe('duplicate_delivery')
  })

  it('keys on the match, so two matches at the same seq are two facts', async () => {
    const deduper = createDeliveryDeduper(createMemoryDeliveryStore())
    expect(await deduper.check(live)).toBeNull()
    expect(
      await deduper.check({
        ...live,
        matchId: '7a1b2c3d-4e5f-4061-8b9c-0d1e2f3a4b5c',
        deliveryId: '0d3c1e2f-4a5b-4c6d-8e9f-000000000042',
      }),
    ).toBeNull()
  })

  it('publishes the two keys, so a consumer can use its own store', () => {
    const deduper = createDeliveryDeduper(createMemoryDeliveryStore())
    expect(deduper.keys(live)).toEqual({
      delivery: deliveryKey(live.deliveryId),
      fact: factKey(live.matchId, 7),
    })
    expect(deliveryKey('abc')).toBe('delivery:abc')
    expect(factKey('m', 3)).toBe('fact:m:3')
  })

  it('works over an async store', async () => {
    const seen = new Set<string>()
    const deduper = createDeliveryDeduper({
      has: key => Promise.resolve(seen.has(key)),
      add: key => Promise.resolve(seen).then(set => void set.add(key)),
    })
    expect(await deduper.check(live)).toBeNull()
    expect(await deduper.check(live)).toBe('duplicate_delivery')
    expect(seen.size).toBe(2)
  })
})

describe('createMemoryDeliveryStore', () => {
  it('drops the oldest keys past its bound', async () => {
    const store = createMemoryDeliveryStore({ max: 4 })
    const deduper = createDeliveryDeduper(store)
    await deduper.check(live)
    expect(store.size()).toBe(2)
    await deduper.check(ended)
    expect(store.size()).toBe(4)
    await deduper.check(envelopeFixture(GAMESERVER_EVENT_FIXTURES.round_end, 9))
    expect(store.size()).toBe(4)
    // The first fact fell out of the window and would be handled again.
    expect(await deduper.check(live)).toBeNull()
  })
})
