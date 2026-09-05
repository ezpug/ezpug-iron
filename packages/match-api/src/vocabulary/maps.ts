import { z } from 'zod'

/**
 * **How a map is named on the wire** — the platform's `map-pools.ts` grammar
 * on 2026-09-05, verbatim: the engine name for an official map (`de_mirage`),
 * `workshop/<id>/<name>` for a Workshop one. It is the string a match plan
 * pins (`MatchRequest.maps[].map`), the string MatchZy and Get5 both take, and
 * the string a gamemode manifest allows or refuses. The platform's *catalog*
 * (display names, artwork, pools) stays on the platform; only the identifier
 * crosses.
 */

/** A Steam Workshop published-file id: a positive decimal integer. */
export const workshopIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,19}$/, 'a workshop id is a positive decimal integer')
export type WorkshopId = z.infer<typeof workshopIdSchema>

/** An official map's engine name: `de_mirage`, `cs_office`, `ar_baggage`. */
export const mapNameSchema = z
  .string()
  .regex(/^[a-z0-9_]+$/, 'a map name is the engine name (e.g. `de_mirage`)')
export type MapName = z.infer<typeof mapNameSchema>

/**
 * The string a match config pins and a match record keeps: the engine name for
 * an official map, `workshop/<id>/<name>` for a workshop one.
 */
export const mapIdentifierSchema = z
  .string()
  .regex(
    /^(?:[a-z0-9_]+|workshop\/[1-9]\d{0,19}\/[a-z0-9_]+)$/,
    'a map identifier is an engine name or `workshop/<id>/<name>`',
  )
export type MapIdentifier = z.infer<typeof mapIdentifierSchema>

/** Where a map comes from, parsed out of its identifier. */
export type MapSource =
  | { kind: 'official'; name: MapName }
  | { kind: 'workshop'; workshopId: WorkshopId; name: MapName }

/** {@link MapSource} → the wire string. Inverse of {@link parseMapIdentifier}. */
export function mapIdentifier(source: MapSource): MapIdentifier {
  return source.kind === 'official' ? source.name : `workshop/${source.workshopId}/${source.name}`
}

/** The wire string → {@link MapSource}. Inverse of {@link mapIdentifier}. */
export function parseMapIdentifier(identifier: string): MapSource {
  const value = mapIdentifierSchema.parse(identifier)
  const workshop = value.match(/^workshop\/([1-9]\d{0,19})\/([a-z0-9_]+)$/)
  return workshop
    ? { kind: 'workshop', workshopId: workshop[1] as string, name: workshop[2] as string }
    : { kind: 'official', name: value }
}
