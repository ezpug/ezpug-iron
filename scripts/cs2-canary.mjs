#!/usr/bin/env node
// The dev-node canary, for the image (PRD-10 T4).
//
//   pnpm cs2:canary                              eight boots, then retakes and pug-2v1
//   pnpm cs2:canary --boots 3 --rows retakes
//   pnpm cs2:canary --lock-token "$(cat token)"  inside somebody's hold of the lane
//   node scripts/cs2-canary.mjs --help
//
// "Boot a bump several times before you trust it" was a sentence in
// `docs/pins.md` (git1468 hung in 6 of 9 boots, git1469 booted 12 of 12). This
// is the verb. It takes the CS2 lane, refuses while any CS2 container runs,
// brings the `cs2-data` volume to Steam's public build if it trails, boots the
// image N times through the dev orchestrator's `nodes` provider — a match per
// boot, cancelled the moment it is `ready` — timing each boot to
// CounterStrikeSharp's first console line and to `server_ready`, then plays the
// named lane rows inside the same hold. One verdict lands in
// `.verify/cs2-canary-<build>.json` and one line on stdout.
//
// Red is a boot that hangs past 60 s, a `Failed to find signature`, a crash, a
// boot that fails, or a red row. A refusal (the lane, a running container, an
// image older than the tree, a volume Steam will not update) is not a verdict
// about the build: it writes no file and exits 2, naming what stopped it.
//
// `pnpm game:follow` (T5) calls it, and the HUD drill's step 2
// (`docs/hud.md`) is it.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  describeLaneLock,
  LANE_LOCK_PATH,
  readLaneLock,
  refreshLaneLock,
  releaseLaneLock,
  takeLaneLock,
  wallClock,
} from './cs2-lane-lock.mjs'
import { readPins } from './dathost-image.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A boot that has not said `server_ready` this long after its request is a hang (the git1468 kind). */
export const BOOT_HANG_MS = 60_000
/** The rows a canary plays when none are named: the update canary, and a plain MatchZy pug. */
export const DEFAULT_ROWS = ['retakes', 'pug-2v1']
export const DEFAULT_BOOTS = 8
/** A hold longer than the lock's 90-minute corpse age refreshes its stamp this often. */
export const LANE_REFRESH_MS = 20 * 60_000
/** What a server's console says when the build outran the plugins, and when it died. */
export const FATAL_CONSOLE = [
  { pattern: /Failed to find signature/, name: 'Failed to find signature' },
  { pattern: /Engine2PreBreakpadDumpFunction/, name: 'Engine2PreBreakpadDumpFunction' },
  { pattern: /SERVER EXITED/, name: 'SERVER EXITED' },
  { pattern: /Segmentation fault|exited with code 139/, name: 'segfault' },
]
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is what the console prints
const CONSOLE_COLOURS = /\x1b\[[0-9;]*m/g
/** CounterStrikeSharp's first line at boot (`CSSharp: Initializing with command line: …`). */
export const CSS_FIRST_LINE = /CSSharp: Initializing/

const HELP = `cs2-canary — boot the CS2 image on the dev node and play lane rows (PRD-10 T4)

  --boots <n>            how many boots; default ${DEFAULT_BOOTS}
  --rows <a,b>           lane rows (cs2.extended.test.ts ids) to play after the
                         boots; default ${DEFAULT_ROWS.join(',')}; 'none' plays none
  --lock-token <token>   play inside a hold of the lane somebody else has
  --lock-wait <minutes>  how long to queue for the lane; default 45
  --no-install           refuse instead of running cs2:install when the volume
                         trails Steam's public build
  --base-url <url>       the dev orchestrator; default $EZPUG_IRON_BASE_URL or
                         http://127.0.0.1:3430
  --json                 print the verdict as JSON instead of the one line
  --help

Exit 0 green, 1 red, 2 refused (nothing was judged).`

// ---------------------------------------------------------------------------
// The parts a test can hold
// ---------------------------------------------------------------------------

/** The flags, checked. Throws a `Refusal` for anything it cannot use. */
export function parseArgs(argv) {
  const options = {
    boots: DEFAULT_BOOTS,
    rows: DEFAULT_ROWS,
    lockToken: null,
    lockWaitMs: 45 * 60_000,
    install: true,
    baseUrl: null,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Refusal('usage', `${flag} needs a value`)
      return next
    }
    if (flag === '--boots') {
      options.boots = Number(value())
      if (!Number.isInteger(options.boots) || options.boots < 1 || options.boots > 50)
        throw new Refusal('usage', '--boots is a whole number from 1 to 50')
    } else if (flag === '--rows') {
      const rows = value()
      options.rows = rows === 'none' ? [] : rows.split(',').filter(Boolean)
    } else if (flag === '--lock-token') options.lockToken = value()
    else if (flag === '--lock-wait') options.lockWaitMs = Number(value()) * 60_000
    else if (flag === '--no-install') options.install = false
    else if (flag === '--base-url') options.baseUrl = value()
    else if (flag === '--json') options.json = true
    else if (flag === '--help' || flag === '-h') options.help = true
    else throw new Refusal('usage', `unknown flag ${flag}`)
  }
  return options
}

/** A stop that judged nothing: the verb names it and exits 2. */
export class Refusal extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** `PatchVersion=1.41.9.2` and friends, out of `steam.inf`. */
export function readSteamInf(text) {
  const field = name => text.match(new RegExp(`^${name}=(\\S+)`, 'm'))?.[1] ?? null
  return { patchVersion: field('PatchVersion'), sourceRevision: field('SourceRevision') }
}

/** `"buildid"		"26144732"`, out of `appmanifest_730.acf`. */
export function readAppManifestBuildId(text) {
  return text.match(/"buildid"\s+"(\d+)"/)?.[1] ?? null
}

/**
 * Valve's keyless update check answers the build a server must run:
 * `message: "Server version required: 1.41.9.2"`, or the same number with its
 * dots removed in `required_version` — which cannot be put back together, so
 * only the message is read (`docs/operations.md`, "The build, by its three names").
 */
export function readUpToDateCheck(json) {
  const message = json?.response?.message
  return typeof message === 'string' ? (message.match(/(\d+(?:\.\d+){2,})/)?.[1] ?? null) : null
}

/** What one console line says about a boot: the first CounterStrikeSharp line, or a fatal one. */
export function classifyConsoleLine(line) {
  const clean = line.replace(CONSOLE_COLOURS, '')
  const fatal = FATAL_CONSOLE.find(f => f.pattern.test(clean))
  if (fatal) return { kind: 'fatal', name: fatal.name, line: clean.trim().slice(0, 240) }
  if (CSS_FIRST_LINE.test(clean)) return { kind: 'css' }
  return null
}

/**
 * Why `cs2:install` failed, by its cause. The one cause with a name is the
 * September 2026 one (`docs/operations.md`, "When Steam will not serve a
 * delta"): `install-game.sh` already revalidates once by itself, so a second
 * failure is not retried here either.
 */
export function installFailure(output) {
  if (/Access Denied|state is 0x6/.test(output))
    return (
      'Steam will not serve a delta to this volume: it fell behind a build Valve has pruned ' +
      "(Failed to get manifest request code, 'Access Denied' / state 0x6) and install-game.sh's " +
      'own revalidation did not recover it — not retried; read docs/operations.md, ' +
      '"When Steam will not serve a delta"'
    )
  if (/needs at least \d+MB|No space left/i.test(output))
    return 'cs2:install ran out of disk; tidy (scripts/docker-hygiene.sh) and run it again'
  const last = output.trim().split('\n').slice(-3).join(' / ')
  return `cs2:install failed: ${last.slice(0, 300) || 'no output'}`
}

/** The verdict's file, under `.verify/` beside the other runs' reports. */
export function verdictPath(build, root = repo) {
  return join(root, '.verify', `cs2-canary-${String(build).replace(/[^\w.-]/g, '_')}.json`)
}

/**
 * **The proof a green run leaves in the tree** (PRD-10 T8, decision 41):
 * `docker/cs2/proven.json`, the build these pins went green on and whether
 * the `hud-on` row was among the green ones. The next `pnpm cs2:build` bakes
 * it into the image, a node agent states it in its `hello`, and the
 * orchestrator holds every node's volume against it. `pnpm game:follow`
 * commits it with the pins it proves.
 */
export const PROOF_PATH = 'docker/cs2/proven.json'

export function proofOf(verdict, boots) {
  return {
    build: verdict.build,
    hud: verdict.rows['hud-on'] === 'green',
    // The keys `GAME_PINS` and the image's own `pins.json` use.
    pins: {
      counterStrikeSharp: verdict.pins.counterstrikesharp,
      metamod: verdict.pins.metamod,
      multiAddonManager: verdict.pins.multiaddonmanager,
      matchzy: verdict.pins.matchzy,
    },
    rows: verdict.rows,
    boots,
    image: verdict.image,
    at: verdict.at,
  }
}

/** The one line a human (or T5's log) reads. */
export function verdictLine(verdict) {
  const boots = verdict.boots.map(b =>
    b.readyMs === null ? '—' : `${(b.readyMs / 1000).toFixed(1)}s`,
  )
  const rows = Object.entries(verdict.rows)
    .map(([id, state]) => `${id} ${state}`)
    .join(', ')
  return (
    `cs2:canary ${verdict.state} on CS2 ${verdict.build} with image ${verdict.image}: ` +
    `${verdict.boots.length} boot${verdict.boots.length === 1 ? '' : 's'} (${boots.join(' ')})` +
    (rows ? `; rows: ${rows}` : '') +
    (verdict.reason ? ` — ${verdict.reason}` : '')
  )
}

/**
 * **The canary, with every hand on the box injected.** `deps`:
 *
 * - `lane`: `{ read(), take({ waitMs, what }), refresh(token), release(token) }`
 * - `clock`: `{ now(), sleep(ms) }`; `every(ms, fn)` → a stop function
 * - `runningContainers()`: names of CS2 containers running now
 * - `image()`: `{ ref, revision, counterStrikeSharp }` (the image's `build.json`)
 * - `treePins()`: the Dockerfile's pins
 * - `steamBuild()`: Steam's public PatchVersion, or `null` when nothing answered
 * - `volumeBuild()`: `{ patchVersion, sourceRevision, buildId }`, or `null` without a game
 * - `install()`: `{ ok, output }`
 * - `prepare()`: before the first boot (the dev orchestrator is there, the fleet is empty)
 * - `boot(n)`: `{ cssMs, readyMs, failure }`
 * - `row(id, token)`: `{ ok, detail }`
 * - `finish()`: after the last boot or row, before the lane is given back
 * - `write(path, verdict)`, `say(line)`
 * - `prove(proof)`: a green run's {@link PROOF_PATH}
 *
 * Resolves with `{ verdict }` or rejects with a `Refusal`.
 */
export async function runCanary(options, deps) {
  const { clock, lane, say } = deps
  let token = options.lockToken
  let owned = false
  let stopRefreshing = null
  if (token) {
    const held = lane.read()
    if (held?.token !== token)
      throw new Refusal(
        'lane',
        `told the CS2 lane is held for this run, and it is ${held === null ? 'free' : `held by ${describeLaneLock(held)}`}`,
      )
    say(`inside a hold of the CS2 lane (${describeLaneLock(held)})`)
  } else {
    let taken
    try {
      taken = await lane.take({ waitMs: options.lockWaitMs, what: 'cs2:canary (PRD-10 T4)' })
    } catch (error) {
      throw new Refusal('lane', error instanceof Error ? error.message : String(error))
    }
    token = taken.entry.token
    owned = true
    say('took the CS2 lane')
    // Boots, an install and two rows can outlast the lock's 90-minute corpse
    // age; a living holder says so by refreshing its stamp, on a timer so a
    // 67 GB install in one call is covered too.
    stopRefreshing = deps.every(LANE_REFRESH_MS, () => lane.refresh(token))
  }

  try {
    const running = deps.runningContainers()
    if (running.length > 0)
      throw new Refusal(
        'container',
        `a CS2 container is running (${running.join(', ')}); the canary boots its own — ` +
          'stop it (`pnpm cs2:down`, or end its match) and run again',
      )

    const image = deps.image()
    const pins = deps.treePins()
    if (image.counterStrikeSharp !== pins.counterstrikesharp)
      throw new Refusal(
        'image',
        `the image ${image.ref} (${image.revision}) carries CounterStrikeSharp ${image.counterStrikeSharp} ` +
          `and the tree pins ${pins.counterstrikesharp} — run \`pnpm cs2:build\` first`,
      )

    const steam = await deps.steamBuild()
    let volume = deps.volumeBuild()
    if (steam === null) say("Steam's public build could not be read; judging the volume's own")
    if (volume === null || (steam !== null && volume.patchVersion !== steam)) {
      const was =
        volume === null
          ? 'no game in the cs2-data volume'
          : `the volume is on ${volume.patchVersion}`
      if (!options.install || steam === null)
        throw new Refusal(
          'volume',
          `${was}${steam ? `, Steam's public build is ${steam}` : ''} — run \`pnpm cs2:install\` ` +
            '(the lane held, no container running)',
        )
      say(`${was}, Steam's public build is ${steam}: cs2:install`)
      const installed = await deps.install()
      if (!installed.ok) throw new Refusal('install', installFailure(installed.output))
      volume = deps.volumeBuild()
      if (volume === null || volume.patchVersion !== steam)
        throw new Refusal(
          'install',
          `cs2:install finished and the volume is on ${volume?.patchVersion ?? 'nothing'}, not ${steam}`,
        )
    }
    const build = volume.patchVersion
    say(
      `CS2 ${build} (source revision ${volume.sourceRevision ?? '?'}, Steam build ${volume.buildId ?? '?'})`,
    )

    await deps.prepare()
    const boots = []
    const rows = {}
    let reason = null
    let bootsRed = false
    for (let n = 1; n <= options.boots; n++) {
      const boot = await deps.boot(n)
      boots.push(boot)
      const css = boot.cssMs === null ? '—' : `${(boot.cssMs / 1000).toFixed(1)}s`
      const ready = boot.readyMs === null ? '—' : `${(boot.readyMs / 1000).toFixed(1)}s`
      say(
        `boot ${n}/${options.boots}: CounterStrikeSharp ${css}, server_ready ${ready}${boot.failure ? ` — ${boot.failure}` : ''}`,
      )
      if (boot.failure) {
        reason = `boot ${n}: ${boot.failure}`
        bootsRed = true
        break
      }
    }
    for (const id of options.rows) {
      if (bootsRed) {
        rows[id] = 'skipped'
        continue
      }
      say(`row ${id}…`)
      const row = await deps.row(id, token)
      rows[id] = row.ok ? 'green' : 'red'
      say(`row ${id}: ${rows[id]}${row.detail ? ` — ${row.detail}` : ''}`)
      if (!row.ok && reason === null) reason = `row ${id} red${row.detail ? `: ${row.detail}` : ''}`
    }

    const verdict = {
      build,
      sourceRevision: volume.sourceRevision ?? null,
      steamBuildId: volume.buildId ?? null,
      image: image.revision,
      imageRef: image.ref,
      pins,
      boots: boots.map(b => ({ cssMs: b.cssMs, readyMs: b.readyMs })),
      rows,
      state: reason === null ? 'green' : 'red',
      reason,
      at: new Date(clock.now()).toISOString(),
    }
    deps.write(verdictPath(build), verdict)
    if (verdict.state === 'green') deps.prove(proofOf(verdict, options.boots))
    return { verdict }
  } finally {
    // The run's key goes whatever happened, before the lane is given back.
    await deps.finish()
    stopRefreshing?.()
    if (owned && lane.release(token)) say('released the CS2 lane')
  }
}

// ---------------------------------------------------------------------------
// The real box
// ---------------------------------------------------------------------------

function sh(command, args, options = {}) {
  return spawnSync(command, args, { cwd: repo, encoding: 'utf8', ...options })
}

function envValue(name, fallback) {
  const result = sh('node', [
    '--env-file-if-exists=.env',
    '-e',
    `process.stdout.write(process.env[${JSON.stringify(name)}] ?? ${JSON.stringify(fallback)})`,
  ])
  return result.stdout
}

const COMPOSE = ['compose', '-f', 'compose.cs2.yaml']

function realDeps(options) {
  const clock = wallClock
  const imageRef = envValue('EZPUG_IRON_CS2_IMAGE', 'ghcr.io/ezpug/ezpug-iron/cs2:dev')
  const baseUrl = options.baseUrl ?? envValue('EZPUG_IRON_BASE_URL', 'http://127.0.0.1:3430')
  const build = { dir: null }
  const say = line => process.stderr.write(`\x1b[36m[cs2:canary]\x1b[0m ${line}\n`)

  /** Every container, running, started from the CS2 image or named like one. */
  const cs2Containers = () => {
    const out = sh('docker', ['ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}']).stdout ?? ''
    return out
      .split('\n')
      .filter(Boolean)
      .map(line => line.split('\t'))
      .filter(
        ([, name, image]) =>
          /ezpug-iron\/cs2|^ezpug-iron-cs2$|^ezpug-node-/.test(`${image}`) ||
          /^ezpug-iron-cs2$|^ezpug-node-/.test(name),
      )
      .map(([id, name]) => ({ id, name }))
  }

  let api = null
  let keyId = null
  let adminKeyId = null
  let admin = null
  const call = secret => async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    const json = text ? JSON.parse(text) : null
    if (!response.ok)
      throw new Error(
        `${method} ${path} → ${response.status} ${json?.error?.message ?? text.slice(0, 200)}`,
      )
    return json
  }

  const fleetEmpty = async (withinMs, what) => {
    const until = clock.now() + withinMs
    for (;;) {
      const { servers } = await api('GET', '/v1/fleet/servers')
      if (servers.length === 0) return true
      if (clock.now() >= until)
        throw new Error(`the fleet still lists ${servers.map(s => s.id).join(', ')} ${what}`)
      await clock.sleep(2_000)
    }
  }

  return {
    clock,
    say,
    every: (ms, fn) => {
      // biome-ignore lint/plugin: the lane lock is wall-clock by nature (cs2-lane-lock.mjs)
      const timer = setInterval(fn, ms)
      return () => clearInterval(timer)
    },
    lane: {
      read: () => readLaneLock(),
      take: ({ waitMs, what }) => takeLaneLock({ what, waitMs, clock }),
      refresh: token => refreshLaneLock(LANE_LOCK_PATH, token, { clock }),
      release: token => releaseLaneLock(LANE_LOCK_PATH, token),
    },
    runningContainers: () => cs2Containers().map(c => c.name),
    image: () => {
      const result = sh('docker', [
        'run',
        '--rm',
        '--entrypoint',
        'cat',
        imageRef,
        '/opt/ezpug/addons/counterstrikesharp/plugins/EZPug.Core/build.json',
      ])
      if (result.status !== 0)
        throw new Refusal(
          'image',
          `the image ${imageRef} does not exist or has no build.json — run \`pnpm cs2:build\``,
        )
      const json = JSON.parse(result.stdout)
      return { ref: imageRef, revision: json.commit, counterStrikeSharp: json.counterStrikeSharp }
    },
    treePins: () => readPins(readFileSync(join(repo, 'docker/cs2/Dockerfile'), 'utf8')),
    steamBuild: async () => {
      try {
        const response = await fetch(
          'https://api.steampowered.com/ISteamApps/UpToDateCheck/v1/?appid=730&version=0',
          { signal: AbortSignal.timeout(15_000) },
        )
        return response.ok ? readUpToDateCheck(await response.json()) : null
      } catch {
        return null
      }
    },
    volumeBuild: () => {
      const result = sh('docker', [
        ...COMPOSE,
        'run',
        '--rm',
        '--no-deps',
        '--entrypoint',
        '/bin/bash',
        'cs2',
        '-c',
        'test -x "$EZPUG_CS2_ROOT/game/bin/linuxsteamrt64/cs2" || exit 3; ' +
          'cat "$EZPUG_CS2_ROOT/game/csgo/steam.inf"; echo ---; ' +
          'cat "$EZPUG_CS2_ROOT/steamapps/appmanifest_730.acf" 2>/dev/null',
      ])
      if (result.status !== 0) return null
      const [inf, acf = ''] = result.stdout.split('\n---\n')
      const { patchVersion, sourceRevision } = readSteamInf(inf)
      return patchVersion
        ? { patchVersion, sourceRevision, buildId: readAppManifestBuildId(acf) }
        : null
    },
    install: () =>
      new Promise(resolve => {
        const child = spawn('./scripts/cs2-env.sh', ['install', '--yes'], { cwd: repo })
        let output = ''
        const keep = chunk => {
          output = (output + chunk.toString()).slice(-20_000)
          process.stderr.write(chunk)
        }
        child.stdout.on('data', keep)
        child.stderr.on('data', keep)
        child.on('close', code => resolve({ ok: code === 0, output }))
      }),
    prepare: async () => {
      try {
        await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(5_000) })
      } catch {
        throw new Refusal(
          'orchestrator',
          `no dev orchestrator answers at ${baseUrl} — \`pnpm dev\`, then \`pnpm dev:node up\``,
        )
      }
      const minted = process.env.EZPUG_IRON_ADMIN_KEY ? null : mintAdminKey()
      adminKeyId = minted?.id ?? null
      admin = call(process.env.EZPUG_IRON_ADMIN_KEY ?? minted.secret)
      const created = await admin('POST', '/v1/keys', {
        name: `cs2-canary-${randomUUID().slice(0, 8)}`,
        scopes: ['matches', 'fleet'],
        budget: { maxConcurrentServers: 1, maxServerLifetimeMinutes: 10, monthlyCents: 0 },
        webhookSecrets: [{ id: 'whsec-cs2-canary', secret: `cs2-canary-${randomUUID()}` }],
      })
      keyId = created.key.id
      api = call(created.secret)
      const { providers } = await api('GET', '/v1/fleet/providers')
      const nodes = providers.find(p => p.id === 'nodes')
      if (!nodes)
        throw new Refusal(
          'orchestrator',
          `the orchestrator at ${baseUrl} has no \`nodes\` provider (EZPUG_IRON_PROVIDERS)`,
        )
      if (!nodes.healthy || nodes.drained)
        throw new Refusal(
          'orchestrator',
          `the \`nodes\` provider is ${nodes.drained ? 'drained' : `unhealthy (${nodes.lastError ?? 'no reason'})`} — \`pnpm dev:node up\``,
        )
      await fleetEmpty(10 * 60_000, 'after ten minutes, before the first boot')
    },
    boot: async n => {
      const startedAt = clock.now()
      build.dir ??= join(
        repo,
        '.cache',
        'cs2-canary',
        new Date(startedAt).toISOString().replace(/[:.]/g, '-'),
      )
      mkdirSync(build.dir, { recursive: true })
      const seen = new Set(cs2Containers().map(c => c.id))
      const match = await api('POST', '/v1/matches', bootRequest(n))
      const result = { cssMs: null, readyMs: null, failure: null }
      let follower = null
      const logFile = createWriteStream(join(build.dir, `boot-${n}.log`))
      const tail = []
      try {
        for (;;) {
          const elapsed = clock.now() - startedAt
          if (follower === null) {
            const fresh = cs2Containers().find(c => !seen.has(c.id))
            if (fresh) {
              follower = spawn('docker', ['logs', '-f', fresh.id])
              const onLine = chunk => {
                // `docker logs -f` can still flush after the boot is done with it.
                if (!logFile.writableEnded) logFile.write(chunk)
                for (const line of chunk.toString().split('\n')) {
                  tail.push(line)
                  if (tail.length > 20) tail.shift()
                  const said = classifyConsoleLine(line)
                  if (said?.kind === 'css' && result.cssMs === null)
                    result.cssMs = clock.now() - startedAt
                  if (said?.kind === 'fatal' && result.failure === null)
                    result.failure = `${said.name}: ${said.line}`
                }
              }
              follower.stdout.on('data', onLine)
              follower.stderr.on('data', onLine)
            }
          }
          if (result.failure) break
          const now = await api('GET', `/v1/matches/${match.id}`)
          if (now.state === 'ready' || now.state === 'live') {
            result.readyMs =
              Date.parse(now.readyAt ?? '') - Date.parse(now.createdAt) || clock.now() - startedAt
            break
          }
          if (['failed', 'ended', 'cancelled'].includes(now.state)) {
            result.failure = `the match ended ${now.state} (${now.endedReason ?? 'no reason'}) before server_ready`
            break
          }
          if (elapsed > BOOT_HANG_MS) {
            const last = tail
              .filter(l => l.trim())
              .slice(-2)
              .join(' / ')
              .replace(CONSOLE_COLOURS, '')
              .slice(0, 240)
            result.failure =
              `no server_ready ${BOOT_HANG_MS / 1000} s after the request (a hang; ` +
              `${result.cssMs === null ? 'CounterStrikeSharp never spoke' : 'CounterStrikeSharp had spoken'}` +
              `${last ? `; last console: ${last}` : ''})`
            break
          }
          await clock.sleep(500)
        }
      } finally {
        const now = await api('GET', `/v1/matches/${match.id}`).catch(() => null)
        if (now?.state === 'live')
          await api('POST', `/v1/matches/${match.id}/commands`, {
            type: 'force_end',
            correlationId: `cs2-canary-end-${n}`,
            reason: 'cs2:canary boot measured',
          }).catch(() => {})
        else if (now && !['failed', 'ended', 'cancelled'].includes(now.state))
          await api('POST', `/v1/matches/${match.id}/cancel`).catch(() => {})
        await fleetEmpty(3 * 60_000, `three minutes after boot ${n}`)
        follower?.stdout.removeAllListeners('data')
        follower?.stderr.removeAllListeners('data')
        follower?.kill()
        logFile.end()
      }
      return result
    },
    row: async (id, token) => {
      const log = createWriteStream(join(build.dir ?? '/tmp', `row-${id}.log`))
      const code = await new Promise(resolve => {
        const child = spawn('pnpm', ['exec', 'vitest', 'run', 'src/cs2.extended.test.ts'], {
          cwd: join(repo, 'apps/orchestrator'),
          env: {
            ...process.env,
            EZPUG_CS2_TESTS: 'required',
            EZPUG_CS2_CASES: id,
            EZPUG_CS2_LANE_TOKEN: token,
          },
        })
        child.stdout.pipe(log)
        child.stderr.pipe(log)
        child.on('close', resolve)
      })
      return {
        ok: code === 0,
        detail:
          code === 0
            ? null
            : `vitest exited ${code}; ${join(build.dir ?? '/tmp', `row-${id}.log`)}`,
      }
    },
    finish: async () => {
      if (admin && keyId) await admin('DELETE', `/v1/keys/${keyId}`).catch(() => {})
      if (admin && adminKeyId) await admin('DELETE', `/v1/keys/${adminKeyId}`).catch(() => {})
    },
    prove: proof => {
      writeFileSync(join(repo, PROOF_PATH), `${JSON.stringify(proof, null, 2)}\n`)
    },
    write: (path, verdict) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(verdict, null, 2)}\n`)
    },
  }
}

function mintAdminKey() {
  const result = sh('pnpm', [
    '--silent',
    '--filter',
    '@ezpug/orchestrator',
    'keys:mint',
    '--',
    '--name',
    `cs2-canary-admin-${randomUUID().slice(0, 8)}`,
    '--scopes',
    'admin',
  ])
  const secret = (result.stdout ?? '').trim().split('\n').pop() ?? ''
  if (!secret.startsWith('ezik_'))
    throw new Refusal(
      'orchestrator',
      `could not mint an admin key (${(result.stderr ?? '').trim() || 'no output'})`,
    )
  // `keys:mint` names the id it minted on stderr; the run revokes the key by it when it is done.
  const id = (result.stderr ?? '').match(/minted API key ([0-9a-f-]{36})/)?.[1] ?? null
  return { secret, id }
}

/**
 * One boot is one match: a `pug` on `de_dust2` with nobody on it, pinned to
 * the dev node, cancelled the moment it is `ready`. No bots: a boot is the
 * server coming up, and the rows after it are where matches are played.
 */
export function bootRequest(n) {
  return {
    clientMatchId: `cs2-canary-boot-${n}-${randomUUID().slice(0, 8)}`,
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'Canary A', players: [] },
      teamB: { name: 'Canary B', players: [] },
    },
    maps: [{ map: 'de_dust2', sides: 'ct' }],
    rules: {
      regulationRounds: 2,
      overtime: { enabled: false, maxRounds: 6, startMoney: 10_000 },
      warmup: { minPlayersToReady: 0, minSpectatorsToReady: 0 },
    },
    requirements: { provider: 'nodes' },
    callbacks: {
      webhookUrl: 'https://webhooks.invalid/cs2-canary',
      webhookSecretId: 'whsec-cs2-canary',
    },
    branding: { hostname: `EZPug · cs2:canary · boot ${n}`, eventName: 'cs2-canary' },
    ttlMinutes: 10,
  }
}

/** The ids `cs2.extended.test.ts` knows, so a typo is refused before the lane is taken. */
export function laneRowIds(root = repo) {
  const text = readFileSync(join(root, 'apps/orchestrator/src/cs2.extended.test.ts'), 'utf8')
  return [...text.matchAll(/^\s+id: '([\w-]+)',$/gm)].map(m => m[1])
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`cs2:canary: ${error.message}\n${HELP}\n`)
    return 2
  }
  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  const known = laneRowIds()
  const unknown = options.rows.filter(id => !known.includes(id))
  if (unknown.length > 0) {
    process.stderr.write(
      `cs2:canary refused (usage): no lane row ${unknown.join(', ')} in cs2.extended.test.ts\n`,
    )
    return 2
  }
  try {
    const { verdict } = await runCanary(options, realDeps(options))
    process.stdout.write(
      options.json ? `${JSON.stringify(verdict, null, 2)}\n` : `${verdictLine(verdict)}\n`,
    )
    return verdict.state === 'green' ? 0 : 1
  } catch (error) {
    if (error instanceof Refusal) {
      process.stdout.write(`cs2:canary refused (${error.code}): ${error.message}\n`)
      return 2
    }
    throw error
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main()
}
