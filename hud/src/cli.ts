/**
 * **`pnpm hud:build` and `pnpm hud:publish`** (PRD-07 T1). The box gains no
 * package for any of this: Wine, Xvfb and SteamCMD live in the build image
 * (`docker/hud/`), and this file decides what it is handed.
 *
 *   pnpm hud:build              compile hud/ into hud/dist/, pack, verify, read back
 *   pnpm hud:build --tools      fetch or update the Windows depots first (about 10 GB)
 *   pnpm hud:verify             is hud/dist/ honest? (no compiler, no network)
 *   pnpm hud:publish            upload hud/dist/'s pack to the Workshop item, then fetch it anonymously
 *   pnpm hud:publish --dry-run  everything but Steam: the clean tree, the honest dist, the item VDF
 *   pnpm hud:keys               write the banner and art keys into @ezpug/match-api (hud/src/keys.ts)
 *
 * `docs/hud.md` is the page for people: the volumes, the session, what Wine
 * needed, how to delete it all.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listFiles, sha256, sourceHashes, sources, VPK_NAME, vtexFor } from './addon.ts'
import {
  type DistManifest,
  MANIFEST,
  parseCompilerInfo,
  serializeManifest,
  verifyDist,
} from './dist.ts'
import { hudKeys, KEYS_MODULE, renderKeysModule } from './keys.ts'
import { readBack } from './readback.ts'
import { writeVpk } from './vpk.ts'
import { itemVdf, parseWorkshopItem, publishedIdFromVdf, uploadVerdict } from './workshop.ts'

const HUD = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(HUD, '..')
const DIST = join(HUD, 'dist')
const CACHE = join(REPO, '.cache', 'hud')

const IMAGE = 'ezpug-iron/hud-build:dev'
const STEAM_VOLUME = 'ezpug-iron-hud-steam'
const BUILD_VOLUME = 'ezpug-iron-hud-build'
/** The dev node's install, the compiler's common content (`apps/node/src/config.ts`). */
const GAME_VOLUME = process.env.EZPUG_NODE_GAME_VOLUME || 'ezpug-iron-cs2_cs2-data'

const log = (line: string) => console.log(`\x1b[36m[hud]\x1b[0m ${line}`)
function die(line: string): never {
  console.error(`\x1b[31m[hud] error:\x1b[0m ${line}`)
  process.exit(1)
}

function run(command: string, args: string[], options: { quiet?: boolean } = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
  })
  if (result.error) die(`${command}: ${result.error.message}`)
  return result
}

const volumeExists = (name: string) =>
  run('docker', ['volume', 'inspect', name], { quiet: true }).status === 0

const owner = () => `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`

/** `docker run` of the build image. The account's name is passed by name, never on the command line. */
function container(subcommand: string[], mounts: string[], extra: string[] = []) {
  return run('docker', [
    'run',
    '--rm',
    '-e',
    `EZPUG_HUD_OWNER=${owner()}`,
    '-e',
    'EZPUG_HUD_STEAM_USER',
    ...extra,
    ...mounts.flatMap(m => ['-v', m]),
    IMAGE,
    ...subcommand,
  ])
}

function buildImage() {
  log(`building ${IMAGE}…`)
  const built = run('docker', ['build', '-q', '-f', 'docker/hud/Dockerfile', '-t', IMAGE, '.'], {
    quiet: true,
  })
  if (built.status !== 0) die(`docker build failed:\n${built.stderr}`)
}

function requireSession() {
  if (!process.env.EZPUG_HUD_STEAM_USER) die('EZPUG_HUD_STEAM_USER is not set (.env)')
  if (!volumeExists(STEAM_VOLUME))
    die(
      `no ${STEAM_VOLUME} volume: the Steam session is logged in by hand once (docs/hud.md, "The Steam session")`,
    )
}

function tools() {
  requireSession()
  const fetched = container(
    ['tools'],
    [`${STEAM_VOLUME}:/serverdata/Steam`, `${BUILD_VOLUME}:/build`],
  )
  if (fetched.status !== 0) die('the depots could not be fetched (above)')
}

function hasTools() {
  return (
    run(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'test',
        '-v',
        `${BUILD_VOLUME}:/build`,
        IMAGE,
        '-f',
        '/build/depots/app_730/depot_2347779/game/bin/win64/resourcecompiler.exe',
      ],
      { quiet: true },
    ).status === 0
  )
}

/** `hud/` → an addon-shaped folder with a `.vtex` beside every picture: what the container compiles. */
function stage(into: string) {
  rm(into)
  for (const s of sources(HUD)) {
    const target = join(into, s.addonPath)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(HUD, s.source), target)
    if (s.vtex) writeFileSync(join(into, s.vtex), vtexFor(s.addonPath))
  }
}

function rm(path: string) {
  rmSync(path, { recursive: true, force: true })
}

function build(args: string[]) {
  buildImage()
  if (!volumeExists(GAME_VOLUME))
    die(
      `no ${GAME_VOLUME} volume: the compiler reads the game's common content from the dev node's install (pnpm cs2:install)`,
    )
  if (!volumeExists(BUILD_VOLUME))
    run('docker', ['volume', 'create', BUILD_VOLUME], { quiet: true })
  if (args.includes('--tools') || !hasTools()) tools()

  const src = join(CACHE, 'src')
  const out = join(CACHE, 'out')
  stage(src)
  rm(out)
  mkdirSync(out, { recursive: true })
  log('compiling under Wine…')
  const compiled = container(
    ['compile'],
    [`${BUILD_VOLUME}:/build`, `${GAME_VOLUME}:/cs2:ro`, `${src}:/src:ro`, `${out}:/out`],
    // The overlay the compiler runs in (docker/hud/hud-build.sh, `assemble`).
    ['--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined'],
  )
  if (compiled.status !== 0)
    die(`the compile failed; the compiler's own logs are in ${join(out, 'logs')}`)

  rm(join(DIST, 'panorama'))
  mkdirSync(DIST, { recursive: true })
  const files: DistManifest['files'] = {}
  const packed: { path: string; data: Buffer }[] = []
  for (const file of listFiles(join(out, 'panorama'))) {
    const path = `panorama/${file}`
    const data = readFileSync(join(out, path))
    mkdirSync(dirname(join(DIST, path)), { recursive: true })
    writeFileSync(join(DIST, path), data)
    files[path] = { sha256: sha256(data), bytes: data.length }
    packed.push({ path, data })
  }
  const pack = writeVpk(packed)
  writeFileSync(join(DIST, VPK_NAME), pack)
  const manifest: DistManifest = {
    compiler: parseCompilerInfo(readFileSync(join(out, 'compiler.txt'), 'utf8')),
    sources: sourceHashes(HUD),
    files,
    pack: { file: VPK_NAME, sha256: sha256(pack), bytes: pack.length },
  }
  writeFileSync(join(DIST, MANIFEST), serializeManifest(manifest))
  log(`hud/dist/: ${Object.keys(files).length} compiled files, ${VPK_NAME} ${pack.length} bytes`)

  verify()
  log('reading the compiled files back with ValveResourceFormat…')
  const results = readBack(HUD, DIST, sources(HUD))
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.file}: ${r.says}`)
  if (results.some(r => !r.ok)) die('a compiled file does not read back as its source')
}

function verify() {
  const problems = verifyDist(HUD)
  if (problems.length > 0) die(`hud/dist/ is not honest:\n  ${problems.join('\n  ')}`)
  log('hud/dist/ matches hud/ and itself')
}

function git(args: string[]) {
  return run('git', args, { quiet: true }).stdout.trim()
}

/**
 * Publish what is committed, nothing else: a dirty tree is refused, so the
 * Workshop item is always a commit someone can check out. A first run creates
 * the item (unlisted, `hud/workshop.json`), writes its id back into that file
 * for a commit, and uploads again under the name a client mounts, `<id>.vpk`.
 */
async function publish(args: string[]) {
  const dirty = git(['status', '--porcelain'])
  if (dirty) die(`the tree is dirty; publish only what is committed:\n${dirty}`)
  verify()
  const itemPath = join(HUD, 'workshop.json')
  let item = parseWorkshopItem(readFileSync(itemPath, 'utf8'))
  const note = `${git(['rev-parse', '--short', 'HEAD'])}: ${git(['log', '-1', '--format=%s'])}`
  // Everything but Steam: the checks above, and the item VDF as it would go.
  if (args.includes('--dry-run')) {
    const name = item.publishedFileId ? `${item.publishedFileId}.vpk` : VPK_NAME
    log(`dry run: would upload hud/dist/${VPK_NAME} as ${name} with this item VDF:`)
    console.log(itemVdf(item, '/work/content', note))
    return
  }
  requireSession()
  buildImage()

  const upload = (name: string) => {
    const work = join(CACHE, 'publish')
    rm(work)
    mkdirSync(join(work, 'content'), { recursive: true })
    copyFileSync(join(DIST, VPK_NAME), join(work, 'content', name))
    writeFileSync(join(work, 'item.vdf'), itemVdf(item, '/work/content', note))
    log(item.publishedFileId ? `updating item ${item.publishedFileId}…` : 'creating the item…')
    container(['publish'], [`${STEAM_VOLUME}:/serverdata/Steam`, `${work}:/work`])
    const transcript = existsSync(join(work, 'steamcmd.txt'))
      ? readFileSync(join(work, 'steamcmd.txt'), 'utf8')
      : ''
    return {
      verdict: uploadVerdict(transcript),
      id: publishedIdFromVdf(readFileSync(join(work, 'item.vdf'), 'utf8')),
    }
  }

  if (!item.publishedFileId) {
    // The id is kept even when the upload after the creation fails: a second
    // run must update this item, never make another.
    const { verdict, id } = upload(VPK_NAME)
    if (id) {
      item = { ...item, publishedFileId: id }
      writeFileSync(itemPath, `${JSON.stringify(item, null, 2)}\n`)
      log(`created item ${id}; hud/workshop.json now names it (commit it)`)
    }
    if (!verdict.ok) die(`Steam refused the upload: ${verdict.reason}`)
    if (!id) die('the item was created but SteamCMD did not say its id')
  }
  const { verdict } = upload(`${item.publishedFileId}.vpk`)
  if (!verdict.ok) die(`Steam refused the upload: ${verdict.reason}`)
  log(`uploaded ${VPK_NAME} as ${item.publishedFileId}.vpk`)
  await check(item.publishedFileId)
}

/** What Steam says about the item, and what an anonymous download of it gets. */
async function check(id: string) {
  const response = await fetch(
    'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
    { method: 'POST', body: new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': id }) },
  )
  const details = (
    (await response.json()) as { response?: { publishedfiledetails?: Record<string, unknown>[] } }
  ).response?.publishedfiledetails?.[0]
  log(
    `Steam Web API: result ${details?.result}, visibility ${details?.visibility}, ${details?.file_size} bytes, banned ${details?.banned}`,
  )
  // 9 is "file not found": Steam shows the item to its owner alone (docs/hud.md, "Publishing").
  if (details?.result === 9)
    log('Steam hides the item from everyone but its owner; until that changes nobody can fetch it')
  const out = join(CACHE, 'fetch')
  rm(out)
  mkdirSync(out, { recursive: true })
  container(['fetch', id], [`${out}:/out`])
  const fetched = join(out, 'fetch', `${id}.vpk`)
  const want = (JSON.parse(readFileSync(join(DIST, MANIFEST), 'utf8')) as DistManifest).pack.sha256
  if (!existsSync(fetched)) {
    const said = existsSync(join(out, 'fetch', 'steamcmd.txt'))
      ? readFileSync(join(out, 'fetch', 'steamcmd.txt'), 'utf8')
          .trim()
          .split('\n')
          .slice(-3)
          .join(' / ')
      : 'nothing'
    die(`an anonymous download of ${id} got no ${id}.vpk (SteamCMD: ${said})`)
  }
  if (sha256(readFileSync(fetched)) !== want)
    die(`the anonymous download of ${id} is not hud/dist/${VPK_NAME}`)
  log(`an anonymous SteamCMD fetched ${id} by id, byte for byte hud/dist/${VPK_NAME}`)
}

/** The contract's two key lists, from the pictures in `hud/banners/` and `hud/art/`. */
function keys() {
  const found = hudKeys(HUD)
  writeFileSync(join(REPO, KEYS_MODULE), renderKeysModule(found))
  log(`${KEYS_MODULE}: ${found.banners.length} banner(s), ${found.art.length} picture(s)`)
}

const [command, ...args] = process.argv.slice(2)
switch (command) {
  case 'build':
    build(args)
    break
  case 'verify':
    verify()
    break
  case 'publish':
    await publish(args)
    break
  case 'keys':
    keys()
    break
  case 'check':
    if (!args[0]) die('usage: hud check <workshop id>')
    buildImage()
    await check(args[0])
    break
  default:
    die(
      'usage: node hud/src/cli.ts build [--tools] | verify | publish [--dry-run] | keys | check <id>',
    )
}
