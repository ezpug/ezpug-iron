import type { MatchRequest, MatchRequestInput } from '@ezpug/match-api'
import { matchRequestSchema } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from '../http/testing'
import type { AuthenticatedKey } from '../keys/service'
import type { ConsoleTail, ServerChannel } from '../link/channels'
import type { GameServerProvider, ProviderConsoleLine } from '../providers/provider'
import { CONSOLE_REDACTED } from '../rcon/redact'

/**
 * **The console and RCON routes** (PRD-02 T20). Two doors an operator opens
 * when something is wrong and the API is not enough: what has this server
 * been printing, and run this line on it. Both are proved here over the whole
 * HTTP surface, because both are about *ordering* — which source answers, and
 * what the answer may not contain.
 *
 * The world is the sim's, with the sim provider replaced by a delegate that
 * also answers `rcon` and `console`; that is exactly the shape Dathost has
 * (a control plane with a console door) and the shape a node has (a Source
 * RCON socket, proved against a real listener in `../rcon/client.test.ts`).
 */

const SECRET_ID = 'whsec-1'
const SECRET = 'a-test-secret-of-at-least-thirty-two-chars'

let requests = 0
function request(overrides: Partial<MatchRequestInput> = {}): MatchRequest {
  requests += 1
  return matchRequestSchema.parse({
    clientMatchId: `console-${requests}`,
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'A', players: [{ steamId64: '76561198000000001', name: 'a' }] },
      teamB: { name: 'B', players: [{ steamId64: '76561198000000002', name: 'b' }] },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: SECRET_ID },
    ttlMinutes: 60,
    ...overrides,
  })
}

interface Rig {
  app: TestApp
  key: AuthenticatedKey
  secret: string
  /** The ledger row of the one match this rig ran. */
  serverRowId: string
  /** The provider's own handle for it. */
  serverId: string
  /** Every command the provider's RCON door was handed. */
  rconSeen: string[]
}

interface RigOptions {
  /** What the provider's `rcon` verb answers; `null` means "no RCON here". */
  rconAnswer?: (command: string) => string | null
  /** What the control plane kept before the link came up. */
  backlog?: ProviderConsoleLine[]
  /** Register no `rcon`/`console` at all — a bare provider, like the sim itself. */
  bare?: boolean
}

async function createRig(options: RigOptions = {}): Promise<Rig> {
  const app = createTestApp()
  const rconSeen: string[] = []
  if (!options.bare) {
    // The sim, wearing a control plane: same id, same verbs, plus the two
    // doors T20 reaches for first.
    app.providers.unregister('sim')
    const delegate: GameServerProvider = {
      ...app.sim,
      rcon: (_serverId, command) => {
        rconSeen.push(command)
        return Promise.resolve(options.rconAnswer?.(command) ?? null)
      },
      console: () => Promise.resolve(options.backlog ?? null),
    }
    app.providers.register(delegate)
  }
  const minted = await app.keys.mint({
    name: 'operator',
    scopes: ['matches', 'fleet', 'admin'],
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [{ id: SECRET_ID, secret: SECRET }],
  })
  const key = (await app.keys.get(minted.key.id)) as AuthenticatedKey
  await app.matches.create(key, request())
  await app.settle()
  const row = app.store.rows.servers[0]
  if (!row?.serverId) throw new Error('the walk opened no ledger row')
  return { app, key, secret: minted.secret, serverRowId: row.id, serverId: row.serverId, rconSeen }
}

/** A channel that only knows how to hand back a tail — what the fleet route reads. */
function tailChannel(
  app: TestApp,
  serverId: string,
  tail: ConsoleTail | undefined,
  onSolicit?: () => ConsoleTail,
): ServerChannel {
  let cached = tail
  const channel: ServerChannel = {
    server: { provider: 'sim', serverId },
    send: () => Promise.reject(new Error('not in this test')),
    consoleTail: () => cached,
    ...(onSolicit && {
      console: () => {
        cached = onSolicit()
        return Promise.resolve(cached)
      },
    }),
  }
  app.links.attach(channel)
  return channel
}

describe('GET /v1/fleet/servers/:serverId/console', () => {
  it('serves the tail the plugin relayed, stamped on our clock and stripped of passwords', async () => {
    const rig = await createRig()
    const at = rig.app.clock.date()
    tailChannel(rig.app, rig.serverId, {
      at,
      uptimeMs: 60_000,
      lines: [
        { uptimeMs: 58_000, line: 'rcon_password "hunter2"' },
        { uptimeMs: 60_000, line: 'Connection to Steam servers successful.' },
      ],
    })
    const answer = await rig.app.request(`/v1/fleet/servers/${rig.serverRowId}/console`, {
      key: rig.secret,
    })
    expect(answer.status).toBe(200)
    expect(answer.body.lines).toEqual([
      {
        at: new Date(at.getTime() - 2_000).toISOString(),
        line: `rcon_password "${CONSOLE_REDACTED}"`,
      },
      { at: at.toISOString(), line: 'Connection to Steam servers successful.' },
    ])
    await rig.app.close()
  })

  it('asks the server for a tail when it has never sent one', async () => {
    const rig = await createRig()
    const at = rig.app.clock.date()
    let asked = 0
    tailChannel(rig.app, rig.serverId, undefined, () => {
      asked += 1
      return { at, uptimeMs: 1_000, lines: [{ uptimeMs: 1_000, line: 'map de_mirage' }] }
    })
    const answer = await rig.app.request(`/v1/fleet/servers/${rig.serverRowId}/console`, {
      key: rig.secret,
    })
    expect(asked).toBe(1)
    expect(answer.body.lines).toEqual([{ at: at.toISOString(), line: 'map de_mirage' }])
    await rig.app.close()
  })

  it('falls back to the provider’s backlog before the link is up', async () => {
    const rig = await createRig({
      backlog: [
        { at: '2026-09-05T18:00:00.000Z', line: 'sv_password geheim' },
        { at: '2026-09-05T18:00:01.000Z', line: 'Server is hibernating' },
      ],
    })
    // The sim attaches a channel of its own; it has no tail, so the control
    // plane's backlog is the only thing left to say.
    const answer = await rig.app.request(`/v1/fleet/servers/${rig.serverRowId}/console`, {
      key: rig.secret,
    })
    expect(answer.status).toBe(200)
    expect(answer.body.lines).toEqual([
      { at: '2026-09-05T18:00:00.000Z', line: `sv_password ${CONSOLE_REDACTED}` },
      { at: '2026-09-05T18:00:01.000Z', line: 'Server is hibernating' },
    ])
    await rig.app.close()
  })

  it('answers an empty tail rather than an error when nobody has anything to say', async () => {
    const rig = await createRig({ bare: true })
    const answer = await rig.app.request(`/v1/fleet/servers/${rig.serverRowId}/console`, {
      key: rig.secret,
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ lines: [] })
    await rig.app.close()
  })

  it('is a 404 for a server nobody allocated and a 403 without the fleet scope', async () => {
    const rig = await createRig()
    const missing = await rig.app.request('/v1/fleet/servers/sim-nobody/console', {
      key: rig.secret,
    })
    expect(missing.status).toBe(404)
    const reader = await rig.app.keys.mint({
      name: 'reader',
      scopes: ['matches'],
      budget: { maxConcurrentServers: 1, maxServerLifetimeMinutes: 60, monthlyCents: 0 },
      webhookSecrets: [{ id: SECRET_ID, secret: SECRET }],
    })
    const refused = await rig.app.request(`/v1/fleet/servers/${rig.serverRowId}/console`, {
      key: reader.secret,
    })
    expect(refused.status).toBe(403)
    await rig.app.close()
  })
})

describe('POST /v1/fleet/servers/:serverId/rcon', () => {
  it('prefers the provider’s door, hands back what it printed and records the line', async () => {
    const rig = await createRig({
      rconAnswer: command =>
        command === 'status' ? 'hostname: EZPug\nrcon_password "hunter2"' : null,
    })
    const answer = await rig.app.request(`/v1/fleet/servers/${rig.serverRowId}/rcon`, {
      method: 'POST',
      key: rig.secret,
      json: { command: 'status' },
    })
    expect(answer.status).toBe(200)
    expect(answer.body.output).toBe(`hostname: EZPug\nrcon_password "${CONSOLE_REDACTED}"`)
    expect(rig.rconSeen).toEqual(['status'])

    const audit = await rig.app.store.rconAudit(rig.serverRowId)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      keyId: rig.key.key.id,
      command: 'status',
      output: `hostname: EZPug\nrcon_password "${CONSOLE_REDACTED}"`,
    })
    await rig.app.close()
  })

  it('never writes a password into the audit, whichever half of the line carried it', async () => {
    const rig = await createRig({ rconAnswer: () => 'ok' })
    await rig.app.request(`/v1/fleet/servers/${rig.serverRowId}/rcon`, {
      method: 'POST',
      key: rig.secret,
      json: { command: 'sv_password geheim' },
    })
    const audit = await rig.app.store.rconAudit(rig.serverRowId)
    expect(audit[0]?.command).toBe(`sv_password ${CONSOLE_REDACTED}`)
    expect(JSON.stringify(audit)).not.toContain('geheim')
    await rig.app.close()
  })

  it('falls through to the link when the provider has no RCON — and a sim refuses', async () => {
    const rig = await createRig({ bare: true })
    const answer = await rig.app.request(`/v1/fleet/servers/${rig.serverRowId}/rcon`, {
      method: 'POST',
      key: rig.secret,
      json: { command: 'status' },
    })
    expect(answer.status).toBe(400)
    expect(answer.body.error.code).toBe('command_unsupported')
    await rig.app.close()
  })

  it('refuses a row the ledger has closed', async () => {
    const rig = await createRig({ rconAnswer: () => 'ok' })
    await rig.app.fleet.release(rig.serverRowId, 'the operator asked')
    await rig.app.settle()
    const answer = await rig.app.request(`/v1/fleet/servers/${rig.serverRowId}/rcon`, {
      method: 'POST',
      key: rig.secret,
      json: { command: 'status' },
    })
    expect(answer.status).toBe(409)
    expect(answer.body.error.code).toBe('invalid_state')
    await rig.app.close()
  })

  it('records the failure and answers 503 when the door is shut', async () => {
    const rig = await createRig({
      rconAnswer: () => {
        throw new Error('connect ECONNREFUSED')
      },
    })
    const answer = await rig.app.request(`/v1/fleet/servers/${rig.serverRowId}/rcon`, {
      method: 'POST',
      key: rig.secret,
      json: { command: 'status' },
    })
    expect(answer.status).toBe(503)
    expect(answer.body.error.code).toBe('provider_unavailable')
    const audit = await rig.app.store.rconAudit(rig.serverRowId)
    expect(audit[0]?.output).toContain('failed')
    await rig.app.close()
  })
})
