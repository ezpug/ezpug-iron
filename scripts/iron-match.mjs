#!/usr/bin/env node
// One real match, end to end, through the Match API — and everything it said,
// written down (PRD-02 T13).
//
//   pnpm iron:match                       a pug on the dev node, bots, four rounds
//   pnpm iron:match --write-fixtures      …and update the recorded fixtures
//   pnpm iron:match --gamemode flying-scoutsman --no-demo
//   node scripts/iron-match.mjs --help
//
// The point is not that a match runs: the point is that plugin, MatchZy,
// orchestrator and contract are recorded agreeing. The script is a client and
// nothing more — it holds an API key, POSTs a match, listens on a webhook
// endpoint of its own and on the match's stream, and reads the events route.
// The two conversations a client cannot see (the `/link` and `/node` frames,
// the payloads MatchZy POSTs) come from the orchestrator's own trace file,
// which is why it has to have been started with `EZPUG_IRON_TRACE_FILE` set;
// without one the run still happens and says what it could not record.
//
// Nothing it writes holds a secret: the trace is scrubbed as it is written
// (`apps/orchestrator/src/trace.ts`) and everything here goes through
// `scrub()` again, which also rebases every timestamp and every identity onto
// the fixtures' own so a second run produces the same bytes.
import { spawnSync } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repo, 'apps/orchestrator/package.json'))
/** `ws`, because Node's own WebSocket cannot send an Authorization header. */
const WebSocket = require('ws')
/**
 * The published package, from its build — the same bytes a client installs.
 * Loaded lazily because `--rebuild` needs nothing from it and a fresh clone's
 * `dist/` does not exist until `pnpm build` has run.
 */
async function matchApi() {
  const dist = join(repo, 'packages/match-api/dist/index.js')
  try {
    return await import(pathToFileURL(dist).href)
  } catch {
    return die(`no build at ${dist} — run \`pnpm build\` first`)
  }
}

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------

const HELP = `iron-match — run one real match through the Match API and record it (PRD-02 T13)

  --gamemode <id>        default pug
  --map <name>           default de_dust2
  --rounds <n>           mp_maxrounds; even, default 4
  --bots <n>             bot_quota, default 10; 0 leaves the server empty
  --no-overtime          allow a drawn map — MatchZy then replays it, so the run hangs
  --max-live-minutes <n> force-end a match still live after this long; default 35
  --base-url <url>       default $EZPUG_IRON_BASE_URL
  --trace <file>         the orchestrator's trace; default $EZPUG_IRON_TRACE_FILE
  --out <dir>            where the run is written; default .cache/iron-match/<run>
  --no-demo              do not mint a demo upload URL
  --write-fixtures       update the recorded fixtures from this run
  --rebuild <dir>        write the files again from a finished run's raw.json,
                         without playing another match
  --timeout-minutes <n>  give up and cancel after this long; default 45
  --json                 print the run summary as JSON and nothing else
  --help
`

function args(argv) {
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

const flags = args(process.argv.slice(2))
if (flags.has('help')) {
  process.stdout.write(HELP)
  process.exit(0)
}

try {
  process.loadEnvFile(join(repo, '.env'))
} catch {
  // A fresh clone has no .env; the process environment is all there is.
}

const QUIET = flags.get('json') === 'true'
const say = line => {
  if (!QUIET) process.stderr.write(`\x1b[36m[iron-match]\x1b[0m ${line}\n`)
}
const die = line => {
  process.stderr.write(`\x1b[31m[iron-match] error:\x1b[0m ${line}\n`)
  process.exit(1)
}

const BASE_URL = (
  flags.get('base-url') ??
  process.env.EZPUG_IRON_BASE_URL ??
  process.env.EZPUG_IRON_PUBLIC_URL ??
  'http://127.0.0.1:3430'
).replace(/\/+$/, '')
const GAMEMODE = flags.get('gamemode') ?? 'pug'
/**
 * The first synthetic SteamID64 a bot is known by — `EZPug.Sdk`'s `BotIdentity`,
 * the one rule the plugin, the harness and the sim all follow. A BigInt because
 * 17 digits do not survive a double.
 */
const BOT_STEAM_ID_BASE = 90000000000000000n
const MAP = flags.get('map') ?? 'de_dust2'
const ROUNDS = Number(flags.get('rounds') ?? 4)
/**
 * `bot_quota` — a head count, because `gamemodes/pug/cfg/ezpug/pug.cfg` puts
 * the server in `bot_quota_mode normal`. Ten is a full 5v5; the *when* of it is
 * the interesting part and lives down in the poll loop.
 */
const BOTS = Number(flags.get('bots') ?? 10)
const WANT_DEMO = flags.get('no-demo') !== 'true'
/**
 * Overtime is **on** by default and that is a finding, not a preference: with
 * an even `mp_maxrounds` and no overtime a map can end 2–2, and MatchZy reads
 * a drawn map in a Bo1 as a series nobody has won yet — `HandleMatchEnd` logs
 * `remainingMaps: 1` and replays the same map instead of sending `series_end`
 * (seen on this box). A recording that hangs is not a recording.
 */
const OVERTIME = flags.get('no-overtime') !== 'true'
const WRITE_FIXTURES = flags.get('write-fixtures') === 'true'
const TIMEOUT_MS = Number(flags.get('timeout-minutes') ?? 45) * 60_000
/**
 * The orchestrator's trace, found rather than assumed. A **relative**
 * `EZPUG_IRON_TRACE_FILE` — which is what `.env.example` and
 * `docs/operations.md` both show — is resolved by each process against its own
 * working directory, and the orchestrator's is its package (`pnpm dev` runs the
 * task there, `pnpm --filter … start` too) while this script's is the repo. So
 * both are looked in, repo first, and neither existing is fatal below rather
 * than a run that plays a whole match and records an empty conversation.
 */
const TRACE_FLAG = flags.get('trace') ?? process.env.EZPUG_IRON_TRACE_FILE ?? null
const TRACE_FILE = (() => {
  if (!TRACE_FLAG) return null
  if (isAbsolute(TRACE_FLAG)) return TRACE_FLAG
  const candidates = [join(repo, TRACE_FLAG), join(repo, 'apps/orchestrator', TRACE_FLAG)]
  return candidates.find(path => existsSync(path)) ?? candidates[0]
})()
/**
 * How long a live match may run before it is force-ended.
 *
 * A four-round match with bots usually clinches at 3–1 and MatchZy sends
 * `series_end` by itself, which is the run worth recording. It does not
 * always: a 2–2 map goes to overtime, and the engine works its overtime
 * clinch out from the `mp_maxrounds 24` MatchZy's own `live.cfg` sets rather
 * than the 4 the match config re-applies a second later — so it plays on past
 * the point either side has won and a run can wander for half an hour. This
 * is the wall in front of that: the match ends `force_ended`, the ledger row
 * closes, and the summary says which of the two happened.
 */
// A match stays `live` past its own `series_end` while the orchestrator holds
// the server open for the demo (PRD-02 T21): GOTV records the delayed broadcast,
// so MatchZy stops recording a `tv_delay` after the last round and the plugin
// uploads what settles. The force-end is the wall for a match that wandered into
// overtime, and it has to sit above the play *plus* that window.
const MAX_LIVE_MS = Number(flags.get('max-live-minutes') ?? 35) * 60_000
/**
 * **The wall clock, in one place.** Everything else in this repo runs on the
 * injected clock from `@ezpug/core` and the determinism guard makes a bare
 * `Date.now()` an error — rightly, because anything that must reproduce must
 * be able to be moved through time. This script is the exception the guard's
 * escape hatch exists for: it drives a real CS2 server on real hardware in
 * real time, so its "wait for the bots" and "give up after twenty minutes"
 * are wall-clock facts with nothing to inject. It is confined here so there
 * is exactly one place to read, and the recordings it writes are rebased onto
 * a fixed epoch anyway (see {@link makeScrubber}).
 */
const wall = {
  // biome-ignore lint/plugin: an operator script driving real hardware in real time
  now: () => Date.now(),
  // biome-ignore lint/plugin: as above — a presigned URL is signed at a wall-clock instant
  at: () => new Date(),
  // biome-ignore lint/plugin: as above — there is no clock to arm a timer on
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

const RUN_ID = `iron-match-${wall.at().toISOString().replace(/[:.]/g, '-')}`
const OUT_DIR = flags.get('rebuild') ?? flags.get('out') ?? join(repo, '.cache/iron-match', RUN_ID)

if (!Number.isInteger(ROUNDS) || ROUNDS <= 0 || ROUNDS % 2 !== 0)
  die('--rounds must be a positive even number (the Match API refuses anything else)')

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** Every call this script made, in order — the `calls` half of the recording. */
const calls = []

/** How many times a `429` is waited out before a call is given up on. */
const RATE_LIMIT_RETRIES = 6

function makeApi(secret) {
  return async function api(method, path, body) {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      const json = text ? JSON.parse(text) : null
      // **A 429 is a wait, not a failure** (`docs/match-api.md`). It matters
      // most in the cleanup: this script's last act is to release a running
      // CS2 server, and a run that had just been rate-limited used to give
      // that up and leave the container standing.
      if (response.status === 429 && attempt <= RATE_LIMIT_RETRIES) {
        const after =
          Number(response.headers.get('retry-after') ?? 1) * 1000 ||
          json?.error?.details?.retryAfterMs
        say(`rate limited on ${method} ${path.replace(/\?.*$/, '')}; waiting ${after} ms`)
        await wall.sleep(Math.min(Math.max(after, 250), 10_000))
        continue
      }
      calls.push({
        route: `${method} ${path.replace(/\?.*$/, '')}`,
        status: response.status,
        ok: response.ok,
        ...(body !== undefined && { request: body }),
        response: json,
      })
      if (!response.ok) {
        const detail = json?.error
          ? `${json.error.code}: ${json.error.message}`
          : text.slice(0, 200)
        throw new Error(`${method} ${path} → ${response.status} ${detail}`)
      }
      return json
    }
  }
}

/**
 * Mint a key from the box. The API's own `POST /v1/keys` needs a key with
 * `admin`, and the first one has to come from somewhere: the orchestrator's
 * `keys:mint` script is that somewhere, and it prints the secret once.
 */
function mintKey(name, scopes) {
  const result = spawnSync(
    'pnpm',
    [
      '--silent',
      '--filter',
      '@ezpug/orchestrator',
      'keys:mint',
      '--',
      '--name',
      name,
      '--scopes',
      scopes,
    ],
    { cwd: repo, encoding: 'utf8' },
  )
  const secret = (result.stdout ?? '').trim().split('\n').pop() ?? ''
  if (!secret.startsWith('ezik_'))
    die(`could not mint an API key (${(result.stderr ?? '').trim() || 'no output'})`)
  return secret
}

// ---------------------------------------------------------------------------
// The demo target: a presigned PUT into the platform's dev MinIO
// ---------------------------------------------------------------------------

/**
 * SigV4 for one PUT, by hand. The alternative is an SDK dependency in a repo
 * that has no other use for one; presigning is a hash chain and forty lines.
 * The credentials come from the platform's own `.env` on this box and are
 * never written anywhere — the URL that carries the signature is scrubbed out
 * of everything this script records.
 */
function presignPut({
  endpoint,
  region,
  accessKey,
  secretKey,
  bucket,
  key,
  expiresIn = 3600,
  now,
}) {
  const url = new URL(`${endpoint.replace(/\/+$/, '')}/${bucket}/${key}`)
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const date = stamp.slice(0, 8)
  const scope = `${date}/${region}/s3/aws4_request`
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  })
  const canonical = [
    'PUT',
    url.pathname,
    [...query.entries()]
      .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&'),
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const toSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n')
  let signing = Buffer.from(`AWS4${secretKey}`, 'utf8')
  for (const part of [date, region, 's3', 'aws4_request'])
    signing = createHmac('sha256', signing).update(part).digest()
  query.set('X-Amz-Signature', createHmac('sha256', signing).update(toSign).digest('hex'))
  url.search = query.toString()
  return url.toString()
}

/** The platform's dev world is beside this one on this box; read its S3 settings, never copy them. */
function platformS3() {
  const env = {}
  try {
    for (const line of readFileSync('/root/ezpug/.env', 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    return null
  }
  if (!env.EZPUG_S3_ENDPOINT || !env.EZPUG_S3_ACCESS_KEY || !env.EZPUG_S3_SECRET_KEY) return null
  return {
    endpoint: env.EZPUG_S3_ENDPOINT,
    region: env.EZPUG_S3_REGION || 'us-east-1',
    accessKey: env.EZPUG_S3_ACCESS_KEY,
    secretKey: env.EZPUG_S3_SECRET_KEY,
    bucket: (env.EZPUG_S3_BUCKETS || 'demos').split(',')[0].trim(),
  }
}

// ---------------------------------------------------------------------------
// The trace: the orchestrator's own recording of what no client can see
// ---------------------------------------------------------------------------

function traceOffset() {
  if (!TRACE_FILE) return null
  try {
    return statSync(TRACE_FILE).size
  } catch {
    return 0
  }
}

function readTrace(from) {
  if (!TRACE_FILE || from === null) return []
  let text = ''
  try {
    text = readFileSync(TRACE_FILE, 'utf8').slice(from)
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Scrubbing: no secret, no address, no wall clock, no random id
// ---------------------------------------------------------------------------

/** Where every recorded timestamp is rebased to, so two runs write the same bytes. */
const FIXTURE_EPOCH = Date.parse('2026-01-01T00:00:00.000Z')

/**
 * `FIXTURE_MATCH_ID` from `@ezpug/match-api/fixtures` — the id every recorded
 * file in this repo calls the match it is about.
 */
const FIXTURE_MATCH_ID = '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b'

/**
 * Replace every identity and every timestamp with a stable one. `identities`
 * maps a real string to its fixture form; `origin` is the wall clock the
 * timestamps are measured from. Timestamps are *rebased*, not made relative:
 * a fixture whose `at` no longer parses as a date is a fixture no schema
 * accepts, and the deltas are the fact worth keeping.
 */
function makeScrubber(identities, origin, numbers = new Map()) {
  const uuids = new Map(Object.entries(identities))
  let anonymous = 0
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
  const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
  /** This service's token grammar (`apps/orchestrator/src/tokens.ts`), anywhere in any string. */
  const TOKENS = /ezi[kesnp]_[A-Za-z0-9_-]{8,}/g
  /**
   * Keys whose value is a secret whatever it looks like. A link token is
   * replaced by something **the protocol's own schema still accepts** —
   * `linkTokenSchema` wants sixteen characters, and a fixture whose `hello`
   * no longer parses proves nothing — carrying the mark every fixture in this
   * repo uses to say it is not one (`FIXTURE_TOKEN_MARK`).
   */
  const SECRET_KEYS = new Map([
    ['secret', '<redacted>'],
    // Not a secret — it is what `keys list` shows an operator — but twelve
    // characters of a real key have no business in a committed file.
    ['prefix', '<redacted>'],
    ['apiKey', '<redacted>'],
    ['password', '<redacted>'],
    ['token', 'not-a-secret_recorded_link_token'],
    ['serverToken', 'not-a-secret_recorded_server_token'],
    ['nodeToken', 'not-a-secret_recorded_node_token'],
  ])
  /** A presigned PUT: the path is a fact, the query is a signature. */
  const PRESIGNED_KEYS = new Set(['demoUploadUrl'])
  const REDACTED = '<redacted>'

  const string = value => {
    const mapped = uuids.get(value)
    if (mapped !== undefined) return mapped
    // `replace` and not `test`: a global regex carries `lastIndex` between
    // calls and would skip every other match.
    const detokenised = value.replace(TOKENS, REDACTED)
    if (detokenised !== value) return detokenised
    if (UUID.test(value)) {
      anonymous += 1
      const fixture = `00000000-0000-4000-8000-${String(anonymous).padStart(12, '0')}`
      uuids.set(value, fixture)
      return fixture
    }
    if (ISO.test(value)) {
      const rebased = new Date(FIXTURE_EPOCH + (Date.parse(value) - origin))
      return rebased.toISOString()
    }
    let out = value
    for (const [real, fixture] of uuids) if (out.includes(real)) out = out.replaceAll(real, fixture)
    return out.replace(IPV4, '127.0.0.1')
  }

  const walk = value => {
    if (typeof value === 'string') return string(value)
    if (typeof value === 'number') return numbers.get(value) ?? value
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, item] of Object.entries(value)) {
        if (SECRET_KEYS.has(key) && typeof item === 'string') out[key] = SECRET_KEYS.get(key)
        else if (PRESIGNED_KEYS.has(key) && typeof item === 'string')
          out[key] = `${item.split('?')[0]}?${REDACTED}`
        else out[key] = walk(item)
      }
      return out
    }
    return value
  }
  return walk
}

/** `matchzySerial` from `apps/orchestrator/src/match-config/matchzy.ts`, verbatim. */
function matchzySerial(matchId) {
  const serial = createHash('sha256').update(matchId).digest().readUInt32BE(0) & 0x7fff_ffff
  return serial === 0 ? 1 : serial
}

/** The canonical bytes every fixture file in this repo is written in. */
function stringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const cleanups = []
let cleaning = false
async function cleanUp() {
  if (cleaning) return
  cleaning = true
  for (const step of cleanups.reverse()) {
    try {
      await step()
    } catch (error) {
      say(`cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// A Ctrl-C is not a licence to leave a CS2 container running and a ledger row
// open: the same cleanup the happy path runs, then the signal's exit code.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    say(`${signal}: cleaning up`)
    void cleanUp().finally(() => process.exit(130))
  })
}

async function run() {
  const startedAt = wall.now()
  const traceFrom = traceOffset()
  if (TRACE_FILE) {
    // **A named trace that is not there is a stop, not a shrug.** Without this
    // the run plays a whole match and then writes an empty `LinkExchange` over
    // a good fixture — "verified" by nobody, which is the one thing this
    // recording exists not to be.
    if (!existsSync(TRACE_FILE))
      die(
        `no trace at ${TRACE_FILE} (nor under apps/orchestrator/) — start the ` +
          'orchestrator with EZPUG_IRON_TRACE_FILE set and let it write at least one ' +
          'frame before recording a match.',
      )
    say(`recording the orchestrator's trace from ${TRACE_FILE}`)
  } else
    say(
      'no trace file: link frames and MatchZy payloads will not be recorded ' +
        '(start the orchestrator with EZPUG_IRON_TRACE_FILE=<file>)',
    )

  // 1. A key of this run's own, with a webhook secret nobody else holds.
  const adminSecret = mintKey(`${RUN_ID}-admin`, 'admin')
  const admin = makeApi(adminSecret)
  const webhookSecret = `iron-match-${randomUUID()}`
  const created = await admin('POST', '/v1/keys', {
    name: RUN_ID,
    scopes: ['matches', 'fleet', 'admin'],
    budget: { maxConcurrentServers: 2, maxServerLifetimeMinutes: 60, monthlyCents: 0 },
    webhookSecrets: [{ id: 'whsec-iron-match', secret: webhookSecret }],
  })
  const keyId = created.key.id
  const api = makeApi(created.secret)
  cleanups.push(async () => {
    await admin('DELETE', `/v1/keys/${keyId}`)
    say(`revoked the run's key`)
  })

  // 2. The webhook endpoint, verified with the published verifier.
  const { verifyWebhook } = await matchApi()
  const deliveries = []
  const webhookServer = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => (body += chunk))
    request.on('end', async () => {
      // The bytes that arrived are what the HMAC is over — verified before
      // anything parses them, which is the rule the published verifier states.
      const verified = await verifyWebhook({
        headers: request.headers,
        body,
        secrets: { 'whsec-iron-match': webhookSecret },
        clock: wall,
      })
      deliveries.push({
        signature: verified.ok ? 'verified' : `refused: ${verified.reason}`,
        attempt: verified.ok ? verified.attempt : 1,
        envelope: verified.ok ? verified.envelope : JSON.parse(body),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
  })
  await new Promise(resolve => webhookServer.listen(0, '127.0.0.1', resolve))
  const webhookUrl = `http://127.0.0.1:${webhookServer.address().port}/webhook`
  cleanups.push(() => new Promise(resolve => webhookServer.close(resolve)))

  // 3. Where the demo goes: a presigned PUT into the platform's dev MinIO.
  let demoUploadUrl
  const s3 = WANT_DEMO ? platformS3() : null
  if (WANT_DEMO && !s3)
    say('no S3 credentials beside this box: the match runs without a demo target')
  if (s3) {
    demoUploadUrl = presignPut({
      ...s3,
      key: `iron-match/${RUN_ID}.dem`,
      expiresIn: 6 * 3600,
      now: wall.at(),
    })
    say(`demo target: ${s3.endpoint}/${s3.bucket}/iron-match/${RUN_ID}.dem`)
  }

  // 3b. **Who owns the flow.** A `matchzy` mode needs a `css_start` and an empty
  //     server before it (below); a `plugin` or `none` mode needs neither — the
  //     SDK's generic emitter reads the flow off the engine (PRD-02 T22), so the
  //     mode's own cfg decides when warmup ends and nothing here drives it. The
  //     catalog is asked rather than the checkout, because what the orchestrator
  //     serves is what the server was assigned.
  const catalog = await api('GET', '/v1/gamemodes')
  const manifest = catalog.gamemodes.find(mode => mode.id === GAMEMODE)
  if (!manifest) die(`the orchestrator serves no gamemode "${GAMEMODE}"`)
  const FLOW = manifest.flow
  // EZ Rating is drawn only where the manifest asks for it, and a bots run can
  // only push a profile into a roster that is open (T27, the step in the loop).
  const RATED = manifest.capabilities.scoreboardRating && manifest.slots.openJoin
  // **Skins over the link** (PRD-02 T28, decision 20): the orchestrator enables the
  // WeaponPaints fork only when a roster entry carries a loadout, so an open-join
  // run rosters one player nobody will be — a loadout on the request is what turns
  // the folder on — and pushes a loadout with every bot profile. What that proves
  // is the hand-off, seen as the core plugin's `skins:` console lines (below): a
  // bot is never dressed, by upstream's own `IsBot` checks, so the pixels are a
  // human's. Not on a `matchzy` flow: a rostered player MatchZy waits for would
  // stall a match that `css_start` is meant to start.
  const SKINNED = manifest.slots.openJoin && FLOW !== 'matchzy'
  /** The loadout every link fixture carries (`packages/protocol/src/fixtures.ts`): tk's karambit. */
  const LOADOUT = {
    t: {
      weapons: [
        {
          defindex: 7,
          paintId: 490,
          wear: 0.12,
          seed: 661,
          nametag: 'lauwarm',
          stattrak: true,
          stattrakCount: 1337,
          stickers: [{ id: 4, x: 0.5, y: -0.25 }],
          keychain: { id: 20, seed: 7 },
        },
      ],
      knife: 'weapon_knife_karambit',
      gloves: 5027,
      agent: 'customplayer_tm_leet_variantg',
      music: 3,
      pin: 874,
    },
    ct: { weapons: [{ defindex: 60, paintId: 1231 }] },
  }
  say(`gamemode ${GAMEMODE} v${manifest.version}: flow ${FLOW}, records ${manifest.records}`)

  // 4. The request. Bots, four rounds, no overtime, nobody rostered — MatchZy
  //    plays it out and `css_start` is what starts it, because a bot never
  //    types `.ready`.
  const request = {
    clientMatchId: RUN_ID,
    game: 'cs2',
    gamemode: GAMEMODE,
    teams: {
      teamA: {
        name: 'EZPug A',
        // The one rostered player, with a loadout, so the skins layer is enabled (SKINNED,
        // above). They never connect: the SteamID is the first bot identity's, which the
        // profile pushes below carry too, so the core holds exactly one loadout for it.
        players: SKINNED
          ? [
              {
                steamId64: String(BOT_STEAM_ID_BASE),
                name: 'EZ Bot 0',
                locale: 'de',
                loadout: LOADOUT,
              },
            ]
          : [],
      },
      teamB: { name: 'EZPug B', players: [] },
    },
    maps: [{ map: MAP, sides: 'ct' }],
    rules: {
      regulationRounds: ROUNDS,
      // **Overtime is where the wall clock goes.** Ten bots are evenly matched,
      // so a four-round map draws 2-2 more often than not and the overtime
      // decides it: six more rounds, drawn again about a third of the time, six
      // more after that. Sixteen rounds at a minute and a half is why
      // {@link MAX_LIVE_MS} is thirty-five minutes rather than fifteen — a
      // match force-ended in the middle cuts GOTV off and the run records no
      // demo, which is the one thing this run exists to produce, and a run on
      // this box reached `series_end` eight seconds the wrong side of a
      // twenty-five minute wall. Two rounds of overtime was tried and is worse,
      // not better: one round a side splits 1-1 far more often than six rounds
      // split 3-3.
      overtime: { enabled: OVERTIME, maxRounds: 6, startMoney: 10_000 },
      warmup: { minPlayersToReady: 0, minSpectatorsToReady: 0 },
      // These travel in the match config, which MatchZy re-applies a second
      // after its own `live.cfg` — so the quota below is what the *match* runs
      // with whatever that cfg did to it. `bot_quota_mode` is deliberately not
      // among them: the mode is the server's, set once in `ezpug/pug.cfg` while
      // the server is empty, and changing it with bots standing evicts GOTV
      // along with them (PRD-02 T21a).
      cvars: {
        // **A short freeze time, and nothing else about the round.** Eighteen
        // seconds a round of bots standing still is four minutes of a run that
        // has to finish inside {@link MAX_LIVE_MS}; five is plenty for a buy
        // nobody makes. This travels in the match config, which MatchZy applies
        // *after* its own `live.cfg`, so it is the last word.
        //
        // **`mp_roundtime` is deliberately left alone.** Cutting it to a minute
        // was tried while the runs that motivated it were still losing every
        // round to the CT side on the clock — which turned out to be the bots
        // not fighting at all (`bot_quota_mode`, above), not the length of the
        // round. It was reverted rather than kept on a reason that had already
        // been shown to be something else; a shorter round is a change somebody
        // can make later, on a measurement of its own.
        mp_freezetime: '5',
        ...(BOTS > 0 && {
          bot_difficulty: '2',
          bot_join_after_player: '0',
          // **`bot_quota` travels here for every flow, which is the point of a request's
          // `rules.cvars`.** It did not always: the loader used to exec the mode's cfg and
          // set these cvars into the *same* console frame, and the engine reconciles the
          // bot population once at the end of one — so a `bot_kick` or a `bot_quota_mode`
          // switch in a mode's cfg evicted whoever was standing and a `bot_quota` beside
          // it could not bring them back. Measured on the dev node with
          // `flying-scoutsman`: bots kicked at 1.2 s, `going_live` at 21 s, an empty
          // server for twenty minutes — then one `bot_quota 10` over RCON and ten bots
          // inside a second. This script asked over RCON for a while because it could; a
          // client cannot, and must not have to. The loader gives the cfg a frame of its
          // own now and everything the assignment asks for the next
          // (`GamemodeLoader.CvarSettleMs`, PRD-02 T22a), so the quota simply arrives with
          // the map. A `matchzy` flow still dances in the poll loop below, for a different
          // reason: MatchZy's own `warmup.cfg` and `live.cfg` move the quota themselves.
          bot_quota: String(BOTS),
        }),
      },
    },
    requirements: { lan: true },
    callbacks: {
      webhookUrl,
      webhookSecretId: 'whsec-iron-match',
      ...(demoUploadUrl && { demoUploadUrl }),
    },
    warmupLines: ['Willkommen bei EZPug.', 'Welcome to EZPug.'],
    branding: { hostname: `EZPug · ${GAMEMODE} · ${MAP}`, eventName: 'iron-match' },
    ttlMinutes: 60,
  }

  const match = await api('POST', '/v1/matches', request)
  const matchId = match.id
  say(`match ${matchId} created (${match.state})`)
  // The server is money and a running CS2 container either way: whatever
  // happens below, this match does not outlive the run.
  cleanups.push(async () => {
    const latest = await api('GET', `/v1/matches/${matchId}`)
    if (['ended', 'failed', 'cancelled'].includes(latest.state)) return
    say(`cancelling ${matchId} (${latest.state})`)
    if (latest.state === 'live')
      await api('POST', `/v1/matches/${matchId}/commands`, {
        correlationId: `${RUN_ID}-force-end`,
        type: 'force_end',
        reason: 'the iron-match run is over',
      })
    else await api('POST', `/v1/matches/${matchId}/cancel`)
  })

  // 5. The stream, from the moment the match exists.
  const streamFrames = []
  const socket = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/v1/matches/${matchId}/stream`, {
    headers: { authorization: `Bearer ${created.secret}` },
  })
  socket.on('message', data => {
    try {
      streamFrames.push(JSON.parse(data.toString()))
    } catch {
      // A frame that is not JSON is the orchestrator's problem, and it has none.
    }
  })
  socket.on('error', error => say(`stream: ${error.message}`))
  cleanups.push(() => {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'done')
  })

  // 6. Watch it play. Force-start once the server says it is ready: nobody is
  //    rostered, so MatchZy waits for a `.ready` that will never come.
  const TERMINAL = ['ended', 'failed', 'cancelled']
  const rcon = (command, tag) =>
    api('POST', `/v1/matches/${matchId}/commands`, {
      correlationId: `${RUN_ID}-${tag}`,
      type: 'rcon',
      command,
    })
  /**
   * The `scoreboard:` line of `ezpug_status` — EZ Rating read back off the
   * controllers rather than off what was asked for (PRD-02 T27).
   *
   * Two doors, in this order and for a reason. RCON *runs* the command: a node
   * opens a Source RCON socket on the game port, which is the only way to make
   * the plugin print anything on demand. RCON does not *read* it: a
   * `SERVER_ONLY` CounterStrikeSharp command answers on the server console, so
   * the RCON reply is empty (measured here). The report also goes into the
   * plugin's console buffer, and `GET /v1/fleet/servers/:id/console` is what
   * hands that back. Null rather than a failure at every step — this is a check
   * on the way past, never a reason to lose a match.
   */
  const readScoreboard = async id => {
    try {
      const rows = await api('GET', '/v1/fleet/servers')
      const row = rows.servers.find(server => server.matchId === id)
      if (!row) return null
      await api('POST', `/v1/fleet/servers/${row.id}/rcon`, { command: 'ezpug_status' })
      await wall.sleep(1_000)
      const tail = await api('GET', `/v1/fleet/servers/${row.id}/console`)
      return (
        tail.lines
          .map(entry => entry.line.trim())
          .filter(line => line.includes('scoreboard:'))
          .at(-1) ?? null
      )
    } catch (error) {
      return `unreadable: ${error.message}`
    }
  }
  /**
   * The core plugin's `skins:` console lines (PRD-02 T28): every loadout handed to
   * the skins layer and every profile it was told to re-read, off the same console
   * buffer the scoreboard line comes from. Null rather than a failure at every step.
   */
  const readSkins = async id => {
    try {
      const rows = await api('GET', '/v1/fleet/servers')
      const row = rows.servers.find(server => server.matchId === id)
      if (!row) return null
      const tail = await api('GET', `/v1/fleet/servers/${row.id}/console`)
      const lines = tail.lines
        .map(entry => entry.line.trim())
        .filter(line => line.includes('skins:'))
      return { lines: lines.length, last: lines.at(-1) ?? null }
    } catch (error) {
      return { lines: 0, last: `unreadable: ${error.message}` }
    }
  }
  let emptied = false
  let filled = false
  let polls = 0
  let rated = false
  let ratedAt = 0
  let scoreboard = null
  let skins = null
  let warmupEnded = false
  let started = false
  let liveAt = 0
  let forced = false
  let last = match.state
  let final = match
  const deadline = startedAt + TIMEOUT_MS
  while (wall.now() < deadline) {
    await wall.sleep(5_000)
    const now = await api('GET', `/v1/matches/${matchId}`)
    final = now
    if (now.state !== last) {
      say(
        `${last} → ${now.state}${now.connect ? ` (${now.connect.host}:${now.connect.port})` : ''}`,
      )
      last = now.state
    }
    if (TERMINAL.includes(now.state)) break
    if (now.state === 'live' && liveAt === 0) liveAt = wall.now()
    if (!forced && liveAt > 0 && wall.now() - liveAt >= MAX_LIVE_MS) {
      forced = true
      say(`still live after ${MAX_LIVE_MS / 60_000} minutes: ending it`)
      await api('POST', `/v1/matches/${matchId}/commands`, {
        correlationId: `${RUN_ID}-force-end`,
        type: 'force_end',
        reason: `still live after ${MAX_LIVE_MS / 60_000} minutes`,
      })
      continue
    }
    if (now.state !== 'ready' && now.state !== 'live') continue

    // **EZ Rating on the scoreboard** (PRD-02 T27), on real hardware, without a
    // human: a bot has no Steam account but it does have a SteamID64 the whole
    // tree agrees on (`BotIdentity`, slot + 90000000000000000), so the platform
    // can push a `profile` for one exactly as it would for a person who joined
    // open. Only for a gamemode whose manifest asks for the number *and* opens
    // its roster — anywhere else the push is refused, correctly, and there is
    // nothing to see. One poll's grace first, so the bots the loader asked for
    // are standing when the profiles land.
    if (RATED && !rated && polls++ > 0) {
      rated = true
      ratedAt = polls
      for (let slot = 0; slot < Math.max(BOTS, 2); slot++) {
        await api('POST', `/v1/matches/${matchId}/commands`, {
          correlationId: `${RUN_ID}-profile-${slot}`,
          type: 'profile',
          player: {
            steamId64: String(BOT_STEAM_ID_BASE + BigInt(slot)),
            name: `EZ Bot ${slot}`,
            locale: slot % 2 === 0 ? 'de' : 'en',
            rating: 1000 + slot * 111,
            rankName: 'Iron',
            // The loadout travels with the profile the way it would for a person who
            // joined open (T28); the core says `skins:` for each one it is handed.
            ...(SKINNED && { loadout: LOADOUT }),
          },
        })
      }
      say(`pushed ${Math.max(BOTS, 2)} bot profiles${SKINNED ? ' with loadouts' : ''}`)
      continue
    }

    // …and read the numbers back a few polls later, off the controllers rather
    // than off what was asked for. Later on purpose: a bot's competitive fields
    // are reset by the engine at every spawn, so the only honest moment to look
    // is once the match is standing and everybody has spawned at least once
    // (measured — read at `ready`, only the players who had already spawned
    // showed a number).
    if (rated && scoreboard === null && polls++ > ratedAt + 3) {
      scoreboard = await readScoreboard(matchId)
      say(`scoreboard: ${scoreboard ?? 'not readable'}`)
      if (SKINNED) {
        skins = await readSkins(matchId)
        say(
          `skins: ${skins ? `${skins.lines} console lines, last: ${skins.last}` : 'not readable'}`,
        )
      }
    }

    // **The bots arrive after the match goes live, not before it** — and that
    // order is the whole reason this box records a demo at all (PRD-02 T21a).
    //
    // Two engine facts decide it, both measured on this box against CS2
    // 1.41.7.8 with one command per boot:
    //
    //  - The GOTV client counts as one of the bots the engine may evict. Under
    //    `bot_quota_mode normal` (and `fill`), a `bot_quota` that *drops* while
    //    bots are standing takes SourceTV with it — and MatchZy's `live.cfg`
    //    opens with exactly that drop. A drop with nothing to drop is a
    //    no-change, fires no callback and evicts nobody; so is every *rise*.
    //  - Bots under `bot_quota_mode competitive` — the mode
    //    `gamemode_competitive.cfg` sets at every map load, and the one mode
    //    whose purge does spare GOTV — do not fight. Ten of them played seven
    //    rounds with zero kills and zero damage between them, every round to
    //    the CT side on the clock, so the map cannot be decided and no
    //    `series_end` ever comes. `normal` bots play properly.
    //
    // So `gamemodes/pug/cfg/ezpug/pug.cfg` puts the server in `normal` while
    // the quota is zero, this empties the server *before* `css_start` so
    // `live.cfg`'s drop is a no-op, and the bots are asked for once the match
    // is live and the only way left is up.
    //
    // The cost is that `live.cfg`'s own `mp_warmup_end` runs on an empty server
    // and ends nothing, so the warmup is ended here instead, a poll after the
    // bots are in. A `mp_warmup_end` outside warmup does nothing, which is what
    // makes it safe to send unconditionally.
    if (now.state === 'ready') {
      // A mode whose flow is nobody's plugin starts itself and fills itself: the
      // loader set the request's `bot_quota` a beat after the mode's cfg (T22a),
      // so the bots are already standing, and the SDK's generic emitter ends the
      // warmup twenty seconds after the map is up with `going_live` the round
      // after (PRD-02 T22). Nothing to force and nothing to empty — `live.cfg` is
      // MatchZy's file and no other flow has one — so there is nothing to do here
      // at all, which is the shape a client should have.
      if (FLOW !== 'matchzy') continue
      if (BOTS > 0 && !emptied) {
        emptied = true
        say('emptying the server before the start, so `live.cfg` cannot take GOTV with it')
        await rcon('bot_kick; bot_quota 0', 'empty')
        continue
      }
      if (!started) {
        started = true
        say('forcing the start (`css_start`): a bot never readies up')
        await rcon('css_start', 'start')
      }
      continue
    }

    // Live. The bots, then the warmup, one poll apart — MatchZy's order, and
    // only its. Another flow already had both before it went live.
    if (FLOW !== 'matchzy') continue
    if (BOTS > 0 && !filled) {
      filled = true
      say(`filling the server with ${BOTS} bots`)
      await rcon(`bot_quota ${BOTS}`, 'bots')
      continue
    }
    if (BOTS > 0 && !warmupEnded) {
      warmupEnded = true
      await rcon('mp_warmup_end', 'warmup-end')
    }
  }
  if (!TERMINAL.includes(final.state)) say(`gave up after ${TIMEOUT_MS / 60_000} minutes`)

  // 7. Let the last envelopes land, then read everything back the way a client
  //    that missed a webhook would.
  await wall.sleep(5_000)
  // Every page: the route is a replay of the whole durable log and the last
  // page is where `match.ended` lives.
  //
  // **An empty page is the end, whatever the cursor says.** The route only
  // returns a null `nextCursor` once the reader has caught up *and the match
  // is terminal* (`machine.ts`) — deliberately, so a client can tail a live
  // match — so a run that gave up on a match still playing would otherwise
  // spin on the same cursor at full speed until the rate limiter stopped it.
  const envelopes = []
  for (let cursor = '0'; cursor !== null; ) {
    const page = await api('GET', `/v1/matches/${matchId}/events?cursor=${cursor}&limit=200`)
    if (page.items.length === 0) break
    envelopes.push(...page.items)
    cursor = page.nextCursor
  }
  const ledger = await api('GET', `/v1/fleet/ledger?since=${new Date(startedAt).toISOString()}`)
  const fleet = await api('GET', '/v1/fleet/servers')

  return {
    run: RUN_ID,
    forced,
    matchId,
    flow: FLOW,
    request,
    match: final,
    envelopes,
    ledger,
    fleet,
    deliveries,
    streamFrames,
    trace: readTrace(traceFrom),
    startedAt,
    demoTarget: s3 ? `${s3.endpoint}/${s3.bucket}/iron-match/${RUN_ID}.dem` : null,
    scoreboard,
    skins,
  }
}

// ---------------------------------------------------------------------------
// Writing it down
// ---------------------------------------------------------------------------

/**
 * The link exchange, **without the ephemeral tier**. `position_tick` is
 * stream-only by decision 6 — never stored, never replayed — so a file in the
 * tree that held one would be storing it, and a five-minute match's ticks are
 * nine tenths of the bytes and none of the meaning. The `ack` a tick-only
 * batch earned goes with it, or the recording would acknowledge frames it
 * does not contain.
 */
/** What `match.ended` said became of this match's demos, or `null` before it landed. */
function demoOutcome(envelopes) {
  return envelopes.find(envelope => envelope.payload.type === 'match.ended')?.payload.demo ?? null
}

function exchanges(trace, kind) {
  const bySocket = new Map()
  const dropped = new Set()
  for (const entry of trace) {
    if (entry.kind !== kind) continue
    let frame = entry.frame
    if (frame?.type === 'events') {
      const kept = []
      for (const sequenced of frame.events) {
        if (sequenced.event.type === 'position_tick') dropped.add(sequenced.seq)
        else kept.push(sequenced)
      }
      if (kept.length === 0) continue
      frame = { ...frame, events: kept }
    }
    if (frame?.type === 'ack' && frame.results.every(result => dropped.has(result.seq))) continue
    const list = bySocket.get(entry.socket) ?? []
    list.push(entry.close ? { from: entry.from, close: entry.close } : { from: entry.from, frame })
    bySocket.set(entry.socket, list)
  }
  return bySocket
}

function write(result) {
  mkdirSync(OUT_DIR, { recursive: true })

  const identities = {
    [result.matchId]: FIXTURE_MATCH_ID,
    [result.request.clientMatchId]: 'iron-match-recorded',
  }
  if (result.match.serverId) identities[result.match.serverId] = 'devbox-1'
  // MatchZy knows the match by a serial derived from its id
  // (`match-config/matchzy.ts` `matchzySerial`): scrub the id and leave the
  // serial and the two no longer agree, which is exactly what the door
  // checks. Both move together.
  const scrub = makeScrubber(
    identities,
    result.startedAt,
    new Map([[matchzySerial(result.matchId), matchzySerial(FIXTURE_MATCH_ID)]]),
  )

  const link = [...exchanges(result.trace, 'link').values()].flat()
  const node = [...exchanges(result.trace, 'node').values()].flat()
  // **The wire, and only the wire.** What MatchZy sent is evidence and never
  // changes; what the orchestrator made of it is a decision that does — the
  // expected translation lives in `apps/orchestrator/src/matchzy/fixtures/`,
  // where a test recomputes it, and duplicating it here would leave a stale
  // copy in a file nobody regenerates.
  const matchzy = result.trace
    .filter(entry => entry.kind === 'matchzy')
    .map(({ name, payload }) => ({ name, payload }))

  // The ledger row this match opened, closed or not: "a live test that leaves
  // a server running is a P1" (CLAUDE.md), so the run says so itself.
  const rows = result.ledger.items.filter(row => row.matchId === result.matchId)
  const bundle = {
    run: result.run ?? RUN_ID,
    baseUrl: BASE_URL,
    matchId: result.matchId,
    finalState: result.match.state,
    endedReason: result.match.endedReason ?? null,
    /** True when the run had to end it rather than MatchZy finishing the series. */
    forcedEnd: result.forced === true,
    demoTarget: result.demoTarget,
    /** What `match.ended` said became of the demos (T21). */
    demo: result.match.endedReason ? (demoOutcome(result.envelopes) ?? null) : null,
    /** `ezpug_status`'s `scoreboard:` line while the match was up, or null when this gamemode does not show a rating (T27). */
    scoreboard: result.scoreboard ?? null,
    /** The core plugin's `skins:` console lines — how many, and the last — while the match was up, or null when no loadout was on the roster (T28). */
    skins: result.skins ?? null,
    ledger: {
      rows: rows.length,
      open: rows.filter(row => row.releasedAt === null).length,
      cents: rows.reduce((total, row) => total + (row.cost?.accruedCents ?? 0), 0),
    },
    /** Every payload type the durable log ended up holding, with its count. */
    payloads: Object.fromEntries(
      Object.entries(
        result.envelopes.reduce((counts, envelope) => {
          counts[envelope.payload.type] = (counts[envelope.payload.type] ?? 0) + 1
          return counts
        }, {}),
      ).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    counts: {
      calls: calls.length,
      envelopes: result.envelopes.length,
      deliveries: result.deliveries.length,
      streamFrames: result.streamFrames.length,
      streamTicks: result.streamFrames.filter(frame => frame.type === 'tick').length,
      linkFrames: link.length,
      nodeFrames: node.length,
      matchzyPayloads: matchzy.length,
      openServersAfter: result.fleet.servers.length,
    },
  }

  // Everything the files below are derived from, unscrubbed and ephemeral
  // (`.cache/` is gitignored): a match costs eight minutes of real hardware,
  // so changing how a fixture is *shaped* must not cost another one —
  // `--rebuild <dir>` reads this back and writes the files again.
  writeFileSync(join(OUT_DIR, 'raw.json'), stringify({ ...result, calls }))
  writeFileSync(join(OUT_DIR, 'run.json'), stringify(bundle))
  writeFileSync(
    join(OUT_DIR, 'client.json'),
    stringify(
      scrub({
        flow: `real-${GAMEMODE}-bo1`,
        calls,
        envelopes: result.envelopes,
        // The order they arrived in, that each verified, and which attempt it
        // took — the shape the conformance recordings use, so one reader
        // serves both, and the envelope itself is already in `envelopes`
        // under the same `seq`.
        deliveries: result.deliveries.map(delivery => ({
          seq: delivery.envelope.seq,
          type: delivery.envelope.payload.type,
          signature: delivery.signature,
          attempt: delivery.attempt,
        })),
        // `frames`, like the conformance recordings — minus the ephemeral
        // tier, the same rule as the link exchange.
        frames: result.streamFrames.filter(frame => frame.type !== 'tick'),
      }),
    ),
  )
  writeFileSync(
    join(OUT_DIR, 'link.json'),
    stringify(scrub({ schema: 'LinkExchange', exchange: link })),
  )
  writeFileSync(
    join(OUT_DIR, 'node.json'),
    stringify(scrub({ schema: 'NodeExchange', exchange: node })),
  )
  // Only a `matchzy` flow has a MatchZy exchange, and an empty one is not
  // evidence of anything: another flow's story crosses `/link` and is already
  // in `link.json`.
  if (matchzy.length > 0)
    writeFileSync(
      join(OUT_DIR, 'matchzy.json'),
      stringify(scrub({ schema: 'MatchZyExchange', events: matchzy })),
    )
  writeFileSync(join(OUT_DIR, 'ledger.json'), stringify(scrub(result.ledger)))
  say(`wrote the run to ${OUT_DIR}`)

  if (!WRITE_FIXTURES) {
    say('run again with --write-fixtures to update the recorded files')
    return bundle
  }
  const protocolDir = join(repo, 'packages/protocol/fixtures/recorded')
  const matchApiDir = join(repo, 'packages/match-api/fixtures/recorded')
  mkdirSync(protocolDir, { recursive: true })
  const files = [
    [join(protocolDir, `real-${GAMEMODE}-link.json`), join(OUT_DIR, 'link.json')],
    [join(protocolDir, `real-${GAMEMODE}-node.json`), join(OUT_DIR, 'node.json')],
    [join(matchApiDir, `real-${GAMEMODE}-bo1.json`), join(OUT_DIR, 'client.json')],
  ]
  if (matchzy.length > 0)
    files.push([join(protocolDir, `real-${GAMEMODE}-matchzy.json`), join(OUT_DIR, 'matchzy.json')])
  for (const [target, source] of files) {
    writeFileSync(target, readFileSync(source, 'utf8'))
    say(`fixture ${target.replace(`${repo}/`, '')}`)
  }
  return bundle
}

// ---------------------------------------------------------------------------

const REBUILD = flags.get('rebuild')

let summary
try {
  if (REBUILD) {
    const raw = JSON.parse(readFileSync(join(REBUILD, 'raw.json'), 'utf8'))
    calls.push(...raw.calls)
    summary = write(raw)
  } else {
    const result = await run()
    summary = write(result)
    if (result.match.state !== 'ended') process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(
    `\x1b[31m[iron-match] ${error instanceof Error ? error.stack : String(error)}\x1b[0m\n`,
  )
  process.exitCode = 1
} finally {
  await cleanUp()
}
if (summary && QUIET) process.stdout.write(stringify(summary))
