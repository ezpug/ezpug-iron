import { z } from 'zod'
import { gameSchema } from '../vocabulary/game'
import { localizedTextSchema } from '../vocabulary/locale'
import { mapIdentifierSchema, mapNameSchema, workshopIdSchema } from '../vocabulary/maps'
import { kebabNameSchema } from '../vocabulary/naming'

/**
 * **A gamemode is a manifest served by the orchestrator** (decision 14). One
 * file per mode, `gamemodes/<id>/manifest.json` in this repo, authored as data
 * and validated by this schema; the orchestrator ships the ones it knows,
 * `GET /v1/gamemodes` publishes them whole, and the platform caches the
 * catalog and renders a card from it. The manifest says what the *server*
 * does for a match of this mode — which plugins to enable, which cfg to exec,
 * which maps it plays, who owns match flow, what it records, what a player
 * may do from a phone — and never what the platform makes of the result
 * (`ranked` is false by construction; rating and ranking are the platform's).
 *
 * Three tiers, each proved by a real mode (decision 15): `config` is stock
 * CS2 by cfg alone (`flying-scoutsman`), `plugin` is a vendored community
 * plugin under the core plugin (`retakes`), `sdk` is a mode written on
 * `EZPug.Sdk` with player commands and a widget (`powerup-dm`). `pug` is the
 * queue's mode, MatchZy-driven. The tier decides what the rest of the
 * manifest may say; {@link gamemodeManifestSchema} refuses a manifest whose
 * parts disagree, so a manifest that parses is one the loader can act on.
 *
 * `docs/gamemodes.md` is the reference for authors and for the platform's
 * renderer.
 */

/** The three tiers (decision 15): stock cfg, a community plugin, a mode on the SDK. */
export const GAMEMODE_TIERS = ['config', 'plugin', 'sdk'] as const
export const gamemodeTierSchema = z.enum(GAMEMODE_TIERS)
export type GamemodeTier = z.infer<typeof gamemodeTierSchema>

/**
 * Who owns match flow on the server — ready-up, knife, live, the series.
 * `matchzy` translates MatchZy's own events into the vocabulary at the edge;
 * `plugin` means the mode's plugin (community or SDK) speaks `going_live`,
 * `round_end`, `map_end`, `series_end` itself; `none` means nobody does: the
 * server plays the map until the client ends the match or the TTL does.
 */
export const GAMEMODE_FLOWS = ['matchzy', 'plugin', 'none'] as const
export const gamemodeFlowSchema = z.enum(GAMEMODE_FLOWS)
export type GamemodeFlow = z.infer<typeof gamemodeFlowSchema>

/**
 * What the server keeps of a match of this mode. `demo` — a demo is recorded
 * and uploaded to the request's `demoUploadUrl` (`demo.uploaded` follows), and
 * every durable event flows. `events` — the durable events only, no demo.
 * `none` — only orchestration facts; the game's own events still stream
 * live but nothing is promised durably. Positions and chat are capabilities,
 * not records: ephemeral by construction (CLAUDE.md "One vocabulary").
 */
export const GAMEMODE_RECORDS = ['demo', 'events', 'none'] as const
export const gamemodeRecordsSchema = z.enum(GAMEMODE_RECORDS)
export type GamemodeRecords = z.infer<typeof gamemodeRecordsSchema>

/**
 * How many people, in what shape. `teams: 1` is a free-for-all (a deathmatch):
 * the request still carries `teamA` and `teamB`, and `teamB.players` is
 * empty. `teamSize` is the most a team may hold; an open-join mode fills up
 * to it as people arrive.
 */
export const gamemodeSlotsSchema = z.object({
  teamSize: z.number().int().positive().max(32),
  teams: z.number().int().positive().max(2),
  /** Players may join without being rostered; profiles are pushed as they arrive. */
  openJoin: z.boolean(),
})
export type GamemodeSlots = z.infer<typeof gamemodeSlotsSchema>

/**
 * Which maps a match of this mode may pin. `any` — whatever the request
 * plans, workshop maps included (the platform's map pool decides). Otherwise
 * an allow-list: official maps by engine name (`catalog`) and Workshop maps
 * by published-file id (`workshop`); a request naming a map outside it is
 * refused `map_not_allowed` at the door. A community plugin that ships spawn
 * files per map, or a mode built for one map, lists them here.
 */
export const gamemodeMapsSchema = z.union([
  z.literal('any'),
  z
    .object({
      catalog: z.array(mapNameSchema).max(64).default([]),
      workshop: z.array(workshopIdSchema).max(64).default([]),
    })
    .refine(maps => maps.catalog.length + maps.workshop.length > 0, {
      message: 'an allow-list names at least one map; use "any" for no restriction',
    }),
])
export type GamemodeMaps = z.infer<typeof gamemodeMapsSchema>

/** Does this manifest allow this map identifier? */
export function gamemodeAllowsMap(maps: GamemodeMaps, identifier: string): boolean {
  if (maps === 'any') return mapIdentifierSchema.safeParse(identifier).success
  const workshop = identifier.match(/^workshop\/([1-9]\d{0,19})\/[a-z0-9_]+$/)
  if (workshop) return maps.workshop.includes(workshop[1] as string)
  return mapNameSchema.safeParse(identifier).success && maps.catalog.includes(identifier)
}

/**
 * A plugin folder name under `addons/counterstrikesharp/plugins/` in the one
 * server image (decision 16): the core plugin enables exactly these, in this
 * order, and nothing else. PascalCase or kebab, as the vendor named it.
 */
export const pluginFolderNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 'a plugin folder name (e.g. `RetakesPlugin`)')
export type PluginFolderName = z.infer<typeof pluginFolderNameSchema>

/**
 * A cfg file relative to the server's `cfg/` directory, forward slashes,
 * `.cfg`, no path tricks. Exec'd in the manifest's order after the map
 * loads and before the match's own rules are applied.
 */
export const cfgFileSchema = z
  .string()
  .regex(
    /^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.cfg$/,
    'a cfg path relative to cfg/, lowercase, ending in .cfg (e.g. `ezpug/pug.cfg`)',
  )
export type CfgFile = z.infer<typeof cfgFileSchema>

/** A console variable's name: lowercase, as the engine spells it. */
export const cvarNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'a cvar name (e.g. `mp_freezetime`)')
export type CvarName = z.infer<typeof cvarNameSchema>

/** A cvar's value, as a string — the console has no other type. */
export const cvarValueSchema = z.string().max(256)

/** The most cvars one manifest may set. A mode that needs more writes a cfg. */
export const GAMEMODE_CVARS_MAX = 64

/**
 * Cvars no manifest may touch: they are the orchestrator's (secrets, the
 * event sink, identity) or the request's (branding). A manifest naming one
 * does not parse.
 */
export const PROTECTED_CVARS = [
  'hostname',
  'sv_password',
  'rcon_password',
  'tv_password',
  'tv_relaypassword',
  'sv_setsteamaccount',
  'logaddress_add_http',
  'logaddress_add',
  'logaddress_delall',
  'logaddress_delall_http',
  'sv_logsecret',
  'sv_downloadurl',
] as const

/**
 * The cvars the mode sets after its cfg files, a bounded map. Applied
 * **over** a request's `rules.cvars` (a request can never undo what a mode
 * needs) and **under** what the rules derive (`mp_maxrounds` from
 * `regulationRounds`, overtime, warmup) — the mode never redirects the round
 * format behind the rules' back either.
 */
export const gamemodeCvarsSchema = z
  .record(cvarNameSchema, cvarValueSchema)
  .refine(cvars => Object.keys(cvars).length <= GAMEMODE_CVARS_MAX, {
    message: `at most ${GAMEMODE_CVARS_MAX} cvars; a mode that needs more writes a cfg`,
  })
  .refine(
    cvars =>
      !Object.keys(cvars).some(name => (PROTECTED_CVARS as readonly string[]).includes(name)),
    {
      message:
        'a protected cvar (hostname, passwords, the log sink, identity) is never a manifest’s',
    },
  )
export type GamemodeCvars = z.infer<typeof gamemodeCvarsSchema>

/**
 * What the mode can do, as booleans the platform branches on and the loader
 * enforces. `positions` — the core plugin streams `position_tick`s.
 * `chat` — chat lines are relayed as `chat_message` / `chat_command`.
 * `playerCommands` — the player-scoped verbs in `commands` are accepted from
 * a widget (an `sdk` mode only). `widget` — a phone widget exists (decision
 * 17; implies `playerCommands`). `backups` — round backups are written and
 * `restore` works, so a crashed server can be recovered mid-match.
 * `scoreboardRating` — EZ Rating shows on the scoreboard (decision 21).
 */
export const gamemodeCapabilitiesSchema = z.object({
  positions: z.boolean(),
  chat: z.boolean(),
  playerCommands: z.boolean(),
  widget: z.boolean(),
  backups: z.boolean(),
  scoreboardRating: z.boolean(),
})
export type GamemodeCapabilities = z.infer<typeof gamemodeCapabilitiesSchema>
export type GamemodeCapability = keyof GamemodeCapabilities
export const GAMEMODE_CAPABILITIES = [
  'positions',
  'chat',
  'playerCommands',
  'widget',
  'backups',
  'scoreboardRating',
] as const satisfies readonly GamemodeCapability[]

/**
 * A player command's name: the bare lowercase verb, the same grammar as a
 * `chat_command`'s `command` so a widget tap and a `!verb` in chat name the
 * same thing.
 */
export const playerCommandNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'a bare lowercase verb (e.g. `powerup`)')
export type PlayerCommandName = z.infer<typeof playerCommandNameSchema>

/** What a charge is counted against. */
export const PLAYER_COMMAND_CHARGE_PERIODS = ['life', 'round', 'map', 'match'] as const
export const playerCommandChargePeriodSchema = z.enum(PLAYER_COMMAND_CHARGE_PERIODS)
export type PlayerCommandChargePeriod = z.infer<typeof playerCommandChargePeriodSchema>

/**
 * A JSON Schema (draft 2020-12) for a command's `args`: an object schema, so
 * the widget validates before it taps and the plugin validates before it
 * acts, from one document. Absent on the command = it takes no args.
 */
export const argsJsonSchemaSchema = z
  .record(z.string(), z.unknown())
  .refine(schema => schema.type === 'object', {
    message: 'a command’s args schema describes an object',
  })
export type ArgsJsonSchema = z.infer<typeof argsJsonSchemaSchema>

/**
 * **A player-scoped verb an `sdk` mode accepts** — from the widget's socket
 * (decision 17) or as `!name` in chat, relayed to the plugin per player. The
 * SDK enforces `cooldownMs` and `charges` before the mode ever sees the tap;
 * a refused tap answers on the socket, an accepted one becomes whatever the
 * mode does (a `plugin_event`, usually).
 */
export const playerCommandSpecSchema = z.object({
  name: playerCommandNameSchema,
  /** What the button says. */
  title: localizedTextSchema,
  /** What it does, one line. */
  description: localizedTextSchema.optional(),
  /** The least time between two uses by one player; `0` = none. */
  cooldownMs: z.number().int().nonnegative().default(0),
  /** How many uses a player has per period; `null` = unlimited. */
  charges: z
    .object({
      count: z.number().int().positive().max(999),
      per: playerCommandChargePeriodSchema,
    })
    .nullable()
    .default(null),
  args: argsJsonSchemaSchema.optional(),
})
export type PlayerCommandSpec = z.infer<typeof playerCommandSpecSchema>

/** The most player commands one manifest may declare. */
export const GAMEMODE_COMMANDS_MAX = 32

/**
 * What a widget needs injected by the host (the platform, PRD-09 T7): the
 * design tokens as CSS custom properties, the viewer's locale, a player token
 * minted for this match and SteamID. The host contract that carries them is
 * {@link widgetHostMessageSchema} in `widget-host.ts`.
 */
export const WIDGET_NEEDS = ['tokens', 'locale', 'playerToken'] as const
export const widgetNeedSchema = z.enum(WIDGET_NEEDS)
export type WidgetNeed = z.infer<typeof widgetNeedSchema>

/**
 * The widget block (decision 17): a built web component the orchestrator
 * serves and the platform embeds in a sandboxed frame. `entry` is the bundle
 * file relative to the gamemode's directory, produced by `gamemode-kit`.
 */
export const gamemodeWidgetSchema = z.object({
  entry: z
    .string()
    .regex(/^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.js$/, 'the built bundle, relative, `.js`'),
  needs: z.array(widgetNeedSchema).min(1).max(WIDGET_NEEDS.length),
})
export type GamemodeWidget = z.infer<typeof gamemodeWidgetSchema>

/** A semver version string, strict — `1.2.3`, with an optional pre-release. */
export const semverSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
    'a semver version (e.g. `0.1.0`)',
  )

/**
 * The manifest's *read side* — the identity and the facts a client needs to
 * build a request and render a card. A client that only wants this much
 * reads this much; the catalog serves the whole manifest.
 */
export const gamemodeSummarySchema = z.object({
  id: kebabNameSchema,
  game: gameSchema,
  tier: gamemodeTierSchema,
  title: localizedTextSchema,
  description: localizedTextSchema,
  slots: gamemodeSlotsSchema,
  flow: gamemodeFlowSchema,
  records: gamemodeRecordsSchema,
  /** Always false this round: the manifest states what the server records, never what counts. */
  ranked: z.literal(false),
  /** The manifest's own version, semver. Bumped with any change to the file. */
  version: semverSchema,
})
export type GamemodeSummary = z.infer<typeof gamemodeSummarySchema>

/**
 * Every rule the tier imposes on the rest of the manifest, checked at parse
 * time so a manifest that parses is one the loader can act on. Listed in
 * `docs/gamemodes.md` under "What the tier allows".
 */
function checkManifestConsistency(
  manifest: {
    tier: GamemodeTier
    flow: GamemodeFlow
    plugins: string[]
    commands: unknown[]
    widget?: unknown
    capabilities: GamemodeCapabilities
  },
  ctx: z.RefinementCtx,
): void {
  const refuse = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message })

  if (manifest.tier === 'config') {
    if (manifest.plugins.length > 0) refuse('plugins', 'a config mode enables no plugin')
    if (manifest.flow === 'plugin') refuse('flow', 'a config mode has no plugin to own its flow')
  } else if (manifest.plugins.length === 0) {
    refuse('plugins', `a ${manifest.tier} mode names the plugin it runs on`)
  }

  if (manifest.tier !== 'sdk') {
    if (manifest.commands.length > 0) refuse('commands', 'only an sdk mode accepts player commands')
    if (manifest.widget !== undefined) refuse('widget', 'only an sdk mode ships a widget')
  }

  const { capabilities } = manifest
  if (capabilities.playerCommands !== manifest.commands.length > 0)
    refuse('capabilities', '`playerCommands` is true exactly when `commands` is non-empty')
  if (capabilities.widget !== (manifest.widget !== undefined))
    refuse('capabilities', '`widget` is true exactly when a widget block exists')
  if (capabilities.widget && !capabilities.playerCommands)
    refuse('capabilities', 'a widget needs player commands to tap')
  if (capabilities.backups && manifest.flow === 'none')
    refuse('capabilities', 'a round backup needs a flow owner to restore into')
}

/**
 * **The whole manifest.** The summary plus what the server side reads. See
 * the module comment and `docs/gamemodes.md`.
 */
export const gamemodeManifestSchema = gamemodeSummarySchema
  .extend({
    maps: gamemodeMapsSchema,
    /** Plugin folders to enable, in order. Empty for a config mode. */
    plugins: z.array(pluginFolderNameSchema).max(16).default([]),
    /** Cfg files to exec, in order, after the map loads. */
    cfg: z.array(cfgFileSchema).max(16).default([]),
    cvars: gamemodeCvarsSchema.default({}),
    capabilities: gamemodeCapabilitiesSchema,
    /** The player-scoped verbs an sdk mode accepts. Empty otherwise. */
    commands: z
      .array(playerCommandSpecSchema)
      .max(GAMEMODE_COMMANDS_MAX)
      .default([])
      .refine(commands => new Set(commands.map(command => command.name)).size === commands.length, {
        message: 'command names are unique within a manifest',
      }),
    widget: gamemodeWidgetSchema.optional(),
    /** The SDK version the manifest was authored against; a loader older in major refuses it. */
    sdkVersion: semverSchema,
  })
  .superRefine(checkManifestConsistency)
export type GamemodeManifest = z.infer<typeof gamemodeManifestSchema>
export type GamemodeManifestInput = z.input<typeof gamemodeManifestSchema>

/** The catalog (`GET /v1/gamemodes`): every manifest the orchestrator ships, whole. */
export const gamemodeCatalogSchema = z.object({
  gamemodes: z.array(gamemodeManifestSchema),
})
export type GamemodeCatalog = z.infer<typeof gamemodeCatalogSchema>
