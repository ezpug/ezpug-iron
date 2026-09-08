import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createFakeClock } from '@ezpug/core'
import Ajv, { type ValidateFunction } from 'ajv'
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeDathost, type FakeDathost, type FetchLike } from './fake'

/**
 * **The fake Dathost, held against the vendor's own OpenAPI** (PRD-02 T15).
 *
 * `references/dathost/openapi.merged.json` merges every fragment embedded in
 * the vendored documentation pages into one document, and
 * `references/dathost.md` names it "the fake's schema truth". This test is
 * where that claim is cashed: `call()` wraps every request the suite makes,
 * matches its path against the document's path templates, and validates the
 * body against the schema the document declares for that operation and
 * status. A response the vendor did not describe is the one thing this file
 * cannot check, so those are listed explicitly below rather than passed over.
 *
 * It reads the reference material rather than importing it (CLAUDE.md:
 * `references/` is never imported) — the file is git-tracked and this is a
 * test, not shipped code.
 *
 * The behaviours under test are the ones the adapter (T16) would get wrong
 * without them: the sync-files caveat, `start` rebooting a running server, a
 * single GET refreshing `booting` where the list does not, deletion
 * protection, the 100 MB upload refusal, and the four faults.
 */

const openapi = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../../references/dathost/openapi.merged.json', import.meta.url),
    ),
    'utf8',
  ),
) as {
  paths: Record<
    string,
    Record<
      string,
      { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }
    >
  >
  components: unknown
}

// The vendor's document is OpenAPI 3.0 with `example` beside schemas; strict
// mode would reject the document rather than any response it describes.
const ajv = new Ajv({ strict: false })
const validators = new Map<string, ValidateFunction>()

/**
 * Statuses the fake answers with that the vendored document never mentions.
 * Each one is a documented behaviour from `references/dathost.md` or an
 * injected fault, and each is listed here so that adding a fifth is a
 * deliberate edit rather than a silent gap.
 */
const UNDOCUMENTED_STATUSES: Record<number, string> = {
  401: 'Basic auth is prose in the docs, not a documented response',
  403: 'DELETE refused while `deletion_protection` is set',
  429: 'rate limiting is undocumented; the adapter backs off on it',
  500: 'an injected server fault',
}

/**
 * Gaps in the vendored document itself: `GET …/metrics` declares only a 200,
 * where every other server route documents the 404 for a server that is not
 * there. The adapter has to handle one, so the fake answers one.
 */
const UNDOCUMENTED_OPERATION_STATUSES = new Set([
  'GET /api/0.1/game-servers/{server_id}/metrics 404',
])

/**
 * Bodies the vendor describes in prose where the document forgot the schema:
 * "On success this returns the new server in the same format as
 * game-servers" (`post_game_servers.md`). Held against `GameServerOutput`
 * anyway — a create that broke the shape would otherwise pass unread.
 */
const PROSE_SCHEMAS: Record<string, string> = {
  'POST /api/0.1/game-servers': 'GameServerOutput',
}

/**
 * The two bodies nothing describes at all. The fake answers what the
 * behaviour tests below assert; T19's live smoke is where the real API gets
 * to disagree, and this list is what it would correct.
 */
const UNDESCRIBED_BODIES = new Set([
  'GET /api/0.1/game-servers/{server_id}/console',
  'GET /api/0.1/game-servers/{server_id}/files',
])

/** `/api/0.1/game-servers/abc/files/cfg/server.cfg` → its path template. */
function templateFor(pathname: string): string {
  const parts = pathname.split('/')
  const candidates = Object.keys(openapi.paths)
    .map(template => ({ template, segments: template.split('/') }))
    // A trailing `{path}` absorbs the rest, so the longest literal prefix wins.
    .sort((a, b) => b.segments.length - a.segments.length)
  for (const { template, segments } of candidates) {
    const greedy = segments.at(-1) === '{path}'
    if (greedy ? parts.length < segments.length : parts.length !== segments.length) continue
    const matches = segments.every((segment, index) => {
      if (segment.startsWith('{')) return true
      return segment === parts[index]
    })
    if (matches) return template
  }
  throw new Error(`no Dathost path template for ${pathname}`)
}

function validatorFor(template: string, method: string, status: number): ValidateFunction | null {
  const key = `${method} ${template} ${status}`
  const cached = validators.get(key)
  if (cached) return cached
  const operation = openapi.paths[template]?.[method.toLowerCase()]
  expect(operation, `${method} ${template} is outside the vendored subset`).toBeDefined()
  const prose = PROSE_SCHEMAS[`${method} ${template}`]
  const schema =
    operation?.responses?.[String(status)]?.content?.['application/json']?.schema ??
    (status === 200 && prose ? { $ref: `#/components/schemas/${prose}` } : undefined)
  if (!schema) return null
  // A response schema is a `$ref` into `#/components/schemas`; carrying the
  // components along makes the fragment resolvable from the compiled root.
  const validate = ajv.compile({ ...(schema as object), components: openapi.components })
  validators.set(key, validate)
  return validate
}

let fake: FakeDathost
let clock: ReturnType<typeof createFakeClock>

const BASE = 'https://dathost.example.invalid/api/0.1'
const PLUGIN = 'addons/counterstrikesharp/plugins/EZPug.Core/EZPug.Core.dll'
const AUTH = { authorization: `Basic ${Buffer.from('ops@ezpug.test:hunter2').toString('base64')}` }

/**
 * One request through the fake, with every answer held against the vendor's
 * schema before the test sees it.
 */
const call: FetchLike = async (input, init) => {
  const response = await fake.fetch(input, init)
  const pathname = new URL(input).pathname
  const template = templateFor(pathname)
  const method = init?.method ?? 'GET'
  const key = `${method} ${template}`

  if (
    !(response.status in UNDOCUMENTED_STATUSES) &&
    !UNDOCUMENTED_OPERATION_STATUSES.has(`${key} ${response.status}`)
  ) {
    const declared = openapi.paths[template]?.[method.toLowerCase()]?.responses ?? {}
    expect(Object.keys(declared), `${key} → ${response.status}`).toContain(String(response.status))
  }

  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) return response

  const body = await response.clone().json()
  const validate = validatorFor(template, method, response.status)
  if (validate) {
    expect(validate(body) || ajv.errorsText(validate.errors), `${key} → ${response.status}`).toBe(
      true,
    )
  } else {
    expect(UNDESCRIBED_BODIES, `${key} answers a body the vendor never described`).toContain(key)
  }
  return response
}

const get = (path: string): Promise<Response> => call(`${BASE}${path}`, { headers: AUTH })

const form = (fields: Record<string, string>): FormData => {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.append(key, value)
  return body
}

const post = (path: string, fields: Record<string, string> = {}): Promise<Response> =>
  call(`${BASE}${path}`, { method: 'POST', headers: AUTH, body: form(fields) })

const put = (path: string, fields: Record<string, string>): Promise<Response> =>
  call(`${BASE}${path}`, { method: 'PUT', headers: AUTH, body: form(fields) })

const del = (path: string): Promise<Response> =>
  call(`${BASE}${path}`, { method: 'DELETE', headers: AUTH })

const create = async (fields: Record<string, string> = {}): Promise<Record<string, unknown>> => {
  const response = await post('/game-servers', {
    game: 'cs2',
    name: 'ezpug-template',
    // The vendor refuses a cs2 create without one (its own test is below).
    'cs2_settings.rcon': 'fake-rcon-from-the-test',
    ...fields,
  })
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

beforeEach(() => {
  clock = createFakeClock()
  fake = createFakeDathost({
    clock,
    email: 'ops@ezpug.test',
    password: 'hunter2',
    bootMs: 30_000,
  })
})

describe('the fake Dathost', () => {
  it('refuses every request without the account’s Basic auth', async () => {
    const anonymous = await fake.fetch(`${BASE}/account`)
    expect(anonymous.status).toBe(401)

    const wrong = await fake.fetch(`${BASE}/account`, {
      headers: { authorization: `Basic ${Buffer.from('ops@ezpug.test:wrong').toString('base64')}` },
    })
    expect(wrong.status).toBe(401)

    expect((await get('/account')).status).toBe(200)
  })

  it('answers the account the live smoke’s preflight reads', async () => {
    const account = (await (await get('/account')).json()) as { email: string; credits: number }
    expect(account.email).toBe('ops@ezpug.test')
    expect(account.credits).toBeGreaterThan(0)
  })

  it('creates a server from the multipart form, dotted settings and all', async () => {
    const server = await create({
      location: 'dusseldorf',
      user_data: 'ezpug:match:m-1',
      autostop: 'false',
      deletion_protection: 'true',
      max_disk_usage_gb: '30',
      'cs2_settings.slots': '12',
      'cs2_settings.enable_gotv': 'true',
      'cs2_settings.rcon': 'fake-rcon-from-the-caller',
    })

    expect(server.game).toBe('cs2')
    expect(server.location).toBe('dusseldorf')
    expect(server.user_data).toBe('ezpug:match:m-1')
    expect(server.deletion_protection).toBe(true)
    expect(server.max_disk_usage_gb).toBe(30)
    expect(server.on).toBe(false)
    expect(server.cs2_settings).toMatchObject({
      slots: 12,
      enable_gotv: true,
      rcon: 'fake-rcon-from-the-caller',
    })
  })

  it('refuses a cs2 create without an rcon password the way the vendor does: 200, text, no server', async () => {
    const response = await post('/game-servers', { game: 'cs2', name: 'no-rcon' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('cs2_settings.rcon needs to be set')
    expect(fake.servers()).toHaveLength(0)
  })

  it('lists what the account holds and forgets a deleted server', async () => {
    const first = await create({ name: 'one' })
    await create({ name: 'two' })

    const listed = (await (await get('/game-servers')).json()) as { id: string }[]
    expect(listed.map(server => server.id)).toEqual([first.id, listed[1]?.id])
    expect(listed).toHaveLength(2)

    expect((await del(`/game-servers/${first.id}`)).status).toBe(200)
    const after = (await (await get('/game-servers')).json()) as { id: string }[]
    expect(after.map(server => server.id)).not.toContain(first.id)
    expect((await get(`/game-servers/${first.id}`)).status).toBe(404)
    expect((await del(`/game-servers/${first.id}`)).status).toBe(404)
  })

  it('refuses to delete a server while deletion protection is set', async () => {
    const template = await create({ deletion_protection: 'true' })
    expect((await del(`/game-servers/${template.id}`)).status).toBe(403)

    await put(`/game-servers/${template.id}`, { deletion_protection: 'false' })
    expect((await del(`/game-servers/${template.id}`)).status).toBe(200)
  })

  it('boots on the clock: the single GET refreshes booting, the list does not', async () => {
    const server = await create()
    expect((await post(`/game-servers/${server.id}/start`)).status).toBe(200)

    const booting = (await (await get(`/game-servers/${server.id}`)).json()) as Record<
      string,
      unknown
    >
    expect(booting).toMatchObject({ on: false, booting: true })

    await clock.advance(29_999)
    expect(
      ((await (await get(`/game-servers/${server.id}`)).json()) as Record<string, unknown>).booting,
    ).toBe(true)

    await clock.advance(1)
    // The list answers from the record as it stands — still `booting`.
    const listed = (await (await get('/game-servers')).json()) as Record<string, unknown>[]
    expect(listed[0]).toMatchObject({ booting: true, on: false })

    const refreshed = (await (await get(`/game-servers/${server.id}`)).json()) as Record<
      string,
      unknown
    >
    expect(refreshed).toMatchObject({ booting: false, on: true })
  })

  it('reboots a server that is already on, and stops one', async () => {
    const server = await create()
    await post(`/game-servers/${server.id}/start`)
    await clock.advance(30_000)
    expect(((await (await get(`/game-servers/${server.id}`)).json()) as { on: boolean }).on).toBe(
      true,
    )

    await post(`/game-servers/${server.id}/start`)
    expect(fake.server(String(server.id))?.booting).toBe(true)
    expect(fake.server(String(server.id))?.on).toBe(false)

    await clock.advance(30_000)
    await get(`/game-servers/${server.id}`)
    expect((await post(`/game-servers/${server.id}/stop`)).status).toBe(200)
    expect(fake.server(String(server.id))).toMatchObject({ on: false, booting: false })
  })

  describe('duplicate', () => {
    it('copies the last synced files, not what is on the box', async () => {
      const template = await create({ deletion_protection: 'true' })
      const id = String(template.id)

      await upload(id, PLUGIN, 'v1')
      await post(`/game-servers/${id}/sync-files`)
      // The image script's mistake: upload, then clone without syncing.
      await upload(id, PLUGIN, 'v2')
      expect(fake.server(id)?.files.get(PLUGIN)).toBe('v2')
      expect(fake.server(id)?.cache.get(PLUGIN)).toBe('v1')

      const stale = (await (await post(`/game-servers/${id}/duplicate`)).json()) as { id: string }
      expect(fake.server(stale.id)?.files.get(PLUGIN)).toBe('v1')

      await post(`/game-servers/${id}/sync-files`)
      expect(fake.server(id)?.cache.get(PLUGIN)).toBe('v2')
      const fresh = (await (await post(`/game-servers/${id}/duplicate`)).json()) as { id: string }
      expect(fake.server(fresh.id)?.files.get(PLUGIN)).toBe('v2')
    })

    it('gives the clone its own identity, off, unprotected, tagged with its source', async () => {
      const template = await create({
        deletion_protection: 'true',
        user_data: 'ezpug:template',
        'cs2_settings.slots': '12',
      })
      await post(`/game-servers/${template.id}/start`)
      await clock.advance(30_000)
      await get(`/game-servers/${template.id}`)

      const clone = (await (await post(`/game-servers/${template.id}/duplicate`)).json()) as Record<
        string,
        unknown
      >
      expect(clone.id).not.toBe(template.id)
      expect(clone.on).toBe(false)
      expect(clone.booting).toBe(false)
      expect(clone.deletion_protection).toBe(false)
      expect(clone.duplicate_source_server).toBe(template.id)
      expect(clone.cs2_settings).toMatchObject({ slots: 12 })
      // Deleting a clone is what teardown does, and it is allowed.
      expect((await del(`/game-servers/${clone.id}`)).status).toBe(200)
    })

    it('wipes a named destination instead of creating one, and 404s an unknown source', async () => {
      const template = await create()
      await upload(String(template.id), 'cfg/server.cfg', 'hostname EZPug')
      await post(`/game-servers/${template.id}/sync-files`)
      const destination = await create({ name: 'to-be-wiped' })
      await upload(String(destination.id), 'cfg/old.cfg', 'stale')

      await post(`/game-servers/${template.id}/duplicate`, {
        destination_server_id: String(destination.id),
      })
      const wiped = fake.server(String(destination.id))
      expect([...(wiped?.files.keys() ?? [])]).toEqual(['cfg/server.cfg'])

      expect((await post('/game-servers/deadbeef/duplicate')).status).toBe(404)
    })
  })

  describe('files', () => {
    it('uploads, lists, downloads and moves', async () => {
      const server = await create()
      const id = String(server.id)

      expect((await upload(id, 'cfg/server.cfg', 'hostname EZPug')).status).toBe(200)
      const listed = (await (await get(`/game-servers/${id}/files`)).json()) as {
        path: string
        size: number
      }[]
      expect(listed).toEqual([{ path: 'cfg/server.cfg', size: 14 }])

      const download = await get(`/game-servers/${id}/files/cfg/server.cfg`)
      expect(await download.text()).toBe('hostname EZPug')

      expect(
        (await put(`/game-servers/${id}/files/cfg/server.cfg`, { destination: 'cfg/moved.cfg' }))
          .status,
      ).toBe(200)
      expect((await get(`/game-servers/${id}/files/cfg/server.cfg`)).status).toBe(404)
      expect(await (await get(`/game-servers/${id}/files/cfg/moved.cfg`)).text()).toBe(
        'hostname EZPug',
      )
    })

    it('narrows the listing to a path and refuses an upload over 100 MB', async () => {
      const server = await create()
      const id = String(server.id)
      await upload(id, 'cfg/server.cfg', 'a')
      await upload(id, 'addons/metamod/metaplugins.ini', 'b')

      const cfg = (await (await get(`/game-servers/${id}/files?path=cfg`)).json()) as {
        path: string
      }[]
      expect(cfg.map(entry => entry.path)).toEqual(['cfg/server.cfg'])

      const oversized = new Uint8Array(100 * 1024 * 1024 + 1)
      const body = new FormData()
      body.append('file', new Blob([oversized]), 'huge.bin')
      const refused = await call(`${BASE}/game-servers/${id}/files/huge.bin`, {
        method: 'POST',
        headers: AUTH,
        body,
      })
      expect(refused.status).toBe(507)
      expect(fake.server(id)?.files.has('huge.bin')).toBe(false)
    })
  })

  describe('console', () => {
    it('takes a line and hands back the backlog', async () => {
      const server = await create()
      const id = String(server.id)
      fake.say(id, 'Console initialized.')

      expect((await post(`/game-servers/${id}/console`, { line: 'ezpug_status' })).status).toBe(200)
      const backlog = (await (await get(`/game-servers/${id}/console`)).json()) as {
        lines: string[]
      }
      expect(backlog.lines).toEqual(['Console initialized.', 'ezpug_status'])

      const tail = (await (await get(`/game-servers/${id}/console?max_lines=1`)).json()) as {
        lines: string[]
      }
      expect(tail.lines).toEqual(['ezpug_status'])
    })
  })

  it('answers metrics for a server and 404s for one that is gone', async () => {
    const server = await create()
    const metrics = (await (await get(`/game-servers/${server.id}/metrics`)).json()) as {
      players_online: unknown[]
    }
    expect(metrics.players_online).toEqual([])
    expect((await get('/game-servers/deadbeef/metrics')).status).toBe(404)
  })

  describe('faults', () => {
    it('answers 429 for the next N requests and then relents', async () => {
      const server = await create()
      fake.setFaults({ status: { code: 429, times: 2 } })

      expect((await get(`/game-servers/${server.id}`)).status).toBe(429)
      expect((await get(`/game-servers/${server.id}`)).status).toBe(429)
      expect((await get(`/game-servers/${server.id}`)).status).toBe(200)
    })

    it('answers 500 only on the route a test names', async () => {
      const server = await create()
      fake.setFaults({ status: { code: 500, times: 5, only: '/start' } })

      expect((await post(`/game-servers/${server.id}/start`)).status).toBe(500)
      expect((await get(`/game-servers/${server.id}`)).status).toBe(200)
    })

    it('boots a server that never finishes booting', async () => {
      const server = await create()
      const id = String(server.id)
      fake.setFaults({ neverBoot: [id] })

      await post(`/game-servers/${id}/start`)
      await clock.advance(60 * 60_000)
      const probed = (await (await get(`/game-servers/${id}`)).json()) as Record<string, unknown>
      expect(probed).toMatchObject({ booting: true, on: false })
    })

    it('vanishes a server: 404 everywhere and absent from the list', async () => {
      const server = await create()
      const other = await create({ name: 'survivor' })
      const id = String(server.id)
      fake.setFaults({ vanished: [id] })

      expect((await get(`/game-servers/${id}`)).status).toBe(404)
      expect((await post(`/game-servers/${id}/stop`)).status).toBe(404)
      expect((await del(`/game-servers/${id}`)).status).toBe(404)
      const listed = (await (await get('/game-servers')).json()) as { id: string }[]
      expect(listed.map(entry => entry.id)).toEqual([other.id])
    })

    it('hangs a console read until the caller gives up', async () => {
      const server = await create()
      fake.setFaults({ consoleTimeout: true })

      const controller = new AbortController()
      const pending = fake.fetch(`${BASE}/game-servers/${server.id}/console`, {
        headers: AUTH,
        signal: controller.signal,
      })
      controller.abort(new Error('the console timed out'))
      await expect(pending).rejects.toThrow('the console timed out')
    })
  })

  it('records every request that arrived, refused ones included', async () => {
    await create()
    await fake.fetch(`${BASE}/account`)

    expect(fake.calls).toEqual(['POST /api/0.1/game-servers', 'GET /api/0.1/account'])
  })

  it('serves the same app over a real socket', async () => {
    const listener = await fake.listen()
    try {
      const response = await fetch(`${listener.url}/account`, { headers: AUTH })
      expect(response.status).toBe(200)
      expect(((await response.json()) as { email: string }).email).toBe('ops@ezpug.test')
    } finally {
      await listener.close()
    }
  })
})

async function upload(id: string, path: string, content: string): Promise<Response> {
  const body = new FormData()
  body.append('file', new Blob([content]), path.split('/').at(-1) ?? 'file')
  return await call(`${BASE}/game-servers/${id}/files/${path}`, {
    method: 'POST',
    headers: AUTH,
    body,
  })
}
