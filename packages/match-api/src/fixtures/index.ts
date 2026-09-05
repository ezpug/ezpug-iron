import type { GameserverEvent, GameserverEventType } from '../vocabulary/gameserver'
import type {
  OrchestrationFact,
  OrchestrationFactType,
  WebhookEnvelope,
  WebhookPayload,
} from '../webhooks/envelope'

/**
 * **One valid event per type** — the platform's own fixture table from
 * `gameserver.test.ts` on 2026-09-05, exported so a consumer (the platform's
 * translator, a C# round-trip test, a gamemode test in the SDK harness) can
 * prove itself against the same twenty-two shapes this package proves itself
 * against. The union is a closed set, so the table is exhaustive by
 * construction: a type without a fixture does not type-check.
 *
 * The conformance runner and the recorded fixtures join here (PRD-01 T8):
 * `runMatchApiConformance` drives an implementation through the flows a
 * client actually performs, and `fixtures/recorded/<flow>.json` beside this
 * package holds what the fake produced for each of them.
 */

export * from './conformance'

export const FIXTURE_MATCH_ID = '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b'
export const FIXTURE_SOURCE = { provider: 'sim', serverId: 'sim-1' } as const

const base = { matchId: FIXTURE_MATCH_ID, source: FIXTURE_SOURCE }

const tk = { steamId64: '76561198279375306', name: 'tk', team: 'team_a' } as const
const maex = { steamId64: '76561198279375307', name: 'maex', team: 'team_b' } as const

export const GAMESERVER_EVENT_FIXTURES: {
  readonly [T in GameserverEventType]: GameserverEvent & { type: T }
} = {
  server_ready: { type: 'server_ready', ...base, map: 'de_nuke' },
  heartbeat: { type: 'heartbeat', ...base, seq: 12, playerCount: 10 },
  player_connected: { type: 'player_connected', ...base, player: tk },
  player_disconnected: { type: 'player_disconnected', ...base, player: tk },
  going_live: { type: 'going_live', ...base, mapNumber: 1, map: 'de_nuke' },
  round_start: {
    type: 'round_start',
    ...base,
    mapNumber: 1,
    roundNumber: 13,
    score: { teamA: 8, teamB: 4 },
  },
  round_end: {
    type: 'round_end',
    ...base,
    mapNumber: 1,
    roundNumber: 13,
    winner: { team: 'team_a', side: 'ct' },
    winCondition: 'bomb_defused',
    score: { teamA: 9, teamB: 4 },
    players: [
      { player: tk, kills: 14, deaths: 6, assists: 2, damage: 1420, headshotKills: 7, mvps: 3 },
    ],
    roundTimeMs: 51_434,
  },
  side_swap: { type: 'side_swap', ...base, mapNumber: 1, sides: { teamA: 't', teamB: 'ct' } },
  map_end: {
    type: 'map_end',
    ...base,
    mapNumber: 1,
    map: 'de_nuke',
    score: { teamA: 13, teamB: 7 },
    winner: 'team_a',
  },
  series_end: {
    type: 'series_end',
    ...base,
    seriesScore: { teamA: 1, teamB: 0 },
    winner: 'team_a',
  },
  match_paused: {
    type: 'match_paused',
    ...base,
    mapNumber: 1,
    kind: 'technical',
    pausedBy: 'team_b',
  },
  match_unpaused: { type: 'match_unpaused', ...base, mapNumber: 1 },
  player_death: {
    type: 'player_death',
    ...base,
    mapNumber: 1,
    roundNumber: 13,
    victim: maex,
    killer: tk,
    assists: [{ player: { ...tk, name: 'jörg' }, flash: true }],
    weapon: 'ak47',
    headshot: true,
    throughSmoke: true,
    roundTimeMs: 32_100,
  },
  bomb_planted: {
    type: 'bomb_planted',
    ...base,
    mapNumber: 1,
    roundNumber: 13,
    player: maex,
    site: 'b',
    roundTimeMs: 40_000,
  },
  bomb_defused: {
    type: 'bomb_defused',
    ...base,
    mapNumber: 1,
    roundNumber: 13,
    player: tk,
    site: 'b',
  },
  bomb_exploded: { type: 'bomb_exploded', ...base, mapNumber: 1, roundNumber: 14, site: 'a' },
  position_tick: {
    type: 'position_tick',
    ...base,
    mapNumber: 1,
    roundNumber: 14,
    positions: [{ steamId64: tk.steamId64, x: -412.5, y: 1180, z: 64, yaw: 92.5 }],
  },
  backup_written: {
    type: 'backup_written',
    ...base,
    mapNumber: 1,
    roundNumber: 14,
    filename: 'matchzy_6f1a_map1_round14.txt',
  },
  demo_available: {
    type: 'demo_available',
    ...base,
    mapNumber: 1,
    filename: '6f1a_map_1_de_nuke.dem',
    sizeBytes: 104_857_600,
  },
  chat_command: { type: 'chat_command', ...base, player: tk, command: 'tech' },
  chat_message: {
    type: 'chat_message',
    ...base,
    player: tk,
    text: 'gg wp',
    scope: 'all',
    tick: 184_320,
  },
  plugin_event: {
    type: 'plugin_event',
    ...base,
    name: 'drop_announced',
    data: { skin: 'AK-47 | Redline' },
  },
}

/**
 * **One valid orchestration fact per type** — the same idea for the other
 * branch of the webhook payload, so a consumer can prove its fact handling
 * against every shape the orchestrator can send. Exhaustive by construction.
 */
export const ORCHESTRATION_FACT_FIXTURES: {
  readonly [T in OrchestrationFactType]: OrchestrationFact & { type: T }
} = {
  'match.allocated': {
    type: 'match.allocated',
    provider: 'sim',
    serverId: 'sim-1',
    fleetServerId: '0b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b',
    region: 'eu-central',
  },
  'match.server_ready': {
    type: 'match.server_ready',
    connect: { host: '203.0.113.10', port: 27_015, password: 'ezpug-fixture-join' },
    tv: { host: '203.0.113.10', port: 27_020, delaySeconds: 105 },
  },
  'match.recovering': {
    type: 'match.recovering',
    reason: 'heartbeat missed for 30 s; provider reports the server gone',
    backupRound: 14,
  },
  'match.recovered': {
    type: 'match.recovered',
    serverId: 'sim-2',
    fleetServerId: '1c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c',
    resumedFromRound: 14,
  },
  'match.failed': {
    type: 'match.failed',
    state: 'failed',
    reason: { kind: 'server_lost', detail: 'no backup to restore from' },
  },
  'match.ended': {
    type: 'match.ended',
    state: 'ended',
    reason: { kind: 'completed' },
  },
  'demo.uploaded': {
    type: 'demo.uploaded',
    mapNumber: 1,
    key: 'demos/6f1a2b3c/map-1.dem',
    size: 104_857_600,
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    contentType: 'application/octet-stream',
  },
  'player.joined': { type: 'player.joined', player: tk, rostered: true },
  'player.left': { type: 'player.left', player: tk },
  'fleet.provider_unreachable': {
    type: 'fleet.provider_unreachable',
    provider: 'sim',
    since: '2026-09-05T18:30:00.000Z',
    lastError: 'probe: connection refused',
  },
  'fleet.node_disconnected': {
    type: 'fleet.node_disconnected',
    node: 'saarlan-rack-2',
    lastSeenAt: '2026-09-05T18:29:40.000Z',
  },
  'fleet.orphan_found': {
    type: 'fleet.orphan_found',
    provider: 'sim',
    serverId: 'sim-7',
    fleetServerId: '2d4e5f60-7182-493a-abcd-2e3f4a5b6c7d',
    released: true,
  },
  'fleet.budget_threshold': {
    type: 'fleet.budget_threshold',
    limit: 'monthlyCents',
    fraction: 0.8,
    usage: { concurrentServers: 2, monthCents: 8_100, monthStartedAt: '2026-09-01T00:00:00.000Z' },
    limits: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 10_000 },
  },
}

export const FIXTURE_CLIENT_MATCH_ID = 'platform-match-4c1a2c7e'

/**
 * An envelope around any payload, with fixture identities — what a test
 * hands a verifier, a deduper or a stream frame. `seq` and `deliveryId`
 * are derived from the sequence so a table of them is stable.
 */
export function envelopeFixture(payload: WebhookPayload, seq = 1): WebhookEnvelope {
  return {
    deliveryId: `0d3c1e2f-4a5b-4c6d-8e9f-${String(seq).padStart(12, '0')}`,
    matchId: FIXTURE_MATCH_ID,
    clientMatchId: FIXTURE_CLIENT_MATCH_ID,
    seq,
    occurredAt: '2026-09-05T18:30:00.000Z',
    payload,
  }
}
