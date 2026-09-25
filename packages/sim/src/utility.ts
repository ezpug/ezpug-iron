/**
 * **The utility a simulated round throws** (ezpug/ezpug-iron#5): the smokes,
 * flashes, HEs and fires on the live tier's `position_tick`, and where the
 * bomb is. The platform's dev world then draws a utility layer off the
 * simulator the way it will off a real server.
 *
 * Every die here is drawn from a fork of its own, one per round. The story's
 * stream never sees them, so a seed plays the same kills, rounds and winner as
 * it did before the simulator threw anything.
 */
import type { Prng } from '@ezpug/core'
import type { GrenadeKind, LiveBomb, LiveGrenade, TeamSide } from '@ezpug/match-api'

/** How long a smoke stands once it blooms. CS2's is about eighteen seconds. */
export const SIM_SMOKE_MS = 18_000
/** How long a fire burns. CS2's molotov burns about seven seconds. */
export const SIM_FIRE_MS = 7_000
/** How far a smoke reaches from its centre, in world units, as the plugin reports it. */
export const SIM_SMOKE_RADIUS = 144
/** How far a simulated fire reaches, in world units. */
export const SIM_FIRE_RADIUS = 150

/** One throw, planned before the round's ticks are sampled. */
export interface PlannedThrow {
  id: string
  kind: GrenadeKind
  /** The thrower's steamId64. */
  thrower: string
  throwAtMs: number
  flightMs: number
  /** Where it lands, from where it was thrown, in world units. */
  dx: number
  dy: number
}

/** A throw in flight or gone off, with its two ends fixed at the first tick it was seen. */
interface LiveThrow extends PlannedThrow {
  from: { x: number; y: number; z: number }
}

/**
 * The throws of one round. Each side throws a smoke or two, and sometimes a
 * flash, an HE and a fire (a molotov from the Ts, an incendiary from the CTs),
 * each by somebody on that side who is still alive when it leaves their hand.
 */
export function planRoundUtility(options: {
  prng: Prng
  idPrefix: string
  sides: { side: TeamSide; players: string[] }[]
  endMs: number
  aliveAt: (steamId64: string, atMs: number) => boolean
}): PlannedThrow[] {
  const { prng, idPrefix, endMs } = options
  const throws: PlannedThrow[] = []
  // Nothing leaves a hand in freeze time's first seconds or the round's last two.
  const latest = Math.min(endMs - 2_000, 70_000)
  if (latest <= 3_000) return throws
  for (const { side, players } of options.sides) {
    if (players.length === 0) continue
    const kinds: GrenadeKind[] = ['smoke']
    if (prng.bool(0.6)) kinds.push('smoke')
    if (prng.bool(0.5)) kinds.push('flash')
    if (prng.bool(0.3)) kinds.push('he')
    if (prng.bool(0.4)) kinds.push(side === 't' ? 'molotov' : 'incendiary')
    if (prng.bool(0.05)) kinds.push('decoy')
    for (const kind of kinds) {
      const throwAtMs = prng.int(3_000, latest + 1)
      const alive = players.filter(steamId64 => options.aliveAt(steamId64, throwAtMs))
      const angle = prng.next() * 2 * Math.PI
      const distance = prng.int(250, 701)
      const flightMs = prng.int(900, 2_001)
      if (alive.length === 0) continue
      throws.push({
        id: `${idPrefix}-${throws.length + 1}`,
        kind,
        thrower: prng.pick(alive),
        throwAtMs,
        flightMs,
        dx: Math.round(Math.cos(angle) * distance),
        dy: Math.round(Math.sin(angle) * distance),
      })
    }
  }
  return throws.sort((a, b) => a.throwAtMs - b.throwAtMs)
}

/**
 * What a round's utility looks like tick by tick. `sample` is called once per
 * tick in time order, with where every player stands at that instant (a dead
 * player where they fell), and answers the grenades flying or active then.
 */
export function utilitySampler(
  throws: readonly PlannedThrow[],
  tickMs: number,
): (
  atMs: number,
  positionOf: (steamId64: string) => LiveThrow['from'] | undefined,
) => LiveGrenade[] {
  const live = new Map<string, LiveThrow>()
  let next = 0
  return (atMs, positionOf) => {
    while (next < throws.length && (throws[next] as PlannedThrow).throwAtMs <= atMs) {
      const planned = throws[next] as PlannedThrow
      next++
      const from = positionOf(planned.thrower)
      if (from) live.set(planned.id, { ...planned, from })
    }
    const grenades: LiveGrenade[] = []
    for (const [id, grenade] of live) {
      const since = atMs - grenade.throwAtMs
      const landing = {
        x: grenade.from.x + grenade.dx,
        y: grenade.from.y + grenade.dy,
        z: grenade.from.z,
      }
      const base = { id, kind: grenade.kind, steamId64: grenade.thrower }
      if (since < grenade.flightMs) {
        const t = since / grenade.flightMs
        grenades.push({
          ...base,
          x: grenade.from.x + grenade.dx * t,
          y: grenade.from.y + grenade.dy * t,
          // An arc, so a renderer that reads height sees one.
          z: grenade.from.z + Math.round(4 * 120 * t * (1 - t)),
          state: 'flying',
        })
        continue
      }
      const activeMs =
        grenade.kind === 'smoke'
          ? SIM_SMOKE_MS
          : grenade.kind === 'molotov' || grenade.kind === 'incendiary'
            ? SIM_FIRE_MS
            : // A flash, an HE, a decoy: one tick where it went off, then gone.
              tickMs
      if (since >= grenade.flightMs + activeMs) {
        live.delete(id)
        continue
      }
      const radius =
        grenade.kind === 'smoke'
          ? SIM_SMOKE_RADIUS
          : grenade.kind === 'molotov' || grenade.kind === 'incendiary'
            ? SIM_FIRE_RADIUS
            : undefined
      grenades.push({
        ...base,
        ...landing,
        state: 'active',
        ...(radius !== undefined ? { radius } : {}),
      })
    }
    return grenades
  }
}

/**
 * Where the bomb is at `atMs`: on its carrier until they plant it or die, on
 * the floor where the carrier fell, in its site from the plant until it goes
 * off or is defused, and nowhere after that.
 */
export function bombAt(options: {
  atMs: number
  carrier: string | undefined
  carrierDiedAtMs: number
  plant: { atMs: number; resolveAtMs: number; site: 'a' | 'b' } | undefined
  plantedAt: LiveThrow['from'] | undefined
  positionOf: (steamId64: string) => LiveThrow['from'] | undefined
}): LiveBomb | undefined {
  const { atMs, carrier, plant } = options
  if (plant && atMs >= plant.resolveAtMs) return undefined
  if (plant && atMs >= plant.atMs && options.plantedAt)
    return { state: 'planted', ...options.plantedAt, site: plant.site }
  if (carrier === undefined) return undefined
  const at = options.positionOf(carrier)
  if (!at) return undefined
  return atMs < options.carrierDiedAtMs
    ? { state: 'carried', ...at, steamId64: carrier }
    : { state: 'dropped', ...at }
}
