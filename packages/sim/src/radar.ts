/**
 * **Radar calibration per official map**, as data under `fixtures/radar/`:
 * the image and the three numbers that turn an engine position into a pixel
 * on it. Copied from the platform's map catalog reference table on
 * 2026-09-05, which read them off Valve's own overview files
 * (`game/csgo/resource/overviews/<map>.txt`: `pos_x`, `pos_y`, `scale`, and
 * `verticalsections` for a two-storey map). The images are the platform's to
 * serve (`/radar/<map>.png`); only the geometry is here.
 *
 * It buys exactly one thing: a simulated match's position ticks land on the
 * picture a spectator is looking at. A map without an entry — a workshop map,
 * anything not Active Duty — still plays; its positions wander in world units
 * nobody calibrated, which is what a map without radar data looks like anyway.
 */
import type { MapRadar } from '@ezpug/match-api'
import { mapRadarSchema } from '@ezpug/match-api'
import deAncient from '../fixtures/radar/de_ancient.json'
import deAnubis from '../fixtures/radar/de_anubis.json'
import deDust2 from '../fixtures/radar/de_dust2.json'
import deInferno from '../fixtures/radar/de_inferno.json'
import deMirage from '../fixtures/radar/de_mirage.json'
import deNuke from '../fixtures/radar/de_nuke.json'
import deOverpass from '../fixtures/radar/de_overpass.json'
import deTrain from '../fixtures/radar/de_train.json'
import deVertigo from '../fixtures/radar/de_vertigo.json'

/** Every stock overview is a 1024-pixel square. */
export const RADAR_IMAGE_SIZE = 1024

/** The maps the fixture set calibrates, keyed by engine name. */
export const SIM_RADARS: Readonly<Record<string, MapRadar>> = Object.freeze({
  de_ancient: mapRadarSchema.parse(deAncient),
  de_anubis: mapRadarSchema.parse(deAnubis),
  de_dust2: mapRadarSchema.parse(deDust2),
  de_inferno: mapRadarSchema.parse(deInferno),
  de_mirage: mapRadarSchema.parse(deMirage),
  de_nuke: mapRadarSchema.parse(deNuke),
  de_overpass: mapRadarSchema.parse(deOverpass),
  de_train: mapRadarSchema.parse(deTrain),
  de_vertigo: mapRadarSchema.parse(deVertigo),
})

/**
 * The radar for a map identifier, or null: still playable, positions
 * uncalibrated. A `workshop/<id>/<name>` identifier is never calibrated here.
 */
export function simRadarFor(map: string): MapRadar | null {
  return Object.hasOwn(SIM_RADARS, map) ? (SIM_RADARS[map] ?? null) : null
}
