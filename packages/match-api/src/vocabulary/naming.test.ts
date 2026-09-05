import { describe, expect, it } from 'vitest'
import {
  domainEventNameSchema,
  gameserverEventTypeSchema,
  kebabNameSchema,
  routePathParams,
  routePathSchema,
} from './naming'

describe('kebab names (providers, gamemodes, nodes, regions)', () => {
  it.each(['parse-demo', 'sync-steam-profile', 'sim', 'a1', 'v2-thing'])('accepts %s', name => {
    expect(kebabNameSchema.safeParse(name).success).toBe(true)
  })
  it.each(['ParseDemo', 'parse_demo', 'parse demo', '-demo', 'demo-', '1demo', ''])(
    'rejects %s',
    name => {
      expect(kebabNameSchema.safeParse(name).success).toBe(false)
    },
  )
})

describe('domain event names (orchestration facts)', () => {
  it.each(['match.allocated', 'match.server_ready', 'demo.uploaded', 'fleet.orphan_found'])(
    'accepts %s',
    name => {
      expect(domainEventNameSchema.safeParse(name).success).toBe(true)
    },
  )
  it.each(['match.finish.now', 'match', 'Match.finished', 'match.roundEnded', 'match-finished'])(
    'rejects %s',
    name => {
      expect(domainEventNameSchema.safeParse(name).success).toBe(false)
    },
  )
})

describe('gameserver event types', () => {
  it.each(['round_end', 'going_live', 'chat_announced', 'powerup_granted'])('accepts %s', name => {
    expect(gameserverEventTypeSchema.safeParse(name).success).toBe(true)
  })
  it.each(['RoundEnd', 'round-end', 'round.end', '_round', ''])('rejects %s', name => {
    expect(gameserverEventTypeSchema.safeParse(name).success).toBe(false)
  })
})

describe('route paths', () => {
  it.each(['/', '/v1/gamemodes', '/v1/matches/:matchId', '/v1/fleet/servers/:serverId/release'])(
    'accepts %s',
    path => {
      expect(routePathSchema.safeParse(path).success).toBe(true)
    },
  )
  it.each(['v1/gamemodes', '/v1/gamemodes/', '/V1/gamemodes', '/v1/player_tokens', '/v1/:MatchId'])(
    'rejects %s',
    path => {
      expect(routePathSchema.safeParse(path).success).toBe(false)
    },
  )
  it('extracts params in order', () => {
    expect(routePathParams('/v1/matches/:matchId/players/:steamId64')).toEqual([
      'matchId',
      'steamId64',
    ])
    expect(routePathParams('/v1/gamemodes')).toEqual([])
  })
})
