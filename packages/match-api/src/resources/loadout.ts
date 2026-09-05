import { z } from 'zod'
import type { teamSideSchema } from '../vocabulary/gameserver'

/**
 * **A player's cosmetics, as the server applies them** (decision 20). The
 * platform owns loadouts; a roster entry carries one; the core plugin hands it
 * to the data-layer fork of cs2-WeaponPaints in memory instead of the fork
 * querying MySQL. So this schema mirrors the fork's own tables
 * (`references/cs2-WeaponPaints/Utility.cs`: `wp_player_skins`,
 * `wp_player_knife`, `wp_player_gloves`, `wp_player_agents`,
 * `wp_player_music`, `wp_player_pins`) field for field, and the fork's data
 * layer is a mapping, not an interpretation:
 *
 * - `wp_player_skins` keys on `(steamid, weapon_team, weapon_defindex)`; here a
 *   weapon skin sits under its side, and `defindex` is the key within it.
 * - a sticker row is the string `id;schema;x;y;wear;scale;rotation`, five slots
 *   (`weapon_sticker_0..4`); here it is one object per occupied slot.
 * - a keychain is `id;x;y;z;seed`.
 * - the knife is a model name per side (`wp_player_knife.knife`); its finish
 *   is a `wp_player_skins` row for the knife's defindex, so it lives in
 *   `weapons` like any other.
 * - gloves are a defindex per side; agents are one model per side; music kit
 *   and pin are one id per side.
 *
 * The bounds are the platform's Skins.md §2 where it decided one (a name tag is
 * clamped to 32 characters; the StatTrak counter is displayed, never
 * hand-edited — so it travels but the plugin owns the increment). Everything is
 * optional: a player who never opened the skins page has a plain loadout, and
 * absence means default, exactly as an absent row does in the fork.
 */

/** One sticker on one weapon — `id;schema;x;y;wear;scale;rotation` in the fork. */
export const stickerSchema = z.object({
  id: z.number().int().nonnegative(),
  schema: z.number().int().nonnegative().default(0),
  x: z.number().default(0),
  y: z.number().default(0),
  wear: z.number().min(0).max(1).default(0),
  scale: z.number().default(1),
  rotation: z.number().default(0),
})
export type Sticker = z.infer<typeof stickerSchema>

/** How many sticker slots a weapon has (`weapon_sticker_0..4`). */
export const STICKER_SLOTS = 5

/** A keychain on a weapon — `id;x;y;z;seed` in the fork. */
export const keychainSchema = z.object({
  id: z.number().int().nonnegative(),
  x: z.number().default(0),
  y: z.number().default(0),
  z: z.number().default(0),
  seed: z.number().int().nonnegative().default(0),
})
export type Keychain = z.infer<typeof keychainSchema>

/** The longest name tag the platform lets a player type (Skins.md §2). */
export const NAME_TAG_MAX = 32

/** One `wp_player_skins` row: a finish on a weapon, for one side. */
export const weaponSkinSchema = z.object({
  /** The weapon's item definition index (`weapon_defindex`). */
  defindex: z.number().int().positive(),
  /** The paint kit (`weapon_paint_id`). */
  paintId: z.number().int().nonnegative(),
  /** Float value (`weapon_wear`); the fork's default is the factory-new floor. */
  wear: z.number().min(0).max(1).default(0.000001),
  /** Pattern seed (`weapon_seed`). */
  seed: z.number().int().nonnegative().default(0),
  nametag: z.string().max(NAME_TAG_MAX).optional(),
  stattrak: z.boolean().default(false),
  /** Displayed, never hand-edited: the plugin increments it in-game. */
  stattrakCount: z.number().int().nonnegative().default(0),
  /** Occupied sticker slots in order; an absent slot is empty. */
  stickers: z.array(stickerSchema).max(STICKER_SLOTS).default([]),
  keychain: keychainSchema.optional(),
})
export type WeaponSkin = z.infer<typeof weaponSkinSchema>

/** Everything one side of a player's loadout holds. */
export const sideLoadoutSchema = z.object({
  weapons: z
    .array(weaponSkinSchema)
    .default([])
    .refine(
      weapons => new Set(weapons.map(weapon => weapon.defindex)).size === weapons.length,
      'a weapon defindex appears twice on one side',
    ),
  /** Knife model (`wp_player_knife.knife`, e.g. `weapon_knife_karambit`). */
  knife: z.string().min(1).max(64).optional(),
  /** Glove item defindex (`wp_player_gloves.weapon_defindex`). */
  gloves: z.number().int().positive().optional(),
  /** Agent model (`wp_player_agents.agent_t` / `agent_ct`). */
  agent: z.string().min(1).max(64).optional(),
  /** Music kit id (`wp_player_music.music_id`). */
  music: z.number().int().positive().optional(),
  /** Pin id (`wp_player_pins.id`). */
  pin: z.number().int().positive().optional(),
})
export type SideLoadout = z.infer<typeof sideLoadoutSchema>

/** A player's loadout: one block per side. Absent side = defaults. */
export const loadoutSchema = z.object({
  t: sideLoadoutSchema.optional(),
  ct: sideLoadoutSchema.optional(),
})
export type Loadout = z.infer<typeof loadoutSchema>

/**
 * The fork's `weapon_team` integer for a side — CS2's own team numbers, the
 * one place the mapping is written down.
 */
export const LOADOUT_SIDE_TEAM_NUMBER: Readonly<Record<z.infer<typeof teamSideSchema>, number>> =
  Object.freeze({ t: 2, ct: 3 })
