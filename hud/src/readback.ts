/**
 * **Reading the compiled addon back** (PRD-07 T1): proof that what the
 * compiler wrote is what `hud/` says, read by a decoder that is not Valve's.
 * ValveResourceFormat's CLI, the release the platform's asset scripts pin
 * (`/root/ezpug/scripts/valve-tools.mjs`, `references/radar-overviews.md`),
 * fetched once into the OS temp dir and checked against its sha-256;
 * `EZPUG_VRF_CLI` points at one you already have.
 *
 * - a layout decompiles to the source's XML, comments and whitespace aside;
 * - a stylesheet decompiles to the source's rules, comments and whitespace aside;
 * - a texture decodes to a PNG the size of the source, and (when ImageMagick's
 *   `compare` is on PATH) with not one pixel different.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compiledPath, type Source } from './addon.ts'

export const VRF = {
  version: '20.0',
  url: 'https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/20.0/cli-linux-x64.zip',
  sha256: '3e8af47cd6ce52e8068904f2aa1dda23c56a6b96a8310b25090f0711cda76a8a',
}

/** The path of a ready `Source2Viewer-CLI`. */
export function vrfCli(): string {
  if (process.env.EZPUG_VRF_CLI) return process.env.EZPUG_VRF_CLI
  const dir = join(tmpdir(), `ezpug-vrf-${VRF.version}`)
  const cli = join(dir, 'Source2Viewer-CLI')
  if (existsSync(cli)) return cli
  mkdirSync(dir, { recursive: true })
  const zip = join(dir, 'cli.zip')
  console.log(`fetching ValveResourceFormat CLI ${VRF.version}…`)
  execFileSync('curl', ['-fsSL', '-o', zip, VRF.url], { stdio: 'inherit' })
  const digest = createHash('sha256').update(readFileSync(zip)).digest('hex')
  if (digest !== VRF.sha256) {
    rmSync(zip)
    throw new Error(`${VRF.url}: checksum ${digest}, pinned ${VRF.sha256}`)
  }
  execFileSync('unzip', ['-oq', zip, '-d', dir])
  execFileSync('chmod', ['+x', cli])
  return cli
}

/** XML or CSS with comments and every whitespace character gone. */
export function normalize(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '')
}

/** A PNG's width and height, from its IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.toString('latin1', 12, 16) !== 'IHDR') throw new Error('not a PNG')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

export interface Readback {
  file: string
  ok: boolean
  says: string
}

/** Decode every compiled file in `distDir` and hold it against its source in `hudDir`. */
export function readBack(hudDir: string, distDir: string, mapped: Source[]): Readback[] {
  const cli = vrfCli()
  const scratch = mkdtempSync(join(tmpdir(), 'ezpug-hud-readback-'))
  const hasCompare = spawnSync('compare', ['-version']).status === 0
  try {
    return mapped.flatMap((s): Readback[] => {
      const compiled = compiledPath(s)
      if (!compiled) return []
      // A texture decompiles to its `.vtex` descriptor at the path given and
      // the picture beside it, under the source picture's own name.
      const folder = join(scratch, compiled.split('/').join('_'))
      mkdirSync(folder)
      const target = join(folder, s.vtex ? 'decoded.vtex' : 'decoded.txt')
      const decoded = s.vtex ? join(folder, s.source.split('/').pop()!) : target
      const run = spawnSync(cli, ['-i', join(distDir, compiled), '-d', '-o', target], {
        encoding: 'utf8',
      })
      if (run.status !== 0 || !existsSync(decoded))
        return [
          {
            file: compiled,
            ok: false,
            says: `VRF could not decode it: ${run.stderr || run.stdout}`,
          },
        ]
      const source = readFileSync(join(hudDir, s.source))
      if (!s.vtex) {
        const same = normalize(readFileSync(decoded, 'utf8')) === normalize(source.toString('utf8'))
        return [
          {
            file: compiled,
            ok: same,
            says: same ? 'decompiles to its source' : 'decompiles to something else',
          },
        ]
      }
      const want = pngSize(source)
      const got = pngSize(readFileSync(decoded))
      if (want.width !== got.width || want.height !== got.height)
        return [
          {
            file: compiled,
            ok: false,
            says: `decodes to ${got.width}×${got.height}, the source is ${want.width}×${want.height}`,
          },
        ]
      if (!hasCompare)
        return [
          {
            file: compiled,
            ok: true,
            says: `decodes to ${got.width}×${got.height} (no ImageMagick, pixels not compared)`,
          },
        ]
      const diff = spawnSync(
        'compare',
        ['-metric', 'AE', decoded, join(hudDir, s.source), 'null:'],
        { encoding: 'utf8' },
      )
      const pixels = Number.parseFloat(diff.stderr.trim())
      return [
        pixels === 0
          ? {
              file: compiled,
              ok: true,
              says: `decodes to ${got.width}×${got.height}, pixel for pixel its source`,
            }
          : {
              file: compiled,
              ok: false,
              says: `decodes with ${diff.stderr.trim()} pixels different from its source`,
            },
      ]
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
