import {
  GAMESERVER_EVENT_TYPES,
  type GameserverEvent,
  type rosterEntrySchema,
  shippedGamemode,
} from '@ezpug/match-api'
import {
  FIXTURE_MATCH_ID,
  GAMESERVER_EVENT_FIXTURES,
  stringifyRecording,
} from '@ezpug/match-api/fixtures'
import type { z } from 'zod'
import { HEARTBEAT_INTERVAL_MS_DEFAULT, PROTOCOL_VERSION } from './constants'
import {
  NODE_FRAME_TYPES,
  type NodeFrameInput,
  type NodeFrameType,
  nodeFrameSchema,
  ORCHESTRATOR_NODE_FRAME_TYPES,
  type OrchestratorNodeFrameInput,
  type OrchestratorNodeFrameType,
  orchestratorNodeFrameSchema,
} from './node-link'
import {
  assignedGamemodeSchema,
  LINK_COMMAND_TYPES,
  type LinkCommandType,
  linkCommandSchema,
  ORCHESTRATOR_FRAME_TYPES,
  type OrchestratorFrameInput,
  type OrchestratorFrameType,
  orchestratorFrameSchema,
  SERVER_FRAME_TYPES,
  type ServerFrameInput,
  type ServerFrameType,
  serverFrameSchema,
} from './server-link'

type RosterEntryInput = z.input<typeof rosterEntrySchema>

/**
 * **One valid frame per type, for every union** — the tables the fixture
 * files under `fixtures/frames/` are written from, and the arbiter between
 * the two languages (PRD-02 working rules): the TypeScript side proves the
 * files are what these tables parse to, the C# side (`EZPug.Sdk.Tests`)
 * proves the generated types read every frame and write it back byte for
 * byte. A frame type without a fixture does not type-check, so the tables
 * are exhaustive by construction, and the `events` frame carries all
 * twenty-two vocabulary events so the union rides along.
 *
 * Nothing here is a secret. Every token is a placeholder that says so.
 */

/** The string every fixture token carries — a test greps for it, so a real one can never slip in. */
export const FIXTURE_TOKEN_MARK = 'not-a-secret'

/** The server token every link fixture carries — the shape of one, and a string that says it is not one. */
export const FIXTURE_SERVER_TOKEN = `ezs_${FIXTURE_TOKEN_MARK}_server_token_0001`
const SERVER_TOKEN = FIXTURE_SERVER_TOKEN
const NODE_TOKEN = `ezn_${FIXTURE_TOKEN_MARK}_node_token_0001`
const ENROLMENT_TOKEN = `eze_${FIXTURE_TOKEN_MARK}_enrolment_0001`

const tk: RosterEntryInput = {
  steamId64: '76561198279375306',
  name: 'tk',
  locale: 'de',
  rating: 1820,
  rankName: 'Eisen III',
  loadout: {
    t: {
      weapons: [
        {
          defindex: 7,
          paintId: 490,
          wear: 0.12,
          seed: 661,
          nametag: 'lauwarm',
          stattrak: true,
          stattrakCount: 1337,
          stickers: [{ id: 4, x: 0.5, y: -0.25 }],
          keychain: { id: 20, seed: 7 },
        },
      ],
      knife: 'weapon_knife_karambit',
      gloves: 5027,
      agent: 'customplayer_tm_leet_variantg',
      music: 3,
      pin: 874,
    },
    ct: { weapons: [{ defindex: 60, paintId: 1231 }] },
  },
}
const maex: RosterEntryInput = { steamId64: '76561198279375307', name: 'maex', locale: 'en' }

/** Every vocabulary event, in the union's order, wrapped with a link `seq`. */
function sequencedEvents(): { seq: number; event: GameserverEvent }[] {
  return GAMESERVER_EVENT_TYPES.map((type, index) => ({
    seq: index + 1,
    event: GAMESERVER_EVENT_FIXTURES[type],
  }))
}

export const SERVER_FRAME_FIXTURES: {
  readonly [T in ServerFrameType]: Extract<ServerFrameInput, { type: T }>
} = {
  hello: {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    token: SERVER_TOKEN,
    versions: {
      plugin: '0.1.0',
      sdk: '0.1.0',
      counterStrikeSharp: '1.0.373',
      matchzy: '0.8.15',
      metamod: '2.0.0-git1411',
    },
    capabilities: ['positions', 'chat', 'playerCommands', 'widget', 'backups', 'scoreboardRating'],
    plugins: ['EZPug.Core', 'MatchZy', 'RetakesPlugin', 'WeaponPaints'],
    hostname: 'EZPug · pug · Mirage',
    map: 'de_mirage',
    state: 'idle',
    lastSeq: 0,
  },
  heartbeat: {
    type: 'heartbeat',
    state: 'live',
    map: 'de_mirage',
    playerCount: 10,
    matchId: FIXTURE_MATCH_ID,
    uptimeMs: 421_337,
  },
  state: { type: 'state', state: 'assigned', matchId: FIXTURE_MATCH_ID, detail: 'plugins loaded' },
  events: { type: 'events', events: sequencedEvents() },
  command_result: {
    type: 'command_result',
    correlationId: 'cmd-0001',
    status: 'rejected',
    code: 'invalid_state',
    message: 'the match is not live',
  },
  backup: {
    type: 'backup',
    matchId: FIXTURE_MATCH_ID,
    backup: {
      mapNumber: 1,
      roundNumber: 13,
      filename: 'matchzy_1_map1_round12.cfg',
      content: '"round" { "team1_score" "8" "team2_score" "4" }\n',
    },
  },
  console: {
    type: 'console',
    correlationId: 'cmd-0002',
    uptimeMs: 421_500,
    lines: [
      { uptimeMs: 421_400, line: 'L 09/05/2026 - 18:00:00: World triggered "Round_Start"' },
      { uptimeMs: 421_450, line: '[EZPug] state: live' },
    ],
  },
  player_command_result: {
    type: 'player_command_result',
    correlationId: 'pc-0001',
    steamId64: '76561198279375306',
    command: 'powerup',
    status: 'rejected',
    code: 'cooldown',
    message: 'Noch 4 Sekunden.',
    cooldownMs: 4000,
    chargesLeft: 0,
  },
}

/** One valid command per link command type, for the `command` frame and the C# union. */
export const LINK_COMMAND_FIXTURES: {
  readonly [T in LinkCommandType]: Extract<z.input<typeof linkCommandSchema>, { type: T }>
} = {
  console: { type: 'console', correlationId: 'cmd-0002', lines: 50 },
  pause: { type: 'pause', correlationId: 'cmd-0003', kind: 'technical' },
  unpause: { type: 'unpause', correlationId: 'cmd-0004' },
  restart_round: { type: 'restart_round', correlationId: 'cmd-0005' },
  force_end: { type: 'force_end', correlationId: 'cmd-0006', reason: 'admin decision' },
  kick: { type: 'kick', correlationId: 'cmd-0007', steamId64: '76561198279375307', reason: 'afk' },
  announce: { type: 'announce', correlationId: 'cmd-0008', text: 'GLHF — viel Erfolg!' },
  rcon: { type: 'rcon', correlationId: 'cmd-0009', command: 'status' },
  restore: { type: 'restore', correlationId: 'cmd-0010', roundNumber: 12 },
  reroll: { type: 'reroll', correlationId: 'cmd-0011' },
  profile: { type: 'profile', correlationId: 'cmd-0012', player: maex },
}

export const ORCHESTRATOR_FRAME_FIXTURES: {
  readonly [T in OrchestratorFrameType]: Extract<OrchestratorFrameInput, { type: T }>
} = {
  welcome: {
    type: 'welcome',
    protocol: PROTOCOL_VERSION,
    provider: 'nodes',
    serverId: 'devbox-1',
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS_DEFAULT,
    ackedSeq: 0,
  },
  assign: {
    type: 'assign',
    matchId: FIXTURE_MATCH_ID,
    game: 'cs2',
    gamemode: assignedGamemodeSchema.parse(shippedGamemode('pug')),
    plugins: ['MatchZy', 'WeaponPaints'],
    cfg: ['ezpug/pug.cfg'],
    cvars: { mp_maxrounds: '24', mp_overtime_enable: '1', matchzy_demo_recording_enabled: 'true' },
    matchzyConfig: {
      matchid: FIXTURE_MATCH_ID,
      num_maps: 1,
      maplist: ['de_mirage'],
      players_per_team: 5,
    },
    maps: [{ map: 'de_mirage', sides: 'knife' }],
    rules: {
      regulationRounds: 24,
      overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
      warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
      cvars: { mp_freezetime: '15' },
    },
    teams: {
      teamA: { name: 'Team tk', players: [tk] },
      teamB: { name: 'Team maex', players: [maex] },
    },
    warmupLines: ['Willkommen bei EZPug.', 'Welcome to EZPug.'],
    branding: { hostname: 'EZPug · SaarLAN 2026 · Mirage', eventName: 'SaarLAN 2026' },
    demoUploadUrl: 'http://127.0.0.1:9400/demos/fixture.dem?X-Amz-Signature=fixture',
    restore: {
      mapNumber: 1,
      roundNumber: 13,
      filename: 'matchzy_1_map1_round12.cfg',
      content: '"round" { "team1_score" "8" "team2_score" "4" }\n',
    },
  },
  command: { type: 'command', command: LINK_COMMAND_FIXTURES.pause },
  player_command: {
    type: 'player_command',
    correlationId: 'pc-0001',
    steamId64: '76561198279375306',
    command: 'powerup',
    args: { kind: 'speed' },
  },
  profile: { type: 'profile', player: tk },
  release: { type: 'release', reason: 'ended' },
  drain: { type: 'drain' },
  ack: {
    type: 'ack',
    results: [
      { seq: 1, status: 'accepted' },
      { seq: 2, status: 'duplicate' },
      { seq: 17, status: 'ephemeral' },
      { seq: 23, status: 'rejected', message: 'names a match this server does not hold' },
    ],
  },
}

const warmInstance = {
  id: 'devbox-1-a',
  purpose: 'warm',
  state: 'running',
  serverId: 'devbox-1-a',
  containerId: '3f0c2a9d1e5b',
  ports: { game: 27415, tv: 27420 },
} as const

export const NODE_FRAME_FIXTURES: {
  readonly [T in NodeFrameType]: Extract<NodeFrameInput, { type: T }>
} = {
  hello: {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    token: ENROLMENT_TOKEN,
    tokenKind: 'enrolment',
    version: '0.1.0',
    region: 'eu-central',
    lan: true,
    labels: { venue: 'saarlan', tickrate: '128', cores: '16' },
    capacity: { maxInstances: 4, warm: 1 },
    imageDigest: `sha256:${'0123456789abcdef'.repeat(4)}`,
    instances: [warmInstance],
  },
  heartbeat: { type: 'heartbeat' },
  instances: {
    type: 'instances',
    instances: [
      { ...warmInstance, purpose: 'match', matchId: FIXTURE_MATCH_ID },
      {
        id: 'devbox-1-b',
        purpose: 'warm',
        state: 'failed',
        serverId: 'devbox-1-b',
        ports: { game: 27416, tv: 27421 },
        error: 'port 27416 is in use',
      },
    ],
  },
}

export const ORCHESTRATOR_NODE_FRAME_FIXTURES: {
  readonly [T in OrchestratorNodeFrameType]: Extract<OrchestratorNodeFrameInput, { type: T }>
} = {
  welcome: {
    type: 'welcome',
    protocol: PROTOCOL_VERSION,
    nodeId: 'devbox',
    nodeToken: NODE_TOKEN,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS_DEFAULT,
    drained: false,
  },
  start: {
    type: 'start',
    instance: {
      id: 'devbox-1-c',
      purpose: 'match',
      image: `ghcr.io/ezpug/ezpug-iron/cs2:0.1.0@sha256:${'0123456789abcdef'.repeat(4)}`,
      serverId: 'devbox-1-c',
      serverToken: SERVER_TOKEN,
      ports: { game: 27417, tv: 27422 },
      env: { EZPUG_IRON_URL: 'http://localhost:3430' },
      matchId: FIXTURE_MATCH_ID,
    },
  },
  stop: { type: 'stop', instanceId: 'devbox-1-c', reason: 'released' },
  drain: { type: 'drain' },
  undrain: { type: 'undrain' },
}

/** One fixture file: its schema's `$defs` name and the frames, parsed so the bytes are canonical. */
export interface ProtocolFixtureFile {
  /** The file under `fixtures/frames/`. */
  file: string
  /** The `$defs` name (and C# type) every frame in it is. */
  schema: string
  frames: readonly unknown[]
}

function parsed<T extends z.ZodType>(
  schema: T,
  table: Record<string, unknown>,
  order: readonly string[],
) {
  return order.map(type => schema.parse(table[type]))
}

/**
 * The four files, each `{ schema, frames }` with one frame per type in the
 * union's order — plus the command table, so every `LinkCommand` branch is a
 * fixture of its own and not only the one the `command` frame happens to
 * carry.
 */
export function protocolFixtureFiles(): ProtocolFixtureFile[] {
  return [
    {
      file: 'server.json',
      schema: 'ServerFrame',
      frames: parsed(serverFrameSchema, SERVER_FRAME_FIXTURES, SERVER_FRAME_TYPES),
    },
    {
      file: 'orchestrator.json',
      schema: 'OrchestratorFrame',
      frames: parsed(
        orchestratorFrameSchema,
        ORCHESTRATOR_FRAME_FIXTURES,
        ORCHESTRATOR_FRAME_TYPES,
      ),
    },
    {
      file: 'commands.json',
      schema: 'LinkCommand',
      frames: parsed(linkCommandSchema, LINK_COMMAND_FIXTURES, LINK_COMMAND_TYPES),
    },
    {
      file: 'node.json',
      schema: 'NodeFrame',
      frames: parsed(nodeFrameSchema, NODE_FRAME_FIXTURES, NODE_FRAME_TYPES),
    },
    {
      file: 'orchestrator-node.json',
      schema: 'OrchestratorNodeFrame',
      frames: parsed(
        orchestratorNodeFrameSchema,
        ORCHESTRATOR_NODE_FRAME_FIXTURES,
        ORCHESTRATOR_NODE_FRAME_TYPES,
      ),
    },
  ]
}

/** The bytes of one fixture file — the conformance suite's writer, so one canonical form serves the repo. */
export function stringifyProtocolFixture(fixture: ProtocolFixtureFile): string {
  return stringifyRecording({ schema: fixture.schema, frames: fixture.frames })
}
