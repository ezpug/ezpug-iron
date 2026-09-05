import type { GameserverEvent, GameserverEventType } from '../vocabulary/gameserver'

/**
 * **One valid event per type** — the platform's own fixture table from
 * `gameserver.test.ts` on 2026-09-05, exported so a consumer (the platform's
 * translator, a C# round-trip test, a gamemode test in the SDK harness) can
 * prove itself against the same twenty-two shapes this package proves itself
 * against. The union is a closed set, so the table is exhaustive by
 * construction: a type without a fixture does not type-check.
 *
 * The conformance runner and the recorded fixtures join here (PRD-01 T8).
 */

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
