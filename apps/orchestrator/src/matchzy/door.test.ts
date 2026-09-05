import type { GameserverEvent, MatchRequest, MatchRequestInput } from '@ezpug/match-api'
import { matchRequestSchema } from '@ezpug/match-api'
import { MATCHZY_LOG_PATH, MATCHZY_TOKEN_HEADER } from '@ezpug/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from '../http/testing'
import type { AuthenticatedKey } from '../keys/service'
import { matchzySerial } from '../match-config/matchzy'
import type { GameServerProvider, ServerConfiguration } from '../providers/provider'
import { mintToken } from '../tokens'

/**
 * **A pug through both doors** (PRD-02 T9): the link says `server_ready`,
 * MatchZy's remote log says the rest — `going_live`, two `round_end`s, the
 * `map_result`, the `series_end` — each POST authenticated with the server's
 * own token in a header, translated once, and landing in the match's log
 * exactly as an event over the link would. Then every way the door says no.
 */

const PROVIDER = 'nodes'

/** A provider whose servers are nothing but the token they were configured with. */
function createPhantomProvider() {
  let counter = 0
  const live = new Map<string, { matchId: string; fleetServerId: string }>()
  const configured = new Map<string, ServerConfiguration>()
  const provider: GameServerProvider & { configured: typeof configured } = {
    id: PROVIDER,
    configured,
    offerings: () =>
      Promise.resolve([
        {
          capabilities: {
            games: ['cs2'],
            region: 'devbox',
            tickrate: 128,
            lan: true,
            workshopMaps: true,
          },
          hourlyCents: 0,
          available: 4,
        },
      ]),
    allocate: allocation => {
      counter += 1
      const serverId = `devbox-${counter}`
      live.set(serverId, { matchId: allocation.matchId, fleetServerId: allocation.fleetServerId })
      return Promise.resolve({ serverId, connect: { host: '127.0.0.1', port: 27_415 } })
    },
    configure: (serverId, configuration) => {
      configured.set(serverId, configuration)
      return Promise.resolve()
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    status: serverId =>
      Promise.resolve(
        live.has(serverId)
          ? { state: 'running', connect: { host: '127.0.0.1', port: 27_415 } }
          : { state: 'gone' },
      ),
    deallocate: serverId => {
      live.delete(serverId)
      return Promise.resolve()
    },
    list: () => Promise.resolve([...live].map(([serverId, entry]) => ({ serverId, ...entry }))),
  }
  return provider
}

function request(overrides: Partial<MatchRequestInput> = {}): MatchRequest {
  return matchRequestSchema.parse({
    clientMatchId: 'platform-match-1',
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'Team tk', players: [{ steamId64: '76561198279375306', name: 'tk' }] },
      teamB: { name: 'Team maex', players: [{ steamId64: '76561198279375307', name: 'maex' }] },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    rules: {
      regulationRounds: 2,
      overtime: { enabled: false, maxRounds: 2, startMoney: 10_000 },
      warmup: { minPlayersToReady: 2, minSpectatorsToReady: 0 },
    },
    callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: 'whsec-1' },
    ttlMinutes: 120,
    ...overrides,
  })
}

interface Rig {
  app: TestApp
  key: AuthenticatedKey
  matchId: string
  serverId: string
  serial: number
  token: string
  post: (
    payload: unknown,
    token?: string | null,
    raw?: string,
  ) => Promise<{ status: number; body: Record<string, unknown> }>
  events: () => Promise<GameserverEvent['type'][]>
}

const rigs: TestApp[] = []
afterEach(async () => {
  for (const app of rigs.splice(0)) await app.close()
})

async function createRig(): Promise<Rig> {
  const provider = createPhantomProvider()
  const app = createTestApp({ providers: [provider] })
  rigs.push(app)
  const minted = await app.keys.mint({
    name: 'platform',
    scopes: ['matches', 'fleet'],
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [{ id: 'whsec-1', secret: 'a-test-secret-of-at-least-thirty-two-chars' }],
  })
  const key = (await app.keys.get(minted.key.id)) as AuthenticatedKey
  const { match } = await app.matches.create(key, request())
  await app.settle()
  const row = app.store.rows.servers.find(server => server.matchId === match.id)
  if (!row?.serverId) throw new Error('the walk left no server')
  const configuration = provider.configured.get(row.serverId)
  if (!configuration) throw new Error('the provider was not configured')
  const source = { provider: PROVIDER, serverId: row.serverId }
  // The link's part: the server is up. (T6 proves the socket; here the sink is enough.)
  await app.matches.ingest(source, {
    type: 'server_ready',
    matchId: match.id,
    source,
    map: 'de_mirage',
  })
  await app.settle()

  const post: Rig['post'] = async (payload, token = configuration.link.serverToken, raw) => {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (token !== null) headers.set(MATCHZY_TOKEN_HEADER, token)
    const response = await app.app.request(MATCHZY_LOG_PATH, {
      method: 'POST',
      headers,
      body: raw ?? JSON.stringify(payload),
    })
    await app.settle()
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  return {
    app,
    key,
    matchId: match.id,
    serverId: row.serverId,
    serial: matchzySerial(match.id),
    token: configuration.link.serverToken,
    post,
    events: async () =>
      (await app.matches.events(key, match.id, 0, 200)).items.map(
        envelope => envelope.payload.type as GameserverEvent['type'],
      ),
  }
}

const team = (name: string, score: number) => ({
  id: '',
  name,
  series_score: 0,
  score,
  score_ct: 0,
  score_t: 0,
  players: [],
})

describe('a pug through the MatchZy door', () => {
  it('translates going_live, the rounds, the map and the series into the match’s log', async () => {
    const rig = await createRig()
    const { serial } = rig
    expect((await rig.app.matches.get(rig.key, rig.matchId)).state).toBe('ready')

    const live = await rig.post({ event: 'going_live', matchid: serial, map_number: 0 })
    expect(live).toEqual({ status: 200, body: { accepted: 1, statuses: ['accepted'] } })
    expect((await rig.app.matches.get(rig.key, rig.matchId)).state).toBe('live')

    // series_start is MatchZy's, never ours: read, dropped, still 200.
    const start = await rig.post({ event: 'series_start', matchid: serial, num_maps: 1 })
    expect(start).toEqual({ status: 200, body: { accepted: 0, dropped: 'not a fact of ours' } })

    await rig.post({
      event: 'round_end',
      matchid: serial,
      map_number: 0,
      round_number: 1,
      reason: 8,
      winner: { side: '3', team: 'team1' },
      team1: team('Team tk', 1),
      team2: team('Team maex', 0),
    })
    await rig.post({
      event: 'round_end',
      matchid: serial,
      map_number: 0,
      round_number: 2,
      reason: 9,
      // MatchZy names the leader (nobody leads at 1–1, so team2); the delta says team B.
      winner: { side: '2', team: 'team2' },
      team1: team('Team tk', 1),
      team2: team('Team maex', 1),
    })
    await rig.post({
      event: 'map_result',
      matchid: serial,
      map_number: 0,
      winner: { side: '2', team: 'team2' },
      team1: team('Team tk', 1),
      team2: team('Team maex', 1),
    })
    const end = await rig.post({
      event: 'series_end',
      matchid: serial,
      time_until_restore: 10,
      winner: { side: '2', team: 'none' },
      team1_series_score: 0,
      team2_series_score: 0,
    })
    expect(end.status).toBe(200)

    const match = await rig.app.matches.get(rig.key, rig.matchId)
    expect(match.state).toBe('ended')
    expect(match.endedReason).toEqual({ kind: 'completed' })
    expect(await rig.events()).toEqual([
      'match.allocated',
      'server_ready',
      'match.server_ready',
      'going_live',
      'round_end',
      'round_end',
      'map_end',
      'series_end',
      'match.ended',
    ])
    const { items } = await rig.app.matches.events(rig.key, rig.matchId, 0, 200)
    const rounds = items
      .filter(envelope => envelope.payload.type === 'round_end')
      .map(e => e.payload)
    expect(rounds[0]).toMatchObject({
      matchId: rig.matchId,
      source: { provider: PROVIDER, serverId: rig.serverId },
      mapNumber: 1,
      roundNumber: 1,
      winner: { team: 'team_a', side: 'ct' },
      winCondition: 'elimination',
      score: { teamA: 1, teamB: 0 },
    })
    expect(rounds[1]).toMatchObject({ roundNumber: 2, winner: { team: 'team_b', side: 't' } })
    const mapEnd = items.find(envelope => envelope.payload.type === 'map_end')?.payload
    expect(mapEnd).toMatchObject({ map: 'de_mirage', score: { teamA: 1, teamB: 1 }, winner: null })
    // No log line ever held the token.
    expect(rig.app.log.lines.some(line => line.includes(rig.token))).toBe(false)

    // The match is over: the door says so rather than feeding a corpse.
    const late = await rig.post({ event: 'going_live', matchid: serial, map_number: 0 })
    expect(late.status).toBe(409)
  })

  it('refuses what it cannot attribute or read', async () => {
    const rig = await createRig()
    expect((await rig.post({ event: 'going_live' }, null)).status).toBe(401)
    expect((await rig.post({ event: 'going_live' }, 'not-a-token')).status).toBe(401)
    expect((await rig.post({ event: 'going_live' }, mintToken('server'))).status).toBe(401)
    expect((await rig.post(undefined, undefined, '{not json')).status).toBe(400)
    expect(await rig.post({ event: 'going_live', matchid: 4711, map_number: 0 })).toEqual({
      status: 200,
      body: { accepted: 0, dropped: `names matchid 4711, this server holds ${rig.serial}` },
    })
    expect((await rig.app.matches.get(rig.key, rig.matchId)).state).toBe('ready')
    expect(rig.app.log.lines.some(line => line.includes(rig.token))).toBe(false)
  })
})
