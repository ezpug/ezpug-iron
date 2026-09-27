import { ApiError } from '../../errors'
import type { MatchEndedReason, MatchRules, WebhookEnvelope } from '../../index'
import { isTerminalMatchState } from '../../resources'
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
  format: 'competitive',
  regulationRounds: 2,
  overtime: { enabled: false, maxRounds: 2, startMoney: 10_000 },
  warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0, autoReady: true },
  cvars: {},
}

/** The happy flow plays a little longer, so a side swap has rounds on both sides of it. */
export const HAPPY_RULES: MatchRules = { ...SHORT_RULES, regulationRounds: 4 }

/**
 * **The margin `reprovision-before-live` and `prefer-lan` need.** The two
 * flows that ask a target to play slower than it wants to, both because they
 * act on a match *before* it is live — one moves it, one gives it back — and
 * both were racing the story on a loaded box. A simulated story goes from
 * the box being ready to the first round in twelve to forty-five *match*
 * seconds, so at the twenty times real time an extended target plays at, the
 * window in which a match can still be moved is barely a second wide — narrow
 * enough that one starved poll cycle falls through it and the flow waits out
 * its budget on a match that is already playing (PRD-02 T39b), or narrow
 * enough that a cancel arrives one poll too late (T40). Two is that window in
 * tens of seconds; {@link PLAY_OUT_TIME_SCALE} is what a match is put back to
 * once there is nothing left to catch.
 */
const PRE_LIVE_TIME_SCALE = 2
/** Fast enough that the rest of the flow costs what it always did. */
const PLAY_OUT_TIME_SCALE = 20

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
 * A match that reached a terminal state where a flow wanted it running, said
 * with the *reason* and not only the state (PRD-02 T21c). The state alone
 * ("the match failed before it was ready") names the symptom and leaves the
 * cause in a row an `afterAll` is about to sweep; `endedReason` is the field
 * the contract already carries for exactly this, so a red run in someone
 * else's CI is readable from its log alone.
 */
function terminal(match: { state: string; endedReason: MatchEndedReason | null }): string {
  const reason = match.endedReason
  if (reason === null) return `${match.state} (no endedReason given)`
  return reason.detail === undefined
    ? `${match.state}: ${reason.kind}`
    : `${match.state}: ${reason.kind} — ${reason.detail}`
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
          throw new Error(`the match ended before it was ready — ${terminal(match)}`)
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
          throw new Error(`the match ended before it went live — ${terminal(match)}`)
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
      // A live match rewinds on its own server (PRD-04 T8). On a simulated
      // one the point is resolved first (`no_backup` before the first backup)
      // and then a scripted story cannot go back — never the refusal a
      // recovery-only `restore` used to give.
      const rewound = await ctx.api.matches.command({
        params,
        body: { type: 'restore', correlationId: 'conformance-restore' },
      })
      ctx.check(
        'a restore of a live simulated match is no_backup or command_unsupported',
        rewound.status === 'rejected' &&
          (rewound.code === 'no_backup' || rewound.code === 'command_unsupported'),
        `${rewound.status} ${rewound.code ?? ''}`,
      )

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
      const wentLive = payload(envelopes, 'going_live')
      ctx.check(
        'going_live says the engine plays the five-a-side game',
        wentLive?.format === 'competitive' && wentLive.engine?.gameMode === 1,
        `going_live.format ${wentLive?.format}, engine ${JSON.stringify(wentLive?.engine)}`,
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
        ctx.check(
          'the ended fact counts the demos that landed',
          ended?.demo?.uploaded === order.filter(t => t === 'demo.uploaded').length &&
            ended?.demo?.skipped === undefined,
          JSON.stringify(ended?.demo),
        )
      } else {
        ctx.check(
          'with nowhere to put a demo the ended fact says so',
          ended?.demo?.uploaded === 0 && ended?.demo?.skipped === 'no_upload_url',
          JSON.stringify(ended?.demo),
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
        'a mode that records events only announces no demo and uploads none',
        manifest.records !== 'demo'
          ? !order.includes('demo.uploaded') && !order.includes('demo_available')
          : true,
        order.filter(t => t.startsWith('demo')).join(','),
      )
      const ended = payload(envelopes, 'match.ended')
      ctx.check(
        'and its ended fact says why there is none',
        manifest.records !== 'demo'
          ? ended?.demo?.uploaded === 0 && ended?.demo?.skipped === 'not_recorded'
          : true,
        JSON.stringify(ended?.demo),
      )
    },
  },

  {
    id: 'workshop-map',
    title: 'a workshop map goes live on a node, named the way the plan named it',
    needs: [],
    async run(ctx) {
      // PRD-05 T1 (ezpug/ezpug-iron#3): the server hosts a workshop plan by its
      // id and the engine then calls the map by a name of its own, which the
      // client never sent. Every fact that names the map names it with the
      // plan's `workshop/<id>/<name>`, so the client can match it to its plan.
      // `preferLan` ranks a node first where one is enrolled, as the platform's
      // workshop row does, and lands anywhere else when none is.
      const map = 'workshop/3084291314/aim_map'
      const body = ctx.request({
        maps: [{ map, sides: 'ct' }],
        requirements: { preferLan: true },
      })
      const created = await ctx.api.matches.create({ body })
      const { final, envelopes } = await playToEnd(ctx, created.id)
      ctx.require('the match ends', final.state === 'ended', terminal(final))
      checkEnvelopeStream(ctx, created.id, body.clientMatchId, envelopes, final.seq)

      const live = payload(envelopes, 'going_live')
      ctx.require('the workshop map goes live', live !== undefined, types(envelopes).join(','))
      ctx.check(
        'going_live names the map as the plan named it',
        live?.map === map,
        `going_live.map ${live?.map}`,
      )
      const ended = payload(envelopes, 'map_end')
      ctx.check(
        'map_end names it the same way when it names it at all',
        ended?.map === undefined || ended.map === map,
        `map_end.map ${ended?.map}`,
      )
    },
  },

  {
    id: 'live-utility',
    title: 'the live tier carries smokes and the bomb beside the positions',
    needs: ['stream'],
    async run(ctx) {
      // 0.26.0 (ezpug/ezpug-iron#5): a position tick carries `grenades`, every
      // one flying or active at that instant, and `bomb`. A source that samples
      // utility sends `grenades` on every tick, so a client can tell "nothing
      // in the air" from "not sampled". The simulator throws a smoke or two a
      // side each round, so a played match shows at least one bloom.
      const subscribe = ctx.target.stream as NonNullable<typeof ctx.target.stream>
      const body = ctx.request()
      const created = await ctx.api.matches.create({ body })
      const unsubscribe = subscribe({ matchId: created.id }, frame => ctx.frames.push(frame))
      try {
        const { final, envelopes } = await playToEnd(ctx, created.id)
        ctx.require('the match ends', final.state === 'ended', terminal(final))
        const ticks = ctx.frames.flatMap(frame => (frame.type === 'tick' ? frame.ticks : []))
        ctx.require(
          'the stream carried position ticks',
          ticks.length > 0,
          `${ctx.frames.length} frames`,
        )
        ctx.check(
          'every tick says it sampled utility',
          ticks.every(tick => Array.isArray(tick.grenades)),
        )
        const grenades = ticks.flatMap(tick => tick.grenades ?? [])
        const smokes = grenades.filter(g => g.kind === 'smoke' && g.state === 'active')
        ctx.check('a smoke stood somewhere', smokes.length > 0, `${grenades.length} grenades`)
        ctx.check(
          'an active smoke says how far it reaches',
          smokes.every(g => (g.radius ?? 0) > 0),
        )
        const bombs = ticks.flatMap(tick => (tick.bomb ? [tick.bomb] : []))
        ctx.check(
          'the bomb is on the tick, and a carried one names its carrier',
          bombs.length > 0 && bombs.every(b => b.state !== 'carried' || b.steamId64 !== undefined),
          `${bombs.length} bomb sightings`,
        )
        ctx.check(
          'none of it is durable',
          !types(envelopes).includes('position_tick'),
          'a position_tick was stored',
        )
      } finally {
        unsubscribe()
      }
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

      // **A mode with a length is as long as it says it is** (PRD-03 T9a):
      // ten minutes of deathmatch, so the flow asks the engine to play them
      // quickly rather than for the story to be shorter than the manifest.
      const body = ctx.request({
        gamemode: 'powerup-dm',
        teams: EMPTY_TEAMS,
        sim: { timeScale: PLAY_OUT_TIME_SCALE },
      })
      const created = await ctx.api.matches.create({ body })
      const params = { matchId: created.id }
      await ctx.waitFor('the match to go live', async () => {
        const match = await ctx.raw.matches.get({ params })
        if (match.state === 'failed' || match.state === 'cancelled')
          throw new Error(`the match ended before it went live — ${terminal(match)}`)
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
      )({ token: minted.token, command: verb, args: { kind: 'speed' } })
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

      // **The length, on the wire** (PRD-03 T9a, the platform's PRD-10 T6): a
      // free-for-all has nothing to win, so what ends it is the manifest's
      // `length` and what a client draws is the countdown `going_live`
      // carries — in the client's own seconds, this match's time scale
      // already divided out.
      const live = payload(envelopes, 'going_live')
      ctx.check(
        'going_live carries the length in force',
        live?.length?.durationSeconds ===
          Math.ceil((manifest.length?.durationSeconds ?? 0) / PLAY_OUT_TIME_SCALE),
        JSON.stringify(live?.length),
      )
      const mapEnd = payload(envelopes, 'map_end')
      const seriesEnd = payload(envelopes, 'series_end')
      ctx.check(
        'the map ended on the mode’s length',
        mapEnd?.reason === 'time_limit',
        mapEnd?.reason,
      )
      ctx.check('and the series with it', seriesEnd?.reason === 'time_limit', seriesEnd?.reason)
      ctx.check(
        'a one-team mode names no winner',
        manifest.slots.teams === 1 ? mapEnd?.winner === null && seriesEnd?.winner === null : true,
        `${mapEnd?.winner} / ${seriesEnd?.winner}`,
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
    id: 'sim-scenarios',
    title: 'the simulator’s scenario catalog is served, and a name from it is one the door takes',
    needs: [],
    async run(ctx) {
      const catalog = await ctx.api.sim.scenarios()
      ctx.require(
        'the catalog names at least one scenario',
        catalog.scenarios.length > 0,
        String(catalog.scenarios.length),
      )
      ctx.check(
        'the default is one of them',
        catalog.scenarios.some(scenario => scenario.name === catalog.default),
        catalog.default,
      )
      ctx.check(
        'the happy path is in it',
        catalog.scenarios.some(scenario => scenario.name === 'happy-path'),
        catalog.scenarios.map(s => s.name).join(','),
      )
      ctx.check(
        'every knob is spelled out',
        catalog.scenarios.every(
          scenario =>
            typeof scenario.neverReady === 'boolean' &&
            typeof scenario.absentPlayers === 'number' &&
            (scenario.crashAfterRound === null || typeof scenario.crashAfterRound === 'number'),
        ),
      )
      const unknown = await refusal(
        ctx,
        'a scenario nobody defined is refused',
        ctx.api.matches.create({
          body: ctx.request({ sim: { scenario: 'a-scenario-nobody-wrote' } }),
        }),
      )
      ctx.check(
        'an unknown scenario is validation_failed at the door',
        unknown.code === 'validation_failed',
        unknown.code,
      )
    },
  },

  {
    id: 'prefer-lan',
    title: 'preferLan ranks the venue first and still lands somewhere when no node is enrolled',
    needs: [],
    async run(ctx) {
      // `lan: true` is "a node or nothing"; this is "a node first, anything
      // after" — the difference a LAN night before a node is enrolled needs.
      //
      // **And it plays slowly, for the same reason `reprovision-before-live`
      // does** (PRD-02 T40). This flow gives its box back with `cancel`, and a
      // cancel is refused the moment the match is live: at the twenty times
      // real time an extended target plays at, `ready → live` is a second or
      // two, so the poll that saw the connect facts and the cancel that
      // followed it were racing the story. Green against the fake and against
      // the real orchestrator most nights, red on a loaded box with
      // `cannot cancel a live match; use force_end` — the shape of every race
      // this round has found. {@link PRE_LIVE_TIME_SCALE} makes that window
      // tens of seconds; the flow ends at the cancel, so it costs nothing.
      const created = await ctx.api.matches.create({
        body: ctx.request({
          requirements: { preferLan: true },
          sim: { timeScale: PRE_LIVE_TIME_SCALE },
        }),
      })
      const ready = await ctx.waitFor('the server’s connect facts', async () => {
        const match = await ctx.raw.matches.get({ params: { matchId: created.id } })
        if (match.state === 'failed' || match.state === 'cancelled')
          throw new Error(`the match ended before it was ready — ${terminal(match)}`)
        return match.connect === null ? null : match
      })
      // The two halves of "ranks, never narrows": a server was found at all,
      // and it is a real allocation with a row behind it. Asking for `lan`
      // *and* `preferLan` is refused by the schema itself, which is a client's
      // own parse and not a call this suite can make.
      ctx.check('a preferred venue never refuses the match', ready.provider !== null, ready.state)
      ctx.check('the box it found holds a ledger row', ready.fleetServerId !== null)
      const cancelled = await ctx.api.matches.cancel({ params: { matchId: created.id } })
      ctx.check(
        'the box this flow rented is given back',
        cancelled.state === 'cancelled',
        cancelled.state,
      )
    },
  },

  {
    id: 'reprovision-before-live',
    title: 'reprovision moves a match to another box before it is live and keeps its id',
    needs: [],
    async run(ctx) {
      // **The only flow that has to catch a match in the act** — everything
      // else waits for a state a match keeps. `pending → live` is a window,
      // and on a target that plays a real story on real timers it is a window
      // measured in seconds: a poll cycle slower than it falls straight
      // through, and the flow then waits out its whole budget on a match that
      // is already playing. So the request asks for the story at
      // {@link PRE_LIVE_TIME_SCALE} instead of the target's own — the window
      // becomes tens of seconds and the margin is structural rather than
      // lucky — and the match is put back on the target's speed once the
      // replacement is standing, so the play-out costs what it always did.
      // A target that does not simulate ignores both, which is what it should
      // do with either.
      const created = await ctx.api.matches.create({
        body: ctx.request({ sim: { timeScale: PRE_LIVE_TIME_SCALE } }),
      })
      const params = { matchId: created.id }
      /**
       * A box of this match's own, while the match can still be moved. The
       * test is the *provider's* id and not the ledger row's: a row is
       * written before the walk asks anyone for a server, so a flow that
       * reprovisioned on `fleetServerId` would be cancelling an allocation
       * that had not happened yet — one `match.allocated` for the whole
       * match instead of the two this flow is about.
       */
      const preLiveServer = (what: string) => async () => {
        const match = await ctx.raw.matches.get({ params })
        if (match.state === 'failed' || match.state === 'cancelled')
          throw new Error(`the match ended ${what} — ${terminal(match)}`)
        // Said in one poll rather than found in the timeout: a match that is
        // already playing cannot be moved, and the reason is that the poll
        // missed the window, not that the box never came.
        if (match.state === 'live' || match.state === 'ended')
          throw new Error(`the match was ${match.state} ${what}: the poll missed the window`)
        return match.serverId === null ? null : match
      }
      const first = await ctx.waitFor('the first server', preLiveServer('before it was ready'))
      ctx.require('the first box holds a ledger row', first.fleetServerId !== null)

      const moved = await ctx.api.matches.command({
        params,
        body: { type: 'reprovision', correlationId: 'conformance-reprovision' },
      })
      ctx.require(
        'a reprovision before live is taken',
        moved.status !== 'rejected',
        `${moved.status} ${moved.code ?? ''}`,
      )
      const second = await ctx.waitFor('the replacement server', async () => {
        const match = await preLiveServer('while it moved')()
        return match !== null && match.fleetServerId !== first.fleetServerId ? match : null
      })
      // Back on the target's own clock for the match itself; a target with no
      // simulator refuses it, and the flow is none the worse.
      await ctx.api.matches
        .command({
          params,
          body: {
            type: 'sim.speed',
            timeScale: PLAY_OUT_TIME_SCALE,
            correlationId: 'conformance-reprovision-speed',
          },
        })
        .catch(() => undefined)
      ctx.check('the match kept its id', second.id === created.id)
      ctx.check('the client’s own id is untouched', second.clientMatchId === created.clientMatchId)
      ctx.check(
        'the box is another one',
        second.fleetServerId !== first.fleetServerId,
        `${first.fleetServerId} then ${second.fleetServerId}`,
      )

      const { final, envelopes } = await playToEnd(ctx, created.id)
      ctx.check('the match plays out on the box it moved to', final.state === 'ended', final.state)
      const order = types(envelopes)
      ctx.check(
        'the replay carries both allocations',
        order.filter(type => type === 'match.allocated').length === 2,
        order.filter(type => type === 'match.allocated').length.toString(),
      )
    },
  },

  {
    id: 'demo-per-map',
    title: 'a series keeps every map’s demo: one presigned url per map',
    needs: ['demoUploadPerMap'],
    async run(ctx) {
      const urls = ctx.target.demoUploadUrls?.(2) ?? []
      ctx.require('the target drew two upload urls', urls.length === 2)
      const body = ctx.request({
        maps: [
          { map: 'de_mirage', sides: 'ct' },
          { map: 'de_nuke', sides: 't' },
        ],
        callbacks: { ...ctx.target.callbacks, demoUploadUrl: undefined, demoUploadUrls: urls },
      })
      const created = await ctx.api.matches.create({ body })
      const { final, envelopes } = await playToEnd(ctx, created.id)
      ctx.require('the series ends', final.state === 'ended', terminal(final))
      const uploaded = envelopes
        .map(envelope => envelope.payload)
        .filter(payload => payload.type === 'demo.uploaded')
      ctx.check(
        'both maps handed over a demo',
        uploaded.length === 2,
        uploaded.map(u => (u.type === 'demo.uploaded' ? u.mapNumber : '')).join(','),
      )
      ctx.check(
        'each demo landed under its own map’s key',
        uploaded.every(
          payload =>
            payload.type === 'demo.uploaded' &&
            (payload.key === undefined ||
              new URL(
                urls.find(entry => entry.mapNumber === payload.mapNumber)?.url ?? '',
              ).pathname.endsWith(payload.key)),
        ),
        uploaded.map(u => (u.type === 'demo.uploaded' ? `${u.mapNumber}:${u.key}` : '')).join(','),
      )
      const ended = payload(envelopes, 'match.ended')
      ctx.check(
        'the ended fact counts both',
        ended?.demo?.uploaded === 2,
        JSON.stringify(ended?.demo),
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
    id: 'mode-owned-rules',
    title: 'a mode whose own script owns the rounds refuses a request that carries rules',
    needs: [],
    async run(ctx) {
      // PRD-06 T1a: Rush's map plays 15 rounds and no overtime; an even
      // `regulationRounds` would override it, so the door names the field.
      const manifest = await ctx.api.gamemodes.get({ params: { gamemodeId: 'rush' } })
      ctx.check('rush says its rules are its own', manifest.rules === 'mode', manifest.rules)
      const body = ctx.request({
        clientMatchId: 'conformance-mode-owned-rules',
        gamemode: 'rush',
        maps: [{ map: 'rush_001', sides: 'ct' }],
        teams: {
          teamA: { name: 'Team hunzR', players: conformanceRoster(TEAM_A_NAMES.slice(0, 3), 0) },
          teamB: { name: 'Team wickeD', players: conformanceRoster(TEAM_B_NAMES.slice(0, 3), 100) },
        },
        rules: SHORT_RULES,
      })
      const error = await refusal(
        ctx,
        'a rush request with rules is refused',
        ctx.api.matches.create({ body }),
      )
      ctx.check(
        'the refusal is validation_failed on rules',
        error.code === 'validation_failed' && error.details?.field === 'rules',
        `${error.code} ${JSON.stringify(error.details)}`,
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
    id: 'wingman-format',
    title: 'the two-a-side game is played where it can be, and refused where it cannot',
    needs: [],
    async run(ctx) {
      // A wingman pug is an ordinary match with one more field, so an
      // implementation that cannot play the format must say so at the door
      // rather than quietly playing the five-a-side game instead.
      const duo = {
        teamA: { name: 'Team hunzR', players: conformanceRoster(TEAM_A_NAMES.slice(0, 2), 0) },
        teamB: { name: 'Team wickeD', players: conformanceRoster(TEAM_B_NAMES.slice(0, 2), 100) },
      }
      const wingmanRules = { ...SHORT_RULES, format: 'wingman' as const }
      const body = ctx.request({ teams: duo, rules: wingmanRules })
      const created = await ctx.api.matches.create({ body })
      ctx.require('a wingman pug is accepted', UUID.test(created.id), created.id)

      // PRD-05 T2d (ezpug/ezpug-iron#4): the server says which game the
      // engine is playing when the map goes live, so a client proves the
      // format from a fact rather than a console probe.
      const { final, envelopes } = await playToEnd(ctx, created.id)
      ctx.require('the wingman match ends', final.state === 'ended', terminal(final))
      const live = payload(envelopes, 'going_live')
      ctx.require('the wingman match goes live', live !== undefined, types(envelopes).join(','))
      ctx.check(
        'going_live says the engine plays wingman: game_type 0, game_mode 2',
        live?.format === 'wingman' && live.engine?.gameType === 0 && live.engine.gameMode === 2,
        `going_live.format ${live?.format}, engine ${JSON.stringify(live?.engine)}`,
      )

      // `flying-scoutsman` runs no match plugin of its own (`flow: "none"`),
      // so there is nothing on that server to switch the engine game.
      const wrongFlow = await refusal(
        ctx,
        'a gamemode that runs its own flow refuses wingman',
        ctx.api.matches.create({
          body: ctx.request({
            clientMatchId: 'conformance-wingman-format-flow',
            gamemode: 'flying-scoutsman',
            teams: duo,
            rules: wingmanRules,
          }),
        }),
      )
      ctx.check(
        'the refusal is validation_failed on rules.format',
        wrongFlow.code === 'validation_failed' && wrongFlow.details?.field === 'rules.format',
        `${wrongFlow.code} ${JSON.stringify(wrongFlow.details)}`,
      )

      // Wingman seats two; a third player would arrive at a map with no
      // spawn for them, so the roster is what is refused, by name.
      const tooMany = await refusal(
        ctx,
        'a third player on a side refuses wingman',
        ctx.api.matches.create({
          body: ctx.request({
            clientMatchId: 'conformance-wingman-format-size',
            teams: {
              teamA: {
                name: 'Team hunzR',
                players: conformanceRoster(TEAM_A_NAMES.slice(0, 3), 0),
              },
              teamB: duo.teamB,
            },
            rules: wingmanRules,
          }),
        }),
      )
      ctx.check(
        'the refusal names the roster that is too long',
        tooMany.code === 'validation_failed' && tooMany.details?.field === 'teams.teamA.players',
        `${tooMany.code} ${JSON.stringify(tooMany.details)}`,
      )
    },
  },

  {
    id: 'simulation-switch',
    title: 'puppets play a match behind a scope, and every fact says nobody was real',
    needs: ['simulation'],
    async run(ctx) {
      // The door first: the suite's own key holds `matches` and not
      // `simulation`, so the same request it plays everywhere else is
      // refused by name the moment it carries the block — before anything
      // about the body is diagnosed, which is why the refusal is `forbidden`
      // and not a validation report.
      const withoutScope = await refusal(
        ctx,
        'a puppets request on a key without the scope is refused',
        ctx.api.matches.create({
          body: ctx.request({
            clientMatchId: 'conformance-simulation-switch-scope',
            simulation: {},
          }),
        }),
      )
      ctx.check(
        'the refusal is forbidden and names the scope',
        withoutScope.code === 'forbidden' && withoutScope.details?.scope === 'simulation',
        `${withoutScope.code} ${JSON.stringify(withoutScope.details)}`,
      )
      ctx.check(
        'the scope answers 403, like every scope',
        withoutScope.status === 403,
        String(withoutScope.status),
      )

      const target = ctx.target.simulation as NonNullable<typeof ctx.target.simulation>
      const puppeteer = ctx.recorded(target.client)

      // A mode that cannot seat a puppet says so at the door, by the field to
      // change, rather than waiting in warmup for players who are never
      // coming. Which mode that is comes from the catalog and not from a name
      // written here: the SDK seats puppets for its own modes since PRD-03 T7,
      // and the day every mode claims the capability there is nobody left to
      // refuse, which is a fact about the catalog and not a failure.
      const catalog = await puppeteer.gamemodes.list()
      const incapableMode = catalog.gamemodes.find(mode => !mode.capabilities.simulation)
      if (incapableMode === undefined) {
        ctx.check('every mode in the catalog seats puppets, so none can refuse them', true, '')
      } else {
        const incapable = await refusal(
          ctx,
          'a mode without the capability refuses puppets',
          puppeteer.matches.create({
            body: ctx.request({
              clientMatchId: 'conformance-simulation-switch-capability',
              gamemode: incapableMode.id,
              simulation: {},
            }),
          }),
        )
        ctx.check(
          'the refusal is validation_failed on simulation',
          incapable.code === 'validation_failed' && incapable.details?.field === 'simulation',
          `${incapable.code} ${JSON.stringify(incapable.details)}`,
        )
      }

      // One scenario language: the name comes from `GET /v1/sim/scenarios`,
      // and one nobody defined is refused on the field that named it.
      const unknown = await refusal(
        ctx,
        'a scenario nobody defined is refused',
        puppeteer.matches.create({
          body: ctx.request({
            clientMatchId: 'conformance-simulation-switch-scenario',
            simulation: { scenario: 'no-such-story' },
          }),
        }),
      )
      ctx.check(
        'the refusal names simulation.scenario',
        unknown.code === 'validation_failed' && unknown.details?.field === 'simulation.scenario',
        `${unknown.code} ${JSON.stringify(unknown.details)}`,
      )

      // **And a scenario no real server can execute** (PRD-03 T11). The
      // catalog is one language for the simulator and for a room of puppets,
      // and the knobs that only a story engine can honour — a forced
      // overtime, here — are refused on the field that named them rather than
      // quietly doing nothing on hardware. The same story through
      // `sim.scenario` is a simulator match and stays legal.
      const impossible = await refusal(
        ctx,
        'a scenario a real server cannot play is refused for puppets',
        puppeteer.matches.create({
          body: ctx.request({
            clientMatchId: 'conformance-simulation-switch-sim-only',
            simulation: { scenario: 'overtime' },
          }),
        }),
      )
      ctx.check(
        'that refusal names simulation.scenario too',
        impossible.code === 'validation_failed' &&
          impossible.details?.field === 'simulation.scenario',
        `${impossible.code} ${JSON.stringify(impossible.details)}`,
      )

      // **Who the puppets are** (PRD-04 T2): `simulation.puppets` names the
      // roster entries a bot plays, and the rest are people. A name the
      // roster does not hold is refused on the field, on every mode; a partial
      // list is refused on the same field by a mode whose match software
      // seats every seat or none (`capabilities.mixedRoster` unsaid — `pug`,
      // whose bodies are MatchZy-Enhanced's), and taken by one that seats
      // exactly who is named. Which mode is which comes from the catalog.
      const rostered = ctx.request().teams
      const [firstEntry, ...restOfTeamA] = rostered.teamA.players
      const stranger = await refusal(
        ctx,
        'a puppet for somebody the roster does not hold is refused',
        puppeteer.matches.create({
          body: ctx.request({
            clientMatchId: 'conformance-simulation-switch-stranger',
            simulation: { puppets: ['76561197960265728'] },
          }),
        }),
      )
      ctx.check(
        'the refusal names simulation.puppets',
        stranger.code === 'validation_failed' && stranger.details?.field === 'simulation.puppets',
        `${stranger.code} ${JSON.stringify(stranger.details)}`,
      )
      const allOrNoneMode = catalog.gamemodes.find(
        mode => mode.capabilities.simulation && !mode.capabilities.mixedRoster,
      )
      if (allOrNoneMode === undefined) {
        ctx.check('every puppet-seating mode in the catalog seats a mixed roster', true, '')
      } else {
        const allOrNone = await refusal(
          ctx,
          'a mode that seats every seat or none refuses a partial list',
          puppeteer.matches.create({
            body: ctx.request({
              clientMatchId: 'conformance-simulation-switch-all-or-none',
              gamemode: allOrNoneMode.id,
              simulation: {
                puppets: [...restOfTeamA, ...rostered.teamB.players].map(
                  player => player.steamId64,
                ),
              },
            }),
          }),
        )
        ctx.check(
          'that refusal names simulation.puppets too',
          allOrNone.code === 'validation_failed' &&
            allOrNone.details?.field === 'simulation.puppets',
          `${allOrNone.code} ${JSON.stringify(allOrNone.details)}`,
        )
      }
      // **A mixed roster under MatchZy waits for the person** (PRD-04 T2b):
      // `pug` claims `mixedRoster` since our fork of MatchZy-Enhanced leaves a
      // seat to a person, and its ready gate holds warmup open until that
      // person is on the server. Nobody is at the keyboard here, so the match
      // must reach `ready`, announce every puppet and never the person, and
      // never go live; the client then cancels it, as a platform would at
      // its join deadline.
      const gateMode = catalog.gamemodes.find(
        mode => mode.flow === 'matchzy' && mode.capabilities.mixedRoster,
      )
      if (gateMode === undefined || firstEntry === undefined) {
        ctx.check('no matchzy mode in the catalog seats a mixed roster', true, '')
      } else {
        const puppets = [...restOfTeamA, ...rostered.teamB.players].map(player => player.steamId64)
        const held = await puppeteer.matches.create({
          body: ctx.request({
            clientMatchId: 'conformance-simulation-switch-held',
            gamemode: gateMode.id,
            simulation: { puppets },
            sim: { timeScale: PLAY_OUT_TIME_SCALE },
          }),
        })
        ctx.require(`${gateMode.id} takes a mixed roster`, UUID.test(held.id), held.id)
        const heldParams = { matchId: held.id }
        // Read and called off in the poll that sees the last puppet arrive: a
        // fake clock runs on to the match's TTL between polls, and a held
        // warmup is only held for as long as somebody is waiting on it.
        // The log is read on from where the last poll left it, never again
        // from the top: one page a poll stays inside the key's rate limit.
        const items: WebhookEnvelope[] = []
        let heldCursor = '0'
        const seen = await ctx.waitFor('every puppet to arrive', async () => {
          for (let guard = 0; guard < 1_000; guard += 1) {
            const page = await target.client.matches.events({
              params: heldParams,
              query: { cursor: heldCursor, limit: 200 },
            })
            items.push(...page.items)
            const last = page.items.at(-1)
            if (last === undefined) break
            heldCursor = String(last.seq)
            if (page.nextCursor === null) break
          }
          const arrived = new Set(
            items.flatMap(envelope =>
              envelope.payload.type === 'player_connected'
                ? [envelope.payload.player.steamId64]
                : [],
            ),
          )
          if (!puppets.every(steamId64 => arrived.has(steamId64))) return null
          const waiting = await target.client.matches.get({ params: heldParams })
          const cancelled =
            waiting.state === 'ready'
              ? await puppeteer.matches.cancel({ params: heldParams })
              : null
          return { items, waiting, cancelled }
        })
        await ctx.settle()
        ctx.check(
          'with every puppet there and the person not, the match waits in ready',
          seen.waiting.state === 'ready',
          terminal(seen.waiting),
        )
        ctx.check(
          'the person was never announced',
          !seen.items.some(
            envelope =>
              envelope.payload.type === 'player_connected' &&
              envelope.payload.player.steamId64 === firstEntry.steamId64,
          ),
        )
        ctx.check(
          'nothing went live without them',
          !seen.items.some(envelope => envelope.payload.type === 'going_live'),
        )
        ctx.check(
          'the client can still call it off',
          seen.cancelled?.state === 'cancelled',
          seen.cancelled?.state ?? 'not asked',
        )
      }

      // The three SDK-seated modes claim `mixedRoster`; the flow plays the
      // config-only one because its roster is the suite's own two teams. One
      // seat is left to a person, and nobody is at the keyboard: the seat
      // stays empty, the puppets play the match out around it, and the
      // person's SteamID is never announced — a simulated server has no door
      // for a human and invents none.
      const mixedMode = catalog.gamemodes.find(
        mode => mode.capabilities.mixedRoster && mode.slots.teams === 2 && mode.id !== 'pug',
      )
      if (mixedMode === undefined || firstEntry === undefined) {
        ctx.check('no two-team mode in the catalog seats a mixed roster', true, '')
      } else {
        const puppets = [...restOfTeamA, ...rostered.teamB.players].map(player => player.steamId64)
        const mixedBody = ctx.request({
          clientMatchId: 'conformance-simulation-switch-mixed',
          gamemode: mixedMode.id,
          ...(mixedMode.maps !== 'any' && {
            maps: [{ map: mixedMode.maps.catalog[0] as string, sides: 'ct' as const }],
          }),
          simulation: { puppets },
          sim: { timeScale: PLAY_OUT_TIME_SCALE },
        })
        const mixed = await puppeteer.matches.create({ body: mixedBody })
        ctx.require('a mixed roster is accepted by a mode that seats one', UUID.test(mixed.id))
        ctx.check(
          'a match with one person in it is still a simulated match',
          mixed.simulated === true,
        )
        const mixedParams = { matchId: mixed.id }
        const mixedFinal = await ctx.waitFor('the mixed match to end', async () => {
          const match = await target.client.matches.get({ params: mixedParams })
          return isTerminalMatchState(match.state) ? match : null
        })
        await ctx.settle()
        const mixedEnvelopes: WebhookEnvelope[] = []
        let mixedCursor = '0'
        for (let guard = 0; guard < 1_000; guard += 1) {
          const page = await target.client.matches.events({
            params: mixedParams,
            query: { cursor: mixedCursor, limit: 200 },
          })
          mixedEnvelopes.push(...page.items)
          if (page.nextCursor === null) break
          mixedCursor = page.nextCursor
        }
        ctx.require('the mixed match ends', mixedFinal.state === 'ended', terminal(mixedFinal))
        const connected = mixedEnvelopes.filter(
          envelope => envelope.payload.type === 'player_connected',
        )
        const announced = new Set(
          connected.map(envelope =>
            envelope.payload.type === 'player_connected' ? envelope.payload.player.steamId64 : '',
          ),
        )
        ctx.check(
          'every puppet was announced',
          puppets.every(steamId64 => announced.has(steamId64)),
          [...announced].join(', '),
        )
        ctx.check(
          'the person was never announced: nobody sat down in that seat',
          !announced.has(firstEntry.steamId64),
          firstEntry.steamId64,
        )
        const mixedUnmarked = mixedEnvelopes.filter(
          envelope =>
            'source' in envelope.payload &&
            !('source' in envelope.payload && envelope.payload.source.simulated === true),
        )
        ctx.check(
          'every gameserver event of the mixed match carries source.simulated',
          mixedUnmarked.length === 0,
          mixedUnmarked.map(envelope => envelope.payload.type).join(', '),
        )
      }

      // Then the match: the same Bo1 every other flow plays, with puppets in
      // the ten seats, and the marker on the resource and on every event. A
      // match belongs to the key that made it, so the puppeteer's own client
      // — unrecorded, as every polling loop is — reads it back.
      const body = ctx.request({ simulation: { scenario: 'happy-path', timeScale: 4 } })
      const created = await puppeteer.matches.create({ body })
      ctx.require('a puppets pug is accepted', UUID.test(created.id), created.id)
      ctx.check('the match says it is simulated', created.simulated === true)
      const params = { matchId: created.id }
      const final = await ctx.waitFor('the puppets match to end', async () => {
        const match = await target.client.matches.get({ params })
        return isTerminalMatchState(match.state) ? match : null
      })
      await ctx.settle()
      const envelopes: WebhookEnvelope[] = []
      let cursor = '0'
      for (let guard = 0; guard < 1_000; guard += 1) {
        const page = await target.client.matches.events({ params, query: { cursor, limit: 200 } })
        envelopes.push(...page.items)
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
      ctx.require('the match ends', final.state === 'ended', terminal(final))
      ctx.check('the ended match still says so', final.simulated === true)
      const events = envelopes.filter(envelope => 'source' in envelope.payload)
      ctx.check('the server spoke', events.length > 0, String(events.length))
      const unmarked = events.filter(
        envelope => !('source' in envelope.payload && envelope.payload.source.simulated === true),
      )
      ctx.check(
        'every gameserver event carries source.simulated',
        unmarked.length === 0,
        unmarked.map(envelope => envelope.payload.type).join(', '),
      )
      ctx.check(
        'the completed match reads completed, like a real one',
        final.endedReason?.kind === 'completed',
        terminal(final),
      )
    },
  },

  {
    id: 'key-scopes',
    title: 'an operator moves a key’s scopes by route, and the door answers the new ones',
    needs: ['admin'],
    async run(ctx) {
      // PRD-04 T3. On 2026-09-21 the production platform key was granted
      // `simulation` by a hand-written `UPDATE`, because no route could do
      // it. This is that route, proven the only way it matters: the key the
      // suite itself calls with is widened, the door is asked again, and the
      // key is put back the way it was found.
      //
      // The key calls are deliberately **not** recorded: an `ApiKey` carries
      // its `prefix`, which is the first characters of a secret, and a golden
      // in a public repo is grepped for exactly those. What the golden holds
      // is the door's three answers, which is what a client builds on anyway.
      const admin = (ctx.target.admin as NonNullable<typeof ctx.target.admin>).client
      const keyId = (ctx.target.admin as NonNullable<typeof ctx.target.admin>).keyId
      const { keys } = await admin.keys.list()
      const before = keys.find(key => key.id === keyId)
      ctx.require('the suite’s own key is listed', before !== undefined, keyId)
      const held = (before as NonNullable<typeof before>).scopes
      ctx.require(
        'it does not hold simulation yet, so there is something to grant',
        !held.includes('simulation'),
        held.join(','),
      )

      // A request carrying the block is refused by the scope — before
      // anything about the body is diagnosed, which is what makes the next
      // answer proof that the grant landed.
      const puppets = { puppets: ['76561197960265728'] }
      const forbidden = await refusal(
        ctx,
        'the block is refused on a key without the scope',
        ctx.api.matches.create({
          body: ctx.request({
            clientMatchId: 'conformance-key-scopes-before',
            simulation: puppets,
          }),
        }),
      )
      ctx.check(
        'the refusal is forbidden and names the scope',
        forbidden.code === 'forbidden' && forbidden.details?.scope === 'simulation',
        `${forbidden.code} ${JSON.stringify(forbidden.details)}`,
      )

      const granted = await admin.keys.setScopes({
        params: { keyId },
        body: { add: ['simulation'] },
      })
      ctx.check(
        'the answer holds what it held and the new scope',
        held.every(scope => granted.scopes.includes(scope)) &&
          granted.scopes.includes('simulation'),
        granted.scopes.join(','),
      )
      ctx.check(
        'nothing else about the key moved',
        JSON.stringify(granted.budget) ===
          JSON.stringify((before as NonNullable<typeof before>).budget) &&
          JSON.stringify(granted.webhookSecretIds) ===
            JSON.stringify((before as NonNullable<typeof before>).webhookSecretIds),
        JSON.stringify({ budget: granted.budget, secrets: granted.webhookSecretIds }),
      )

      // The same request on the same secret, one call later: the scope gate
      // is open, so the body is judged at last — and the stranger on the
      // puppet list is what it is judged on. Nothing caches a key.
      const judged = await refusal(
        ctx,
        'the same request is now judged on its body',
        ctx.api.matches.create({
          body: ctx.request({ clientMatchId: 'conformance-key-scopes-after', simulation: puppets }),
        }),
      )
      ctx.check(
        'it is validation_failed on simulation.puppets, not forbidden',
        judged.code === 'validation_failed' && judged.details?.field === 'simulation.puppets',
        `${judged.code} ${JSON.stringify(judged.details)}`,
      )

      // Granting what a key already holds is the same key back.
      const again = await admin.keys.setScopes({
        params: { keyId },
        body: { add: ['simulation'] },
      })
      ctx.check(
        'a scope granted twice is granted once',
        JSON.stringify(again.scopes) === JSON.stringify(granted.scopes),
        again.scopes.join(','),
      )

      // The two refusals an operator meets on the wire. (A scope on both
      // lists is the third, and it never gets here: the body is the
      // contract's, so the published client refuses it before it is sent —
      // `scopesPatchRequestSchema`'s own test holds that half.)
      const emptied = await refusal(
        ctx,
        'emptying a key’s scopes is refused',
        admin.keys.setScopes({ params: { keyId }, body: { remove: again.scopes } }),
      )
      ctx.check(
        'that is validation_failed too — a key with no scopes is a revoke',
        emptied.code === 'validation_failed',
        emptied.code,
      )
      const stranger = await refusal(
        ctx,
        'a key nobody minted is not_found',
        admin.keys.setScopes({
          params: { keyId: '00000000-0000-4000-8000-000000000000' },
          body: { add: ['fleet'] },
        }),
      )
      ctx.check('the stranger is not_found', stranger.code === 'not_found', stranger.code)

      // Put it back, and the door closes again.
      const restored = await admin.keys.setScopes({
        params: { keyId },
        body: { remove: ['simulation'] },
      })
      ctx.check(
        'the key is as it was found',
        JSON.stringify(restored.scopes) === JSON.stringify(held),
        restored.scopes.join(','),
      )
      const closed = await refusal(
        ctx,
        'the block is refused again',
        ctx.api.matches.create({
          body: ctx.request({ clientMatchId: 'conformance-key-scopes-back', simulation: puppets }),
        }),
      )
      ctx.check(
        'and it is forbidden once more',
        closed.code === 'forbidden' && closed.details?.scope === 'simulation',
        `${closed.code} ${JSON.stringify(closed.details)}`,
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
          throw new Error(`the match ended before it went live — ${terminal(match)}`)
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
