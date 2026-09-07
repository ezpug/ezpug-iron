import type { FakeClock } from '@ezpug/core'
import { createFakeClock } from '@ezpug/core'
import { createChaosController } from '@ezpug/core/chaos'
import type { GameserverEvent } from '@ezpug/match-api'
import { gameserverEventSchema } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import type { MatchAssignment } from './assignment'
import { SIM_CHAT_EVENT } from './chat'
import { decodeSimulatedMatchRecord } from './record'
import type { SimPlan, SimulatedServerOptions } from './server'
import { createSimulatedServer, SIM_PROVIDER_ID } from './server'
import { BACKUP_RESTORED_EVENT } from './story'
import { FIXTURE_MATCH_ID, fixtureAssignment } from './testing'

function createHarness(
  options: Partial<Omit<SimulatedServerOptions, 'clock'>> & { clock?: FakeClock } = {},
  serverId = 'sim-1',
) {
  const clock = options.clock ?? createFakeClock()
  const delivered: GameserverEvent[] = []
  const bodies: string[] = []
  const server = createSimulatedServer({
    clock,
    serverId,
    seed: 'server-test',
    onError: error => {
      throw error
    },
    ...options,
  })
  server.events(event => {
    delivered.push(event)
    bodies.push(JSON.stringify(event))
  })
  return { clock, server, delivered, bodies }
}

function provision(
  server: ReturnType<typeof createHarness>['server'],
  plan: SimPlan = {},
  assignment: MatchAssignment = fixtureAssignment(),
): void {
  server.assign(assignment, plan)
  server.start()
}

describe('the recording a simulated server hands over', () => {
  it('is the bytes the demo_available event announced, once the event was dealt', async () => {
    const { clock, server, delivered } = createHarness()
    provision(server)
    expect(server.record()).toBeNull()
    await clock.runAll()

    const announced = delivered.find(event => event.type === 'demo_available')
    if (announced?.type !== 'demo_available') throw new Error('unreachable')
    const recording = server.record(announced.mapNumber)
    expect(recording).not.toBeNull()
    // Honest about its own size: the pipe stores exactly what the event said
    // was there, not a plausible 90 MB it does not have.
    expect(announced.sizeBytes).toBe(recording?.bytes.byteLength)
    expect(announced.filename).toBe(recording?.filename)
    const record = decodeSimulatedMatchRecord(recording?.bytes as Uint8Array)
    expect(record?.matchId).toBe(FIXTURE_MATCH_ID)
    expect(record?.serverId).toBe('sim-1')
    expect(record?.events.some(event => event.type === 'map_end')).toBe(true)
    expect(record?.events.some(event => event.type === 'position_tick')).toBe(false)
  })

  it('has no recording for a map it never played, and says so with null', async () => {
    const { clock, server } = createHarness()
    provision(server)
    await clock.runAll()
    expect(server.record(9)).toBeNull()
  })

  it('does not hand over a demo before the map is over', async () => {
    const { clock, server, delivered } = createHarness()
    provision(server)
    await clock.advance(300_000)
    expect(delivered.some(event => event.type === 'round_end')).toBe(true)
    expect(delivered.some(event => event.type === 'demo_available')).toBe(false)
    expect(server.record(1)).toBeNull()
  })
})

describe('createSimulatedServer', () => {
  it('plays a full match to its subscribers: valid, ordered, seq-stamped', async () => {
    const { clock, server, delivered, bodies } = createHarness()
    expect(server.status()).toMatchObject({ state: 'allocated', matchId: null, sim: null })
    provision(server)
    expect(server.status().state).toBe('starting')
    await clock.runAll()

    expect(delivered[0]?.type).toBe('server_ready')
    expect(delivered[delivered.length - 1]?.type).toBe('series_end')
    let previousSeq = 0
    for (const body of bodies) {
      const event = gameserverEventSchema.parse(JSON.parse(body))
      expect(event.matchId).toBe(FIXTURE_MATCH_ID)
      expect(event.source).toEqual({ provider: SIM_PROVIDER_ID, serverId: 'sim-1' })
      expect(event.seq).toBe(previousSeq + 1)
      previousSeq = event.seq as number
    }
    // Heartbeats flowed while the match ran, and stopped with it: a finished
    // story leaves no timer armed (the leak check).
    expect(delivered.some(event => event.type === 'heartbeat')).toBe(true)
    expect(clock.pending()).toBe(0)
    const status = server.status()
    expect(status.state).toBe('running')
    expect(status.seq).toBe(previousSeq)
    expect(status.sim).toMatchObject({
      scenario: 'happy-path',
      seed: `server-test#${FIXTURE_MATCH_ID}#sim-1`,
      mode: 'auto',
      timeScale: 1,
      remainingBeats: 0,
      finished: true,
      outcome: 'completed',
      chaos: null,
    })
    expect(server.finished()).toBe(true)
  })

  it('is byte-for-byte deterministic under the same seed', async () => {
    const one = createHarness()
    const two = createHarness()
    provision(one.server)
    provision(two.server)
    await one.clock.runAll()
    await two.clock.runAll()
    expect(one.bodies.length).toBeGreaterThan(100)
    expect(one.bodies).toEqual(two.bodies)
  })

  it('takes a seed from the plan, so a request reproduces a match on any box', async () => {
    const one = createHarness({}, 'sim-1')
    const two = createHarness({}, 'sim-2')
    provision(one.server, { seed: 'shared' })
    provision(two.server, { seed: 'shared' })
    await one.clock.runAll()
    await two.clock.runAll()
    const strip = (events: GameserverEvent[]) => events.map(({ source: _source, ...rest }) => rest)
    expect(strip(one.delivered)).toEqual(strip(two.delivered))
    expect(one.server.status().sim?.seed).toBe('shared')
  })

  it('no-show: eight connect, nothing goes live, warmup heartbeats keep coming', async () => {
    const { clock, server, delivered } = createHarness()
    provision(server, { scenario: 'no-show' })
    await clock.advance(120_000)

    expect(delivered.filter(event => event.type === 'player_connected')).toHaveLength(8)
    expect(delivered.some(event => event.type === 'going_live')).toBe(false)
    const heartbeats = delivered.filter(event => event.type === 'heartbeat')
    expect(heartbeats.length).toBeGreaterThan(5)
    expect(heartbeats[heartbeats.length - 1]?.playerCount).toBe(8)
    expect(server.status().playerCount).toBe(8)
    // The story is dry but the server is honestly still up — the
    // orchestrator's join deadline decides, so the heartbeat stays armed.
    expect(clock.pending()).toBeGreaterThan(0)
    expect(server.outcome()).toBe('idle')
  })

  it('never-ready: silence, and a status stuck in starting', async () => {
    const { clock, server, delivered } = createHarness()
    provision(server, { scenario: 'never-ready' })
    await clock.advance(600_000)
    expect(delivered).toHaveLength(0)
    expect(server.status().state).toBe('starting')
  })

  it('server-crash: the stream stops, status answers gone, the backups are on record', async () => {
    const { clock, server, delivered } = createHarness()
    provision(server, { scenario: 'server-crash' })
    await clock.runAll()

    const last = delivered[delivered.length - 1]
    expect(last?.type).toBe('round_end')
    expect(delivered.some(event => event.type === 'map_end')).toBe(false)
    expect(server.status().state).toBe('gone')
    expect(server.finished()).toBe(true)
    expect(server.backups()).toHaveLength(9)
    expect(server.backups()[8]).toEqual({
      mapNumber: 1,
      roundNumber: 9,
      filename: 'matchzy_backup_map1_round09.cfg',
    })
    expect(clock.pending()).toBe(0)
    expect(() => server.start()).toThrow(/crashed/)
  })

  it('kill(): the console button crashes a healthy match mid-flight', async () => {
    const { clock, server, delivered } = createHarness()
    provision(server)
    await clock.advance(120_000)
    const beforeKill = delivered.length
    expect(beforeKill).toBeGreaterThan(0)

    server.kill()
    await clock.advance(600_000)
    expect(delivered.length).toBe(beforeKill)
    expect(server.status().state).toBe('gone')
    expect(clock.pending()).toBe(0)
  })

  it('step mode: no timers, one beat per step, resumable into auto', async () => {
    const { clock, server, delivered } = createHarness()
    provision(server, { scenario: 'happy-path', mode: 'step' })
    await clock.advance(600_000)
    expect(delivered).toHaveLength(0)

    expect(await server.step()).toMatchObject({ type: 'server_ready', seq: 1 })
    expect(await server.step()).toMatchObject({ type: 'player_connected', seq: 2 })
    expect(delivered).toHaveLength(2)
    expect(server.status().state).toBe('running')

    server.setMode('auto')
    expect(server.mode()).toBe('auto')
    await clock.runAll()
    expect(delivered[delivered.length - 1]?.type).toBe('series_end')
    expect(await server.step().catch((error: Error) => error.message)).toMatch(/step mode/)
  })

  it('time scale compresses the same story into less clock', async () => {
    const realtime = createHarness()
    const compressed = createHarness()
    provision(realtime.server)
    provision(compressed.server, { timeScale: 60 })
    await realtime.clock.runAll()
    await compressed.clock.runAll()

    const started = Date.UTC(2026, 0, 1)
    const realtimeMs = realtime.clock.now() - started
    const compressedMs = compressed.clock.now() - started
    expect(compressed.delivered[compressed.delivered.length - 1]?.type).toBe('series_end')
    expect(compressedMs).toBeLessThan(realtimeMs / 30)
    // And the speed can change mid-flight.
    const { clock, server, delivered } = createHarness()
    provision(server)
    await clock.advance(30_000)
    server.setSpeed(600)
    expect(server.timeScale()).toBe(600)
    await clock.advance(10_000)
    expect(delivered[delivered.length - 1]?.type).toBe('series_end')
    expect(() => server.setSpeed(0)).toThrow(/positive/)
  })

  it('process-wide chaos composes at the delivery seam: drops and duplicates, reproducibly', async () => {
    const clock = createFakeClock()
    const chaos = createChaosController({ clock, seed: 'chaos-test' })
    chaos.script('sim.event', [
      { fault: 'drop', key: 'server_ready' },
      { fault: 'duplicate', key: 'going_live' },
    ])
    const { server, delivered } = createHarness({ clock, chaos })
    provision(server)
    await clock.runAll()
    await chaos.settled()

    expect(delivered.filter(event => event.type === 'server_ready')).toHaveLength(0)
    const lives = delivered.filter(event => event.type === 'going_live')
    expect(lives).toHaveLength(2)
    expect(lives[0]).toEqual(lives[1])
    expect(delivered.filter(event => event.type === 'series_end')).toHaveLength(1)
  })

  it("the server's own chaos delays and duplicates, never drops, and clears again", async () => {
    const { clock, server, delivered } = createHarness()
    provision(server, { chaos: { duplicate: 1, delay: 0 } })
    expect(server.chaos()).toEqual({ duplicate: 1, delay: 0 })
    await clock.advance(60_000)
    const doubled = delivered.length
    expect(doubled).toBeGreaterThan(0)
    // Every beat arrived twice — and every one of them still arrived.
    const seqs = delivered.map(event => event.seq)
    expect(new Set(seqs).size * 2).toBe(doubled)
    expect(server.status().sim?.chaos).toEqual({ duplicate: 1, delay: 0 })

    server.setChaos(null)
    expect(server.chaos()).toBeNull()
    await clock.runAll()
    const after = delivered.slice(doubled)
    expect(new Set(after.map(event => event.seq)).size).toBe(after.length)
    expect(after[after.length - 1]?.type).toBe('series_end')
  })

  it('a delayed delivery arrives out of order, which is the point', async () => {
    const { clock, server, delivered } = createHarness()
    provision(server, { chaos: { delay: 0.5, delayMs: 60_000 } })
    await clock.runAll()
    const seqs = delivered.map(event => event.seq as number)
    expect(seqs.length).toBeGreaterThan(100)
    expect([...seqs].sort((a, b) => a - b)).not.toEqual(seqs)
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('keeps playing when a subscriber throws, and reports every failure', async () => {
    const clock = createFakeClock()
    const failures: unknown[] = []
    const server = createSimulatedServer({
      clock,
      serverId: 'sim-1',
      seed: 'server-test',
      onError: error => failures.push(error),
    })
    const emitted: GameserverEvent[] = []
    server.events(event => emitted.push(event))
    server.events(() => {
      throw new Error('subscriber down')
    })
    provision(server)
    await clock.runAll()

    expect(emitted[emitted.length - 1]?.type).toBe('series_end')
    expect(failures.length).toBe(emitted.length)
  })

  it('unsubscribes cleanly', async () => {
    const { clock, server } = createHarness()
    const seen: GameserverEvent[] = []
    const unsubscribe = server.events(event => seen.push(event))
    provision(server)
    await clock.advance(30_000)
    const before = seen.length
    expect(before).toBeGreaterThan(0)
    unsubscribe()
    await clock.runAll()
    expect(seen.length).toBe(before)
  })

  it('refuses a second assignment and a start before the first', () => {
    const { server } = createHarness()
    expect(() => server.start()).toThrow(/before assign/)
    server.assign(fixtureAssignment())
    expect(() => server.assign(fixtureAssignment())).toThrow(/already assigned/)
  })

  it('a replacement server for the same match tells its own story', async () => {
    const first = createHarness({}, 'sim-1')
    provision(first.server)
    await first.clock.advance(60_000)
    first.server.kill()

    const second = createHarness({}, 'sim-2')
    provision(second.server)
    await second.clock.advance(60_000)
    expect(second.delivered.length).toBeGreaterThan(0)
    // Same match, different server, different events — a retry never feeds a
    // consumer's dedup a copy of the dead server's stream.
    expect(second.delivered.every(event => event.source.serverId === 'sim-2')).toBe(true)
    const strip = (events: GameserverEvent[]) =>
      JSON.stringify(events.map(({ seq: _seq, source: _source, ...rest }) => rest))
    expect(strip(first.delivered)).not.toBe(strip(second.delivered))
  })

  it('stop() parks the playback; start() resumes it', async () => {
    const { clock, server, delivered } = createHarness()
    provision(server)
    await clock.advance(60_000)
    const parkedAt = delivered.length
    server.stop()
    expect(server.status().state).toBe('stopped')
    await clock.advance(300_000)
    expect(delivered.length).toBe(parkedAt)

    server.start()
    await clock.runAll()
    expect(delivered[delivered.length - 1]?.type).toBe('series_end')
  })

  it('says a line in chat, in order with the match it is playing', async () => {
    const { clock, server, delivered } = createHarness()
    provision(server)
    await clock.advance(30_000)
    const before = delivered.length
    expect(before).toBeGreaterThan(0)

    expect(await server.announce('🎁 DROP — maex gewinnt: Currywurst!')).toBe(true)

    const said = delivered[before]
    expect(said?.type).toBe('plugin_event')
    if (said?.type !== 'plugin_event') throw new Error('unreachable')
    expect(said.name).toBe(SIM_CHAT_EVENT)
    expect(said.data.line).toBe('🎁 DROP — maex gewinnt: Currywurst!')
    expect(said.seq).toBe(before + 1)
    expect(server.announced()).toEqual(['🎁 DROP — maex gewinnt: Currywurst!'])

    // Sanitized like any adapter would: the simulator is not the one box
    // where an unsayable line looks fine.
    await server.announce('DROP"; quit')
    expect(server.announced()[1]).not.toMatch(/[;"]/)
  })

  it('has nowhere to say a line once the server is gone, and says so with false', async () => {
    const { clock, server } = createHarness()
    expect(await server.announce('DROP — nobody home')).toBe(false)
    provision(server)
    await clock.advance(30_000)
    server.kill()
    expect(await server.announce('DROP — into the void')).toBe(false)
  })

  it('close() cancels every timer for shutdown', async () => {
    const { clock, server, delivered } = createHarness()
    provision(server)
    await clock.advance(30_000)
    expect(clock.pending()).toBeGreaterThan(0)
    server.close()
    expect(clock.pending()).toBe(0)
    const before = delivered.length
    await clock.runAll()
    expect(delivered.length).toBe(before)
  })
})

describe('restore', () => {
  it('a replacement server with the dead one’s seed resumes from the backup and finishes', async () => {
    const dead = createHarness({}, 'sim-1')
    provision(dead.server, { scenario: 'server-crash', seed: 'recovery' })
    await dead.clock.runAll()
    expect(dead.server.status().state).toBe('gone')
    const backup = dead.server.backups().at(-1)
    expect(backup).toEqual({
      mapNumber: 1,
      roundNumber: 9,
      filename: 'matchzy_backup_map1_round09.cfg',
    })

    const fresh = createHarness({}, 'sim-2')
    fresh.server.assign(fixtureAssignment(), { scenario: 'server-crash', seed: 'recovery' })
    fresh.server.restore({ mapNumber: 1, roundNumber: 9 })
    fresh.server.start()
    await fresh.clock.runAll()

    const types = fresh.delivered.map(event => event.type)
    expect(types[0]).toBe('server_ready')
    expect(fresh.delivered.filter(event => event.type === 'player_connected')).toHaveLength(10)
    expect(
      fresh.delivered.find(
        event => event.type === 'plugin_event' && event.name === BACKUP_RESTORED_EVENT,
      ),
    ).toMatchObject({ data: { mapNumber: 1, roundNumber: 9 } })
    const rounds = fresh.delivered.filter(event => event.type === 'round_end')
    expect(rounds[0]?.roundNumber).toBe(9)
    expect(types[types.length - 1]).toBe('series_end')
    expect(fresh.server.status()).toMatchObject({ state: 'running', playerCount: 10 })
    expect(fresh.server.status().sim?.outcome).toBe('completed')
    expect(fresh.server.status().sim?.scenario).toBe('server-crash')
    expect(fresh.clock.pending()).toBe(0)

    // The resumed rounds are the very rounds the dead server would have
    // played: same seed, same dice, same scores — a recovery replays the match
    // the crash interrupted, on a new box.
    const uncut = createHarness({}, 'sim-3')
    provision(uncut.server, { scenario: 'happy-path', seed: 'recovery' })
    await uncut.clock.runAll()
    const strip = (events: GameserverEvent[]) =>
      events
        .filter(event => event.type === 'round_end')
        .map(({ seq: _seq, source: _source, ...rest }) => rest)
    expect(strip(fresh.delivered)).toEqual(strip(uncut.delivered).slice(8))
    expect(strip(dead.delivered)).toEqual(strip(uncut.delivered).slice(0, 9))
    // And the dead server's round 9 is the resumed server's first: a consumer
    // that dedups on (map, round) sees the same result twice, never a new one.
    expect(strip(fresh.delivered)[0]).toEqual(strip(dead.delivered)[8])
    // The recording hands over the whole map, this server named as its player.
    const recording = fresh.server.record(1)
    expect(recording?.record.serverId).toBe('sim-2')
    expect(recording?.record.events.some(event => event.type === 'going_live')).toBe(true)
  })

  it('refuses a backup the story never wrote, and a restore after starting', async () => {
    const { clock, server } = createHarness()
    server.assign(fixtureAssignment(), { scenario: 'server-crash' })
    expect(() => server.restore({ mapNumber: 1, roundNumber: 40 })).toThrow(/no backup/)
    expect(() => server.restore({ mapNumber: 2, roundNumber: 1 })).toThrow(/no backup/)
    server.start()
    await clock.advance(10_000)
    expect(() => server.restore({ mapNumber: 1, roundNumber: 5 })).toThrow(/before it started/)
  })

  it('needs an assignment first', () => {
    const { server } = createHarness()
    expect(() => server.restore({ mapNumber: 1, roundNumber: 1 })).toThrow(/before assign/)
  })
})
