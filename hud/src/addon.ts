/**
 * **`hud/` and the addon, the one place they meet** (PRD-07 T1). `hud/` is laid
 * out for the people who edit it; the addon is laid out for the game, and every
 * path below is one the game or the server names:
 *
 * | in `hud/`             | in the addon                                       |
 * | --------------------- | -------------------------------------------------- |
 * | `addoninfo.txt`       | `addoninfo.txt`                                    |
 * | `layout/<n>.xml`      | `panorama/layout/custom_game/<n>.xml`              |
 * | `styles/<n>.css`      | `panorama/styles/custom_game/<n>.css`              |
 * | `images/<p>.png`      | `panorama/images/custom_game/ezpug/<p>.png` + a `.vtex` beside it |
 *
 * A layout's name on the server is its **source** path with the extension
 * (`panorama/layout/custom_game/ezpug_hello.xml`); a stylesheet is included and
 * a picture referenced by the **compiled** one (`….vcss_c`, `s2r://….vtex`).
 * Everything is `ezpug_`-prefixed or under `ezpug/`, because a client mounts
 * other servers' addons into the same `custom_game` folders.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** The addon's folder name in the build tree (`content/csgo_addons/<name>`). */
export const ADDON = 'ezpug_hud'

/** The pack's file name in `hud/dist/`; published as `<workshop id>.vpk`. */
export const VPK_NAME = `${ADDON}.vpk`

export const IMAGE_ROOT = 'panorama/images/custom_game/ezpug'

export interface Source {
  /** Relative to `hud/`. */
  source: string
  /** Relative to the addon's content root. */
  addonPath: string
  /** The `.vtex` descriptor written beside a picture, which is what compiles. */
  vtex?: string
}

const files = (dir: string, suffix: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter(f => f.endsWith(suffix) && statSync(join(dir, f)).isFile())
        .map(f => f.split('\\').join('/'))
        .sort()
    : []

/** Every source in `hud/`, mapped. A name that is not lower case is refused: a VPK has none. */
export function sources(hudDir: string): Source[] {
  const mapped: Source[] = [{ source: 'addoninfo.txt', addonPath: 'addoninfo.txt' }]
  for (const f of files(join(hudDir, 'layout'), '.xml'))
    mapped.push({ source: `layout/${f}`, addonPath: `panorama/layout/custom_game/${f}` })
  for (const f of files(join(hudDir, 'styles'), '.css'))
    mapped.push({ source: `styles/${f}`, addonPath: `panorama/styles/custom_game/${f}` })
  for (const f of files(join(hudDir, 'images'), '.png')) {
    const addonPath = `${IMAGE_ROOT}/${f}`
    mapped.push({ source: `images/${f}`, addonPath, vtex: addonPath.replace(/\.png$/, '.vtex') })
  }
  for (const s of mapped)
    if (s.addonPath !== s.addonPath.toLowerCase())
      throw new Error(`hud/${s.source}: names in the addon are lower case`)
  return mapped
}

/** What a source compiles to, relative to the addon's game root; `undefined` for what does not compile. */
export function compiledPath(s: Source): string | undefined {
  if (s.vtex) return `${s.vtex}_c`
  if (s.addonPath.endsWith('.xml')) return s.addonPath.replace(/\.xml$/, '.vxml_c')
  if (s.addonPath.endsWith('.css')) return s.addonPath.replace(/\.css$/, '.vcss_c')
  return undefined
}

/**
 * A picture's texture descriptor. BGRA8888, uncompressed: a DXT5 picture comes
 * out pink on blue in a custom HUD (cs2-ui-kit's GOTCHAS). Nobody writes these
 * by hand; the build writes one beside every `.png`.
 */
export function vtexFor(pngAddonPath: string): string {
  return `<!-- dmx encoding keyvalues2_noids 1 format vtex 1 -->
"CDmeVtex"
{
\t"m_inputTextureArray" "element_array"
\t[
\t\t"CDmeInputTexture"
\t\t{
\t\t\t"m_name" "string" "InputTexture0"
\t\t\t"m_fileName" "string" "${pngAddonPath}"
\t\t\t"m_colorSpace" "string" "srgb"
\t\t\t"m_typeString" "string" "2D"
\t\t\t"m_imageProcessorArray" "element_array"
\t\t\t[
\t\t\t\t"CDmeImageProcessor"
\t\t\t\t{
\t\t\t\t\t"m_algorithm" "string" "None"
\t\t\t\t\t"m_stringArg" "string" ""
\t\t\t\t\t"m_vFloat4Arg" "vector4" "0 0 0 0"
\t\t\t\t}
\t\t\t]
\t\t}
\t]
\t"m_outputTypeString" "string" "2D"
\t"m_outputFormat" "string" "BGRA8888"
\t"m_outputClearColor" "vector4" "0 0 0 0"
\t"m_nOutputMinDimension" "int" "0"
\t"m_nOutputMaxDimension" "int" "0"
\t"m_textureOutputChannelArray" "element_array"
\t[
\t\t"CDmeTextureOutputChannel"
\t\t{
\t\t\t"m_inputTextureArray" "string_array" [ "InputTexture0" ]
\t\t\t"m_srcChannels" "string" "rgba"
\t\t\t"m_dstChannels" "string" "rgba"
\t\t\t"m_mipAlgorithm" "CDmeImageProcessor"
\t\t\t{
\t\t\t\t"m_algorithm" "string" "Box"
\t\t\t\t"m_stringArg" "string" ""
\t\t\t\t"m_vFloat4Arg" "vector4" "0 0 0 0"
\t\t\t}
\t\t\t"m_outputColorSpace" "string" "srgb"
\t\t}
\t]
}
`
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

/** Every source's hash, keyed by its path in `hud/`. */
export function sourceHashes(hudDir: string): Record<string, string> {
  return Object.fromEntries(
    sources(hudDir).map(s => [s.source, sha256(readFileSync(join(hudDir, s.source)))]),
  )
}

/** Files under `dir`, relative and `/`-separated, sorted. */
export function listFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter(f => statSync(join(dir, f)).isFile())
        .map(f => relative(dir, join(dir, f)).split('\\').join('/'))
        .sort()
    : []
}
