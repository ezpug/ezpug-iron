/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { MATCH_API_ERROR_CODES } from '../errors'
import {
  GAMEMODE_CAPABILITIES,
  GAMEMODE_CVARS_MAX,
  GAMEMODE_FLOWS,
  GAMEMODE_RECORDS,
  GAMEMODE_TIERS,
  type GamemodeManifestInput,
  gamemodeAllowsMap,
  gamemodeCatalogSchema,
  gamemodeCvarsSchema,
  gamemodeManifestSchema,
  gamemodeSummarySchema,
  gamemodeWidgetSchema,
  PLAYER_COMMAND_CHARGE_PERIODS,
  PROTECTED_CVARS,
  playerCommandSpecSchema,
  WIDGET_NEEDS,
} from '../resources/gamemode'
import {
  WIDGET_HOST_MESSAGE_TYPES,
  WIDGET_HOST_PROTOCOL,
  widgetHostMessageSchema,
} from '../resources/widget-host'
import { matchApiRoutes } from '../routes'
import { matchApiJsonSchemas } from '../schemas'
import { SHIPPED_GAMEMODE_IDS, SHIPPED_GAMEMODES, shippedGamemode } from './index'

const gamemodesDir = dirname(
  createRequire(import.meta.url).resolve('@ezpug/gamemodes/package.json'),
)

/** A valid sdk manifest to mutate from — the shape every rule test starts at. */
function sdkManifest(overrides: Partial<GamemodeManifestInput> = {}): GamemodeManifestInput {
  return {
    id: 'test-mode',
    game: 'cs2',
    tier: 'sdk',
    title: { de: 'Testmodus', en: 'Test mode' },
    description: { de: 'Ein Modus für Tests.', en: 'A mode for tests.' },
    slots: { teamSize: 5, teams: 2, openJoin: true },
    flow: 'plugin',
    records: 'events',
    ranked: false,
    maps: { catalog: ['de_mirage'], workshop: ['3070284539'] },
    plugins: ['EZPug.TestMode'],
    cfg: ['ezpug/test-mode.cfg'],
    cvars: { mp_freezetime: '5' },
    capabilities: {
      positions: true,
      chat: true,
      playerCommands: true,
      widget: true,
      backups: false,
      scoreboardRating: false,
    },
    commands: [{ name: 'tap', title: { de: 'Tippen', en: 'Tap' } }],
    widget: { entry: 'widget/test-mode.js', needs: ['tokens', 'locale', 'playerToken'] },
    version: '0.1.0',
    sdkVersion: '0.1.0',
    ...overrides,
  }
}

function issuesOf(input: GamemodeManifestInput): string[] {
  const result = gamemodeManifestSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map(issue => issue.path.join('.'))
}

describe('the four shipped manifests', () => {
  it('are every directory under gamemodes/, each with a manifest.json, in catalog order', () => {
    const directories = readdirSync(gamemodesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    expect(directories).toEqual([...SHIPPED_GAMEMODE_IDS].sort())
    expect(SHIPPED_GAMEMODES.map(manifest => manifest.id)).toEqual([...SHIPPED_GAMEMODE_IDS])
    for (const id of SHIPPED_GAMEMODE_IDS) {
      const raw = JSON.parse(readFileSync(join(gamemodesDir, id, 'manifest.json'), 'utf8'))
      expect(raw.id).toBe(id)
      expect(gamemodeManifestSchema.parse(raw)).toEqual(shippedGamemode(id))
    }
  })

  it('prove one tier each, as decision 15 says, and pug is first', () => {
    expect(shippedGamemode('pug').tier).toBe('plugin')
    expect(shippedGamemode('pug').flow).toBe('matchzy')
    expect(shippedGamemode('pug').records).toBe('demo')
    expect(shippedGamemode('flying-scoutsman').tier).toBe('config')
    expect(shippedGamemode('flying-scoutsman').plugins).toEqual([])
    expect(shippedGamemode('retakes').tier).toBe('plugin')
    expect(shippedGamemode('retakes').slots.openJoin).toBe(true)
    expect(shippedGamemode('powerup-dm').tier).toBe('sdk')
    expect(shippedGamemode('powerup-dm').widget?.needs).toEqual([...WIDGET_NEEDS])
    expect(shippedGamemode('powerup-dm').commands.map(command => command.name)).toEqual(['powerup'])
    expect(shippedGamemode('powerup-dm').commands[0]?.charges).toEqual({ count: 1, per: 'life' })
    expect(SHIPPED_GAMEMODES[0]?.id).toBe('pug')
  })

  it('are all cs2, unranked, bilingual and on the round’s SDK', () => {
    for (const manifest of SHIPPED_GAMEMODES) {
      expect(manifest.game).toBe('cs2')
      expect(manifest.ranked).toBe(false)
      expect(manifest.title.de).not.toBe('')
      expect(manifest.title.en).not.toBe('')
      expect(manifest.description.de).not.toEqual(manifest.description.en)
      expect(manifest.sdkVersion).toBe('0.1.0')
      for (const command of manifest.commands) expect(command.title.de).not.toBe('')
    }
  })

  it('serve as the catalog and each as a summary', () => {
    const catalog = gamemodeCatalogSchema.parse({ gamemodes: SHIPPED_GAMEMODES })
    expect(catalog.gamemodes).toHaveLength(4)
    for (const manifest of SHIPPED_GAMEMODES) {
      expect(gamemodeSummarySchema.parse(manifest).id).toBe(manifest.id)
    }
    expect(matchApiRoutes.gamemodes.list.response.parse({ gamemodes: SHIPPED_GAMEMODES })).toEqual(
      catalog,
    )
    expect(matchApiRoutes.gamemodes.get.response.parse(shippedGamemode('pug'))).toEqual(
      shippedGamemode('pug'),
    )
  })

  it('survive the JSON Schema export the C# generator reads', () => {
    const documents = matchApiJsonSchemas()
    expect(documents.GamemodeManifest).toBeDefined()
    expect(documents.GamemodeCatalog).toBeDefined()
    expect(documents.WidgetHostMessage).toBeDefined()
  })
})

describe('what the tier allows', () => {
  it('a config mode enables no plugin and has no plugin flow', () => {
    const config = sdkManifest({
      tier: 'config',
      commands: [],
      widget: undefined,
      capabilities: {
        positions: true,
        chat: true,
        playerCommands: false,
        widget: false,
        backups: false,
        scoreboardRating: false,
      },
    })
    expect(issuesOf({ ...config, plugins: [], flow: 'none' })).toEqual([])
    expect(issuesOf({ ...config, plugins: ['Anything'], flow: 'none' })).toEqual(['plugins'])
    expect(issuesOf({ ...config, plugins: [], flow: 'plugin' })).toEqual(['flow'])
  })

  it('a plugin or sdk mode names the plugin it runs on', () => {
    expect(issuesOf(sdkManifest({ plugins: [] }))).toEqual(['plugins'])
  })

  it('only an sdk mode has commands or a widget', () => {
    expect(issuesOf(sdkManifest({ tier: 'plugin' })).sort()).toEqual(['commands', 'widget'])
  })

  it('capabilities say what the manifest holds', () => {
    const noWidget = { ...sdkManifest().capabilities, widget: false }
    expect(issuesOf(sdkManifest({ capabilities: noWidget }))).toEqual(['capabilities'])
    const noCommands = { ...sdkManifest().capabilities, playerCommands: false }
    expect(issuesOf(sdkManifest({ capabilities: noCommands }))).toContain('capabilities')
    expect(issuesOf(sdkManifest({ commands: [] }))).toContain('capabilities')
    const backups = { ...sdkManifest().capabilities, backups: true }
    expect(issuesOf(sdkManifest({ capabilities: backups, flow: 'none' }))).toEqual(['capabilities'])
    expect(issuesOf(sdkManifest({ capabilities: backups, flow: 'plugin' }))).toEqual([])
  })

  it('refuses a repeated command name and more than the bound', () => {
    const tap = { name: 'tap', title: { de: 'Tippen', en: 'Tap' } }
    expect(issuesOf(sdkManifest({ commands: [tap, tap] }))).toEqual(['commands'])
    const many = Array.from({ length: 33 }, (_, i) => ({ ...tap, name: `tap-${i}` }))
    expect(issuesOf(sdkManifest({ commands: many }))).toEqual(['commands'])
  })

  it('fills a command’s defaults and insists args describe an object', () => {
    const parsed = gamemodeManifestSchema.parse(sdkManifest())
    expect(parsed.commands[0]).toEqual({
      name: 'tap',
      title: { de: 'Tippen', en: 'Tap' },
      cooldownMs: 0,
      charges: null,
    })
    const badArgs = { name: 'tap', title: { de: 'Tippen', en: 'Tap' }, args: { type: 'string' } }
    expect(issuesOf(sdkManifest({ commands: [badArgs] }))).toEqual(['commands.0.args'])
  })

  it('keeps ranked false by construction', () => {
    const ranked = { ...sdkManifest(), ranked: true } as unknown as GamemodeManifestInput
    expect(issuesOf(ranked)).toEqual(['ranked'])
  })

  it('lists every capability once', () => {
    expect([...GAMEMODE_CAPABILITIES].sort()).toEqual(
      Object.keys(sdkManifest().capabilities).sort(),
    )
  })
})

describe('the map allow-list', () => {
  const list = { catalog: ['de_mirage'], workshop: ['3070284539'] }

  it('any allows every well-formed identifier', () => {
    expect(gamemodeAllowsMap('any', 'de_mirage')).toBe(true)
    expect(gamemodeAllowsMap('any', 'workshop/3070284539/de_thera')).toBe(true)
    expect(gamemodeAllowsMap('any', 'De Mirage')).toBe(false)
  })

  it('a list allows its names and its workshop ids only', () => {
    expect(gamemodeAllowsMap(list, 'de_mirage')).toBe(true)
    expect(gamemodeAllowsMap(list, 'de_nuke')).toBe(false)
    expect(gamemodeAllowsMap(list, 'workshop/3070284539/de_thera')).toBe(true)
    expect(gamemodeAllowsMap(list, 'workshop/1/de_thera')).toBe(false)
  })

  it('an empty list does not parse; say any instead', () => {
    expect(issuesOf(sdkManifest({ maps: { catalog: [], workshop: [] } }))).toEqual(['maps'])
  })

  it('has its refusal in the error set', () => {
    expect(MATCH_API_ERROR_CODES).toContain('map_not_allowed')
  })
})

describe('cvars', () => {
  it('are bounded and never a protected one', () => {
    const many = Object.fromEntries(
      Array.from({ length: GAMEMODE_CVARS_MAX + 1 }, (_, i) => [`cvar_${i}`, '1']),
    )
    expect(gamemodeCvarsSchema.safeParse(many).success).toBe(false)
    for (const name of PROTECTED_CVARS)
      expect(gamemodeCvarsSchema.safeParse({ [name]: 'x' }).success, name).toBe(false)
    expect(gamemodeCvarsSchema.safeParse({ Mp_Freezetime: '5' }).success).toBe(false)
    expect(gamemodeCvarsSchema.parse({ mp_freezetime: '5' })).toEqual({ mp_freezetime: '5' })
  })
})

describe('the widget host contract', () => {
  it('is a closed set and parses one message per type', () => {
    const tokens = { '--signal-primary': '#ff5a1f' }
    const messages = {
      'ezpug.widget.ready': { type: 'ezpug.widget.ready', protocol: WIDGET_HOST_PROTOCOL },
      'ezpug.widget.init': {
        type: 'ezpug.widget.init',
        protocol: WIDGET_HOST_PROTOCOL,
        orchestratorUrl: 'https://gs.ezpug.example',
        matchId: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
        locale: 'de',
        tokens,
        playerToken: null,
      },
      'ezpug.widget.tokens': { type: 'ezpug.widget.tokens', tokens },
      'ezpug.widget.size': { type: 'ezpug.widget.size', height: 320 },
      'ezpug.widget.error': { type: 'ezpug.widget.error', message: 'no token' },
    } satisfies Record<
      (typeof WIDGET_HOST_MESSAGE_TYPES)[number],
      z.input<typeof widgetHostMessageSchema>
    >
    for (const type of WIDGET_HOST_MESSAGE_TYPES) {
      expect(widgetHostMessageSchema.parse(messages[type]).type).toBe(type)
    }
    expect(
      widgetHostMessageSchema.safeParse({ type: 'ezpug.widget.ready', protocol: 2 }).success,
    ).toBe(false)
    expect(
      widgetHostMessageSchema.safeParse({ type: 'ezpug.widget.tokens', tokens: { primary: 'x' } })
        .success,
    ).toBe(false)
  })
})

describe('docs/gamemodes.md', () => {
  // The reference the platform loop and the next author read instead of this
  // schema (PRD-01 T10). A field with no row is a field nobody was told about;
  // a value with no mention is a value nobody can act on.
  const docs = readFileSync(new URL('../../../../docs/gamemodes.md', import.meta.url), 'utf8')
  const documents = (name: string) => docs.includes(`\`${name}\``)

  it('has a row for every field of the manifest', () => {
    const fields = [
      ...Object.keys(gamemodeManifestSchema.shape),
      ...Object.keys(gamemodeManifestSchema.shape.slots.shape),
      ...Object.keys(gamemodeManifestSchema.shape.capabilities.shape),
      ...Object.keys(gamemodeWidgetSchema.shape),
      ...Object.keys(playerCommandSpecSchema.shape),
    ]
    for (const field of fields) expect(documents(field), field).toBe(true)
  })

  it('names every value of every closed set the manifest carries', () => {
    const values = [
      ...GAMEMODE_TIERS,
      ...GAMEMODE_FLOWS,
      ...GAMEMODE_RECORDS,
      ...GAMEMODE_CAPABILITIES,
      ...PLAYER_COMMAND_CHARGE_PERIODS,
      ...WIDGET_NEEDS,
      ...PROTECTED_CVARS,
      ...SHIPPED_GAMEMODE_IDS,
    ]
    for (const value of values) expect(documents(value), value).toBe(true)
  })

  it('walks the widget host handshake message by message', () => {
    for (const type of WIDGET_HOST_MESSAGE_TYPES) expect(docs.includes(type), type).toBe(true)
    expect(docs).toContain(`protocol \`${WIDGET_HOST_PROTOCOL}\``)
  })
})
