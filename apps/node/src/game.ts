import { judgeNodeGame, type NodeGame, type NodeImage, nodeImageProofSchema } from '@ezpug/protocol'
import { z } from 'zod'
import { GAME_MOUNT_PATH } from './config'
import type { DockerPort } from './docker/port'
import type { Log } from './log'

/**
 * **The node states its build** (PRD-10 T8, decision 41). At boot, at every
 * dial and before every `start`, the agent reads three things out of one
 * throwaway container — the server image with the game volume bound
 * read-only, never started:
 *
 * - the volume's `steam.inf` (`PatchVersion`, `SourceRevision`) and
 *   `appmanifest_730.acf` (`buildid`): the game it holds;
 * - the image's `build.json` (the commit it was built from) and its
 *   `pins.json` and `proven.json` (`docker/cs2/Dockerfile`, outside the tree
 *   that is overlaid onto the volume): what it was built with, and the build
 *   the dev-node canary last went green on with exactly those pins.
 *
 * The agent says all of it in its `hello` and logs the comparison by name.
 * It **compares and tells, never refuses to start, never downloads**: a
 * venue has only the server it has, and moving a 67 GB volume is a human's
 * `cs2:install` with the lane free (`docs/nodes.md`, "When the game updates").
 */

/** Where the image keeps what it says about itself (`docker/cs2/Dockerfile`). */
export const IMAGE_META_DIR = '/usr/local/share/ezpug'
export const STEAM_INF_PATH = `${GAME_MOUNT_PATH}/game/csgo/steam.inf`
export const APP_MANIFEST_PATH = `${GAME_MOUNT_PATH}/steamapps/appmanifest_730.acf`
export const BUILD_JSON_PATH = '/opt/ezpug/addons/counterstrikesharp/plugins/EZPug.Core/build.json'
export const PINS_JSON_PATH = `${IMAGE_META_DIR}/pins.json`
export const PROVEN_JSON_PATH = `${IMAGE_META_DIR}/proven.json`

export interface GameStatement {
  game: NodeGame
  image: NodeImage
}

/** `PatchVersion=1.41.9.2` and `SourceRevision=11162119`, out of `steam.inf`. */
export function readSteamInf(text: string | null): {
  patchVersion: string | null
  sourceRevision: string | null
} {
  const field = (name: string): string | null =>
    text?.match(new RegExp(`^${name}=(\\S+)`, 'm'))?.[1] ?? null
  return { patchVersion: field('PatchVersion'), sourceRevision: field('SourceRevision') }
}

/** `"buildid"		"26144732"`, out of `appmanifest_730.acf`. */
export function readAppManifestBuildId(text: string | null): string | null {
  return text?.match(/"buildid"\s+"(\d+)"/)?.[1] ?? null
}

const json = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const pinsSchema = z.record(z.string().max(64), z.string().max(128))

/** What the three image files say; anything unreadable is the honest nothing. */
export function readImageFiles(files: {
  buildJson: string | null
  pinsJson: string | null
  provenJson: string | null
}): NodeImage {
  const build = z.object({ commit: z.string().max(64) }).safeParse(json(files.buildJson))
  const pins = pinsSchema.safeParse(json(files.pinsJson))
  const proven = nodeImageProofSchema.safeParse(json(files.provenJson))
  return {
    revision: build.success ? build.data.commit : null,
    pins: pins.success ? pins.data : {},
    proven: proven.success ? { ...proven.data, pins: { ...proven.data.pins } } : null,
  }
}

/** Read the statement out of `image` with `gameVolume` bound read-only. */
export async function readGameStatement(
  docker: DockerPort,
  image: string,
  gameVolume: string,
): Promise<GameStatement> {
  const read = await docker.readFiles(
    image,
    [`${gameVolume}:${GAME_MOUNT_PATH}:ro`],
    [STEAM_INF_PATH, APP_MANIFEST_PATH, BUILD_JSON_PATH, PINS_JSON_PATH, PROVEN_JSON_PATH],
  )
  const inf = readSteamInf(read[STEAM_INF_PATH] ?? null)
  return {
    game: {
      build: readAppManifestBuildId(read[APP_MANIFEST_PATH] ?? null),
      patchVersion: inf.patchVersion,
      sourceRevision: inf.sourceRevision,
    },
    image: readImageFiles({
      buildJson: read[BUILD_JSON_PATH] ?? null,
      pinsJson: read[PINS_JSON_PATH] ?? null,
      provenJson: read[PROVEN_JSON_PATH] ?? null,
    }),
  }
}

/** The one line the agent logs: what it holds, and whether its image was proven on it. */
export function statementLine(statement: GameStatement): string {
  const { game, image } = statement
  const holds =
    game.patchVersion === null
      ? 'no game build on the volume'
      : `CS2 ${game.patchVersion} (source revision ${game.sourceRevision ?? '?'}, Steam build ${game.build ?? '?'})`
  const verdict = judgeNodeGame('this node', game, image)
  const imageSays = `image ${image.revision ?? '(unknown revision)'}${image.proven ? ` proven on ${image.proven.build}${image.proven.hud ? ' with the HUD' : ''}` : ''}`
  return verdict.canary.state === 'green'
    ? `game: ${holds}; ${imageSays}: matches${verdict.hud.state === 'green' ? '' : ` (hud: ${verdict.hud.reason})`}`
    : `game: ${holds}; ${imageSays}: unproven — ${verdict.canary.reason}`
}

/** The same game, read twice? (The image cannot change under a running agent; the volume can.) */
export const sameGame = (a: NodeGame | undefined, b: NodeGame): boolean =>
  a !== undefined &&
  a.build === b.build &&
  a.patchVersion === b.patchVersion &&
  a.sourceRevision === b.sourceRevision

/** Read and log, or log that it could not be read; never throws. */
export async function stateGame(
  docker: DockerPort,
  image: string,
  gameVolume: string,
  log: Log,
): Promise<GameStatement | null> {
  try {
    const statement = await readGameStatement(docker, image, gameVolume)
    if (judgeNodeGame('this node', statement.game, statement.image).canary.state === 'green')
      log.info(statementLine(statement))
    else log.warn(statementLine(statement))
    return statement
  } catch (error) {
    log.warn(
      `game: could not read the game build off ${gameVolume} with ${image}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}
