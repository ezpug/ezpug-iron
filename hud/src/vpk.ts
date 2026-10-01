/**
 * **Valve Pak, version 2, one file** (PRD-07 T1): the shape a Workshop addon
 * reaches a client in. MultiAddonManager mounts `<id>/<id>.vpk` (or the
 * multi-chunk `<id>_dir.vpk`, `src/multiaddonmanager.cpp:425`), so the pack is
 * one file with every entry's data after the tree (archive index `0x7fff`).
 *
 * Neither Windows depot ships Valve's `vpk.exe`, so this writes the format
 * itself, after `cs2-workshop-publisher`'s `vpk.py` (MIT): the header, the tree
 * grouped by extension then directory, the data, and the three MD5s of the
 * "other" section (tree, archive-hash section, whole file). There is no
 * signature section; Valve's own packs carry one, and whether a client wants
 * one for an addon is on the look list (docs/hud.md). Deterministic: the same
 * files in give the same bytes out, so the committed pack can be checked.
 */
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'

const SIGNATURE = 0x55aa1234
const EMBEDDED = 0x7fff
const TERMINATOR = 0xffff
const HEADER_BYTES = 28
const OTHER_MD5_BYTES = 48

export interface VpkFile {
  /** The path inside the pack, `/`-separated and lower case (`panorama/layout/custom_game/x.vxml_c`). */
  path: string
  data: Buffer
}

export interface VpkEntry {
  path: string
  crc32: number
  data: Buffer
}

const md5 = (data: Buffer) => createHash('md5').update(data).digest()

function split(path: string): { dir: string; name: string; ext: string } {
  const slash = path.lastIndexOf('/')
  const dir = slash < 0 ? ' ' : path.slice(0, slash)
  const file = path.slice(slash + 1)
  const dot = file.lastIndexOf('.')
  return dot < 0
    ? { dir, name: file, ext: ' ' }
    : { dir, name: file.slice(0, dot), ext: file.slice(dot + 1) || ' ' }
}

function checkPath(path: string) {
  if (path !== path.toLowerCase()) throw new Error(`vpk: ${path} is not lower case`)
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some(p => p === '' || p === '..')
  )
    throw new Error(`vpk: ${path} is not a clean relative path`)
}

/** The bytes of a single-file VPK v2 holding `files`, sorted by path. */
export function writeVpk(files: VpkFile[]): Buffer {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const [i, file] of sorted.entries()) {
    checkPath(file.path)
    if (i > 0 && sorted[i - 1]!.path === file.path) throw new Error(`vpk: ${file.path} twice`)
  }
  const offsets = new Map<string, number>()
  let offset = 0
  for (const file of sorted) {
    offsets.set(file.path, offset)
    offset += file.data.length
  }
  // ext → dir → [name, file]; insertion order is the sorted order of the paths.
  const grouped = new Map<string, Map<string, [string, VpkFile][]>>()
  for (const file of sorted) {
    const { dir, name, ext } = split(file.path)
    const dirs = grouped.get(ext) ?? new Map<string, [string, VpkFile][]>()
    grouped.set(ext, dirs)
    dirs.set(dir, [...(dirs.get(dir) ?? []), [name, file]])
  }
  const parts: Buffer[] = []
  const cstring = (s: string) => parts.push(Buffer.from(`${s}\0`, 'utf8'))
  for (const [ext, dirs] of grouped) {
    cstring(ext)
    for (const [dir, names] of dirs) {
      cstring(dir)
      for (const [name, file] of names) {
        cstring(name)
        const entry = Buffer.alloc(18)
        entry.writeUInt32LE(crc32(file.data), 0)
        entry.writeUInt16LE(0, 4) // preload bytes
        entry.writeUInt16LE(EMBEDDED, 6)
        entry.writeUInt32LE(offsets.get(file.path)!, 8)
        entry.writeUInt32LE(file.data.length, 12)
        entry.writeUInt16LE(TERMINATOR, 16)
        parts.push(entry)
      }
      cstring('')
    }
    cstring('')
  }
  cstring('')
  const tree = Buffer.concat(parts)
  const data = Buffer.concat(sorted.map(f => f.data))
  const archiveSection = Buffer.alloc(0)
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32LE(SIGNATURE, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(tree.length, 8)
  header.writeUInt32LE(data.length, 12)
  header.writeUInt32LE(archiveSection.length, 16)
  header.writeUInt32LE(OTHER_MD5_BYTES, 20)
  header.writeUInt32LE(0, 24) // signature section
  const body = Buffer.concat([header, tree, data, archiveSection, md5(tree), md5(archiveSection)])
  return Buffer.concat([body, md5(body)])
}

/** Every entry of a single-file VPK v2, checked: CRCs and the three MD5s. */
export function readVpk(pack: Buffer): VpkEntry[] {
  if (pack.length < HEADER_BYTES || pack.readUInt32LE(0) !== SIGNATURE)
    throw new Error('vpk: bad signature')
  if (pack.readUInt32LE(4) !== 2) throw new Error(`vpk: version ${pack.readUInt32LE(4)}, not 2`)
  const treeSize = pack.readUInt32LE(8)
  const dataSize = pack.readUInt32LE(12)
  const archiveSize = pack.readUInt32LE(16)
  const otherSize = pack.readUInt32LE(20)
  const signatureSize = pack.readUInt32LE(24)
  const dataStart = HEADER_BYTES + treeSize
  const archiveStart = dataStart + dataSize
  const otherStart = archiveStart + archiveSize
  if (otherSize !== OTHER_MD5_BYTES || otherStart + otherSize + signatureSize !== pack.length)
    throw new Error('vpk: section sizes do not add up to the file')
  const tree = pack.subarray(HEADER_BYTES, dataStart)
  const other = pack.subarray(otherStart, otherStart + otherSize)
  if (!md5(tree).equals(other.subarray(0, 16))) throw new Error('vpk: tree checksum mismatch')
  if (!md5(pack.subarray(archiveStart, otherStart)).equals(other.subarray(16, 32)))
    throw new Error('vpk: archive section checksum mismatch')
  if (!md5(pack.subarray(0, otherStart + 32)).equals(other.subarray(32, 48)))
    throw new Error('vpk: whole-file checksum mismatch')

  let at = 0
  const cstring = () => {
    const end = tree.indexOf(0, at)
    if (end < 0) throw new Error('vpk: unterminated string in the tree')
    const s = tree.subarray(at, end).toString('utf8')
    at = end + 1
    return s
  }
  const entries: VpkEntry[] = []
  for (let ext = cstring(); ext !== ''; ext = cstring()) {
    for (let dir = cstring(); dir !== ''; dir = cstring()) {
      for (let name = cstring(); name !== ''; name = cstring()) {
        const crc = tree.readUInt32LE(at)
        const preload = tree.readUInt16LE(at + 4)
        const archive = tree.readUInt16LE(at + 6)
        const offset = tree.readUInt32LE(at + 8)
        const length = tree.readUInt32LE(at + 12)
        if (tree.readUInt16LE(at + 16) !== TERMINATOR) throw new Error('vpk: bad entry terminator')
        if (archive !== EMBEDDED) throw new Error(`vpk: archive ${archive} in a single-file pack`)
        const preloaded = tree.subarray(at + 18, at + 18 + preload)
        at += 18 + preload
        const path = `${dir === ' ' ? '' : `${dir}/`}${name}${ext === ' ' ? '' : `.${ext}`}`
        const data = Buffer.concat([
          preloaded,
          pack.subarray(dataStart + offset, dataStart + offset + length),
        ])
        if (crc32(data) !== crc) throw new Error(`vpk: ${path} fails its CRC`)
        entries.push({ path, crc32: crc, data })
      }
    }
  }
  return entries
}
