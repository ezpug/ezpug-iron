#!/usr/bin/env node
// **The Dathost live smoke** (PRD-02 T19) — one rented server in Frankfurt,
// allocated, dialled home, spoken to, and given back.
//
//   pnpm dathost:smoke                  the whole smoke against dathost.net
//   pnpm dathost:smoke --json           the summary and nothing else
//   node scripts/dathost-smoke.mjs --help
//
// **What it is for.** Everything else in this repo about Dathost runs against
// the fake vendor (T15): the provider's every verb, the template script, the
// fault suite. That is the point of offline-first, and it is also the reason
// this exists — a fake is a reading of `references/dathost/openapi.merged.json`
// and a reading can be wrong. This is the one command that finds out, and it
// is the only place in the round besides T36 and T37 where a real server is
// rented. Nine steps, in order, each of which has been wrong at least once
// in somebody's project:
//
//   1. `GET /account` — the credentials are the credentials.
//   2. `dathost-image --check` — the template is what this tree says it is.
//   3. The orchestrator answers and has the `dathost` provider registered.
//   4. The account is counted *before*, so a stray afterwards is attributable.
//   5. A match is created asking for `dathost` by name.
//   6. It reaches `ready` — which only happens when the clone booted, the
//      plugin dialled the link out of a datacentre in Düsseldorf and said
//      `server_ready`. This is the step the whole round is aimed at.
//   7. `ezpug_status` is sent as an `rcon` command and travels down the link,
//      so the answer proves the link carries traffic in both directions.
//   8. The connect facts and the GOTV relay are read off the match.
//   9. The server is released — and *then* the ledger row is checked closed
//      and the account is counted again.
//
// **The money.** A rented server is the only thing in this repo that costs
// real euros by the minute, so: exactly one is ever allocated, the release is
// a `finally` that also runs on a signal, the run is bounded by
// `--budget-minutes` (default 60 — the PRD's one server-hour) whatever else
// happens, and if the reaper has not taken a stray clone by the time the run
// ends this script deletes it itself and says so. The last thing the summary
// carries is the count of servers on the account wearing our tag; a run that
// cannot get that to zero exits non-zero, because "a live test that leaves a
// server running is a P1" (CLAUDE.md) and a P1 nobody noticed is worse.
//
// **Secrets.** The account's password comes from the environment only. The
// API key is minted for the run and revoked at the end of it, and neither it,
// the join password nor the server token is ever in the summary, in a log
// line or in an error — `connect` is reported as a host, a port and
// `passwordSet: true`. `ezpug_status` is safe to print by construction (its
// renderer is written to say "nothing a stranger should",
// `plugins/EZPug.Core/Commands/StatusReport.cs`) and is scrubbed again here
// against everything this run happens to know.
//
// **It is importable.** `main({ fetch, env, sleep, … })` is what
// `apps/orchestrator/src/providers/dathost/smoke-script.test.ts` calls to run
// this whole script offline — the fake vendor behind the provider, a fake
// server on the real link, and the same nine steps. The live lane
// (`apps/orchestrator/src/dathost.extended.test.ts`, `EZPUG_DATHOST_TESTS`)
// shells out to it and asserts the summary.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** The vendor's base URL — the same constant the provider holds. */
export const DATHOST_API_BASE_URL = 'https://dathost.net/api/0.1'

/**
 * The `user_data` marker a server of ours wears (`DATHOST_DEFAULT_TAG` in the
 * provider, `TEMPLATE_TAG` in the image script). What "the account lists no
 * tagged server" is counted by.
 */
export const SMOKE_TAG = 'ezpug'

/** The webhook secret id the run registers on its own key. */
const WEBHOOK_SECRET_ID = 'whsec-dathost-smoke'

const HELP = `dathost-smoke — rent one real Dathost server and give it back (PRD-02 T19)

  --base-url <url>       the orchestrator; default $EZPUG_IRON_BASE_URL
  --key <secret>         an API key with matches+fleet+admin; default
                         $EZPUG_IRON_ADMIN_KEY, else minted from this box
  --gamemode <id>        default pug
  --map <name>           default de_dust2
  --region <id>          requirements.region; default frankfurt
  --budget-minutes <n>   the wall this run may never cross; default 60
  --budget-cents <n>     the run key's monthly ceiling in euro cents; default 500
  --boot-minutes <n>     how long the clone gets to boot and dial in; default 12
  --no-image-check       skip step 2 (it needs docker or --tree)
  --tree <dir>           the artifact tree the image check compares against
  --webhook-url <url>    where match webhooks go; default: nowhere reachable
  --json                 print the summary as JSON and nothing else
  --help

The account comes from the environment and only from the environment:
EZPUG_IRON_DATHOST_EMAIL, EZPUG_IRON_DATHOST_PASSWORD (the unprefixed
EZPUG_DATHOST_* names work too). EZPUG_IRON_DATHOST_API_URL points the vendor
calls somewhere other than dathost.net; it is how the offline rehearsal runs,
not a knob for a deployment.
`

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
 * **The wall clock, in one place.** Every other thing in this repo runs on the
 * injected clock and the determinism guard makes a bare `Date.now()` an error.
 * An operator script driving a datacentre in real time is the exception that
 * escape hatch exists for — and it is injectable anyway, which is how the
 * offline rehearsal runs the same nine steps on a fake clock.
 */
const wall = {
  // biome-ignore lint/plugin: an operator script renting real hardware in real time
  now: () => Date.now(),
  // biome-ignore lint/plugin: as above — there is no clock to arm a poll on
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/**
 * The in-flight run's release, for the signal handlers below. A Ctrl-C is not
 * a licence to leave a rented server running: the same cleanup the happy path
 * runs, then the signal's exit code.
 */
let pendingRelease = null

/** Terminal match states — nothing follows them. */
const TERMINAL = ['ended', 'failed', 'cancelled']
/** Ledger states that mean the row is closed and costs nothing more. */
const CLOSED = ['released', 'failed']

/** `user_data` back, or `null` for anything that is not one of ours. */
function decodeTag(userData) {
  if (!userData) return null
  try {
    const parsed = JSON.parse(userData)
    return parsed && typeof parsed === 'object' && typeof parsed.tag === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Every server on the account wearing our tag that is **not** the template:
 * a clone the provider made, or one it made and never got to name (which is
 * why `duplicate_source_server` counts too — the provider's `list()` claims
 * by the same two rules).
 */
function ourClones(servers, { templateId }) {
  return servers.filter(server => {
    if (server.id === templateId) return false
    const tag = decodeTag(server.user_data)
    if (tag?.role === 'template') return false
    return tag?.tag === SMOKE_TAG || server.duplicate_source_server === templateId
  })
}

export async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const out = options.stdout ?? (text => process.stdout.write(text))
  const err = options.stderr ?? (text => process.stderr.write(text))
  const fetchImpl = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? wall.sleep
  const now = options.now ?? wall.now
  const mintKey = options.mintKey ?? mintKeyFromThisBox

  const flags = parseArgs(argv)
  if (flags.has('help')) {
    out(HELP)
    return 0
  }
  // A checkout's `.env` is where an operator's credentials actually live.
  // Only when the caller did not hand us an environment of its own.
  if (options.env === undefined) {
    try {
      process.loadEnvFile(join(repo, '.env'))
    } catch {
      // A fresh clone has no .env; the process environment is all there is.
    }
  }

  const json = flags.get('json') === 'true'
  const say = line => {
    if (!json) err(`\x1b[36m[dathost-smoke]\x1b[0m ${line}\n`)
  }
  const warn = line => {
    if (!json) err(`\x1b[33m[dathost-smoke] warning:\x1b[0m ${line}\n`)
  }

  const problems = []
  const startedAt = now()
  /** Everything the run is willing to say out loud. No secret is ever put here. */
  const result = {
    ok: false,
    verb: 'smoke',
    steps: [],
    account: null,
    imageCheck: null,
    provider: null,
    matchId: null,
    finalState: null,
    connect: null,
    tv: null,
    status: null,
    ledger: null,
    clones: { before: 0, afterRelease: 0, deleted: 0 },
    elapsedSeconds: 0,
    problems,
  }
  const step = (name, detail) => {
    result.steps.push(name)
    say(`${result.steps.length}. ${name}${detail ? ` — ${detail}` : ''}`)
  }

  /**
   * The run's own client, hoisted: the two assertions after the release —
   * the ledger row and the account — need a key that is still valid, which
   * is why the run's key is revoked at the very end and not in `cleanups`.
   */
  let api = null
  let revokeKey = null
  /**
   * Servers already wearing our tag when the run started. They are counted
   * out of the "left behind" check and never deleted: another deployment may
   * share this account, and a smoke that took somebody else's live match
   * down would be worse than a leak.
   */
  let knownBefore = new Set()

  /** Everything that must happen however the run goes, newest first. */
  const cleanups = []
  const cleanUp = async () => {
    for (const undo of cleanups.splice(0).reverse()) {
      try {
        await undo()
      } catch (error) {
        problems.push(`cleanup: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Redact anything this run knows before a string reaches the summary. */
  const secrets = []
  const scrub = text => {
    let scrubbed = String(text)
    for (const secret of secrets) if (secret) scrubbed = scrubbed.split(secret).join('<redacted>')
    return scrubbed
  }

  const finish = () => {
    result.elapsedSeconds = Math.round((now() - startedAt) / 1000)
    result.ok = problems.length === 0
    if (json) out(`${JSON.stringify(result, null, 2)}\n`)
    else {
      for (const problem of problems) err(`\x1b[31m[dathost-smoke] problem:\x1b[0m ${problem}\n`)
      if (result.ok) say(`green in ${result.elapsedSeconds} s — nothing left running`)
    }
    return result.ok ? 0 : 1
  }

  pendingRelease = cleanUp

  const email = env.EZPUG_IRON_DATHOST_EMAIL ?? env.EZPUG_DATHOST_EMAIL ?? ''
  const password = env.EZPUG_IRON_DATHOST_PASSWORD ?? env.EZPUG_DATHOST_PASSWORD ?? ''
  const templateId =
    env.EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID ?? env.EZPUG_DATHOST_TEMPLATE_SERVER_ID ?? ''
  if (!email || !password || !templateId) {
    problems.push(
      'no Dathost account: set EZPUG_IRON_DATHOST_EMAIL, EZPUG_IRON_DATHOST_PASSWORD and ' +
        'EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID (the password is read from the environment ' +
        'only, never from a flag)',
    )
    return finish()
  }
  secrets.push(password)
  const vendorUrl = (
    env.EZPUG_IRON_DATHOST_API_URL ??
    env.EZPUG_DATHOST_API_URL ??
    DATHOST_API_BASE_URL
  ).replace(/\/+$/, '')
  // Built once, used by `vendor` alone: it is in no log line and no error.
  const authorization = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`

  const baseUrl = (
    flags.get('base-url') ??
    env.EZPUG_IRON_BASE_URL ??
    env.EZPUG_IRON_PUBLIC_URL ??
    'http://127.0.0.1:3430'
  ).replace(/\/+$/, '')
  const gamemode = flags.get('gamemode') ?? 'pug'
  const map = flags.get('map') ?? 'de_dust2'
  const region = flags.get('region') ?? 'frankfurt'
  const budgetMs = Number(flags.get('budget-minutes') ?? 60) * 60_000
  /**
   * The run key's own monthly ceiling. `0` is "no money" (T5), not "no
   * limit", so a Dathost server would be refused before it was ever asked
   * for; €5 is a hundred times what one server-hour in Frankfurt costs and
   * still a wall a runaway loop hits in an afternoon.
   */
  const budgetCents = Number(flags.get('budget-cents') ?? 500)
  const bootMs = Number(flags.get('boot-minutes') ?? 12) * 60_000
  const wantImageCheck = flags.get('no-image-check') !== 'true'
  const deadline = startedAt + budgetMs
  const runId = `dathost-smoke-${startedAt}`

  /** One call at the vendor. Never retried here: the provider owns backoff, this is a smoke. */
  const vendor = async (method, path) => {
    const response = await fetchImpl(`${vendorUrl}${path}`, {
      method,
      headers: { authorization },
    })
    const text = await response.text()
    if (!response.ok)
      throw new Error(`dathost ${method} ${path} → ${response.status} ${scrub(text).slice(0, 200)}`)
    return text ? JSON.parse(text) : null
  }

  /** One call at the orchestrator, as a client with a bearer token. */
  const makeApi = secret => async (method, path, body) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    const parsed = text ? JSON.parse(text) : null
    if (!response.ok) {
      const detail = parsed?.error
        ? `${parsed.error.code}: ${parsed.error.message}`
        : scrub(text).slice(0, 200)
      throw new Error(`${method} ${path} → ${response.status} ${detail}`)
    }
    return parsed
  }

  try {
    // ── 1. The account ─────────────────────────────────────────────────────
    const account = await vendor('GET', '/account')
    result.account = {
      id: account?.id ?? null,
      credits: account?.credits ?? null,
      timeLeft: account?.time_left ?? null,
    }
    step('GET /account', `credits ${result.account.credits}`)

    // ── 2. The template is what this tree says it is ───────────────────────
    if (wantImageCheck) {
      const image = await import(pathToFileURL(join(repo, 'scripts/dathost-image.mjs')).href)
      const captured = []
      const code = await image.main({
        argv: ['--check', '--json', ...(flags.has('tree') ? ['--tree', flags.get('tree')] : [])],
        env: {
          EZPUG_IRON_DATHOST_EMAIL: email,
          EZPUG_IRON_DATHOST_PASSWORD: password,
          EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID: templateId,
          EZPUG_IRON_DATHOST_API_URL: vendorUrl,
          ...(env.EZPUG_IRON_CS2_IMAGE && { EZPUG_IRON_CS2_IMAGE: env.EZPUG_IRON_CS2_IMAGE }),
        },
        fetch: fetchImpl,
        sleep,
        stdout: text => captured.push(text),
        stderr: () => {},
      })
      const report = JSON.parse(captured.join('') || '{}')
      result.imageCheck = {
        ran: true,
        ok: code === 0,
        problems: (report.problems ?? []).map(scrub),
      }
      if (code !== 0)
        problems.push(
          `the template is not what this tree builds: ${result.imageCheck.problems.join('; ')}`,
        )
      step('dathost-image --check', code === 0 ? 'green' : 'red')
    } else {
      result.imageCheck = { ran: false, ok: null, problems: [] }
      warn('skipping the image check (--no-image-check): the template is trusted as it stands')
    }

    // ── 3. The orchestrator, and a key to talk to it with ──────────────────
    // `/healthz` first only because it needs no key: a wrong `--base-url` is
    // the commonest way to run this, and it should not look like a missing
    // provider. What is authoritative about the fleet is the fleet route.
    let live = false
    try {
      live = (await fetchImpl(`${baseUrl}/healthz`)).ok
    } catch {
      live = false
    }
    if (!live)
      throw new Error(
        `no orchestrator answering at ${baseUrl} — point --base-url at one (in dev: ` +
          '`pnpm dev:up && pnpm dev`)',
      )
    const bootstrap = flags.get('key') ?? env.EZPUG_IRON_ADMIN_KEY ?? mintKey(`${runId}-bootstrap`)
    secrets.push(bootstrap)
    const admin = makeApi(bootstrap)
    // The run's own key: its own budget, its own webhook secret, revoked at
    // the end. One concurrent server is the whole ceiling this run may use —
    // the budget is a wall, and here it is also the money.
    const webhookSecret = `dathost-smoke-${startedAt}-not-a-real-secret`
    const created = await admin('POST', '/v1/keys', {
      name: runId,
      scopes: ['matches', 'fleet', 'admin'],
      budget: { maxConcurrentServers: 1, maxServerLifetimeMinutes: 60, monthlyCents: budgetCents },
      webhookSecrets: [{ id: WEBHOOK_SECRET_ID, secret: webhookSecret }],
    })
    secrets.push(created.secret, webhookSecret)
    api = makeApi(created.secret)
    revokeKey = () => admin('DELETE', `/v1/keys/${created.key.id}`)
    const providers = await api('GET', '/v1/fleet/providers')
    const dathost = providers.providers.find(entry => entry.id === 'dathost')
    result.provider = dathost
      ? {
          id: dathost.id,
          healthy: dathost.healthy,
          drained: dathost.drained,
          servers: dathost.servers,
        }
      : null
    if (!dathost)
      throw new Error(
        'the fleet lists no `dathost` provider — put the credential trio in the ' +
          'orchestrator’s environment and set EZPUG_IRON_PROVIDERS=dathost,…',
      )
    if (dathost.drained) throw new Error('the `dathost` provider is drained — nothing would land')
    step('the orchestrator is up and Dathost is registered', baseUrl)

    // ── 4. What the account holds before we touch it ───────────────────────
    const before = ourClones(await vendor('GET', '/game-servers'), { templateId })
    result.clones.before = before.length
    if (before.length > 0)
      warn(
        `${before.length} server(s) already wear our tag: ${before.map(s => s.id).join(', ')} — ` +
          'the reaper should have taken them; this run leaves them alone and counts them out',
      )
    knownBefore = new Set(before.map(server => server.id))
    step('counted the account', `${before.length} tagged server(s) before`)

    // ── 5. One match, on Dathost by name ───────────────────────────────────
    const request = {
      clientMatchId: runId,
      game: 'cs2',
      gamemode,
      teams: { teamA: { name: 'EZPug A', players: [] }, teamB: { name: 'EZPug B', players: [] } },
      maps: [{ map, sides: 'ct' }],
      rules: {
        regulationRounds: 2,
        overtime: { enabled: false, maxRounds: 6, startMoney: 10_000 },
        warmup: { minPlayersToReady: 0, minSpectatorsToReady: 0 },
        cvars: {},
      },
      // The whole point of the smoke: not `lan`, not `simulated`, this
      // provider and no other. A box that also has nodes must not answer.
      requirements: { provider: 'dathost', region },
      callbacks: {
        webhookUrl: flags.get('webhook-url') ?? 'https://webhooks.invalid/dathost-smoke',
        webhookSecretId: WEBHOOK_SECRET_ID,
      },
      warmupLines: ['Willkommen bei EZPug.', 'Welcome to EZPug.'],
      branding: { hostname: `EZPug · smoke · ${map}`, eventName: 'dathost-smoke' },
      // The row's own lifetime ceiling: whatever happens to this process, the
      // reaper takes the server back within the hour the PRD allows.
      ttlMinutes: 60,
    }
    const match = await api('POST', '/v1/matches', request)
    result.matchId = match.id
    // From here on the server is money. Nothing below may throw past this.
    cleanups.push(async () => {
      const latest = await api('GET', `/v1/matches/${match.id}`)
      if (TERMINAL.includes(latest.state)) return
      say(`releasing: cancelling ${match.id} (${latest.state})`)
      if (latest.state === 'live')
        await api('POST', `/v1/matches/${match.id}/commands`, {
          correlationId: `${runId}-force-end`,
          type: 'force_end',
          reason: 'the dathost smoke is over',
        })
      else await api('POST', `/v1/matches/${match.id}/cancel`)
    })
    step('created the match', `${match.id} (${match.state})`)

    // ── 6. The clone boots and the plugin dials home ───────────────────────
    const bootBy = Math.min(now() + bootMs, deadline)
    let latest = match
    let state = match.state
    while (now() < bootBy && latest.state !== 'ready' && !TERMINAL.includes(latest.state)) {
      await sleep(5_000)
      latest = await api('GET', `/v1/matches/${match.id}`)
      if (latest.state !== state) {
        say(`   ${state} → ${latest.state}`)
        state = latest.state
      }
    }
    result.finalState = latest.state
    if (latest.state !== 'ready')
      throw new Error(
        latest.state === 'failed'
          ? `the match failed: ${latest.endedReason?.kind ?? 'no reason given'}${latest.endedReason?.detail ? ` (${latest.endedReason.detail})` : ''}`
          : `the server never became ready (${latest.state} after ${Math.round((now() - startedAt) / 1000)} s)`,
      )
    step(
      'the plugin dialled the link and the match is ready',
      `${Math.round((now() - startedAt) / 1000)} s`,
    )

    // ── 7. `ezpug_status`, down the link and back ──────────────────────────
    const status = await api('POST', `/v1/matches/${match.id}/commands`, {
      correlationId: `${runId}-status`,
      type: 'rcon',
      command: 'ezpug_status',
    })
    const output = scrub(status.output ?? '')
    result.status = {
      applied: status.status === 'applied',
      lines: output ? output.split('\n').length : 0,
      output,
    }
    if (status.status !== 'applied')
      problems.push(`ezpug_status came back ${status.status}: ${scrub(status.error?.code ?? '')}`)
    else if (!output.includes('link:'))
      problems.push('ezpug_status answered, but not with the core plugin’s report')
    step('ezpug_status through the link', `${result.status.lines} line(s)`)

    // ── 8. The connect facts and the GOTV relay ────────────────────────────
    // Never the password itself: a summary is a thing people paste.
    result.connect = latest.connect
      ? {
          host: latest.connect.host,
          port: latest.connect.port,
          passwordSet: Boolean(latest.connect.password),
        }
      : null
    result.tv = latest.tv ?? null
    if (!result.connect) problems.push('the match is ready but carries no connect facts')
    if (!result.tv)
      problems.push('the match carries no GOTV relay — the template’s `enable_gotv` is off')
    step(
      'read the connect facts',
      `${result.connect?.host}:${result.connect?.port}${result.tv ? `, GOTV ${result.tv.host}:${result.tv.port}` : ''}`,
    )
    if (now() > deadline) problems.push('the run crossed its budget before it could finish')
  } catch (error) {
    problems.push(scrub(error instanceof Error ? error.message : String(error)))
  } finally {
    // ── 9a. Release, whatever happened above ───────────────────────────────
    await cleanUp()
    pendingRelease = null
  }

  // ── 9b. …and only then, what the release left behind ─────────────────────
  // Deliberately outside the `try`: the two assertions the money hangs on are
  // about the state *after* the release, and a run that failed in step 6 has
  // exactly as much to prove here as one that reached step 8.
  try {
    if (result.matchId && api) {
      const rows = await waitForClosedRows({ api, matchId: result.matchId, sleep })
      result.ledger = rows
      if (rows.rows === 0) problems.push('the match opened no ledger row')
      if (rows.open > 0)
        problems.push(`${rows.open} ledger row(s) still open — a server is running`)
      step('the ledger row is closed', `${rows.rows} row(s), ${rows.open} open`)
    }
    // The account, counted again. A clone the reaper has not taken yet is
    // deleted here rather than left as somebody's surprise invoice.
    const tagged = ourClones(await vendor('GET', '/game-servers'), { templateId })
    const strays = tagged.filter(server => !knownBefore.has(server.id))
    result.clones.afterRelease = strays.length
    if (tagged.length > strays.length)
      warn(
        `${tagged.length - strays.length} tagged server(s) were here before this run and are left alone`,
      )
    for (const stray of strays) {
      try {
        await vendor('DELETE', `/game-servers/${stray.id}`)
        result.clones.deleted += 1
        warn(`deleted a server the release left behind: ${stray.id}`)
      } catch (error) {
        problems.push(
          `a tagged server is still on the account and could not be deleted (${stray.id}): ` +
            scrub(error instanceof Error ? error.message : String(error)),
        )
      }
    }
    if (result.clones.deleted > 0)
      problems.push(
        `${result.clones.deleted} server(s) had to be deleted by hand after the release — ` +
          'the provider’s deallocate or the reaper did not close them out',
      )
    step('the account lists no tagged server', `${result.clones.afterRelease} found`)
  } catch (error) {
    problems.push(
      `could not prove the run left nothing behind: ${scrub(error instanceof Error ? error.message : String(error))}`,
    )
  }

  // The run's key, last of all — nothing above needs it any more and a key
  // left behind is a standing permission nobody minted on purpose.
  if (revokeKey) {
    try {
      await revokeKey()
    } catch (error) {
      problems.push(
        `could not revoke the run's key: ${scrub(error instanceof Error ? error.message : String(error))}`,
      )
    }
  }

  return finish()
}

/**
 * Poll the ledger until this match's rows are closed. A `deallocate` is a
 * vendor round trip behind the cancel that triggered it, so the row is not
 * closed the instant `cancel` answers; a minute is generous and the loop
 * says what it saw either way.
 */
async function waitForClosedRows({ api, matchId, tries = 12, wait = 5_000, sleep = wall.sleep }) {
  let seen = { rows: 0, open: 0, hourlyCents: null }
  for (let attempt = 0; attempt < tries; attempt++) {
    const page = await api('GET', `/v1/fleet/ledger?matchId=${matchId}`)
    const items = page.items ?? []
    seen = {
      rows: items.length,
      open: items.filter(row => !CLOSED.includes(row.state)).length,
      hourlyCents: items[0]?.cost?.hourlyCents ?? null,
      accruedCents: items.reduce((sum, row) => sum + (row.cost?.accruedCents ?? 0), 0),
    }
    if (seen.rows > 0 && seen.open === 0) return seen
    if (attempt < tries - 1) await sleep(wait)
  }
  return seen
}

/**
 * The first key has to come from somewhere. `POST /v1/keys` needs `admin`,
 * so on a box that holds the orchestrator's database the orchestrator's own
 * `keys:mint` is that somewhere; against a remote deployment `--key` or
 * `EZPUG_IRON_ADMIN_KEY` is, and this is never reached.
 */
function mintKeyFromThisBox(name) {
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
      'admin',
    ],
    { cwd: repo, encoding: 'utf8' },
  )
  const secret = (result.stdout ?? '').trim().split('\n').pop() ?? ''
  if (!secret.startsWith('ezik_'))
    throw new Error(
      'no API key: pass --key (or set EZPUG_IRON_ADMIN_KEY); minting one from this box needs ' +
        `the orchestrator's own database (${(result.stderr ?? '').trim().slice(0, 200) || 'no output'})`,
    )
  return secret
}

// Run when invoked, importable when a test wants to hand it a fake world.
// The signal handlers are installed only for a real run: importing this
// module must not change how the importing process handles Ctrl-C.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      process.stderr.write(`\x1b[36m[dathost-smoke]\x1b[0m ${signal}: releasing the server\n`)
      void Promise.resolve(pendingRelease?.()).finally(() => process.exit(130))
    })
  }
  process.exitCode = await main()
}
