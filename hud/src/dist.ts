/**
 * **`hud/dist/`: the compiled addon, committed** (PRD-07 T1). A later task, a
 * revert and a publish all work without the compiler, because what it made is
 * in the tree beside a manifest of hashes:
 *
 * - `panorama/**` — the compiled files, loose, as the compiler wrote them;
 * - `ezpug_hud.vpk` — the same files packed, the thing that is published;
 * - `manifest.json` — the hash of every source the compile read, of every file
 *   it wrote, of the pack, and what compiled it.
 *
 * `verifyDist` is the honesty check, run by `pnpm hud:build`, before every
 * publish, and by a test on every `pnpm verify`: a source edited without a
 * rebuild, a compiled file edited by hand or a pack that disagrees with the
 * loose files is a red build.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compiledPath, listFiles, sha256, sourceHashes, sources, VPK_NAME } from './addon.ts'
import { readVpk } from './vpk.ts'

export interface DistManifest {
  /** What compiled it: the compiler's hash and the depot manifests it came from. */
  compiler: { resourcecompiler: string; depots: Record<string, string> }
  /** Every source the compile read, by its path in `hud/`. */
  sources: Record<string, string>
  /** Every compiled file, by its path in the addon. */
  files: Record<string, { sha256: string; bytes: number }>
  pack: { file: string; sha256: string; bytes: number }
}

export const MANIFEST = 'manifest.json'

/** `compiler.txt` as the build container writes it: `resourcecompiler.exe <sha>` then `depot_<id> <manifest>` lines. */
export function parseCompilerInfo(text: string): DistManifest['compiler'] {
  const depots: Record<string, string> = {}
  let resourcecompiler = ''
  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/)
    if (!key || !value) continue
    if (key === 'resourcecompiler.exe') resourcecompiler = value
    else if (key.startsWith('depot_')) depots[key.slice('depot_'.length)] = value
  }
  return { resourcecompiler, depots }
}

export function serializeManifest(manifest: DistManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Every way `hud/dist/` can disagree with `hud/` or with itself; empty means honest. */
export function verifyDist(hudDir: string): string[] {
  const dist = join(hudDir, 'dist')
  const manifestPath = join(dist, MANIFEST)
  if (!existsSync(manifestPath)) return ['hud/dist/manifest.json is missing: run `pnpm hud:build`']
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DistManifest
  const problems: string[] = []

  const now = sourceHashes(hudDir)
  for (const [source, hash] of Object.entries(now))
    if (manifest.sources[source] !== hash)
      problems.push(
        manifest.sources[source]
          ? `hud/${source} changed since the last compile: run \`pnpm hud:build\``
          : `hud/${source} is new since the last compile: run \`pnpm hud:build\``,
      )
  for (const source of Object.keys(manifest.sources))
    if (!(source in now))
      problems.push(`hud/${source} was compiled but is gone: run \`pnpm hud:build\``)

  const expected = sources(hudDir)
    .map(compiledPath)
    .filter((p): p is string => p !== undefined)
    .sort()
  const recorded = Object.keys(manifest.files).sort()
  if (expected.join('\n') !== recorded.join('\n'))
    problems.push(
      `the manifest lists ${recorded.join(', ')}, the sources compile to ${expected.join(', ')}`,
    )

  const onDisk = listFiles(join(dist, 'panorama')).map(f => `panorama/${f}`)
  for (const file of onDisk)
    if (!manifest.files[file]) problems.push(`hud/dist/${file} is not in the manifest`)
  for (const [file, { sha256: hash }] of Object.entries(manifest.files)) {
    const path = join(dist, file)
    if (!existsSync(path)) problems.push(`hud/dist/${file} is missing`)
    else if (sha256(readFileSync(path)) !== hash)
      problems.push(`hud/dist/${file} does not match its hash`)
  }

  const packPath = join(dist, VPK_NAME)
  if (manifest.pack.file !== VPK_NAME)
    problems.push(`the manifest names the pack ${manifest.pack.file}`)
  if (!existsSync(packPath)) return [...problems, `hud/dist/${VPK_NAME} is missing`]
  const pack = readFileSync(packPath)
  if (sha256(pack) !== manifest.pack.sha256)
    problems.push(`hud/dist/${VPK_NAME} does not match its hash`)
  try {
    const entries = readVpk(pack)
    const packed = entries.map(e => e.path).sort()
    if (packed.join('\n') !== recorded.join('\n'))
      problems.push(
        `the pack holds ${packed.join(', ')}, the manifest lists ${recorded.join(', ')}`,
      )
    for (const entry of entries) {
      const want = manifest.files[entry.path]
      if (want && sha256(entry.data) !== want.sha256)
        problems.push(`${entry.path} in the pack differs from hud/dist/${entry.path}`)
    }
  } catch (error) {
    problems.push(`hud/dist/${VPK_NAME}: ${(error as Error).message}`)
  }
  return problems
}
