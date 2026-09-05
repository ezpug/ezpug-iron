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

/** A point on a radar image, in pixels from its top-left corner. */
export interface RadarPoint {
  layer: string
  x: number
  y: number
}

/**
 * Which layer a world position belongs to: the first whose Z range contains
 * `z`, else the last layer (the ground floor is the catch-all). Layers are
 * ordered top floor first.
 */
export function radarLayerFor(radar: MapRadar, z: number): MapRadarLayer {
  const layers = radar.layers
  const found = layers.find(
    layer => (layer.zMin === null || z >= layer.zMin) && (layer.zMax === null || z < layer.zMax),
  )
  return found ?? (layers[layers.length - 1] as MapRadarLayer)
}

/**
 * World → image. The transform every minimap and every 2D replay frame runs,
 * living here rather than in whichever surface drew a dot first: `x` grows
 * right and `y` grows *down* on the image, which is the sign flip everyone
 * gets wrong once. The platform's `map-pools.ts`, verbatim.
 */
export function worldToRadar(radar: MapRadar, position: WorldPosition): RadarPoint {
  const layer = radarLayerFor(radar, position.z)
  return {
    layer: layer.name,
    x: (position.x - layer.posX) / layer.scale,
    y: (layer.posY - position.y) / layer.scale,
  }
}

/**
 * The layer a name refers to, or null. A renderer showing the lower floor of
 * Nuke asks for `lower`; a point projected by {@link worldToRadar} names the
 * layer it landed on, and this is how a surface gets the image behind it.
 */
export function radarLayerNamed(radar: MapRadar, name: string): MapRadarLayer | null {
  return radar.layers.find(layer => layer.name === name) ?? null
}

/**
 * Where a player is looking, on the image. The engine's `yaw` is degrees
 * counter-clockwise from world +X (0 faces east, 90 faces north = world +Y);
 * the image's y grows *down*, so the same turn is clockwise on the picture —
 * the second sign flip everyone gets wrong once, sitting beside the first. The
 * result is radians in image space, ready for `Math.cos`/`Math.sin` on the
 * pixel axes: 0 points right, `-π/2` points up.
 */
export function radarHeading(yawDegrees: number): number {
  return (-yawDegrees * Math.PI) / 180
}

/** Image → world, at a given Z. The inverse of {@link worldToRadar}. */
export function radarToWorld(
  layer: MapRadarLayer,
  point: { x: number; y: number },
): {
  x: number
  y: number
} {
  return { x: layer.posX + point.x * layer.scale, y: layer.posY - point.y * layer.scale }
}
