#!/usr/bin/env node
// **The Dathost template image** (PRD-02 T18) — one server on the account that
// every match is cloned from, built out of exactly the artifacts the CS2 image
// carries.
//
//   pnpm dathost:image                  create or refresh the template
//   pnpm dathost:image --check          is the template what this tree says it is?
//   pnpm dathost:image --dry-run        say what would change and touch nothing
//   node scripts/dathost-image.mjs --help
//
// **Why a template at all.** Dathost has no image registry: a server is a box
// with files on it, and the only way to get a second one with our plugins is
// `POST /game-servers/{id}/duplicate`, which copies the source's *files* along
// with its settings. So the "image" for the rented half of the fleet is a
// server that never runs a match — Metamod, CounterStrikeSharp, MatchZy, our
// plugins and our cfg set sitting on disk with `deletion_protection` on — and
// `EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID` names it. This script is what puts
// them there.
//
// **One build, two destinations** (the PRD's words). The files uploaded here
// are not fetched again from Metamod's or MatchZy's release pages: they are
// read out of `ghcr.io/ezpug/ezpug-iron/cs2`, the very image `pnpm cs2:up`
// runs on this box and a node runs at a venue, from the directory its
// entrypoint overlays onto `game/csgo`. A pin lives in `docker/cs2/Dockerfile`
// (checksummed there, copied into `docs/pins.md`, held together by
// `scripts/check-pins.mjs`) and is read here, never re-decided.
//
// **The sync-files trap.** `duplicate` copies the API's *cached* view of the
// source's files, not what is on the box (`references/dathost.md`), so this
// ends with `POST …/sync-files` — an upload without one is a template that
// clones yesterday's plugin, which looks exactly like a plugin bug.
//
// **What it refuses.** Every write is preceded by a `GET` of the named server
// and a check that it is ours *and* a template: a server carrying a match's
// tag, a clone of the template, or anything with no marker at all is refused
// outright (`--adopt` is the deliberate way to claim one). The template is
// never started, never deleted and never given a GSLT — a token is one per
// running server (T17), and a template that held one would lend it to every
// clone that failed to get a lease.
//
// **Secrets.** The account's password comes from the environment, never from a
// flag (a flag lands in shell history and in `/proc`), and the Basic header is
// built once and put on a request by `call` alone: it is in no log line, no
// error and no `--json` output. Nothing this script writes to the template
// holds a secret either — the RCON and join passwords are minted per
// allocation by the provider, and `ezpug.json` (the link URL and the server
// token) is written by `configure`, on the clone, never here.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The `user_data` marker every server of ours wears. The twin of
 * `DATHOST_DEFAULT_TAG` in `apps/orchestrator/src/providers/dathost/provider.ts`
 * — the orchestrator's `list()` claims by it and its reaper deletes by it, so
 * the two must agree; `dathost-image.test.ts` asserts they do rather than
 * trusting this comment.
 */
export const TEMPLATE_TAG = 'ezpug'

/** What tells the template apart from a match's server inside that marker. */
export const TEMPLATE_ROLE = 'template'

/** The vendor's base URL (`references/dathost.md`). */
export const DATHOST_API_BASE_URL = 'https://dathost.net/api/0.1'

/** Frankfurt, as Dathost spells it. */
export const DEFAULT_LOCATION = 'dusseldorf'

/** Where the CS2 image stages the tree its entrypoint overlays onto `game/csgo`. */
const IMAGE_TREE_DIR = '/opt/ezpug'

/** The image the tree is taken out of, unless `EZPUG_IRON_CS2_IMAGE` says otherwise. */
const DEFAULT_IMAGE = 'ghcr.io/ezpug/ezpug-iron/cs2:dev'

/**
 * The record of what was uploaded, written last and read by `--check`. It
 * lives beside `ezpug.json` (the provider's sidecar) at the game root and
 * holds no secret: pins, a git revision, and a sha-256 per file.
 */
export const IMAGE_MANIFEST_PATH = 'ezpug-image.json'

/** Bumped when the manifest's shape changes; an older one is refreshed, not parsed. */
const MANIFEST_VERSION = 1

/** Dathost refuses an upload over this (`references/dathost.md`); ours are ~10 MB at worst. */
const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024

/** How many uploads are in flight at once. Polite, and enough for 500 files. */
const UPLOAD_CONCURRENCY = 4

/** Four attempts, ~13 s — the provider's schedule, for the same reasons. */
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000]

/** Slots on a fresh template. Ten players and two spectators; it is also the price. */
const DEFAULT_SLOTS = 12

/**
 * The Metamod loader line and where it is anchored — the same edit
 * `docker/cs2/entrypoint.sh` makes on the volume at every boot. On Dathost
 * nothing re-applies it, so a game update on their side that rewrites
 * `gameinfo.gi` is a `--check` failure and a re-run of this script.
 */
const METAMOD_GAMEINFO_LINE = '\t\t\tGame\tcsgo/addons/metamod'
const METAMOD_GAMEINFO_NEEDLE = 'csgo/addons/metamod'
const GAMEINFO_PATH = 'gameinfo.gi'
const GAMEINFO_ANCHOR = 'Game_LowViolence'

const HELP = `dathost-image — build or refresh the Dathost template server (PRD-02 T18)

  (no verb)            create or refresh the template from the CS2 image's artifacts
  --check              verify the template against this tree and docs/pins.md's homes
  --dry-run            print the plan and touch nothing

  --tree <dir>         use this artifact tree instead of extracting one from the image
  --image <ref>        the image to extract from; default $EZPUG_IRON_CS2_IMAGE
  --template <id>      default $EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID; absent means create
  --location <id>      where a new template is created; default $EZPUG_IRON_DATHOST_LOCATION
  --name <name>        the new template's name; default "EZPug template (cs2)"
  --slots <n>          cs2_settings.slots; default ${DEFAULT_SLOTS} on create, untouched on refresh
  --adopt              claim a server that does not yet wear our template marker
  --force              re-upload every file, and write even to a running template
  --json               print the result as JSON and nothing else
  --help

The account comes from the environment and only from the environment:
EZPUG_IRON_DATHOST_EMAIL, EZPUG_IRON_DATHOST_PASSWORD (the unprefixed
EZPUG_DATHOST_* names work too, as everywhere else in this repo).
EZPUG_IRON_DATHOST_API_URL points this script somewhere other than dathost.net;
it is how the test suite runs it against the fake vendor, not a knob for a
deployment — the orchestrator's own provider does not read it.
`

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `--flag value`, `--flag=value` and bare `--flag`, in one pass. */
function parseArgs(argv) {
  const flags = new Map()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const [name, inline] = token.slice(2).split('=', 2)
    if (inline !== undefined) flags.set(name, inline)
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags.set(name, argv[++i])
    else flags.set(name, 'true')
  }
  return flags
}

/**
 * The one place this script reaches for the wall clock. The determinism guard
 * (`scripts/lint/determinism.grit`) is right about everything that has to
 * reproduce; an operator script backing off against a vendor's rate limiter
 * has no clock to inject and nothing to replay, and a test hands it a `sleep`
 * that returns immediately.
 */
const wall = {
  // biome-ignore lint/plugin: an operator script talking to a live vendor API in real time
  at: () => new Date(),
  // biome-ignore lint/plugin: as above — there is no clock to arm a backoff on
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Every file under `dir`, as repo-style relative paths with forward slashes. */
function walk(dir, base = dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, found)
    else if (entry.isFile()) found.push(relative(base, full).split(sep).join('/'))
  }
  return found
}

/**
 * Where a file of the image's staging tree lands in a Dathost server's file
 * manager, whose paths start at the game root — `game/csgo` for CS2, the
 * directory `docker/cs2/entrypoint.sh` overlays the same tree onto. `null`
 * means "not part of a server's files": the gamemode *manifests* travel over
 * the link inside the assignment (decision 5), never on disk.
 */
export function remotePathFor(relativePath) {
  if (relativePath.startsWith('addons/')) return relativePath
  if (relativePath.startsWith('cfg/')) return relativePath
  const gamemodeCfg = /^gamemodes\/[^/]+\/cfg\/(.+)$/.exec(relativePath)
  if (gamemodeCfg) return `cfg/${gamemodeCfg[1]}`
  return null
}

/**
 * The pins the image was built from, read out of its Dockerfile — the *home*
 * of each number. `docs/pins.md` is the copy for people and `pnpm lint`
 * (`scripts/check-pins.mjs`) refuses a disagreement between the two, so
 * reading the home is reading the table without parsing prose.
 */
export function readPins(dockerfile) {
  const arg = name => dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1] ?? null
  return {
    metamod: arg('METAMOD_VERSION'),
    counterstrikesharp: arg('COUNTER_STRIKE_SHARP_VERSION'),
    matchzy: arg('MATCHZY_VERSION'),
  }
}

// ---------------------------------------------------------------------------
// The artifact tree
// ---------------------------------------------------------------------------

/**
 * The CS2 image's staging directory, on this disk. `docker create` and
 * `docker cp` rather than a `docker run`: the container never starts, so
 * nothing needs the game volume and nothing can boot a server by accident.
 * The extraction is cached per image id, because 515 files out of a 165 MB
 * image is a few seconds nobody needs to spend twice.
 */
function extractTree(image, say) {
  const inspect = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
    encoding: 'utf8',
  })
  if (inspect.status !== 0) {
    throw new Error(
      `the image ${image} is not on this box — build it with \`pnpm cs2:build\`, or point ` +
        '`--tree` at an artifact tree that already exists',
    )
  }
  const imageId = inspect.stdout.trim().replace(/^sha256:/, '')
  const target = join(repo, '.cache/dathost-image', imageId.slice(0, 16))
  if (existsSync(join(target, 'addons'))) {
    say(`artifacts: ${target} (cached from ${image})`)
    return { dir: target, image, imageId }
  }

  const created = spawnSync('docker', ['create', image], { encoding: 'utf8' })
  if (created.status !== 0) throw new Error(`docker create ${image} failed: ${created.stderr}`)
  const container = created.stdout.trim()
  try {
    mkdirSync(target, { recursive: true })
    const copied = spawnSync('docker', ['cp', `${container}:${IMAGE_TREE_DIR}/.`, target], {
      encoding: 'utf8',
    })
    if (copied.status !== 0)
      throw new Error(`docker cp out of ${image} failed: ${copied.stderr.trim()}`)
  } finally {
    spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' })
  }
  say(`artifacts: extracted ${IMAGE_TREE_DIR} out of ${image} into ${target}`)
  return { dir: target, image, imageId }
}

/**
 * The upload plan: every file of the tree that belongs on a server, with the
 * path it takes there and the hash that decides whether it has to move.
 * A collision — two gamemodes shipping `cfg/ezpug/x.cfg` — is refused here
 * rather than resolved silently, because on the volume the entrypoint would
 * let the last `cp` win and nobody would ever find out which.
 */
export function planFiles(treeDir) {
  const files = []
  const seen = new Map()
  for (const relativePath of walk(treeDir)) {
    const remote = remotePathFor(relativePath)
    if (remote === null) continue
    const previous = seen.get(remote)
    if (previous !== undefined)
      throw new Error(
        `two files of the image want to be ${remote}: ${previous} and ${relativePath}`,
      )
    seen.set(remote, relativePath)
    const content = readFileSync(join(treeDir, relativePath))
    if (content.byteLength > UPLOAD_LIMIT_BYTES)
      throw new Error(
        `${relativePath} is ${content.byteLength} bytes and Dathost refuses anything over ` +
          `${UPLOAD_LIMIT_BYTES} (their file manager wants FTP for those)`,
      )
    files.push({
      source: relativePath,
      path: remote,
      size: content.byteLength,
      sha256: sha256(content),
    })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  return files
}

/** What the plugin build recorded about itself, if the tree carries it. */
function readBuildJson(treeDir) {
  const path = join(treeDir, 'addons/counterstrikesharp/plugins/EZPug.Core/build.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The manifest, byte-stable: sorted keys, one writer, so `--check` can diff it. */
function buildManifest({ pins, build, image, files, at }) {
  return {
    manifestVersion: MANIFEST_VERSION,
    generator: 'scripts/dathost-image.mjs',
    builtAt: at,
    image,
    revision: build?.commit ?? 'unknown',
    plugins: { sdk: build?.sdk ?? 'unknown', core: build?.core ?? 'unknown' },
    pins,
    files: Object.fromEntries(files.map(f => [f.path, { sha256: f.sha256, size: f.size }])),
  }
}

// ---------------------------------------------------------------------------
// The vendor
// ---------------------------------------------------------------------------

/**
 * The subset of Dathost this script speaks, with the account's Basic header
 * closed over. Retries follow the provider's rule and for the same money
 * reason: a 429 refused the call so anything may be sent again, a 5xx may have
 * done the work anyway — so only calls that are safe to repeat are retried,
 * and `POST /game-servers` (a *new server on the bill*) never is.
 */
function createClient({ baseUrl, email, password, fetchImpl, sleep }) {
  const authorization = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`

  async function call(method, path, options = {}) {
    const { form, file, idempotent = false, allowMissing = false, query } = options
    // Every segment encoded, the separators kept: a file path is part of the
    // route (`…/files/{path}`), not a query parameter.
    const url = new URL(
      baseUrl +
        path
          .split('/')
          .map(segment => encodeURIComponent(segment))
          .join('/'),
    )
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value))

    for (let attempt = 0; ; attempt++) {
      let response
      try {
        let body
        if (file !== undefined) {
          body = new FormData()
          body.set('file', new Blob([file.content]), file.name)
        } else if (form !== undefined) {
          body = new FormData()
          for (const [key, value] of Object.entries(form)) body.set(key, String(value))
        }
        response = await fetchImpl(url.toString(), {
          method,
          headers: { authorization },
          ...(body !== undefined && { body }),
        })
      } catch (error) {
        // A dropped socket is a 5xx that never arrived: retryable exactly
        // where a 5xx is, and fatal where it is not.
        if (!idempotent || attempt >= RETRY_DELAYS_MS.length)
          throw new Error(
            `${method} ${path} failed: ${error instanceof Error ? error.message : ''}`,
          )
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      if (response.ok) return response
      if (response.status === 404 && allowMissing) return null
      const retryable = response.status === 429 || response.status >= 500
      if (
        retryable &&
        (idempotent || response.status === 429) &&
        attempt < RETRY_DELAYS_MS.length
      ) {
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      // The status and nothing else: a vendor's error body is not ours to
      // print, and the request carried the account's header.
      throw new Error(`${method} ${path} answered ${response.status}`)
    }
  }

  return {
    async getServer(id) {
      const response = await call('GET', `/game-servers/${id}`, {
        idempotent: true,
        allowMissing: true,
      })
      return response === null ? null : await response.json()
    },
    async createServer(form) {
      // Not idempotent: a 5xx that may have created a server is *not* sent
      // again, because the second one would be a second server on the bill
      // that nothing knows about. (A 429 is, since it refused the call.)
      const response = await call('POST', '/game-servers', { form })
      // The vendor answers a create it *refused* with a 200 and a plain-text
      // sentence ("cs2_settings.rcon needs to be set", seen 2026-09-08), so a
      // 2xx is not yet a server: only a JSON body with an id is. That sentence
      // is a validation message and not the account's header, so it is the
      // one vendor body this script repeats — without it the failure reads as
      // a parser bug.
      const text = await response.text()
      let server
      try {
        server = JSON.parse(text)
      } catch {
        server = undefined
      }
      if (typeof server !== 'object' || server === null || typeof server.id !== 'string') {
        const line = text.split('\n')[0].trim().slice(0, 160)
        throw new Error(
          `POST /game-servers answered ${response.status} without a server: ${line || '(empty body)'}`,
        )
      }
      return server
    },
    async updateServer(id, form) {
      await call('PUT', `/game-servers/${id}`, { form, idempotent: true })
    },
    async listFiles(id) {
      const response = await call('GET', `/game-servers/${id}/files`, {
        idempotent: true,
        query: { hide_default_files: 'true' },
      })
      return await response.json()
    },
    async downloadFile(id, path) {
      const response = await call('GET', `/game-servers/${id}/files/${path}`, {
        idempotent: true,
        allowMissing: true,
      })
      return response === null ? null : Buffer.from(await response.arrayBuffer())
    },
    async uploadFile(id, path, content) {
      // Writing the same bytes twice is writing the same bytes.
      await call('POST', `/game-servers/${id}/files/${path}`, {
        file: { content, name: path.split('/').pop() },
        idempotent: true,
      })
    },
    async syncFiles(id) {
      await call('POST', `/game-servers/${id}/sync-files`, { idempotent: true })
    },
  }
}

// ---------------------------------------------------------------------------
// The template's identity
// ---------------------------------------------------------------------------

/** The `user_data` a template wears. Parsed by the orchestrator's `decodeTag`. */
export function templateUserData() {
  return JSON.stringify({ tag: TEMPLATE_TAG, role: TEMPLATE_ROLE })
}

/**
 * "Refuses to touch a server that is not the template" (the PRD). The id in
 * the environment is a string somebody typed; everything after this line
 * writes files and settings, so the marker is checked first and the refusal
 * says which of the three things went wrong.
 */
export function templateRefusal(server, { adopt = false } = {}) {
  if (server.game !== undefined && server.game !== 'cs2')
    return `${server.id} is a ${server.game} server, not cs2`
  let marker = null
  try {
    const parsed = JSON.parse(server.user_data || '')
    if (parsed && typeof parsed === 'object') marker = parsed
  } catch {
    marker = null
  }
  if (marker?.tag === TEMPLATE_TAG && marker.role === TEMPLATE_ROLE) return null
  // These two are refused **even with `--adopt`**: a server the orchestrator
  // believes is running a match is the one thing no flag should let this
  // script write five hundred files onto.
  if (marker?.matchId || marker?.fleetServerId)
    return `${server.id} is a match's server (user_data carries a match), not the template`
  if (server.duplicate_source_server)
    return `${server.id} is a clone of ${server.duplicate_source_server}, not the template`
  if (adopt) return null
  return (
    `${server.id} carries no EZPug template marker in user_data — refusing to write to a ` +
    'server this script did not build. Pass --adopt to claim it deliberately.'
  )
}

/**
 * The settings a template must hold, whatever it held before. Each one is a
 * decision with a consequence:
 *
 * - `deletion_protection` — the template is the image. It is also the one
 *   thing standing between a misconfigured deployment's reaper and a rebuild
 *   from scratch, since a reaper deletes by tag.
 * - `autostop` / `reboot_on_crash` off — the reaper is ours and a crash is a
 *   `server_lost` we want to see (they are cloned onto every match's server,
 *   where `allocate` sets them again anyway).
 * - `enable_metamod` off — that is Dathost's *managed* Metamod; ours is in
 *   the image, pinned and checksummed, and two loaders are one too many.
 * - `enable_gotv` on — GOTV is the template's, because the provider reads the
 *   relay off the clone and never turns one on.
 */
function templateSettings({ slots }) {
  return {
    user_data: templateUserData(),
    deletion_protection: 'true',
    autostop: 'false',
    reboot_on_crash: 'false',
    'cs2_settings.enable_metamod': 'false',
    'cs2_settings.enable_gotv': 'true',
    ...(slots !== undefined && { 'cs2_settings.slots': String(slots) }),
  }
}

/** What of {@link templateSettings} the server does not already say. */
function settingsDrift(server, { slots }) {
  const cs2 = server.cs2_settings ?? {}
  const drift = []
  if (server.deletion_protection !== true) drift.push('deletion_protection is off')
  if (server.autostop === true) drift.push('autostop is on')
  if (server.reboot_on_crash === true) drift.push('reboot_on_crash is on')
  if (cs2.enable_metamod === true) drift.push("Dathost's managed Metamod is on")
  if (cs2.enable_gotv !== true) drift.push('GOTV is off')
  if (cs2.steam_game_server_login_token)
    drift.push('the template holds a GSLT — every clone would inherit it (T17: one per server)')
  if (slots !== undefined && cs2.slots !== slots) drift.push(`slots are ${cs2.slots}, not ${slots}`)
  return drift
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const out = options.stdout ?? (text => process.stdout.write(text))
  const err = options.stderr ?? (text => process.stderr.write(text))
  const fetchImpl = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? wall.sleep
  const now = options.now ?? (() => wall.at().toISOString())

  const flags = parseArgs(argv)
  if (flags.has('help')) {
    out(HELP)
    return 0
  }
  // A checkout's `.env` is where an operator's credentials actually live
  // (`.gitignore` keeps it out of the tree). Only when the caller did not
  // hand us an environment of its own — the test suite does.
  if (options.env === undefined) {
    try {
      process.loadEnvFile(join(repo, '.env'))
    } catch {
      // A fresh clone has no .env; the process environment is all there is.
    }
  }

  const json = flags.get('json') === 'true'
  const say = line => {
    if (!json) err(`\x1b[36m[dathost-image]\x1b[0m ${line}\n`)
  }
  const warn = line => {
    if (!json) err(`\x1b[33m[dathost-image] warning:\x1b[0m ${line}\n`)
  }

  const check = flags.get('check') === 'true'
  const dryRun = flags.get('dry-run') === 'true'
  const verb = check ? 'check' : dryRun ? 'dry-run' : 'build'
  const problems = []
  const result = { ok: true, verb, problems }

  const finish = () => {
    result.ok = problems.length === 0
    if (json) out(`${JSON.stringify(result, null, 2)}\n`)
    else for (const problem of problems) err(`\x1b[31m[dathost-image] problem:\x1b[0m ${problem}\n`)
    return result.ok ? 0 : 1
  }

  try {
    const email = env.EZPUG_IRON_DATHOST_EMAIL ?? env.EZPUG_DATHOST_EMAIL ?? ''
    const password = env.EZPUG_IRON_DATHOST_PASSWORD ?? env.EZPUG_DATHOST_PASSWORD ?? ''
    if (!email || !password) {
      problems.push(
        'no Dathost account: set EZPUG_IRON_DATHOST_EMAIL and EZPUG_IRON_DATHOST_PASSWORD ' +
          '(the password is read from the environment only, never from a flag)',
      )
      return finish()
    }
    const baseUrl = (
      env.EZPUG_IRON_DATHOST_API_URL ??
      env.EZPUG_DATHOST_API_URL ??
      DATHOST_API_BASE_URL
    ).replace(/\/+$/, '')
    const location =
      flags.get('location') ??
      env.EZPUG_IRON_DATHOST_LOCATION ??
      env.EZPUG_DATHOST_LOCATION ??
      DEFAULT_LOCATION
    const templateId =
      flags.get('template') ??
      env.EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID ??
      env.EZPUG_DATHOST_TEMPLATE_SERVER_ID ??
      ''
    const force = flags.get('force') === 'true'
    const slots = flags.has('slots') ? Number(flags.get('slots')) : undefined
    if (slots !== undefined && (!Number.isInteger(slots) || slots < 5 || slots > 64)) {
      problems.push('--slots must be an integer between 5 and 64 (the vendor’s range)')
      return finish()
    }

    // ── The artifacts ──────────────────────────────────────────────────────
    const image = flags.get('image') ?? env.EZPUG_IRON_CS2_IMAGE ?? DEFAULT_IMAGE
    let tree
    if (flags.has('tree')) {
      const dir = resolve(process.cwd(), flags.get('tree'))
      if (!existsSync(dir)) throw new Error(`--tree ${dir} does not exist`)
      tree = { dir, image: `${image} (via --tree)`, imageId: null }
      say(`artifacts: ${dir} (--tree)`)
    } else {
      tree = extractTree(image, say)
    }

    const pins = readPins(readFileSync(join(repo, 'docker/cs2/Dockerfile'), 'utf8'))
    const build = readBuildJson(tree.dir)
    // The one pin the tree itself witnesses: the plugins record what they were
    // compiled against, so an image built before a bump is caught here rather
    // than by a server booting with half its plugins missing.
    if (build && pins.counterstrikesharp && build.counterStrikeSharp !== pins.counterstrikesharp) {
      problems.push(
        `the artifacts were built against CounterStrikeSharp ${build.counterStrikeSharp} but ` +
          `docker/cs2/Dockerfile pins ${pins.counterstrikesharp} — rebuild with \`pnpm cs2:build\``,
      )
    }

    const files = planFiles(tree.dir)
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    say(
      `plan: ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB — Metamod ` +
        `${pins.metamod}, CounterStrikeSharp ${pins.counterstrikesharp}, MatchZy ${pins.matchzy}` +
        (build ? `, EZPug ${build.core} (${build.commit})` : ''),
    )
    result.pins = pins
    result.files = files.length
    result.bytes = totalBytes
    // A tree that disagrees with the pins is wrong wherever it is sent: stop
    // before the account is touched at all.
    if (problems.length > 0) return finish()

    const client = createClient({ baseUrl, email, password, fetchImpl, sleep })

    // ── The server ─────────────────────────────────────────────────────────
    let server = null
    if (templateId) {
      server = await client.getServer(templateId)
      if (server === null) {
        problems.push(
          `no server ${templateId} on this account — either the id is stale or it was ` +
            'deleted; drop EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID to build a new template',
        )
        return finish()
      }
      const refusal = templateRefusal(server, { adopt: flags.get('adopt') === 'true' })
      if (refusal !== null) {
        problems.push(refusal)
        return finish()
      }
      say(`template: ${server.id} "${server.name}" in ${server.location}`)
    } else if (check) {
      problems.push(
        'nothing to check: EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID is unset and no --template ' +
          'was given',
      )
      return finish()
    } else if (dryRun) {
      say(`template: none configured — would create one in ${location}`)
      result.wouldCreate = true
      result.uploads = files.length
      return finish()
    } else {
      const name = flags.get('name') ?? 'EZPug template (cs2)'
      say(`template: none configured — creating "${name}" in ${location}`)
      server = await client.createServer({
        game: 'cs2',
        name,
        location,
        'cs2_settings.game_mode': 'competitive',
        // The vendor refuses a cs2 create without one. The template never
        // runs, so nobody ever types this: it is drawn once, kept nowhere, and
        // every clone gets its own from `allocate` anyway.
        'cs2_settings.rcon': randomBytes(24).toString('base64url'),
        ...templateSettings({ slots: slots ?? DEFAULT_SLOTS }),
      })
      say(`template: created ${server.id}`)
      result.created = true
    }
    result.templateServerId = server.id
    result.location = server.location

    // A template that is on has the game holding its own files open, and a
    // half-swapped addons directory is the kind of thing that shows up two
    // weeks later as one map that crashes.
    if (server.on === true || server.booting === true) {
      const line = `${server.id} is running — the template is never started; stop it first`
      if (check || dryRun) warn(line)
      else if (!force) {
        problems.push(`${line} (or pass --force)`)
        return finish()
      } else warn(`${line} (--force)`)
    }

    // ── What is on it now ──────────────────────────────────────────────────
    const remoteManifestBytes = await client.downloadFile(server.id, IMAGE_MANIFEST_PATH)
    let remoteManifest = null
    if (remoteManifestBytes) {
      try {
        const parsed = JSON.parse(remoteManifestBytes.toString('utf8'))
        if (parsed.manifestVersion === MANIFEST_VERSION) remoteManifest = parsed
        else warn(`the template's manifest is version ${parsed.manifestVersion}; refreshing it`)
      } catch {
        warn(`${IMAGE_MANIFEST_PATH} on the template is not JSON; refreshing it`)
      }
    }
    // The listing is a body the vendor's own OpenAPI never describes (T15's
    // note), so it is used where it helps and dropped where it surprises: if
    // the entries are not `{path, size}` the cross-check is skipped rather
    // than turned into 500 phantom uploads.
    const listed = new Map()
    let listingUsable = true
    for (const entry of await client.listFiles(server.id)) {
      if (typeof entry?.path === 'string' && typeof entry?.size === 'number')
        listed.set(entry.path, entry.size)
      else listingUsable = false
    }
    if (!listingUsable)
      warn(
        'the file listing is not the {path, size} shape the fake models — not cross-checking sizes',
      )
    const gameinfo = await client.downloadFile(server.id, GAMEINFO_PATH)

    /**
     * A file has to move when the manifest does not know it, when its hash
     * changed, or when the *listing* disagrees with the manifest — the last
     * one is the case a manifest alone would miss: somebody edited a plugin
     * through the control panel and the record still claims our bytes. An
     * edit that kept the byte count exactly is beyond what a listing can
     * see, and downloading five hundred files to hash them is not what a
     * refresh is for; `--force` is the way to re-upload everything.
     */
    const uploads = files.filter(file => {
      // `--force` is a *write* instruction; under `--check` it would turn
      // every file into a false accusation.
      if (force && !check) return true
      const recorded = remoteManifest?.files?.[file.path]
      if (!recorded || recorded.sha256 !== file.sha256) return true
      return listingUsable && listed.get(file.path) !== file.size
    })
    const stale = remoteManifest
      ? Object.keys(remoteManifest.files ?? {}).filter(
          path => !files.some(file => file.path === path),
        )
      : []
    const gameinfoNeedsLoader =
      gameinfo !== null && !gameinfo.toString('utf8').includes(METAMOD_GAMEINFO_NEEDLE)
    const drift = settingsDrift(server, { slots })

    result.uploads = uploads.length
    result.unchanged = files.length - uploads.length
    result.stale = stale
    result.drift = drift

    if (stale.length > 0) {
      warn(
        `${stale.length} file(s) this tree no longer ships are still on the template ` +
          `(${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ', …' : ''}) — the vendor's ` +
          'API cannot delete a file; remove them in the control panel',
      )
    }
    if (gameinfo === null) {
      warn(
        `no ${GAMEINFO_PATH} at the template's file root — Metamod's loader line cannot be ` +
          "checked from here. T19's live smoke is where the real file manager's layout " +
          'settles; the server’s own console will say whether Metamod loaded.',
      )
    }

    // ── --check ────────────────────────────────────────────────────────────
    if (check) {
      if (!remoteManifest) problems.push(`the template carries no ${IMAGE_MANIFEST_PATH}`)
      else {
        for (const [what, expected] of Object.entries(pins)) {
          const actual = remoteManifest.pins?.[what]
          if (actual !== expected)
            problems.push(
              `the template carries ${what} ${actual ?? 'nothing'}, docker/cs2/Dockerfile ` +
                `pins ${expected} (docs/pins.md)`,
            )
        }
        if (build && remoteManifest.revision !== build.commit)
          problems.push(
            `the template was built from ${remoteManifest.revision}, this tree is ${build.commit}`,
          )
        if (listingUsable)
          for (const path of Object.keys(remoteManifest.files ?? {}))
            if (!listed.has(path)) problems.push(`${path} is in the manifest but not on the server`)
      }
      // Every stale file named would be 500 lines the day the manifest is
      // missing; ten and a count is what an operator can act on.
      for (const file of uploads.slice(0, 10))
        problems.push(`${file.path} on the template is not this tree's file`)
      if (uploads.length > 10)
        problems.push(`…and ${uploads.length - 10} more files that are not this tree's`)
      for (const line of drift) problems.push(`settings: ${line}`)
      if (gameinfoNeedsLoader)
        problems.push(`${GAMEINFO_PATH} has no Metamod loader line — no plugin would load`)
      if (problems.length === 0)
        say(`ok: ${files.length} files, the pins and the settings all match this tree`)
      return finish()
    }

    // ── --dry-run ──────────────────────────────────────────────────────────
    if (dryRun) {
      say(
        `would upload ${uploads.length} file(s) and leave ${files.length - uploads.length} ` +
          'unchanged',
      )
      for (const file of uploads.slice(0, 10)) say(`  + ${file.path}`)
      if (uploads.length > 10) say(`  … and ${uploads.length - 10} more`)
      for (const line of drift) say(`  ~ settings: ${line}`)
      if (gameinfoNeedsLoader) say(`  ~ ${GAMEINFO_PATH}: add Metamod's loader line`)
      say(
        uploads.length + drift.length > 0 || gameinfoNeedsLoader
          ? 'would then sync-files, so the next duplicate clones this'
          : 'nothing to do — the template is this tree',
      )
      return finish()
    }

    // ── Build ──────────────────────────────────────────────────────────────
    // Settings first: if the upload is interrupted the template is at least
    // protected from deletion and cannot be started by an autostop rule.
    if (drift.length > 0) {
      say(`settings: ${drift.length > 0 ? drift.join('; ') : 'planting the template marker'}`)
      await client.updateServer(server.id, {
        ...templateSettings({ slots }),
        // Only ever cleared, never set: a token on the template is inherited
        // by every clone (T17 leases one per allocation).
        ...(server.cs2_settings?.steam_game_server_login_token && {
          'cs2_settings.steam_game_server_login_token': '',
        }),
      })
    }

    if (uploads.length === 0) say('files: already this tree, nothing to upload')
    else {
      say(`files: uploading ${uploads.length} of ${files.length}…`)
      let done = 0
      const queue = [...uploads]
      const worker = async () => {
        for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
          await client.uploadFile(server.id, file.path, readFileSync(join(tree.dir, file.source)))
          done += 1
          if (done % 50 === 0 || done === uploads.length)
            say(`files: ${done}/${uploads.length} uploaded`)
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, uploads.length) }, worker),
      )
    }

    if (gameinfoNeedsLoader) {
      const lines = gameinfo.toString('utf8').split('\n')
      const anchor = lines.findIndex(line => line.includes(GAMEINFO_ANCHOR))
      if (anchor === -1) {
        warn(`${GAMEINFO_PATH} has no ${GAMEINFO_ANCHOR} line to anchor Metamod to — left alone`)
      } else {
        lines.splice(anchor + 1, 0, METAMOD_GAMEINFO_LINE)
        await client.uploadFile(server.id, GAMEINFO_PATH, Buffer.from(lines.join('\n'), 'utf8'))
        say(`${GAMEINFO_PATH}: Metamod's loader line added`)
        result.gameinfoPatched = true
      }
    }

    const manifest = buildManifest({
      pins,
      build,
      image: tree.image,
      files,
      at: now(),
    })
    await client.uploadFile(
      server.id,
      IMAGE_MANIFEST_PATH,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    )

    // Last, and never skipped: `duplicate` copies the API's cache, and the
    // cache is what this call refreshes.
    await client.syncFiles(server.id)
    result.synced = true
    say('sync-files: done — the next duplicate clones exactly this')
    say(`EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID=${server.id}`)
    return finish()
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
    return finish()
  }
}

// Run when invoked, importable when a test wants to hand it a fake Dathost.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main()
}
