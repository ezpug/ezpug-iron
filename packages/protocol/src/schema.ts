import {
  bombSiteSchema,
  gamemodeCapabilitiesSchema,
  gamemodeFlowSchema,
  gamemodeRecordsSchema,
  gamemodeSlotsSchema,
  gamemodeTierSchema,
  gameSchema,
  gameserverEventSchema,
  gameserverPlayerSchema,
  gameserverSourceSchema,
  keychainSchema,
  loadoutSchema,
  localeSchema,
  localizedTextSchema,
  mapPlanSchema,
  mapPlanSidesSchema,
  matchApiErrorCodeSchema,
  matchBrandingSchema,
  matchRulesSchema,
  matchTeamSchema,
  matchTeamsSchema,
  pauseKindSchema,
  pauseSourceSchema,
  playerCommandChargePeriodSchema,
  playerCommandSpecSchema,
  playerRoundSummarySchema,
  rosterEntrySchema,
  rosterSchema,
  roundWinConditionSchema,
  roundWinnerSchema,
  serverChatScopeSchema,
  serverSlotSchema,
  sideLoadoutSchema,
  stickerSchema,
  teamScoreSchema,
  teamSideSchema,
  weaponSkinSchema,
} from '@ezpug/match-api'
import { z } from 'zod'
import { PROTOCOL_CONSTANTS, PROTOCOL_VERSION } from './constants'
import {
  imageDigestSchema,
  instancePortsSchema,
  instancePurposeSchema,
  instanceSpecSchema,
  instanceStateSchema,
  nodeCapacitySchema,
  nodeFrameSchema,
  nodeInstanceSchema,
  nodeTokenKindSchema,
  orchestratorNodeFrameSchema,
} from './node-link'
import {
  assignedGamemodeSchema,
  consoleLineSchema,
  gamemodeCapabilitySchema,
  linkAckStatusSchema,
  linkCommandSchema,
  linkCommandStatusSchema,
  linkServerStateSchema,
  orchestratorFrameSchema,
  playerCommandRefusalSchema,
  roundBackupSchema,
  sequencedEventSchema,
  serverFrameSchema,
  serverVersionsSchema,
} from './server-link'

/**
 * **The JSON Schema export** — what the C# generator reads. Zod is the
 * source; each document below is one JSON Schema (draft 2020-12) whose
 * `$defs` carry every wire shape under the name its C# twin gets.
 *
 * Names are decided here and nowhere else: a schema in a {@link Named} list
 * becomes a `$defs` entry (and a C# type) of that name, every use of it a
 * `$ref`; a schema that is not named is inlined where it is used and the
 * generator names it after its owner and property. Discriminated unions
 * carry an `x-branch` suffix, so a union `ServerFrame` with a `hello` branch
 * yields `HelloServerFrame`.
 *
 * `io: 'output'` on purpose: the documents describe the bytes as the
 * *producing* side writes them, defaults filled — the orchestrator sends
 * parsed frames, the plugin fills its own defaults — so a C# property with a
 * default is a required property with an initializer, and absent means
 * absent.
 */

export interface Named {
  schema: z.ZodType
  /** The `$defs` entry and C# type name, PascalCase. */
  id: string
  /** One line for the generated doc comment. */
  description: string
  /** For a discriminated union: the suffix its branches' names get. */
  branch?: string
}

/**
 * The document's version, separate from {@link PROTOCOL_VERSION}: the
 * protocol version is what peers negotiate, this is the shape of the export
 * the generator understands.
 */
export const SCHEMA_DOCUMENT_VERSION = 1

/** The shapes the server link shares with `@ezpug/match-api`, named as the package names them. */
const SHARED_NAMES: readonly Named[] = [
  { schema: gameSchema, id: 'Game', description: 'The game a server plays (decision 18).' },
  { schema: localeSchema, id: 'Locale', description: 'A player’s language: German or English.' },
  {
    schema: localizedTextSchema,
    id: 'LocalizedText',
    description: 'A translated string: both languages, always.',
  },
  {
    schema: matchTeamSchema,
    id: 'MatchTeam',
    description: 'A match team as every event names one.',
  },
  { schema: teamSideSchema, id: 'TeamSide', description: 'A CS side.' },
  { schema: serverSlotSchema, id: 'ServerSlot', description: 'Where a connected human sits.' },
  {
    schema: gameserverSourceSchema,
    id: 'GameserverSource',
    description: 'Which provider and which server an event came from.',
  },
  {
    schema: gameserverPlayerSchema,
    id: 'GameserverPlayer',
    description: 'A player as a gameserver sees one: SteamID64, in-game name, slot.',
  },
  {
    schema: teamScoreSchema,
    id: 'TeamScore',
    description: 'A score in team order, never winner first.',
  },
  {
    schema: roundWinConditionSchema,
    id: 'RoundWinCondition',
    description: 'Why a round ended, normalized.',
  },
  {
    schema: roundWinnerSchema,
    id: 'RoundWinner',
    description: 'Who took a round, and on which side.',
  },
  {
    schema: playerRoundSummarySchema,
    id: 'PlayerRoundSummary',
    description: 'One player’s cumulative stats as of a round end.',
  },
  { schema: pauseKindSchema, id: 'PauseKind', description: 'Why a match is standing still.' },
  { schema: pauseSourceSchema, id: 'PauseSource', description: 'Who asked for a pause.' },
  { schema: bombSiteSchema, id: 'BombSite', description: 'A bomb site.' },
  {
    schema: serverChatScopeSchema,
    id: 'ServerChatScope',
    description: 'Which window a chat line was said in.',
  },
  {
    schema: gameserverEventSchema,
    id: 'GameserverEvent',
    description:
      'The vocabulary (decision 4): the one language a server speaks to anyone. v1, byte-compatible with the platform’s.',
    branch: 'Event',
  },
  {
    schema: matchApiErrorCodeSchema,
    id: 'MatchApiErrorCode',
    description: 'The Match API’s error vocabulary, as a command result names a reason.',
  },
  { schema: stickerSchema, id: 'Sticker', description: 'One sticker on one weapon.' },
  { schema: keychainSchema, id: 'Keychain', description: 'A keychain on a weapon.' },
  {
    schema: weaponSkinSchema,
    id: 'WeaponSkin',
    description: 'A finish on a weapon, for one side.',
  },
  {
    schema: sideLoadoutSchema,
    id: 'SideLoadout',
    description: 'Everything one side of a loadout holds.',
  },
  {
    schema: loadoutSchema,
    id: 'Loadout',
    description: 'A player’s cosmetics as the server applies them (decision 20).',
  },
  {
    schema: rosterEntrySchema,
    id: 'RosterEntry',
    description:
      'A rostered or pushed player: SteamID64, display name, locale, rating, rank, loadout.',
  },
  { schema: rosterSchema, id: 'Roster', description: 'A team as the request locks it.' },
  { schema: matchTeamsSchema, id: 'MatchTeams', description: 'Both rosters.' },
  {
    schema: mapPlanSidesSchema,
    id: 'MapPlanSides',
    description: 'Which side team A starts on, or `knife`.',
  },
  {
    schema: mapPlanSchema,
    id: 'MapPlan',
    description: 'One map to be played and how sides are decided.',
  },
  { schema: matchRulesSchema, id: 'MatchRules', description: 'The rules a context decided.' },
  {
    schema: matchBrandingSchema,
    id: 'MatchBranding',
    description: 'Hostname and event name (decision 22).',
  },
  { schema: gamemodeTierSchema, id: 'GamemodeTier', description: 'The three tiers (decision 15).' },
  {
    schema: gamemodeFlowSchema,
    id: 'GamemodeFlow',
    description: 'Who owns match flow on the server.',
  },
  {
    schema: gamemodeRecordsSchema,
    id: 'GamemodeRecords',
    description: 'What the server keeps of a match.',
  },
  {
    schema: gamemodeSlotsSchema,
    id: 'GamemodeSlots',
    description: 'How many people, in what shape.',
  },
  {
    schema: gamemodeCapabilitiesSchema,
    id: 'GamemodeCapabilities',
    description: 'What the mode can do, as booleans the loader enforces.',
  },
  {
    schema: playerCommandChargePeriodSchema,
    id: 'PlayerCommandChargePeriod',
    description: 'What a charge is counted against.',
  },
  {
    schema: playerCommandSpecSchema,
    id: 'PlayerCommandSpec',
    description: 'A player-scoped verb an sdk mode accepts, with its cooldown and charges.',
  },
]

/** The server link's own shapes. */
const SERVER_LINK_NAMES: readonly Named[] = [
  {
    schema: linkServerStateSchema,
    id: 'LinkServerState',
    description: 'Where a server is in its life, as it reports it.',
  },
  {
    schema: gamemodeCapabilitySchema,
    id: 'GamemodeCapability',
    description: 'One manifest capability, as a hello lists the ones a server can honour.',
  },
  {
    schema: serverVersionsSchema,
    id: 'ServerVersions',
    description: 'The versions a server runs.',
  },
  {
    schema: roundBackupSchema,
    id: 'RoundBackup',
    description: 'A round backup as it crosses the link, up as written and down on restore.',
  },
  {
    schema: consoleLineSchema,
    id: 'ConsoleLine',
    description: 'One console line with the server’s uptime.',
  },
  {
    schema: sequencedEventSchema,
    id: 'SequencedEvent',
    description: 'One vocabulary event with its per-server link sequence number.',
  },
  {
    schema: assignedGamemodeSchema,
    id: 'AssignedGamemode',
    description: 'The manifest as resolved for one assignment: everything a server reads.',
  },
  {
    schema: linkCommandSchema,
    id: 'LinkCommand',
    description: 'A Match API command relayed verbatim, or the link’s own `console`.',
    branch: 'Command',
  },
  {
    schema: linkCommandStatusSchema,
    id: 'LinkCommandStatus',
    description: 'What became of a command on the server.',
  },
  {
    schema: playerCommandRefusalSchema,
    id: 'PlayerCommandRefusal',
    description: 'Why a player’s command was refused.',
  },
  {
    schema: linkAckStatusSchema,
    id: 'LinkAckStatus',
    description: 'What the orchestrator answers per event.',
  },
  {
    schema: serverFrameSchema,
    id: 'ServerFrame',
    description: 'What a server sends the orchestrator.',
    branch: 'ServerFrame',
  },
  {
    schema: orchestratorFrameSchema,
    id: 'OrchestratorFrame',
    description: 'What the orchestrator sends a server.',
    branch: 'OrchestratorFrame',
  },
]

/** The node link's shapes. */
const NODE_LINK_NAMES: readonly Named[] = [
  {
    schema: nodeTokenKindSchema,
    id: 'NodeTokenKind',
    description: 'Which kind of token a hello presents.',
  },
  {
    schema: instancePortsSchema,
    id: 'InstancePorts',
    description: 'The game and GOTV ports a container publishes.',
  },
  {
    schema: instancePurposeSchema,
    id: 'InstancePurpose',
    description: 'Why an instance exists: warm or for a match.',
  },
  {
    schema: instanceStateSchema,
    id: 'InstanceState',
    description: 'A container’s life as docker sees it.',
  },
  {
    schema: nodeInstanceSchema,
    id: 'NodeInstance',
    description: 'One container, as the node reports it.',
  },
  {
    schema: nodeCapacitySchema,
    id: 'NodeCapacity',
    description: 'How many containers, and how many warm.',
  },
  { schema: imageDigestSchema, id: 'ImageDigest', description: 'An OCI image digest.' },
  {
    schema: instanceSpecSchema,
    id: 'InstanceSpec',
    description: 'What `start` tells a node to run.',
  },
  {
    schema: nodeFrameSchema,
    id: 'NodeFrame',
    description: 'What a node sends the orchestrator.',
    branch: 'NodeFrame',
  },
  {
    schema: orchestratorNodeFrameSchema,
    id: 'OrchestratorNodeFrame',
    description: 'What the orchestrator sends a node.',
    branch: 'OrchestratorNodeFrame',
  },
]

/** What one export produces: a JSON Schema document with named `$defs`. */
export interface ProtocolSchemaDocument {
  $schema: string
  title: string
  description: string
  'x-protocol-version': number
  'x-document-version': number
  'x-constants': Record<string, string | number>
  $defs: Record<string, Record<string, unknown>>
}

function toDocument(
  title: string,
  description: string,
  names: readonly Named[],
): ProtocolSchemaDocument {
  const registry = z.registry<{ id: string }>()
  const byId = new Map<string, Named>()
  for (const named of names) {
    if (byId.has(named.id)) throw new Error(`protocol schema: ${named.id} is named twice`)
    if (!/^[A-Z][A-Za-z0-9]*$/.test(named.id))
      throw new Error(`protocol schema: ${named.id} is not PascalCase`)
    byId.set(named.id, named)
    registry.add(named.schema, { id: named.id })
  }
  const exported = z.toJSONSchema(registry, {
    uri: id => `#/$defs/${id}`,
    io: 'output',
    unrepresentable: 'throw',
  })
  const $defs: Record<string, Record<string, unknown>> = {}
  for (const named of names) {
    const {
      $schema: _schema,
      $id: _id,
      ...schema
    } = exported.schemas[named.id] as Record<string, unknown>
    $defs[named.id] = {
      description: named.description,
      ...(named.branch ? { 'x-branch': named.branch } : {}),
      ...schema,
    }
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title,
    description,
    'x-protocol-version': PROTOCOL_VERSION,
    'x-document-version': SCHEMA_DOCUMENT_VERSION,
    'x-constants': { ...PROTOCOL_CONSTANTS },
    $defs,
  }
}

/** The server link, whole: the vocabulary, the shared Match API shapes, both frame unions. */
export function serverLinkJsonSchema(): ProtocolSchemaDocument {
  return toDocument(
    'EZPug Iron server link',
    'The wire between a server’s EZPug core plugin and the orchestrator (decision 5). Generated from packages/protocol/src by scripts/protocol-schema.mjs; the C# twins in plugins/EZPug.Sdk/Generated are generated from this file.',
    [...SHARED_NAMES, ...SERVER_LINK_NAMES],
  )
}

/** The node link, whole. TypeScript on both ends; exported for documentation and the node agent's tests. */
export function nodeLinkJsonSchema(): ProtocolSchemaDocument {
  return toDocument(
    'EZPug Iron node link',
    'The wire between an ezpug-node agent and the orchestrator (decision 23). Generated from packages/protocol/src by scripts/protocol-schema.mjs.',
    NODE_LINK_NAMES,
  )
}

/** The two documents by the file name each is written to under `packages/protocol/schema/`. */
export const PROTOCOL_SCHEMA_FILES = Object.freeze({
  'server-link.schema.json': serverLinkJsonSchema,
  'node-link.schema.json': nodeLinkJsonSchema,
})

/** The one writer for a schema document: two-space JSON, trailing newline. */
export function stringifySchemaDocument(document: ProtocolSchemaDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}
