import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readVpk, writeVpk } from '../src/vpk.ts'

const files = [
  { path: 'panorama/styles/custom_game/b.vcss_c', data: Buffer.from('style') },
  { path: 'panorama/layout/custom_game/a.vxml_c', data: Buffer.from('layout') },
  { path: 'panorama/images/custom_game/ezpug/cast/hello.vtex_c', data: Buffer.alloc(4096, 7) },
  { path: 'addoninfo.txt', data: Buffer.from('"AddonInfo" {}') },
  { path: 'readme', data: Buffer.from('no extension') },
]

describe('the VPK writer', () => {
  it('reads back every file, byte for byte, with its CRC', () => {
    const entries = readVpk(writeVpk(files))
    expect(entries.map(e => e.path).sort()).toEqual(files.map(f => f.path).sort())
    for (const file of files) {
      const entry = entries.find(e => e.path === file.path)!
      expect(entry.data.equals(file.data)).toBe(true)
      expect(entry.crc32).toBe(crc32(file.data))
    }
  })

  it('writes the same bytes for the same files in any order', () => {
    expect(writeVpk(files).equals(writeVpk([...files].reverse()))).toBe(true)
  })

  it('is a version 2 pack with a 48-byte checksum section and no signature', () => {
    const pack = writeVpk(files)
    expect(pack.readUInt32LE(0)).toBe(0x55aa1234)
    expect(pack.readUInt32LE(4)).toBe(2)
    expect(pack.readUInt32LE(20)).toBe(48)
    expect(pack.readUInt32LE(24)).toBe(0)
  })

  it('refuses a byte changed anywhere', () => {
    const pack = writeVpk(files)
    for (const at of [40, pack.length - 600, pack.length - 1]) {
      const broken = Buffer.from(pack)
      broken[at] = broken[at]! ^ 0xff
      expect(() => readVpk(broken)).toThrow(/checksum|CRC|terminator|unterminated/)
    }
  })

  it('refuses a path a VPK cannot hold', () => {
    expect(() => writeVpk([{ path: 'Panorama/x.vxml_c', data: Buffer.alloc(1) }])).toThrow(
      /lower case/,
    )
    expect(() => writeVpk([{ path: '../x.vxml_c', data: Buffer.alloc(1) }])).toThrow(/clean/)
    expect(() => writeVpk([files[0]!, files[0]!])).toThrow(/twice/)
  })
})
