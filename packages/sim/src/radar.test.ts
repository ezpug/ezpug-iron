import { mapRadarSchema, worldToRadar } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { RADAR_IMAGE_SIZE, SIM_RADARS, simRadarFor } from './radar'

describe('the radar fixture set', () => {
  it('calibrates the Active Duty maps, every layer parsing against the vocabulary', () => {
    const names = Object.keys(SIM_RADARS).sort()
    expect(names).toEqual([
      'de_ancient',
      'de_anubis',
      'de_dust2',
      'de_inferno',
      'de_mirage',
      'de_nuke',
      'de_overpass',
      'de_train',
      'de_vertigo',
    ])
    for (const radar of Object.values(SIM_RADARS)) {
      expect(mapRadarSchema.parse(radar)).toEqual(radar)
      for (const layer of radar.layers) {
        expect(layer.size).toBe(RADAR_IMAGE_SIZE)
        expect(layer.imageUrl).toMatch(/^\/radar\/de_[a-z0-9_]+\.png$/)
      }
    }
  })

  it('carries two storeys for the two-storey maps, top floor first, one footprint', () => {
    for (const name of ['de_nuke', 'de_train', 'de_vertigo']) {
      const radar = simRadarFor(name)
      expect(radar?.layers.map(layer => layer.name)).toEqual(['default', 'lower'])
      const [upper, lower] = radar?.layers ?? []
      expect(upper?.zMin).toBe(lower?.zMax)
      expect(upper?.posX).toBe(lower?.posX)
      expect(upper?.scale).toBe(lower?.scale)
    }
    for (const name of ['de_mirage', 'de_dust2', 'de_inferno', 'de_ancient', 'de_anubis']) {
      expect(simRadarFor(name)?.layers).toHaveLength(1)
    }
  })

  it('answers null for a map nobody calibrated — a workshop map still plays', () => {
    expect(simRadarFor('workshop/3070288000/de_cache')).toBeNull()
    expect(simRadarFor('de_cache')).toBeNull()
    expect(simRadarFor('constructor')).toBeNull()
  })

  it("puts Mirage's own top-left corner on pixel (0, 0)", () => {
    const mirage = simRadarFor('de_mirage')
    if (!mirage) throw new Error('unreachable')
    expect(worldToRadar(mirage, { x: -3230, y: 1713, z: 0 })).toEqual({
      layer: 'default',
      x: 0,
      y: 0,
    })
  })
})
