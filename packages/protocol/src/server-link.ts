import {
  assertClosedSet,
  cfgFileSchema,
  DEMO_UPLOAD_URLS_MAX,
  GAMEMODE_CAPABILITIES,
  gamemodeCvarsSchema,
  gamemodeManifestSchema,
  gameSchema,
  gameserverEventSchema,
  isOrchestratorCommand,
  isSimCommand,
  kebabNameSchema,
  type MatchCommand,
  mapPlanSchema,
  matchApiErrorCodeSchema,
  matchBrandingSchema,
  matchCommandSchema,
  matchIdSchema,
  matchRulesSchema,
  matchTeamsSchema,
  type ORCHESTRATOR_COMMAND_TYPES,
  playerCommandNameSchema,
  pluginFolderNameSchema,
  rosterEntrySchema,
  SERVER_CHAT_TEXT_MAX,
  type SIM_COMMAND_TYPES,
  steamId64Schema,
  widgetPushFrameSchema,
} from '@ezpug/match-api'
import { z } from 'zod'
import {
  BACKUP_CONTENT_MAX,
  CONSOLE_LINE_MAX,
  CONSOLE_TAIL_DEFAULT,
  CONSOLE_TAIL_MAX,
  EVENTS_BATCH_MAX,
  PROTOCOL_VERSION,
} from './constants'

/**
 * **The server link** (decision 5): the one outbound WebSocket every server
 * opens to the orchestrator at `/link`, and everything that crosses it.
 * A Dathost server, a node-hosted server and the dev container are
 * indistinguishable once this socket is up — providers only differ in how a
 * server gets *started*; from here on the server is a peer that says
 * `hello`, heartbeats, streams the vocabulary and answers commands.
 *
 * Two closed unions, one per direction, every frame one JSON text message
 * with a `type`:
 *
 * - {@link serverFrameSchema} — what a server sends: `hello`, `heartbeat`,
 *   `state`, `events`, `command_result`, `backup`, `console`,
 *   `player_command_result`, `widget_push`.
 * - {@link orchestratorFrameSchema} — what the orchestrator sends a server:
 *   `welcome`, `assign`, `command`, `player_command`, `profile`, `release`,
 *   `drain`, `ack`.
 *
 * The decisions this file fixes:
 *
 * - **The first frame each way is fixed.** A socket opens, the server says
 *   `hello` with its token, the orchestrator answers `welcome` or closes with
 *   a `LINK_CLOSE_CODES` code. Nothing else is legal before that exchange.
 * - **Events carry a per-server `seq`.** The vocabulary's own `seq` is a
 *   per-match hint the platform reads; the link's `seq` is the server's
 *   delivery counter — monotonic from 1 for the life of the plugin process,
 *   persisted in its on-disk buffer — and the orchestrator acks every one
 *   `accepted`, `duplicate`, `ephemeral` or `rejected`. At-least-once
 *   delivery on the server's side, idempotent ingestion on the
 *   orchestrator's, and `welcome.ackedSeq` tells a reconnecting server where
 *   to resume.
 * - **Commands are the Match API's.** A `command` frame relays one of the
 *   Match API's `MatchCommand` shapes verbatim (minus the `sim.*` family,
 *   which never reaches a real server) plus one link-only verb, `console`;
 *   the `command_result` comes back with the same `correlationId` and the
 *   Match API's own status and error vocabulary, so the orchestrator turns
 *   it into a `MatchCommandResult` without translation.
 * - **The server is not trusted with the wall clock.** No frame carries a
 *   timestamp; console lines carry the server's own uptime and the
 *   orchestrator stamps arrival. The vocabulary made the same choice.
 * - **Secrets travel once.** The server token is in `hello` and nowhere
 *   else; `assign` carries the demo upload URL (presigned, the client's) and
 *   the match's cvars — never an API key, never a node token.
 */

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** A token as it crosses the link: opaque, at least sixteen characters, never logged. */
export const linkTokenSchema = z.string().min(16).max(512)

/** A version as a component reports it (`0.1.0`, `1.0.373`, `0.8.15`). Free-form: vendors differ. */
export const versionStringSchema = z.string().min(1).max(64)

/** Milliseconds since the plugin loaded — the server's monotonic clock, never wall time. */
export const uptimeMsSchema = z.number().int().nonnegative()

/**
 * Where a server is in its life, as it reports it. `booting` before the
 * map is up, `idle` when it could take an assignment, `assigned` from the
 * moment `assign` is applied until the mode goes live, `live` while a match
 * plays, `ending` while demos upload and plugins unload, `draining` when it
 * will finish what it has and take nothing new.
 */
export const LINK_SERVER_STATES = [
  'booting',
  'idle',
  'assigned',
  'live',
  'ending',
  'draining',
] as const
export const linkServerStateSchema = z.enum(LINK_SERVER_STATES)
export type LinkServerState = z.infer<typeof linkServerStateSchema>

/** One manifest capability, as a server's `hello` lists the ones it can honour. */
export const gamemodeCapabilitySchema = z.enum(GAMEMODE_CAPABILITIES)
export type GamemodeCapabilityName = z.infer<typeof gamemodeCapabilitySchema>

/** The versions a server runs — the pins `docs/pins.md` holds, as observed at runtime. */
export const serverVersionsSchema = z.object({
  /** The EZPug core plugin. */
  plugin: versionStringSchema,
  /** `EZPug.Sdk`. */
  sdk: versionStringSchema,
  /** CounterStrikeSharp, as the runtime reports it. */
  counterStrikeSharp: versionStringSchema,
  /** MatchZy, where installed. */
  matchzy: versionStringSchema.optional(),
  /** Metamod:Source, where the plugin can read it. */
  metamod: versionStringSchema.optional(),
})
export type ServerVersions = z.infer<typeof serverVersionsSchema>

/**
 * A round backup as it crosses the link, both ways: up in a `backup` frame
 * as MatchZy writes one, down in `assign.restore` when the match resumes on
 * another server (PRD-02 T14). `content` is the backup file's text; the
 * orchestrator keeps the latest few per match in its own database
 * (decision 10) and never parses them.
 */
export const roundBackupSchema = z.object({
  /** 1-based map number within the series. */
  mapNumber: z.number().int().positive(),
  /** The round this backup restores to — the next round to be played, 1-based. */
  roundNumber: z.number().int().positive(),
  /** The file name MatchZy wrote, relative to its backup directory. */
  filename: z.string().min(1).max(256),
  content: z.string().max(BACKUP_CONTENT_MAX),
})
export type RoundBackup = z.infer<typeof roundBackupSchema>

/** One line of the server console, stamped with the server's uptime. */
export const consoleLineSchema = z.object({
  uptimeMs: uptimeMsSchema,
  line: z.string().max(CONSOLE_LINE_MAX),
})
export type LinkConsoleLine = z.infer<typeof consoleLineSchema>

/**
 * One vocabulary event with its link sequence number. `seq` is per server,
 * monotonic from 1, the dedup key the `ack` answers to; the event's own
 * optional `seq` is the per-match hint and stays whatever the plugin set.
 */
export const sequencedEventSchema = z.object({
  seq: z.number().int().positive(),
  event: gameserverEventSchema,
})
export type SequencedEvent = z.infer<typeof sequencedEventSchema>

/**
 * What a gamemode looks like once the orchestrator has resolved it for one
 * assignment: the manifest as shipped (`@ezpug/match-api`'s
 * `GamemodeManifest`) minus the two blocks a server never reads — the map
 * allow-list (the request's map plan already passed it) and the widget
 * bundle (the orchestrator serves that to browsers). Everything else is
 * verbatim, defaults filled, so the loader and the SDK's command table read
 * the same fields `docs/gamemodes.md` documents.
 */
export const assignedGamemodeSchema = z
  .object(gamemodeManifestSchema.shape)
  .omit({ maps: true, widget: true })
export type AssignedGamemode = z.infer<typeof assignedGamemodeSchema>

// ---------------------------------------------------------------------------
// Commands over the link
// ---------------------------------------------------------------------------

type SimCommandType = (typeof SIM_COMMAND_TYPES)[number]
type OrchestratorCommandType = (typeof ORCHESTRATOR_COMMAND_TYPES)[number]

/**
 * The one command that exists only on the link: send me the console tail.
 * Answered by a `console` frame carrying the same `correlationId`, never by
 * a `command_result`. The fleet console route (PRD-02 T20) is what asks.
 */
export const consoleCommandSchema = z.object({
  type: z.literal('console'),
  correlationId: z.string().min(1).max(128),
  /** How many lines from the end. */
  lines: z.number().int().positive().max(CONSOLE_TAIL_MAX).default(CONSOLE_TAIL_DEFAULT),
})
export type ConsoleCommand = z.infer<typeof consoleCommandSchema>

type MatchCommandOption = (typeof matchCommandSchema.options)[number]
type RelayedCommandOption = Exclude<
  MatchCommandOption,
  { shape: { type: { value: SimCommandType | OrchestratorCommandType } } }
>

/**
 * The Match API's command options that reach a real server: everything but
 * the `sim.*` family and the orchestrator's own (`reprovision` — the box is
 * being replaced, not asked).
 */
const relayedCommandOptions = matchCommandSchema.options.filter(
  option =>
    !isSimCommand(option.shape.type.value) && !isOrchestratorCommand(option.shape.type.value),
) as RelayedCommandOption[]

/**
 * What a `command` frame carries: a Match API `MatchCommand` verbatim — the
 * same object the client posted, `correlationId` included — or the link's
 * own `console`. The `sim.*` commands are not here because a real server
 * cannot honour them, and `reprovision` is not because it is about which box
 * plays the match; the orchestrator answers both itself.
 */
export const linkCommandSchema = z.discriminatedUnion('type', [
  consoleCommandSchema,
  ...relayedCommandOptions,
] as [typeof consoleCommandSchema, ...RelayedCommandOption[]])
export type LinkCommand =
  | ConsoleCommand
  | Exclude<MatchCommand, { type: SimCommandType | OrchestratorCommandType }>

/** Every command type a server may be sent, in the union's order. */
export const LINK_COMMAND_TYPES = [
  'console',
  'pause',
  'unpause',
  'restart_round',
  'force_end',
  'kick',
  'announce',
  'rcon',
  'restore',
  'reroll',
  'profile',
] as const
export type LinkCommandType = (typeof LINK_COMMAND_TYPES)[number]

assertClosedSet('link commands', linkCommandSchema, 'type', LINK_COMMAND_TYPES)

/** What became of a command on the server. `accepted` never appears here: the server is the end of the line. */
export const linkCommandStatusSchema = z.enum(['applied', 'rejected'])
export type LinkCommandStatus = z.infer<typeof linkCommandStatusSchema>

/**
 * Why the SDK refused a player's command before the mode saw it, or why
 * the mode refused it after. Each is a line in the player's language on the
 * phone; the widget branches on the code.
 */
export const PLAYER_COMMAND_REFUSALS = [
  /** The cooldown the manifest declares has not elapsed; `cooldownMs` says how long is left. */
  'cooldown',
  /** No charges left for the period the manifest declares. */
  'no_charges',
  /** The manifest declares no such verb. */
  'unknown_command',
  /** `args` did not match the verb's schema. */
  'invalid_args',
  /** The SteamID64 is not on the server. */
  'not_in_match',
  /** The player is dead and the verb needs a living player. */
  'not_alive',
  /** The mode said no; `message` says why. */
  'refused',
] as const
export const playerCommandRefusalSchema = z.enum(PLAYER_COMMAND_REFUSALS)
export type PlayerCommandRefusal = z.infer<typeof playerCommandRefusalSchema>

/** What the orchestrator answers per event in an `ack`. */
export const LINK_ACK_STATUSES = [
  /** New to this server: logged, relayed, applied where it maps to a transition. */
  'accepted',
  /** Its `seq` was seen before. Nothing happened; the server drops it from its buffer. */
  'duplicate',
  /** The position-tick tier: broadcast on the stream, never logged, never deduped. */
  'ephemeral',
  /** It did not parse or names a match this server does not hold. Dropped; `message` says why. Never retried. */
  'rejected',
] as const
export const linkAckStatusSchema = z.enum(LINK_ACK_STATUSES)
export type LinkAckStatus = z.infer<typeof linkAckStatusSchema>

// ---------------------------------------------------------------------------
// Server → orchestrator
// ---------------------------------------------------------------------------

/**
 * The first frame on every socket. The token is the per-server secret the
 * provider planted at start (`ezpug.json` or the environment); the rest is
 * what the fleet console shows about a server and what the orchestrator
 * checks an assignment against (a manifest naming a plugin the image lacks
 * is refused before it is sent).
 */
export const helloServerFrameSchema = z.object({
  type: z.literal('hello'),
  protocol: z.literal(PROTOCOL_VERSION),
  token: linkTokenSchema,
  versions: serverVersionsSchema,
  /** The manifest capabilities this build of the plugin can honour. */
  capabilities: z.array(gamemodeCapabilitySchema),
  /** Plugin folders present in the image, whether or not enabled. */
  plugins: z.array(pluginFolderNameSchema).max(64),
  hostname: z.string().min(1).max(128),
  /** The engine map currently loaded. */
  map: z.string().min(1).max(128),
  state: linkServerStateSchema,
  /** The match the server believes it holds — a reconnect mid-match says so. */
  matchId: matchIdSchema.optional(),
  /** The last link `seq` this server assigned; `0` on a fresh install. */
  lastSeq: z.number().int().nonnegative(),
})

/** Liveness, every `welcome.heartbeatIntervalMs`. Silence past two of them opens the recovery window. */
export const heartbeatServerFrameSchema = z.object({
  type: z.literal('heartbeat'),
  state: linkServerStateSchema,
  map: z.string().min(1).max(128),
  playerCount: z.number().int().nonnegative(),
  matchId: matchIdSchema.optional(),
  uptimeMs: uptimeMsSchema,
})

/** A state change, the moment it happens — heartbeats carry the state too, this one is not late. */
export const stateServerFrameSchema = z.object({
  type: z.literal('state'),
  state: linkServerStateSchema,
  matchId: matchIdSchema.optional(),
  /** For a human reading the fleet console (`plugins loaded`, `demo uploading`). */
  detail: z.string().max(256).optional(),
})

/** A batch of vocabulary events, in `seq` order, each acked on its own. */
export const eventsServerFrameSchema = z.object({
  type: z.literal('events'),
  events: z.array(sequencedEventSchema).min(1).max(EVENTS_BATCH_MAX),
})

/** The answer to a `command` frame, by `correlationId`. */
export const commandResultServerFrameSchema = z.object({
  type: z.literal('command_result'),
  correlationId: z.string().min(1).max(128),
  status: linkCommandStatusSchema,
  /** Why a `rejected` command was rejected, in the Match API's error vocabulary. */
  code: matchApiErrorCodeSchema.optional(),
  message: z.string().max(1024).optional(),
  /** For `rcon`: what the console printed. */
  output: z
    .string()
    .max(64 * 1024)
    .optional(),
})

/** A round backup as it was written — persisted by the orchestrator, recovery fuel. */
export const backupServerFrameSchema = z.object({
  type: z.literal('backup'),
  matchId: matchIdSchema,
  backup: roundBackupSchema,
})

/**
 * The console tail. Unsolicited on a `state: ending` with a failure, or
 * the answer to a `console` command (then with its `correlationId`).
 */
export const consoleServerFrameSchema = z.object({
  type: z.literal('console'),
  correlationId: z.string().min(1).max(128).optional(),
  /** The server's uptime when the tail was taken; line stamps are relative to the same clock. */
  uptimeMs: uptimeMsSchema,
  lines: z.array(consoleLineSchema).max(CONSOLE_TAIL_MAX),
})

/** The answer to a `player_command` frame, relayed to the phone that tapped. */
export const playerCommandResultServerFrameSchema = z.object({
  type: z.literal('player_command_result'),
  correlationId: z.string().min(1).max(128),
  steamId64: steamId64Schema,
  command: playerCommandNameSchema,
  status: linkCommandStatusSchema,
  code: playerCommandRefusalSchema.optional(),
  /** In the player's language — the widget shows it as it is. */
  message: z.string().max(SERVER_CHAT_TEXT_MAX).optional(),
  /** For `cooldown`: how long until the verb works again. */
  cooldownMs: z.number().int().nonnegative().optional(),
  /** Charges left in the current period, where the verb has charges. */
  chargesLeft: z.number().int().nonnegative().optional(),
})

/**
 * **A gamemode's picture for one phone** (PRD-02 T26): the Match API's
 * `WidgetPushFrame` addressed to one player of one match, relayed to that
 * player's open widget sockets and to nobody else. Ephemeral by
 * construction — never acked, never sequenced, never written to
 * `match_events`, dropped when no widget of that player is open — which is
 * what lets `powerup-dm`'s `radar_peek` put enemy positions on a phone
 * without a position ever being stored (CLAUDE.md).
 *
 * `data` is the mode's own shape and the orchestrator does not read it; it
 * only checks that the serialized frame stays under
 * {@link WIDGET_PUSH_DATA_MAX}.
 */
export const widgetPushServerFrameSchema = z.object({
  type: z.literal('widget_push'),
  matchId: matchIdSchema,
  /** Whose phone. A push for somebody who has no widget open is simply dropped. */
  steamId64: steamId64Schema,
  push: widgetPushFrameSchema,
})

export const serverFrameSchema = z.discriminatedUnion('type', [
  helloServerFrameSchema,
  heartbeatServerFrameSchema,
  stateServerFrameSchema,
  eventsServerFrameSchema,
  commandResultServerFrameSchema,
  backupServerFrameSchema,
  consoleServerFrameSchema,
  playerCommandResultServerFrameSchema,
  widgetPushServerFrameSchema,
])
export type ServerFrame = z.infer<typeof serverFrameSchema>
export type ServerFrameInput = z.input<typeof serverFrameSchema>

/** Every frame type a server sends, in the union's order. */
export const SERVER_FRAME_TYPES = [
  'hello',
  'heartbeat',
  'state',
  'events',
  'command_result',
  'backup',
  'console',
  'player_command_result',
  'widget_push',
] as const
export type ServerFrameType = (typeof SERVER_FRAME_TYPES)[number]
export type ServerFrameOf<T extends ServerFrameType> = Extract<ServerFrame, { type: T }>

assertClosedSet('server frames', serverFrameSchema, 'type', SERVER_FRAME_TYPES)

// ---------------------------------------------------------------------------
// Orchestrator → server
// ---------------------------------------------------------------------------

/**
 * The answer to an accepted `hello`. `provider` and `serverId` are what the
 * server stamps into every event's `source`; `ackedSeq` is the highest link
 * `seq` the orchestrator already holds for this server, so a reconnecting
 * plugin resends from the next one and drops the rest of its buffer.
 */
export const welcomeOrchestratorFrameSchema = z.object({
  type: z.literal('welcome'),
  protocol: z.literal(PROTOCOL_VERSION),
  /** The provider adapter this server belongs to — `dathost`, `nodes`, `sim`. */
  provider: kebabNameSchema,
  /** The provider's handle for this server; `source.serverId` on every event. */
  serverId: z.string().min(1).max(128),
  heartbeatIntervalMs: z.number().int().positive(),
  ackedSeq: z.number().int().nonnegative(),
})

/**
 * Everything a server needs to play one match, composed by the orchestrator
 * from the request, the manifest and the ledger (PRD-02 T6). The core plugin
 * writes each of `pluginConfigs` where CounterStrikeSharp reads it, enables
 * `plugins`, execs `cfg`, sets `cvars`, changes to the first map,
 * writes `matchzyConfig` and loads it when the mode's flow is `matchzy`,
 * sets the hostname from `branding`, hands each roster entry's loadout to
 * the skins layer, and reports `state: assigned`. `restore` is present when
 * the match resumes here after a lost server.
 */
export const assignOrchestratorFrameSchema = z.object({
  type: z.literal('assign'),
  matchId: matchIdSchema,
  game: gameSchema,
  gamemode: assignedGamemodeSchema,
  /** The plugin folders to enable, in order — the manifest's, plus what the roster needs (skins). */
  plugins: z.array(pluginFolderNameSchema).max(16),
  /** Cfg files to exec, in order, after the map loads. */
  cfg: z.array(cfgFileSchema).max(16),
  /**
   * The cvars to set after the cfg files: the request's under the mode's
   * under what the rules derive, merged once here so the server applies a
   * flat map and never reasons about precedence.
   */
  cvars: gamemodeCvarsSchema,
  /** The MatchZy match config to write and load, when the flow is `matchzy`. Opaque here; T9 builds it. */
  matchzyConfig: z.record(z.string(), z.unknown()).optional(),
  /**
   * **A vendored plugin's own config file, by plugin folder** (PRD-02 T23):
   * what CounterStrikeSharp will read for that folder at
   * `addons/counterstrikesharp/configs/plugins/<folder>/<folder>.json`,
   * written by the loader *before* the folder is enabled — the plugin parses
   * it once, at load, and a file that arrives later is a file nobody reads.
   *
   * The door a community plugin gets when its settings are not cvars.
   * cs2-retakes keeps `MaxPlayers` and `ShouldAutoJoinGame` here rather than
   * on the console, so a mode that wants ten players and open join has to
   * say so in a JSON document; `matchzyConfig` is the same idea one plugin
   * earlier, kept separate because MatchZy's is loaded by a console command
   * mid-match and this one is not. Opaque here: the builders are the
   * orchestrator's (`match-config/retakes.ts`).
   */
  pluginConfigs: z.record(pluginFolderNameSchema, z.record(z.string(), z.unknown())).optional(),
  /** The map plan, in order; the first entry is loaded before the mode starts. */
  maps: z.array(mapPlanSchema).min(1),
  /** Absent for a mode with its own defaults (a config-only mode). */
  rules: matchRulesSchema.optional(),
  teams: matchTeamsSchema,
  /** Printed one every few seconds during warmup, in order. */
  warmupLines: z.array(z.string().min(1).max(SERVER_CHAT_TEXT_MAX)).max(20).default([]),
  branding: matchBrandingSchema.default({}),
  /** The presigned PUT the plugin uploads the demo to (decision 10). Absent = no upload, `demo.skipped`. */
  demoUploadUrl: z.url().optional(),
  /**
   * One presigned PUT per map of a series (T38a): the entry for the map
   * being uploaded wins, `demoUploadUrl` is the fallback for every map
   * without one. A signature covers the key it was drawn for, which is why
   * this is a list and not a template.
   */
  demoUploadUrls: z
    .array(z.object({ mapNumber: z.number().int().positive(), url: z.url() }))
    .max(DEMO_UPLOAD_URLS_MAX)
    .optional(),
  restore: roundBackupSchema.optional(),
})

/** A command for the server, answered by a `command_result` (or a `console` frame) with its `correlationId`. */
export const commandOrchestratorFrameSchema = z.object({
  type: z.literal('command'),
  command: linkCommandSchema,
})

/**
 * A player's tap, relayed from the widget socket (decision 17): the verb the
 * manifest declares and its arguments, for one SteamID64. The SDK enforces
 * cooldown and charges before the mode sees it and answers with a
 * `player_command_result`.
 */
export const playerCommandOrchestratorFrameSchema = z.object({
  type: z.literal('player_command'),
  correlationId: z.string().min(1).max(128),
  steamId64: steamId64Schema,
  command: playerCommandNameSchema,
  args: z.record(z.string(), z.unknown()).optional(),
})

/**
 * One player's profile, pushed: the way an open-join mode learns who just
 * connected, and the way a rostered player's rating or loadout is refreshed
 * mid-match. The same shape the Match API's `profile` command carries.
 */
export const profileOrchestratorFrameSchema = z.object({
  type: z.literal('profile'),
  player: rosterEntrySchema,
})

/** The match is over for this server: unload the mode, back to the lobby map, `state: idle`. */
export const releaseOrchestratorFrameSchema = z.object({
  type: z.literal('release'),
  /** For the server log: `ended`, `force_ended`, `ttl_expired`, the provider's reason. */
  reason: z.string().max(256).optional(),
})

/** Finish what you have, take nothing new, report `state: draining`. */
export const drainOrchestratorFrameSchema = z.object({
  type: z.literal('drain'),
})

/** What became of each event in an `events` frame, by link `seq`. */
export const ackOrchestratorFrameSchema = z.object({
  type: z.literal('ack'),
  results: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        status: linkAckStatusSchema,
        /** For `rejected`: why, for the server log. */
        message: z.string().max(512).optional(),
      }),
    )
    .min(1)
    .max(EVENTS_BATCH_MAX),
})

export const orchestratorFrameSchema = z.discriminatedUnion('type', [
  welcomeOrchestratorFrameSchema,
  assignOrchestratorFrameSchema,
  commandOrchestratorFrameSchema,
  playerCommandOrchestratorFrameSchema,
  profileOrchestratorFrameSchema,
  releaseOrchestratorFrameSchema,
  drainOrchestratorFrameSchema,
  ackOrchestratorFrameSchema,
])
export type OrchestratorFrame = z.infer<typeof orchestratorFrameSchema>
export type OrchestratorFrameInput = z.input<typeof orchestratorFrameSchema>

/** Every frame type the orchestrator sends a server, in the union's order. */
export const ORCHESTRATOR_FRAME_TYPES = [
  'welcome',
  'assign',
  'command',
  'player_command',
  'profile',
  'release',
  'drain',
  'ack',
] as const
export type OrchestratorFrameType = (typeof ORCHESTRATOR_FRAME_TYPES)[number]
export type OrchestratorFrameOf<T extends OrchestratorFrameType> = Extract<
  OrchestratorFrame,
  { type: T }
>

assertClosedSet('orchestrator frames', orchestratorFrameSchema, 'type', ORCHESTRATOR_FRAME_TYPES)
