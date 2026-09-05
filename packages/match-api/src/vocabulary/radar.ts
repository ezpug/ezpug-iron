import { z } from 'zod'

/**
 * **Radar metadata** — what turns a `position_tick`'s world coordinates into a
 * dot on a minimap image. The platform's `map-pools.ts` shapes, verbatim: the
 * simulator engine (`packages/sim`) reads a map's radar to put positions on
 * real overview coordinates, and a live page draws them with the same three
 * numbers CS's own overview files carry. The image itself is data the serving
 * side owns; only its geometry is contract.
 */

/**
 * One radar layer: the image plus the three numbers CS's own overview data
 * uses — the world coordinate of the image's top-left corner and how many
 * world units one image pixel covers.
 *
 * `zMin`/`zMax` are the multi-level answer (Nuke's lower bombsite, Vertigo's
 * ground floor): a position belongs to the layer whose Z range contains it,
 * and a single-level map is one layer with no bounds.
 */
export const mapRadarLayerSchema = z.object({
  /** Layer name as the game files call it — `default`, `lower`. */
  name: z.string().min(1).max(32),
  /** The radar image, as a URL the serving side owns. Never a hotlink. */
  imageUrl: z.string().min(1),
  /** World X of the image's left edge (`pos_x` in an overview file). */
  posX: z.number(),
  /** World Y of the image's top edge (`pos_y`). */
  posY: z.number(),
  /** World units per image pixel (`scale`). Positive. */
  scale: z.number().positive(),
  /** Square image edge, in pixels — 1024 for every stock overview. */
  size: z.number().int().positive(),
  /** Inclusive lower Z bound, or null for "everything below `zMax`". */
  zMin: z.number().nullable().default(null),
  /** Exclusive upper Z bound, or null for "everything above `zMin`". */
  zMax: z.number().nullable().default(null),
})
export type MapRadarLayer = z.infer<typeof mapRadarLayerSchema>

/** A map's radar assets: at least one layer, ordered top floor first. */
export const mapRadarSchema = z.object({
  layers: z.array(mapRadarLayerSchema).min(1),
})
export type MapRadar = z.infer<typeof mapRadarSchema>

/** A world position as the gameserver's position ticks report it. */
export interface WorldPosition {
  x: number
  y: number
  z: number
}

/** The same position as a wire schema. */
export const worldPositionSchema: z.ZodType<WorldPosition> = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
})
