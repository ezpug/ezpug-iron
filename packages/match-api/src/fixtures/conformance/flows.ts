import { ApiError } from '../../errors'
import type { MatchRules, WebhookEnvelope } from '../../index'
import { deepEqual } from './recording'
import type { ConformanceContext, ConformanceFlow } from './types'

/**
 * **The flows** (PRD-01 T8) — what a client actually does with the Match API,
 * written once and run against every implementation of it: the fake here,
 * the orchestrator in PRD-02, whatever the platform pins. Each is a small
 * story with checks along the way, and each records what it saw
 * (`fixtures/recorded/<id>.json`) so a later run can be held against it byte
 * for byte.
 *
 * Two rules keep them honest:
 *
 * - **A flow asserts the contract, not an implementation.** "The match ends
 *   `completed`", not "the fake's second server is `sim-2`". Where two
 *   answers are both correct — a `csgo` request may be refused
 *   `no_capable_server` or `game_unsupported` — the check accepts the set.
 * - **A flow is short on purpose.** The rounds are set to the smallest number
 *   that still plays a whole map (`SHORT_RULES`), because every extra round
 *   is another kilobyte in a golden file nobody reads. The shapes are what
 *   matters, and a two-round map produces all of them.
 */

/** Ten fake SteamID64s, five a side — the grammar, none of them a person. */
const TEAM_A_NAMES = ['hunzR', 'maex', 'Zerberus', 'flippo', 'Kessi'] as const
const TEAM_B_NAMES = ['wickeD', 'Jörg', 'schnitzL', 'BastiGHG', 'moepL'] as const

/** A roster of made-up players with well-formed ids. */
export function conformanceRoster(names: readonly string[], offset: number) {
  return names.map((name, index) => ({
    steamId64: `7656119800000${String(offset + index).padStart(4, '0')}`,
    name,
  }))
}

export const CONFORMANCE_TEAMS = {
  teamA: { name: 'Team hunzR', players: conformanceRoster(TEAM_A_NAMES, 0) },
  teamB: { name: 'Team wickeD', players: conformanceRoster(TEAM_B_NAMES, 100) },
}

/** No roster at all — an open-join mode fills itself. */
export const EMPTY_TEAMS = {
  teamA: { name: 'Alle', players: [] },
  teamB: { name: 'Niemand', players: [] },
}

/** The shortest rules that still play a whole map: MR1, no overtime. */
export const SHORT_RULES: MatchRules = {
  regulationRounds: 2,
  overtime: { enabled: false, maxRounds: 2, startMoney: 10_000 },
  warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
  cvars: {},
}

/** The happy flow plays a little longer, so a side swap has rounds on both sides of it. */
export const HAPPY_RULES: MatchRules = { ...SHORT_RULES, regulationRounds: 4 }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/

/** The payload types of a replay, in order — what most checks look at. */
function types(envelopes: readonly WebhookEnvelope[]): string[] {
  return envelopes.map(envelope => envelope.payload.type)
}

function payload<T extends WebhookEnvelope['payload']['type']>(
  envelopes: readonly WebhookEnvelope[],
  type: T,
): Extract<WebhookEnvelope['payload'], { type: T }> | undefined {
  const found = envelopes.find(envelope => envelope.payload.type === type)?.payload
  return found?.type === type
    ? (found as Extract<WebhookEnvelope['payload'], { type: T }>)
    : undefined
}

/** Run something that must be refused, and hand back the refusal. */
async function refusal(ctx: ConformanceContext, what: string, call: Promise<unknown>) {
  try {
    await call
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  ctx.require(what, false, 'the call was answered instead of refused')
  throw new Error('unreachable')
}

/**
 * The checks every match flow shares: the envelopes are a contiguous
 * sequence, they all belong to the match, none of them is ephemeral, and
 * every one of them was also delivered.
 */
function checkEnvelopeStream(
  ctx: ConformanceContext,
  matchId: string,
  clientMatchId: string,
  envelopes: readonly WebhookEnvelope[],
  seq: number,
): void {
  ctx.check(
    'the replay is a contiguous sequence from 1',
    envelopes.every((envelope, index) => envelope.seq === index + 1),
    envelopes
      .map(e => e.seq)
      .slice(0, 8)
      .join(','),
  )
  ctx.check(
    'the replay ends at the match’s own seq',
    envelopes.length === seq,
    `${envelopes.length} envelopes, Match.seq ${seq}`,
  )
  ctx.check(
    'every envelope names the match and the client’s id for it',
    envelopes.every(e => e.matchId === matchId && e.clientMatchId === clientMatchId),
  )
  ctx.check(
    'every deliveryId is unique',
    new Set(envelopes.map(e => e.deliveryId)).size === envelopes.length,
  )
  ctx.check(
    'position ticks are never durable',
    !types(envelopes).includes('position_tick'),
    'a position_tick was stored',
  )

  const delivered = ctx.delivered(matchId)
  const deliveredSeqs = new Set(delivered.map(e => e.seq))
  const missing = envelopes.filter(e => !deliveredSeqs.has(e.seq)).map(e => e.seq)
  ctx.check(
    'every durable envelope was delivered by webhook',
    missing.length === 0,
    `never delivered: ${missing.join(',')}`,
  )
  const unknown = delivered.filter(e => !envelopes.some(stored => stored.seq === e.seq))
  ctx.check(
    'no delivery carried something the replay does not have',
    unknown.length === 0,
    unknown.map(e => e.payload.type).join(','),
  )
  const first = delivered.find(e => envelopes.some(stored => stored.deliveryId === e.deliveryId))
  ctx.check(
    'a delivered envelope is the one the replay stored',
    first === undefined ||
      deepEqual(
        first,
        envelopes.find(e => e.deliveryId === first.deliveryId),
      ),
  )
}

/** Play a match to its end and hand back the final state and the replay. */
async function playToEnd(ctx: ConformanceContext, matchId: string) {
  const final = await ctx.waitForState(matchId, ['ended', 'failed', 'cancelled'])
  await ctx.settle()
  const envelopes = await ctx.replay(matchId)
  return { final, envelopes }
}

export const MATCH_API_CONFORMANCE_FLOWS: readonly ConformanceFlow[] = [
  {
    id: 'happy-bo1',
    title: 'a Bo1 on pug: create, ready, live, commands, demo, ended',
    needs: [],
    async run(ctx) {
      const catalog = await ctx.api.gamemodes.list()
      ctx.require(
        'the catalog ships pug',
        catalog.gamemodes.some(mode => mode.id === 'pug'),
        catalog.gamemodes.map(m => m.id).join(','),
      )

      const body = ctx.request({ rules: HAPPY_RULES })
      const created = await ctx.api.matches.create({ body })
      ctx.require(
        'a create answers a match before it is live',
        ['pending', 'allocating', 'configuring', 'ready'].includes(created.state),
        created.state,
      )
      ctx.check('the match id is a uuid', UUID.test(created.id), created.id)
      ctx.check('the client’s own id is echoed', created.clientMatchId === body.clientMatchId)
      ctx.check('a fresh match has no sequence yet', created.seq === 0, String(created.seq))
      ctx.check('the ttl is stated as an expiry', typeof created.expiresAt === 'string')

      const again = await ctx.api.matches.create({ body })
      ctx.check(
        'the same clientMatchId is the same match, not a second one',
        again.id === created.id,
        `${created.id} then ${again.id}`,
      )

      const params = { matchId: created.id }
      const ready = await ctx.waitFor('the server’s connect facts', async () => {
        const match = await ctx.raw.matches.get({ params })
        if (match.state === 'failed' || match.state === 'cancelled')
          throw new Error(`the match ${match.state} before it was ready`)
        return match.connect === null ? null : match
      })
      ctx.check('a ready server has a provider badge', ready.provider !== null)
      ctx.check('a ready server has the provider’s own id for it', ready.serverId !== null)
      ctx.check('a ready server holds a ledger row', ready.fleetServerId !== null)
      ctx.check(
        'the connect facts are complete',
        ready.connect !== null &&
          ready.connect.host.length > 0 &&
          ready.connect.port > 0 &&
          ready.connect.port < 65_536,
      )
      ctx.check('GOTV is stated with its delay', ready.tv !== null && ready.tv.delaySeconds >= 0)
      ctx.check('readyAt is set', ready.readyAt !== null)

      const live = await ctx.waitFor('the match to go live', async () => {
        const match = await ctx.raw.matches.get({ params })
        if (match.state === 'failed' || match.state === 'cancelled')
          throw new Error(`the match ${match.state} before it went live`)
        return match.state === 'live' ? match : null
      })
      ctx.check('liveAt is set once it is live', live.liveAt !== null)

      const announced = await ctx.api.matches.command({
        params,
        body: { type: 'announce', correlationId: 'conformance-announce', text: 'glhf' },
      })
      ctx.check(
        'an announce is applied on a live match',
        announced.status === 'applied' || announced.status === 'accepted',
        `${announced.status} ${announced.code ?? ''}`,
      )
      const replayed = await ctx.api.matches.command({
        params,
        body: { type: 'announce', correlationId: 'conformance-announce', text: 'a different line' },
      })
      ctx.check('a repeated correlationId replays the first answer', deepEqual(replayed, announced))
      const paused = await ctx.api.matches.command({
        params,
        body: { type: 'pause', correlationId: 'conformance-pause', kind: 'technical' },
      })
      ctx.check('a pause is accepted', paused.status !== 'rejected', paused.code ?? '')
      const unpaused = await ctx.api.matches.command({
        params,
        body: { type: 'unpause', correlationId: 'conformance-unpause' },
      })
      ctx.check('an unpause is accepted', unpaused.status !== 'rejected', unpaused.code ?? '')

      const { final, envelopes } = await playToEnd(ctx, created.id)
      ctx.require('the match ends', final.state === 'ended', `${final.state}`)
      ctx.check(
        'a match that played out ended completed',
        final.endedReason?.kind === 'completed',
        JSON.stringify(final.endedReason),
      )
      ctx.check('endedAt is set', final.endedAt !== null)

      checkEnvelopeStream(ctx, created.id, body.clientMatchId, envelopes, final.seq)
      const order = types(envelopes)
      ctx.check('the first fact is the allocation', order[0] === 'match.allocated', order[0])
      ctx.check(
        'the allocation happened once, not once per create',
        order.filter(t => t === 'match.allocated').length === 1,
      )
      for (const type of [
        'match.server_ready',
        'server_ready',
        'going_live',
        'round_start',
        'round_end',
        'side_swap',
        'map_end',
        'series_end',
      ]) {
        ctx.check(`the stream carries ${type}`, order.includes(type))
      }
      ctx.check(
        'the last fact is the end of the match',
        order.at(-1) === 'match.ended',
        order.at(-1),
      )
      const ended = payload(envelopes, 'match.ended')
      ctx.check('match.ended states the terminal state', ended?.state === 'ended', ended?.state)
      ctx.check(
        'going_live precedes the first round',
        order.indexOf('going_live') < order.indexOf('round_start'),
      )
      ctx.check(
        'the commands landed as events',
        order.includes('match_paused') && order.includes('match_unpaused'),
      )
      const serverReady = payload(envelopes, 'match.server_ready')
      ctx.check(
        'the ready fact carries the same connect facts as the resource',
        serverReady?.connect.host === ready.connect?.host &&
          serverReady?.connect.port === ready.connect?.port,
      )

      if (ctx.target.callbacks.demoUploadUrl !== undefined) {
        const uploaded = payload(envelopes, 'demo.uploaded')
        ctx.check('a demo was uploaded to the presigned url', uploaded !== undefined)
        ctx.check('the demo fact carries its size', (uploaded?.size ?? 0) > 0)
        ctx.check('the demo fact carries a sha256', SHA256.test(uploaded?.sha256 ?? ''))
        ctx.check(
          'the demo was announced by the server before it was uploaded',
          order.indexOf('demo_available') < order.indexOf('demo.uploaded'),
        )
      }
    },
  },

  {
    id: 'config-only',
    title: 'flying-scoutsman: a config-only gamemode plays and records no demo',
    needs: [],
    async run(ctx) {
      const manifest = await ctx.api.gamemodes.get({
        params: { gamemodeId: 'flying-scoutsman' },
      })
      ctx.check('a config-only mode declares the config tier', manifest.tier === 'config')
      ctx.check('a config-only mode enables no plugin', manifest.plugins.length === 0)
      ctx.check('a config-only mode is never ranked here', manifest.ranked === false)

      const body = ctx.request({ gamemode: 'flying-scoutsman' })
      const created = await ctx.api.matches.create({ body })
      const { final, envelopes } = await playToEnd(ctx, created.id)
      ctx.require('the match ends', final.state === 'ended', final.state)
      ctx.check('the gamemode is echoed on the resource', final.gamemode === 'flying-scoutsman')
      checkEnvelopeStream(ctx, created.id, body.clientMatchId, envelopes, final.seq)

      const order = types(envelopes)
      ctx.check('rounds were played', order.includes('round_end'))
      ctx.check(
        'a mode that records events only uploads no demo',
        manifest.records !== 'demo' ? !order.includes('demo.uploaded') : true,
        order.filter(t => t.startsWith('demo')).join(','),
      )
    },
  },

  {
    id: 'open-join',
    title: 'retakes: an open-join gamemode fills itself and reports who joined',
    needs: [],
    async run(ctx) {
      const manifest = await ctx.api.gamemodes.get({ params: { gamemodeId: 'retakes' } })
      ctx.check('retakes is an open-join mode', manifest.slots.openJoin === true)
      ctx.require(
        'an open-join mode names the maps it can run',
        manifest.maps === 'any' || manifest.maps.catalog.length > 0,
      )
      const map = manifest.maps === 'any' ? 'de_dust2' : (manifest.maps.catalog[0] as string)

      const body = ctx.request({
        gamemode: 'retakes',
        teams: EMPTY_TEAMS,
        maps: [{ map, sides: 'ct' }],
      })
      const created = await ctx.api.matches.create({ body })
      ctx.check('an empty roster is accepted for an open-join mode', UUID.test(created.id))

      const { final, envelopes } = await playToEnd(ctx, created.id)
      ctx.require('the match ends', final.state === 'ended', final.state)
      checkEnvelopeStream(ctx, created.id, body.clientMatchId, envelopes, final.seq)

      const joins = envelopes.filter(e => e.payload.type === 'player.joined')
      ctx.check('people joining are reported as facts', joins.length > 0, `${joins.length} joins`)
      ctx.check(
        'a player nobody rostered is marked as such',
        joins.some(e => e.payload.type === 'player.joined' && e.payload.rostered === false),
      )
      ctx.check(
        'a join names a SteamID64 and a display name',
        joins.every(
          e =>
            e.payload.type === 'player.joined' &&
            /^\d{17}$/.test(e.payload.player.steamId64) &&
            e.payload.player.name.length > 0,
        ),
      )
    },
  },

  {
    id: 'player-command',
    title: 'powerup-dm: a player token, a widget’s tap, a plugin_event back',
    needs: ['playerCommand'],
    async run(ctx) {
      const manifest = await ctx.api.gamemodes.get({ params: { gamemodeId: 'powerup-dm' } })
      ctx.require('an sdk mode declares the sdk tier', manifest.tier === 'sdk', manifest.tier)
      ctx.check('it declares the player-command capability', manifest.capabilities.playerCommands)
      ctx.require('it declares at least one verb', manifest.commands.length > 0)
      const verb = manifest.commands[0]?.name as string
      ctx.check('it declares a widget', manifest.widget !== undefined)

      const body = ctx.request({ gamemode: 'powerup-dm', teams: EMPTY_TEAMS })
      const created = await ctx.api.matches.create({ body })
      const params = { matchId: created.id }
      await ctx.waitFor('the match to go live', async () => {
        const match = await ctx.raw.matches.get({ params })
        if (match.state === 'failed' || match.state === 'cancelled')
          throw new Error(`the match ${match.state} before it went live`)
        return match.state === 'live' ? match : null
      })

      const someone = '76561198000009999'
      const minted = await ctx.api.matches.mintPlayerToken({
        params,
        body: { steamId64: someone },
      })
      ctx.check('a player token is minted with an expiry', typeof minted.expiresAt === 'string')
      ctx.check('the token is scoped to the match', minted.matchId === created.id)
      ctx.check('the token is scoped to the person', minted.steamId64 === someone)
      ctx.check('the token is long enough to be a secret', minted.token.length >= 16)

      const answer = await (
        ctx.target.playerCommand as NonNullable<typeof ctx.target.playerCommand>
      )({ token: minted.token, command: verb, args: { kind: 'haste' } })
      ctx.check(
        'a player command answers as a plugin_event',
        answer.payload.type === 'plugin_event',
        answer.payload.type,
      )
      ctx.check('the answer belongs to the match', answer.matchId === created.id)

      const unknown = await refusal(
        ctx,
        'a verb the manifest does not declare is refused',
        (ctx.target.playerCommand as NonNullable<typeof ctx.target.playerCommand>)({
          token: minted.token,
          command: 'not-a-verb',
        }),
      )
      ctx.check(
        'an undeclared verb is command_unsupported',
        unknown.code === 'command_unsupported',
        unknown.code,
      )

      const { final, envelopes } = await playToEnd(ctx, created.id)
      ctx.require('the match ends', final.state === 'ended', final.state)
      checkEnvelopeStream(ctx, created.id, body.clientMatchId, envelopes, final.seq)
      ctx.check(
        'the plugin_event the tap produced is in the replay',
        envelopes.some(e => e.deliveryId === answer.deliveryId),
      )
    },
  },

  {
    id: 'cancel-allocating',
    title: 'a cancel before the server is live releases it and ends the match cancelled',
    needs: [],
    async run(ctx) {
      const body = ctx.request()
      const created = await ctx.api.matches.create({ body })
      const params = { matchId: created.id }
      const cancelled = await ctx.api.matches.cancel({ params })
      ctx.require('a cancel answers the match', cancelled.id === created.id)
      ctx.check('the match is cancelled', cancelled.state === 'cancelled', cancelled.state)
      ctx.check(
        'the reason says who ended it',
        cancelled.endedReason?.kind === 'cancelled',
        JSON.stringify(cancelled.endedReason),
      )
      ctx.check('endedAt is set', cancelled.endedAt !== null)

      await ctx.settle()
      const envelopes = await ctx.replay(created.id)
      const order = types(envelopes)
      ctx.check('the match never went live', !order.includes('going_live'), order.join(','))
      ctx.check(
        'the last fact is the end of the match',
        order.at(-1) === 'match.ended',
        order.at(-1),
      )
      const ended = payload(envelopes, 'match.ended')
      ctx.check('the end fact states cancelled', ended?.state === 'cancelled', ended?.state)

      const twice = await refusal(
        ctx,
        'a second cancel is refused',
        ctx.api.matches.cancel({ params }),
      )
      ctx.check(
        'cancelling a cancelled match is invalid_state',
        twice.code === 'invalid_state',
        twice.code,
      )
    },
  },

  {
    id: 'crash-restore',
    title: 'a server lost mid-match is recovered from its backup and the match finishes',
    needs: ['faults'],
    async run(ctx) {
      await (ctx.target.faults as NonNullable<typeof ctx.target.faults>)({
        crash: { afterRound: 2, backup: true },
      })
      const body = ctx.request({ rules: HAPPY_RULES })
      const created = await ctx.api.matches.create({ body })
      const { final, envelopes } = await playToEnd(ctx, created.id)

      ctx.require('a recovered match still ends', final.state === 'ended', final.state)
      ctx.check(
        'it ends completed, not on the failure branch',
        final.endedReason?.kind === 'completed',
        JSON.stringify(final.endedReason),
      )
      checkEnvelopeStream(ctx, created.id, body.clientMatchId, envelopes, final.seq)

      const order = types(envelopes)
      const recovering = payload(envelopes, 'match.recovering')
      const recovered = payload(envelopes, 'match.recovered')
      ctx.require('the client is told the match is recovering', recovering !== undefined)
      ctx.require('the client is told it recovered', recovered !== undefined)
      ctx.check('the recovering fact says why', (recovering?.reason.length ?? 0) > 0)
      ctx.check(
        'the recovering fact names the round it can resume from',
        recovering?.backupRound !== null && recovering?.backupRound !== undefined,
      )
      ctx.check(
        'it resumed from the round it said it would',
        recovered?.resumedFromRound === recovering?.backupRound,
        `${recovering?.backupRound} then ${recovered?.resumedFromRound}`,
      )
      ctx.check(
        'the replacement is a second allocation',
        order.filter(t => t === 'match.allocated').length === 2,
      )
      ctx.check(
        'recovering comes before the replacement is allocated',
        order.indexOf('match.recovering') < order.lastIndexOf('match.allocated'),
      )
      ctx.check(
        'the recovered fact comes after the replacement is ready',
        order.lastIndexOf('match.server_ready') < order.indexOf('match.recovered'),
      )
      ctx.check('the match still ended last', order.at(-1) === 'match.ended', order.at(-1))
      ctx.check(
        'the rounds after the crash were played by the replacement',
        recovered?.serverId !== undefined && recovered.serverId !== null,
      )
    },
  },

  {
    id: 'crash-lost',
    title: 'a server lost with its backups fails the match server_lost',
    needs: ['faults'],
    async run(ctx) {
      await (ctx.target.faults as NonNullable<typeof ctx.target.faults>)({
        crash: { afterRound: 1, backup: false },
      })
      const body = ctx.request()
      const created = await ctx.api.matches.create({ body })
      const { final, envelopes } = await playToEnd(ctx, created.id)

      ctx.require('the match fails', final.state === 'failed', final.state)
      ctx.check(
        'the reason is the lost server',
        final.endedReason?.kind === 'server_lost',
        JSON.stringify(final.endedReason),
      )
      checkEnvelopeStream(ctx, created.id, body.clientMatchId, envelopes, final.seq)

      const order = types(envelopes)
      ctx.check(
        'the client hears recovering before failed',
        order.slice(-2).join(',') === 'match.recovering,match.failed',
        order.slice(-3).join(','),
      )
      const failed = payload(envelopes, 'match.failed')
      ctx.check('the failure fact states the terminal state', failed?.state === 'failed')
      ctx.check('the failure fact carries the reason', failed?.reason.kind === 'server_lost')
    },
  },

  {
    id: 'csgo-refused',
    title: 'a game nothing can serve is refused at the door, and nothing is allocated',
    needs: [],
    async run(ctx) {
      const body = ctx.request({ game: 'csgo' })
      const error = await refusal(
        ctx,
        'a csgo request is refused',
        ctx.api.matches.create({ body }),
      )
      ctx.check(
        'the refusal says nothing can serve it',
        error.code === 'no_capable_server' || error.code === 'game_unsupported',
        error.code,
      )
      ctx.check(
        'the refusal is a 4xx or a 503, never a 500',
        error.status !== 500,
        String(error.status),
      )
      const listed = await ctx.api.matches.list({ query: { clientMatchId: body.clientMatchId } })
      ctx.check(
        'a refused request left no match behind',
        listed.items.length === 0,
        `${listed.items.length} matches`,
      )
    },
  },

  {
    id: 'budget-refused',
    title: 'a request beyond the key’s budget is refused with money, not capacity',
    needs: ['budget'],
    async run(ctx) {
      const budget = ctx.target.budget as NonNullable<typeof ctx.target.budget>
      const client = ctx.recorded(budget.client)
      const body = ctx.request({ ttlMinutes: budget.maxServerLifetimeMinutes + 1 })
      const error = await refusal(
        ctx,
        'a request past the key’s ceiling is refused',
        client.matches.create({ body }),
      )
      ctx.check('the refusal is budget_exceeded', error.code === 'budget_exceeded', error.code)
      ctx.check(
        'money answers 402, so a client never retries it',
        error.status === 402,
        String(error.status),
      )
      const listed = await client.matches.list({ query: { clientMatchId: body.clientMatchId } })
      ctx.check('nothing was allocated', listed.items.length === 0)
    },
  },

  {
    id: 'webhook-replay',
    title: 'the events route replays the same envelopes from any cursor',
    needs: [],
    async run(ctx) {
      const body = ctx.request()
      const created = await ctx.api.matches.create({ body })
      const { final, envelopes } = await playToEnd(ctx, created.id)
      ctx.require('the match ends', final.state === 'ended', final.state)
      checkEnvelopeStream(ctx, created.id, body.clientMatchId, envelopes, final.seq)

      const params = { matchId: created.id }
      const liveSeq = envelopes.find(e => e.payload.type === 'going_live')?.seq ?? 1
      const page = await ctx.api.matches.events({
        params,
        query: { cursor: String(liveSeq), limit: 25 },
      })
      ctx.check(
        'a cursor resumes after the seq it names',
        page.items[0]?.seq === liveSeq + 1,
        String(page.items[0]?.seq),
      )
      ctx.check(
        'a page holds at most the limit',
        page.items.length <= 25,
        String(page.items.length),
      )
      ctx.check(
        'the next cursor is the last seq on the page',
        page.nextCursor === null || page.nextCursor === String(page.items.at(-1)?.seq),
        page.nextCursor ?? 'null',
      )

      // Walked on the unrecorded client: the golden already holds one page,
      // and a second copy of the whole match teaches nothing.
      const walked: WebhookEnvelope[] = []
      let cursor = String(liveSeq)
      for (let guard = 0; guard < 100; guard += 1) {
        const next = await ctx.raw.matches.events({ params, query: { cursor, limit: 25 } })
        walked.push(...next.items)
        if (next.nextCursor === null || next.items.length === 0) break
        cursor = next.nextCursor
      }
      const tail = envelopes.filter(e => e.seq > liveSeq)
      ctx.check(
        'walking the cursor to the end yields exactly the tail',
        deepEqual(walked, tail),
        `${walked.length} walked, ${tail.length} expected`,
      )

      const last = await ctx.api.matches.events({
        params,
        query: { cursor: String(final.seq), limit: 25 },
      })
      ctx.check('a cursor at the end yields nothing', last.items.length === 0)
      ctx.check(
        'a terminal match says there is no more to come',
        last.nextCursor === null,
        last.nextCursor ?? 'null',
      )

      const unknown = await refusal(
        ctx,
        'the events of a match that does not exist are refused',
        ctx.api.matches.events({
          params: { matchId: '00000000-0000-4000-8000-000000000000' },
          query: { cursor: '0' },
        }),
      )
      ctx.check('an unknown match is not_found', unknown.code === 'not_found', unknown.code)
    },
  },

  {
    id: 'stream-hello',
    title: 'the stream’s hello agrees with the events route about where the match is',
    needs: ['stream'],
    async run(ctx) {
      const subscribe = ctx.target.stream as NonNullable<typeof ctx.target.stream>
      const body = ctx.request()
      const created = await ctx.api.matches.create({ body })
      const params = { matchId: created.id }
      const live = await ctx.waitFor('the match to go live', async () => {
        const match = await ctx.raw.matches.get({ params })
        if (match.state === 'failed' || match.state === 'cancelled')
          throw new Error(`the match ${match.state} before it went live`)
        return match.state === 'live' ? match : null
      })

      const unsubscribe = subscribe({ matchId: created.id }, frame => ctx.frames.push(frame))
      try {
        // Over a socket the greeting takes a round trip; in process it is already here.
        const hello = await ctx.waitFor(
          'the stream to say hello',
          async () => ctx.frames[0] ?? null,
        )
        ctx.require('the first frame is a hello', hello.type === 'hello', hello.type)
        if (hello.type !== 'hello') return
        ctx.check('the hello names the match', hello.matchId === created.id)
        ctx.check(
          'the hello agrees with the resource about the state',
          hello.state === 'live' || hello.state === live.state,
          hello.state,
        )
        ctx.check(
          'the hello’s seq is a sequence the events route knows',
          hello.seq >= live.seq,
          `${hello.seq} vs ${live.seq}`,
        )

        const before = await ctx.api.matches.events({
          params,
          query: { cursor: String(hello.seq), limit: 25 },
        })
        ctx.check(
          'replaying from the hello’s seq starts after it',
          before.items.every(e => e.seq > hello.seq),
        )

        const { final, envelopes } = await playToEnd(ctx, created.id)
        ctx.require('the match ends', final.state === 'ended', final.state)
        const framed = ctx.frames.filter(f => f.type === 'event')
        ctx.check('the stream mirrored the durable events', framed.length > 0)
        ctx.check(
          'every event frame carries an envelope the events route also has',
          framed.every(
            frame =>
              frame.type === 'event' &&
              envelopes.some(
                stored =>
                  stored.deliveryId === frame.envelope.deliveryId &&
                  deepEqual(stored, frame.envelope),
              ),
          ),
        )
        ctx.check(
          'a subscriber that joined at the hello missed nothing after it',
          framed.every(frame => frame.type === 'event' && frame.envelope.seq > hello.seq),
        )
        const ticks = ctx.frames.filter(f => f.type === 'tick')
        ctx.check(
          'position ticks travel on the stream and nowhere else',
          ticks.length === 0 || !types(envelopes).includes('position_tick'),
        )
      } finally {
        unsubscribe()
      }
    },
  },
]

/** Every flow id, in the order the suite runs them. */
export const MATCH_API_CONFORMANCE_FLOW_IDS = MATCH_API_CONFORMANCE_FLOWS.map(
  flow => flow.id,
) as readonly string[]
