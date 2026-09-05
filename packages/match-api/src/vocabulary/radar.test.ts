import { describe, expect, it } from 'vitest'
import {
  type MapRadar,
  mapRadarSchema,
  radarHeading,
  radarLayerFor,
  radarLayerNamed,
  radarToWorld,
  worldToRadar,
} from './radar'

/** Nuke's own overview numbers: two floors over one footprint, split at z = -495. */
const NUKE: MapRadar = {
  layers: [
    {
      name: 'default',
      imageUrl: '/radar/de_nuke.png',
      posX: -3453,
      posY: 2887,
      scale: 7,
      size: 1024,
      zMin: -495,
      zMax: null,
    },
    {
      name: 'lower',
      imageUrl: '/radar/de_nuke_lower.png',
      posX: -3453,
      posY: 2887,
      scale: 7,
      size: 1024,
      zMin: null,
      zMax: -495,
    },
  ],
}

describe('the radar transforms', () => {
  it('parses a layered radar and picks the layer by altitude, top floor first', () => {
    expect(mapRadarSchema.parse(NUKE)).toEqual(NUKE)
    expect(radarLayerFor(NUKE, 0).name).toBe('default')
    // The boundary belongs to the upper floor: zMin inclusive, zMax exclusive.
    expect(radarLayerFor(NUKE, -495).name).toBe('default')
    expect(radarLayerFor(NUKE, -496).name).toBe('lower')
    expect(radarLayerNamed(NUKE, 'lower')?.imageUrl).toBe('/radar/de_nuke_lower.png')
    expect(radarLayerNamed(NUKE, 'roof')).toBeNull()
  })

  it('puts the top-left world corner on pixel (0, 0) and grows y downwards', () => {
    expect(worldToRadar(NUKE, { x: -3453, y: 2887, z: 0 })).toEqual({
      layer: 'default',
      x: 0,
      y: 0,
    })
    const point = worldToRadar(NUKE, { x: -3453 + 700, y: 2887 - 1400, z: -600 })
    expect(point).toEqual({ layer: 'lower', x: 100, y: 200 })
  })

  it('round-trips image → world → image', () => {
    const layer = NUKE.layers[0] as MapRadar['layers'][number]
    const world = radarToWorld(layer, { x: 512, y: 384 })
    expect(worldToRadar(NUKE, { ...world, z: 0 })).toEqual({ layer: 'default', x: 512, y: 384 })
  })

  it('turns a yaw into an image heading: east is 0, north points up', () => {
    expect(radarHeading(0)).toBeCloseTo(0)
    expect(radarHeading(90)).toBeCloseTo(-Math.PI / 2)
  })
})
