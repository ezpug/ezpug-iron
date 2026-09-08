import type { Clock } from '@ezpug/core'
import { Hono } from 'hono'

/**
 * **The fake Dathost** (PRD-02 T15) — the vendor's raw server API, in
 * process, on the injected clock. It is what the Dathost provider (T16),
 * the template-image script (T18) and the fault suite (T32) run against, so
 * that "no test needs Dathost" (CLAUDE.md, offline-first) stays true of
 * everything except the one demanded live smoke (T19).
 *
 * The subset is the one `references/dathost.md` says EZPug uses, and no
 * more: create, list, get, update, delete, `duplicate`, `sync-files`,
 * `start`, `stop`, console (backlog and one line), files (list, download,
 * upload, move), `metrics`, `account`. The vendor's match API is not here
 * and never will be — Match.md §3 chose the raw server API so a Dathost
 * server and a LAN node behave identically.
 *
 * Four behaviours are modelled because the adapter is wrong without them:
 *
 * - **`duplicate` copies the last *synced* files, not the live ones.** Every
 *   server keeps two file sets: what is on the box and what the API cached.
 *   `sync-files` copies the first onto the second; `duplicate` reads the
 *   second. An image script that uploads a plugin and clones without syncing
 *   gets yesterday's plugin here exactly as it would there.
 * - **`start` reboots a server that is already on**, and a boot takes time:
 *   `booting` is true until `bootMs` of *clock* time has passed.
 * - **`GET /game-servers/{id}` refreshes `booting` before answering; the
 *   list does not.** A listed server can therefore still claim `booting`
 *   after it finished, which is why `status()` reads the single item.
 * - **`deletion_protection` blocks `DELETE`** — the template carries it, a
 *   clone never does.
 *
 * Faults a test asks for (`setFaults`): a 429 or a 500 for the next N
 * requests, a server whose boot never ends, a server that vanished off the
 * account, and a console read that never answers. Nothing here is random:
 * ids and passwords come off a counter, every instant off the clock.
 *
 * Secrets: the RCON, join, FTP and MySQL passwords this fake makes up are
 * obviously synthetic (`fake-…`) and exist only in memory, so a recording
 * that ever caught one is greppable (CLAUDE.md, secrets).
 */

/** The `fetch` shape the provider is injected with — this fake's front door. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface FakeDathostOptions {
  clock: Clock
  /** The Basic-auth pair every request must carry. */
  email: string
  password: string
  /** Clock milliseconds a `start` spends `booting` before the server is `on`. Default 30 s. */
  bootMs?: number
  /** What a server costs per hour in the account's currency — what the ledger snapshots. Default 0.24. */
  costPerHour?: number
  /** Where a server is created when the caller names no location. */
  location?: string
  /** Credits on the account. */
  credits?: number
}

/** What a test can make go wrong. Every field is off by default. */
export interface FakeDathostFaults {
  /**
   * Answer the next `times` matching requests with `code` and no body — the
   * 429 and 5xx the adapter must back off on. `only` narrows it to requests
   * whose path contains that substring.
   */
  status?: { code: number; times: number; only?: string }
  /** Server ids whose `booting` never flips — the boot that never ends. */
  neverBoot?: readonly string[]
  /**
   * Server ids that vanished off the account: 404 on every route, absent
   * from `list`. What the recovery flow (T14) sees when a box dies.
   */
  vanished?: readonly string[]
  /** `GET …/console` never answers; it settles only when the caller aborts. */
  consoleTimeout?: boolean
}

/** One file, as bytes — the listing reports `byteLength` and the download hands them back. */
interface FakeFile {
  content: Uint8Array
}

interface FakeServerRecord {
  /** The JSON body every server route hands out, mutated in place. */
  server: Record<string, unknown>
  /** What is on the box. */
  files: Map<string, FakeFile>
  /** What the API cached — what `duplicate` copies (`sync-files` refreshes it). */
  cache: Map<string, FakeFile>
  /** The console backlog, oldest first. */
  console: string[]
  /** When `booting` is due to end, or `undefined` when the server is not booting. */
  bootDueAt?: number
}

/** A server as a test reads it, without reaching into the fake's storage. */
export interface FakeDathostServerView {
  id: string
  name: string
  on: boolean
  booting: boolean
  userData: string
  location: string
  deletionProtection: boolean
  duplicateSourceServer?: string
  /** What is on the box right now. */
  files: ReadonlyMap<string, string>
  /** What `duplicate` would copy right now. */
  cache: ReadonlyMap<string, string>
  console: readonly string[]
  /** The whole record, for a test that wants a field this view forgot. */
  raw: Record<string, unknown>
}

export interface FakeDathost {
  /** The door: hand this to `createDathostProvider({ fetch })`. */
  readonly fetch: FetchLike
  /** The same app over a real socket, for anything that needs a URL. */
  listen: (options?: { port?: number; hostname?: string }) => Promise<FakeDathostListener>
  /** `METHOD /path` for every request that arrived, in order — including the refused ones. */
  readonly calls: string[]
  setFaults: (faults: FakeDathostFaults) => void
  /** Every server the account holds, in creation order. */
  servers: () => FakeDathostServerView[]
  server: (id: string) => FakeDathostServerView | undefined
  /** Write a line into a server's console backlog, as the game would. */
  say: (id: string, line: string) => void
}

export interface FakeDathostListener {
  url: string
  port: number
  close: () => Promise<void>
}

const BASE_PATH = '/api/0.1'
const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024
const DEFAULT_BOOT_MS = 30_000

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Dathost answers a refusal with a bare status and no body of ours to parse. */
function bare(status: number): Response {
  return new Response(null, { status })
}

export function createFakeDathost(options: FakeDathostOptions): FakeDathost {
  const { clock, email, password } = options
  const bootMs = options.bootMs ?? DEFAULT_BOOT_MS
  const costPerHour = options.costPerHour ?? 0.24
  const defaultLocation = options.location ?? 'dusseldorf'
  const credits = options.credits ?? 42.5

  const servers = new Map<string, FakeServerRecord>()
  const calls: string[] = []
  let faults: FakeDathostFaults = {}
  let statusFaultsLeft = 0
  let counter = 0

  const nextId = (): string => {
    counter += 1
    // Dathost ids are 24 hex characters; a counter keeps them predictable.
    return counter.toString(16).padStart(24, '0')
  }

  const expected = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`

  const vanished = (id: string): boolean => (faults.vanished ?? []).includes(id)

  /**
   * `booting` ends when the clock says it does — and never, for a server a
   * test put in `neverBoot`. Called by everything that hands out a single
   * server; the list deliberately does not call it.
   */
  const refresh = (id: string, record: FakeServerRecord): void => {
    if (record.bootDueAt === undefined) return
    if ((faults.neverBoot ?? []).includes(id)) return
    if (clock.now() < record.bootDueAt) return
    record.bootDueAt = undefined
    record.server.booting = false
    record.server.on = true
  }

  const find = (id: string): FakeServerRecord | undefined =>
    vanished(id) ? undefined : servers.get(id)

  const blank = (
    id: string,
    name: string,
    game: string,
    location: string,
  ): Record<string, unknown> => ({
    id,
    name,
    game,
    location,
    on: false,
    booting: false,
    confirmed: true,
    autostop: false,
    autostop_minutes: 0,
    cost_per_hour: costPerHour,
    cost_per_month: 0,
    created_at: Math.floor(clock.now() / 1000),
    cycle_months_1_discount_percentage: 0,
    cycle_months_3_discount_percentage: 0,
    cycle_months_6_discount_percentage: 0,
    cycle_months_12_discount_percentage: 0,
    deletion_protection: false,
    disk_usage_bytes: 0,
    enable_core_dump: false,
    enable_mysql: false,
    enable_syntropy: false,
    ftp_password: `fake-ftp-${id}`,
    ip: `${location}.fake-dathost.invalid`,
    max_cost_per_hour: costPerHour,
    max_cost_per_month: 0,
    max_disk_usage_gb: 30,
    month_credits: 0,
    month_reset_at: Math.floor(clock.now() / 1000),
    mysql_password: `fake-mysql-${id}`,
    mysql_username: `fake_${id}`,
    players_online: 0,
    ports: { game: 27015, gotv: 27020, gotv_secondary: 27021 },
    prefer_dedicated: false,
    private_ip: '10.0.0.1',
    raw_ip: '203.0.113.1',
    reboot_on_crash: false,
    server_image: 'fake-dathost',
    subscription_cycle_months: 1,
    subscription_renewal_failed_attempts: 0,
    subscription_state: 'PAY_AS_YOU_GO',
    user_data: '',
    cs2_settings: {
      slots: 12,
      enable_gotv: false,
      enable_metamod: false,
      game_mode: 'competitive',
      insecure: false,
      private_server: false,
      rcon: `fake-rcon-${id}`,
      password: `fake-join-${id}`,
    },
  })

  /**
   * Multipart create and update speak dotted field names
   * (`cs2_settings.rcon`), and every value arrives as text — the form has no
   * types, so `"true"` becomes a boolean and `"12"` a number where the
   * vendor's schema says so.
   */
  const NUMERIC_FIELDS = new Set([
    'autostop_minutes',
    'max_disk_usage_gb',
    'manual_sort_order',
    'cs2_settings.slots',
    'csgo_settings.slots',
  ])
  const BOOLEAN_FIELDS = new Set([
    'autostop',
    'confirmed',
    'deletion_protection',
    'enable_core_dump',
    'enable_mysql',
    'enable_syntropy',
    'prefer_dedicated',
    'reboot_on_crash',
    'cs2_settings.disable_bots',
    'cs2_settings.enable_gotv',
    'cs2_settings.enable_gotv_secondary',
    'cs2_settings.enable_metamod',
    'cs2_settings.insecure',
    'cs2_settings.private_server',
    'cs2_settings.disable_workshop_command_filtering',
  ])

  const applyForm = (server: Record<string, unknown>, form: Map<string, string>): void => {
    for (const [key, raw] of form) {
      let value: unknown = raw
      if (NUMERIC_FIELDS.has(key)) value = Number(raw)
      else if (BOOLEAN_FIELDS.has(key)) value = raw === 'true' || raw === 'True' || raw === '1'

      const dot = key.indexOf('.')
      if (dot === -1) {
        server[key] = value
        continue
      }
      const group = key.slice(0, dot)
      const field = key.slice(dot + 1)
      const existing = server[group]
      const settings = (
        typeof existing === 'object' && existing !== null ? existing : {}
      ) as Record<string, unknown>
      settings[field] = value
      server[group] = settings
    }
  }

  const copyFiles = (from: Map<string, FakeFile>): Map<string, FakeFile> =>
    new Map(Array.from(from, ([path, file]) => [path, { content: file.content.slice() }]))

  const viewOf = (id: string, record: FakeServerRecord): FakeDathostServerView => ({
    id,
    name: String(record.server.name),
    on: record.server.on === true,
    booting: record.server.booting === true,
    userData: String(record.server.user_data ?? ''),
    location: String(record.server.location),
    deletionProtection: record.server.deletion_protection === true,
    duplicateSourceServer: record.server.duplicate_source_server as string | undefined,
    files: new Map(Array.from(record.files, ([path, f]) => [path, decoder.decode(f.content)])),
    cache: new Map(Array.from(record.cache, ([path, f]) => [path, decoder.decode(f.content)])),
    console: [...record.console],
    raw: record.server,
  })

  /**
   * A start (or an update that restarts): the server goes off, `booting`
   * goes on, and the clock decides when it is over.
   */
  const boot = (record: FakeServerRecord): void => {
    record.server.on = false
    record.server.booting = true
    record.bootDueAt = clock.now() + bootMs
  }

  const app = new Hono().basePath(BASE_PATH)

  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    calls.push(`${c.req.method} ${path}`)
    // Basic auth on every request, `references/dathost.md` — the header is
    // compared whole so a wrong password and a missing one look the same.
    if (c.req.header('authorization') !== expected) return bare(401)
    if (
      statusFaultsLeft > 0 &&
      faults.status &&
      (!faults.status.only || path.includes(faults.status.only))
    ) {
      statusFaultsLeft -= 1
      return bare(faults.status.code)
    }
    await next()
  })

  app.get('/account', c =>
    c.json({
      id: 'fake-account',
      email,
      credits,
      gravatar_url: 'https://www.gravatar.com/avatar/fake',
      trial: false,
      seconds_left: 360_000,
      time_left: '100 hours',
    }),
  )

  app.get('/game-servers', c =>
    // The list does **not** refresh `booting` (references/dathost.md).
    c.json(
      Array.from(servers.entries(), ([id, record]) =>
        vanished(id) ? undefined : record.server,
      ).filter((server): server is Record<string, unknown> => server !== undefined),
    ),
  )

  app.post('/game-servers', async c => {
    const form = await formOf(c.req.raw)
    const game = form.get('game')
    const name = form.get('name')
    if (!game || !name) return bare(400)
    // The vendor's own shape for a create it refuses (seen live 2026-09-08):
    // a **200** carrying a plain-text sentence and no server. A caller that
    // trusts the status and parses JSON reads it as a parser bug.
    if (game === 'cs2' && !form.get('cs2_settings.rcon'))
      return c.text('cs2_settings.rcon needs to be set', 200)
    const id = nextId()
    const server = blank(id, name, game, form.get('location') ?? defaultLocation)
    applyForm(server, form)
    server.id = id
    servers.set(id, { server, files: new Map(), cache: new Map(), console: [] })
    return c.json(server)
  })

  app.get('/game-servers/:id', c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    // The single GET **does** refresh `booting` before answering.
    refresh(id, record)
    return c.json(record.server)
  })

  app.put('/game-servers/:id', async c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    applyForm(record.server, await formOf(c.req.raw))
    // "If the server is on this will restart the server to reflect the changes."
    if (record.server.on === true) boot(record)
    return bare(200)
  })

  app.delete('/game-servers/:id', c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    if (record.server.deletion_protection === true) return bare(403)
    servers.delete(id)
    return bare(200)
  })

  app.post('/game-servers/:id/duplicate', async c => {
    const id = c.req.param('id')
    const source = find(id)
    if (!source) return bare(404)
    const form = await formOf(c.req.raw)
    const destinationId = form.get('destination_server_id')
    const target = destinationId ? find(destinationId) : undefined
    if (destinationId && !target) return bare(404)

    const cloneId = destinationId ?? nextId()
    const server = structuredClone(source.server)
    server.id = cloneId
    server.name = `${String(source.server.name)} (copy)`
    server.location = form.get('location') ?? source.server.location
    server.on = false
    server.booting = false
    server.players_online = 0
    // A clone is never protected — teardown is `stop` + `delete`.
    server.deletion_protection = false
    server.duplicate_source_server = id
    server.ftp_password = `fake-ftp-${cloneId}`
    server.mysql_password = `fake-mysql-${cloneId}`
    server.mysql_username = `fake_${cloneId}`
    server.created_at = Math.floor(clock.now() / 1000)

    // The caveat, modelled: a clone gets the API's **cached** files, not
    // whatever is on the source box right now.
    const files = copyFiles(source.cache)
    servers.set(cloneId, { server, files, cache: copyFiles(files), console: [] })
    return c.json(server)
  })

  app.post('/game-servers/:id/sync-files', c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    record.cache = copyFiles(record.files)
    return bare(200)
  })

  app.post('/game-servers/:id/start', c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    // "This will reboot the server if the server is already on."
    boot(record)
    return bare(200)
  })

  app.post('/game-servers/:id/stop', c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    record.server.on = false
    record.server.booting = false
    record.bootDueAt = undefined
    record.server.players_online = 0
    // "…and once more when stopping a server."
    record.cache = copyFiles(record.files)
    return bare(200)
  })

  app.get('/game-servers/:id/console', async c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    if (faults.consoleTimeout) return await never()
    const max = Number(c.req.query('max_lines') ?? 1000)
    return c.json({ lines: record.console.slice(-Math.max(max, 0)) })
  })

  app.post('/game-servers/:id/console', async c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    const line = (await formOf(c.req.raw)).get('line')
    if (line === undefined) return bare(400)
    record.console.push(line)
    return bare(200)
  })

  app.get('/game-servers/:id/files', c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    const root = c.req.query('path') ?? ''
    return c.json(
      Array.from(record.files, ([path, file]) => ({ path, size: file.content.byteLength })).filter(
        entry => entry.path.startsWith(root),
      ),
    )
  })

  app.get('/game-servers/:id/files/:path{.+}', c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    const path = c.req.param('path')
    const file = record.files.get(path)
    if (!file) return bare(404)
    return new Response(file.content.slice(), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })
  })

  app.post('/game-servers/:id/files/:path{.+}', async c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    const path = c.req.param('path')
    // "if the path ends with / a directory will be created and the file
    // parameter will be ignored" — a directory is not a thing this fake
    // stores, so it is simply accepted.
    if (path.endsWith('/')) return bare(200)
    const body = await c.req.raw.formData()
    const file = body.get('file')
    const content =
      file instanceof File
        ? new Uint8Array(await file.arrayBuffer())
        : encoder.encode(typeof file === 'string' ? file : '')
    if (content.byteLength > UPLOAD_LIMIT_BYTES) return bare(507)
    record.files.set(path, { content })
    return bare(200)
  })

  app.put('/game-servers/:id/files/:path{.+}', async c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    const path = c.req.param('path')
    const destination = (await formOf(c.req.raw)).get('destination')
    if (!destination) return bare(400)
    const file = record.files.get(path)
    if (!file) return bare(404)
    record.files.delete(path)
    record.files.set(destination, file)
    return bare(200)
  })

  app.get('/game-servers/:id/metrics', c => {
    const id = c.req.param('id')
    const record = find(id)
    if (!record) return bare(404)
    return c.json({
      all_time_players: [],
      maps_played: [],
      players_online: [],
      players_online_graph: [],
      memory_usage_bytes_graph: [],
    })
  })

  app.all('*', () => bare(404))

  /**
   * The door. An abort on the caller's signal rejects the promise the way
   * `fetch` does, rather than reaching the handler — which is what makes the
   * `consoleTimeout` fault a timeout and not a 500.
   */
  const fetchImpl: FetchLike = async (input, init) => {
    const request = new Request(input, init)
    if (!request.signal) return await app.fetch(request)
    return await Promise.race([app.fetch(request), aborted(request.signal)])
  }

  return {
    fetch: fetchImpl,
    calls,
    setFaults(next) {
      faults = next
      statusFaultsLeft = next.status?.times ?? 0
    },
    servers: () => Array.from(servers, ([id, record]) => viewOf(id, record)),
    server(id) {
      const record = servers.get(id)
      return record ? viewOf(id, record) : undefined
    },
    say(id, line) {
      servers.get(id)?.console.push(line)
    },
    async listen(listenOptions = {}) {
      const { serve } = await import('@hono/node-server')
      const hostname = listenOptions.hostname ?? '127.0.0.1'
      const server = serve({ fetch: app.fetch, port: listenOptions.port ?? 0, hostname })
      await new Promise<void>(resolve => {
        if (server.listening) resolve()
        else server.once('listening', () => resolve())
      })
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      return {
        url: `http://${hostname}:${port}${BASE_PATH}`,
        port,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close(error => (error ? reject(error) : resolve()))
          }),
      }
    },
  }
}

/**
 * Multipart and urlencoded bodies, flattened to text — the vendor's forms
 * carry nothing but scalars outside the file upload, which reads its own
 * `FormData`.
 */
async function formOf(request: Request): Promise<Map<string, string>> {
  const form = new Map<string, string>()
  const type = request.headers.get('content-type') ?? ''
  if (
    !type.includes('multipart/form-data') &&
    !type.includes('application/x-www-form-urlencoded')
  ) {
    return form
  }
  const body = await request.formData()
  for (const [key, value] of body) if (typeof value === 'string') form.set(key, value)
  return form
}

/**
 * The console that times out: a handler that never answers. The caller's
 * abort is what ends the wait (`fetchImpl`), so there is no timer of ours and
 * nothing to leak when the test ends.
 */
function never(): Promise<Response> {
  return new Promise<Response>(() => {})
}

/** Rejects with the signal's reason when the caller gives up, and never otherwise. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
