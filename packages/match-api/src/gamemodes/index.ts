import flyingScoutsman from '@ezpug/gamemodes/flying-scoutsman/manifest.json'
import powerupDm from '@ezpug/gamemodes/powerup-dm/manifest.json'
import pug from '@ezpug/gamemodes/pug/manifest.json'
import retakes from '@ezpug/gamemodes/retakes/manifest.json'
import { type GamemodeManifest, gamemodeManifestSchema } from '../resources/gamemode'

/**
 * **The four manifests this round ships** (decision 15), read from
 * `gamemodes/<id>/manifest.json` at the repo root (`@ezpug/gamemodes`, data
 * only) — the files are the source, PRD-02 builds what they name, and the
 * published bundle inlines them so a
 * consumer holds the same catalog the orchestrator serves. Parsed through the
 * schema here so the defaults are filled and a manifest that stops parsing
 * fails every import, not one request.
 *
 * `pug` is the queue's mode and the first entry; the rest are the tier
 * proofs in decision 15's order.
 */
export const SHIPPED_GAMEMODES: readonly GamemodeManifest[] = [
  pug,
  flyingScoutsman,
  retakes,
  powerupDm,
].map(manifest => gamemodeManifestSchema.parse(manifest))

/** The shipped ids, in catalog order. */
export const SHIPPED_GAMEMODE_IDS = ['pug', 'flying-scoutsman', 'retakes', 'powerup-dm'] as const
export type ShippedGamemodeId = (typeof SHIPPED_GAMEMODE_IDS)[number]

/** One shipped manifest by id. */
export function shippedGamemode(id: ShippedGamemodeId): GamemodeManifest {
  const manifest = SHIPPED_GAMEMODES.find(candidate => candidate.id === id)
  if (!manifest) throw new Error(`no shipped gamemode ${id}`)
  return manifest
}
