/**
 * **A simulated gameserver**, as one handle: it is told a match (`assign`),
 * plays the story on the injected clock (`start`, or one beat at a time in
 * step mode), and every event it speaks reaches the subscribers of `events`
 * with a per-server `seq` — the same union a real server speaks over its
 * link, so whoever sits on the other end (the orchestrator's `sim` provider,
 * the published fake) cannot tell the two apart. If a consumer could, that is
 * a bug here, never a consumer change.
 *
 * Time lives on the injected clock: a fake clock plays a full Bo1 in
 * milliseconds; the system clock plays it out in real time, or compressed via
 * `timeScale`. Chaos composes at the delivery seam (`@ezpug/core/chaos`) — the
 * server itself never rolls dice at delivery time, so a chaotic run is still
 * reproducible under its seed.
 *
 * The platform's `simulator/provider.ts` on 2026-09-05, decoupled from its
 * provider interface: no allocation, no connect facts, no transport — those
 * are the orchestrator's — and `restore` added for the recovery flow.
 */
import type { Clock, Timer } from '@ezpug/core'
import { createPrng } from '@ezpug/core'
import type { ChaosController, ChaosDeliverer } from '@ezpug/core/chaos'
import { createChaosController } from '@ezpug/core/chaos'
import type {
  Game,
  GameserverEvent,
  MapRadar,
  SimChaos,
  SimMode,
  SimStatus,
} from '@ezpug/match-api'
import { gameserverEventSchema } from '@ezpug/match-api'
import type { MatchAssignment } from './assignment'
import { sanitizeChatLine } from './chat'
import { simRadarFor } from './radar'
import type { SimulatedRecording } from './record'
import type { SimulatorScenario, SimulatorScenarioName } from './scenario'
import { resolveScenario } from './scenario'
import type { MatchStory, StoryResumePoint } from './story'
import { buildMatchStory, resumeStory } from './story'

/** The provider badge every event of a simulated server carries (`source.provider`). */
export const SIM_PROVIDER_ID = 'sim'

/**
 * **What a simulated server says out loud** — the `plugin_event` it echoes
 * back for every line it was told to announce. A real plugin prints the line
 * and says nothing back; the simulator publishes it through the same delivery
 * path as every other beat, so the line is *ordered* against the match's own
 * events and a test can prove an announcement landed after the round that
 * triggered it.
 */
export const SIM_CHAT_EVENT = 'chat_announced'

/**
 * A simulated server's lifecycle. `allocated` until it is told a match,
 * `starting` until `server_ready` fired, `running` from then on, `stopped`
 * while parked, `gone` once killed or crashed — a status probe on a corpse.
 */
export const SIM_SERVER_STATES = ['allocated', 'starting', 'running', 'stopped', 'gone'] as const
export type SimServerState = (typeof SIM_SERVER_STATES)[number]

/** Per-match knobs, all optional — the server's defaults fill the rest. */
export interface SimPlan {
  scenario?: SimulatorScenarioName | SimulatorScenario
  /**
   * The seed the story is built from. Overrides the derived one
   * (`<root>#<matchId>#<serverId>`), which is how a replacement server is
   * handed the dead one's story for a `restore` — and how a request's
   * `sim.seed` reproduces a match on any box.
   */
  seed?: string
  /** 1 = real time; 60 = a minute of match per second of clock. */
  timeScale?: number
  /** `step` arms no timers — `step()` deals the story one beat at a time. */
  mode?: SimMode
  heartbeatIntervalMs?: number
  /** Position-tick sampling interval; `null` turns the ephemeral tier off. */
  positionTickIntervalMs?: number | null
  bootDelayMs?: number
  /**
   * Make *this* box flaky: delay and duplicate its own deliveries. Scoped to
   * one server, seeded off it, and deliberately not the process-wide rail
   * ({@link SimulatedServerOptions.chaos}); composes with it when both are armed.
   */
  chaos?: SimChaos | null
}

export interface SimulatedServerOptions {
  clock: Clock
  serverId: string
  /** The determinism root; the per-server story seed derives from it. Default `sim`. */
  seed?: string
  /** Delay/duplicate/drop the deliveries — `target: sim.event`, keyed by event type. */
  chaos?: ChaosDeliverer
  /** A subscriber that threw, or a chaos delivery that failed. The match keeps playing. */
  onError?: (error: unknown, info: { serverId: string; matchId?: string }) => void
  /**
   * What a map looks like, asked once per map at assign time. Default: the
   * fixture set under `fixtures/radar/` ({@link simRadarFor}); answer null and
   * positions still sample, in world units nobody calibrated.
   */
  radar?: (input: { game: Game; map: string }) => MapRadar | null
  defaults?: SimPlan
}

/** A round backup this server wrote — what a `restore` can resume from. */
export interface SimBackup {
  mapNumber: number
  roundNumber: number
  filename: string
}

export interface SimulatedServerStatus {
  serverId: string
  matchId: string | null
  state: SimServerState
  playerCount: number
  /** The last `seq` stamped on an event of this server; 0 before the first. */
  seq: number
  /** The Match API's `sim` block, null before `assign`. */
  sim: SimStatus | null
}

export type SimEventListener = (event: GameserverEvent) => void

/** The per-server control surface — the `sim.*` commands drive exactly this. */
export interface SimulatedServer {
  readonly serverId: string
  /**
   * Tell the server its match. Builds the whole story now, from the seed;
   * nothing fires until `start()`. Once per server — a replacement server is
   * a new server.
   */
  assign: (assignment: MatchAssignment, plan?: SimPlan) => void
  /**
   * Load a round backup (`backup_written`'s round): the pending playback
   * becomes a boot, reconnects, `backup_restored`, `going_live` and the story
   * from that round on. For a replacement server handed the dead one's seed;
   * the crash the scenario scripted is disarmed, so the resumed match ends.
   * Before `start()`, after `assign`; throws `SimulatorRestoreError` when the
   * story never wrote that backup.
   */
  restore: (point: StoryResumePoint) => void
  /** Begin (or resume) playback on the clock. Idempotent while playing. */
  start: () => void
  /** Park the playback: timers cancelled, state `stopped`; `start()` resumes. */
  stop: () => void
  /** Deal the next story beat now (step mode). Resolves after delivery; `null` when dry. */
  step: () => Promise<GameserverEvent | null>
  mode: () => SimMode
  setMode: (mode: SimMode) => void
  timeScale: () => number
  setSpeed: (timeScale: number) => void
  /** This server's own delivery chaos, or null when it is delivering honestly. */
  chaos: () => SimChaos | null
  /** Arm or clear it mid-match; `null` makes the box reliable again. */
  setChaos: (chaos: SimChaos | null) => void
  /** The kill-server button: the box dies, status answers `gone`, heartbeats stop. */
  kill: () => void
  /**
   * Say one line in the server's chat. Sanitized like every adapter does, then
   * delivered as a {@link SIM_CHAT_EVENT} `plugin_event` in order with the
   * match. `false` when there is no server to say it on — gone, unassigned,
   * not playing — which is an answer, not a failure.
   */
  announce: (line: string) => Promise<boolean>
  /** Every line this server was told to say, in the order it said them. */
  announced: () => readonly string[]
  status: () => SimulatedServerStatus
  /**
   * Subscribe to every event this server speaks, `seq`-stamped, position
   * ticks included — the consumer decides what is ephemeral. Returns the
   * unsubscribe.
   */
  events: (listener: SimEventListener) => () => void
  /**
   * The recording behind a map's `demo_available` — the same bytes, the same
   * length the event announced. `null` until that event has been dealt: a
   * server does not hand over a demo of a map it has not finished.
   */
  record: (mapNumber?: number) => SimulatedRecording | null
  /** The round backups written so far, in order. */
  backups: () => SimBackup[]
  /** Where the story is going — `null` before `assign`. */
  outcome: () => MatchStory['outcome'] | null
  remainingBeats: () => number
  finished: () => boolean
  /** Teardown: cancel every timer, drop every subscriber. */
  close: () => void
}

const DEFAULT_PLAN: Required<Omit<SimPlan, 'scenario' | 'seed' | 'chaos'>> = {
  timeScale: 1,
  mode: 'auto',
  heartbeatIntervalMs: 10_000,
  positionTickIntervalMs: 5_000,
  bootDelayMs: 4_000,
}

interface Assigned {
  assignment: MatchAssignment
  scenario: SimulatorScenario
  seed: string
  story: MatchStory
  bootDelayMs: number
  positionTickIntervalMs: number | null
  radars: (MapRadar | null)[]
}

export function createSimulatedServer(options: SimulatedServerOptions): SimulatedServer {
  const { clock, serverId } = options
  const root = options.seed ?? 'sim'
  const source = { provider: SIM_PROVIDER_ID, serverId }
  const radarFor = options.radar ?? (({ map }: { map: string }) => simRadarFor(map))
  const listeners = new Set<SimEventListener>()

  let assigned: Assigned | undefined
  let lifecycle: SimServerState = 'allocated'
  let crashed = false
  let playing = false
  let readyEmitted = false
  let completed = false
  let connected = 0
  let seq = 0
  let cursor = 0
  let lastAtMs = 0
  let mode: SimMode = DEFAULT_PLAN.mode
  let timeScale = DEFAULT_PLAN.timeScale
  let heartbeatIntervalMs = DEFAULT_PLAN.heartbeatIntervalMs
  let chaosProfile: SimChaos | null = null
  let chaos: ChaosController | null = null
  let beatTimer: Timer | undefined
  let heartbeatTimer: Timer | undefined
  const announced: string[] = []
  const backups: SimBackup[] = []
  const dealtDemos = new Set<number>()

  const report = (error: unknown): void => {
    const info = { serverId, ...(assigned && { matchId: assigned.assignment.matchId }) }
    if (options.onError) options.onError(error, info)
    else console.error('[sim]', info, error)
  }

  const cancelTimers = (): void => {
    beatTimer?.cancel()
    beatTimer = undefined
    heartbeatTimer?.cancel()
    heartbeatTimer = undefined
  }

  /**
   * Arm (or clear) this server's delivery chaos. The controller is built
   * lazily and seeded off the server id, so a chaotic run is still
   * reproducible — the server never rolls dice at delivery time itself.
   */
  const armChaos = (profile: SimChaos | null): void => {
    chaosProfile = profile
    if (!profile) {
      chaos?.reset()
      chaos = null
      return
    }
    chaos ??= createChaosController({
      clock,
      seed: `${root}#chaos#${serverId}`,
      onError: error => report(error),
    })
    chaos.configure('sim.event', profile)
  }

  const crash = (): void => {
    crashed = true
    playing = false
    cancelTimers()
  }

  /** One event out the door. Fire-and-forget in playback; awaited by `step`. */
  const deliver = (event: GameserverEvent): Promise<void> => {
    // The server's own conformance guard: an event that does not parse is a
    // simulator bug and must die here, not in a consumer.
    gameserverEventSchema.parse(event)
    const fanOut = (): void => {
      for (const listener of listeners) {
        try {
          listener(event)
        } catch (error) {
          report(error)
        }
      }
    }
    // This box's own flakiness sits *inside* the process-wide rail: delay and
    // duplicate only, because those are the two faults a consumer promises to
    // survive — a real server retries rather than losing an event.
    const send = chaos
      ? (): Promise<void> =>
          (chaos as ChaosController).deliver(
            { target: 'sim.event', key: event.type, faults: ['delay', 'duplicate'] },
            fanOut,
          )
      : (): Promise<void> => {
          fanOut()
          return Promise.resolve()
        }
    const delivery = options.chaos
      ? options.chaos.deliver({ target: 'sim.event', key: event.type }, send)
      : send()
    return delivery.catch((error: unknown) => report(error))
  }

  const armHeartbeat = (): void => {
    if (mode === 'step' || !assigned) return
    const { matchId } = assigned.assignment
    heartbeatTimer = clock.after(heartbeatIntervalMs / timeScale, () => {
      if (!playing || crashed || completed) return
      void deliver({ type: 'heartbeat', matchId, source, seq: ++seq, playerCount: connected })
      armHeartbeat()
    })
  }

  /** Emit the next story beat; handles lifecycle side effects and the ending. */
  const emitBeat = (): { event: GameserverEvent; done: Promise<void> } | null => {
    const story = assigned?.story
    if (!story) return null
    const beat = story.beats[cursor]
    if (!beat) return null
    cursor++
    lastAtMs = beat.atMs

    const event: GameserverEvent = { ...beat.event, seq: ++seq }
    if (event.type === 'server_ready') {
      lifecycle = 'running'
      readyEmitted = true
      armHeartbeat()
    } else if (event.type === 'player_connected') {
      connected++
    } else if (event.type === 'player_disconnected') {
      connected = Math.max(0, connected - 1)
    } else if (event.type === 'backup_written') {
      backups.push({
        mapNumber: event.mapNumber,
        roundNumber: event.roundNumber,
        filename: event.filename,
      })
    } else if (event.type === 'demo_available') {
      dealtDemos.add(event.mapNumber)
    }

    const done = deliver(event)

    if (cursor >= story.beats.length) {
      // The story is over. `completed` and `crashed` stop the heartbeat;
      // `idle` keeps warming up — the orchestrator's deadlines decide its fate.
      if (story.outcome === 'crashed') crash()
      else if (story.outcome === 'completed') {
        completed = true
        heartbeatTimer?.cancel()
        heartbeatTimer = undefined
      }
    }
    return { event, done }
  }

  const scheduleNext = (): void => {
    if (!playing || mode !== 'auto' || crashed) return
    const next = assigned?.story.beats[cursor]
    if (!next) return
    const delay = Math.max(0, (next.atMs - lastAtMs) / timeScale)
    beatTimer = clock.after(delay, () => {
      const emitted = emitBeat()
      if (emitted) void emitted.done
      scheduleNext()
    })
  }

  const buildStory = (current: Omit<Assigned, 'story'>, scenario: SimulatorScenario): MatchStory =>
    buildMatchStory({
      prng: createPrng(current.seed),
      assignment: current.assignment,
      scenario,
      source,
      bootDelayMs: current.bootDelayMs,
      positionTickIntervalMs: current.positionTickIntervalMs,
      radars: current.radars,
    })

  const requireAssigned = (verb: string): Assigned => {
    if (!assigned) throw new Error(`simulator: ${verb} before assign on ${serverId}`)
    return assigned
  }

  return {
    serverId,

    assign(assignment, plan = {}) {
      if (assigned) throw new Error(`simulator: ${serverId} is already assigned`)
      if (crashed) throw new Error(`simulator: ${serverId} is gone — allocate a new one`)
      const merged = { ...DEFAULT_PLAN, ...options.defaults, ...plan }
      const scenario = resolveScenario(merged.scenario)
      // The per-server seed: a replacement server for the same match tells
      // its own story unless it is handed the dead one's seed on purpose.
      const seed = merged.seed ?? `${root}#${assignment.matchId}#${serverId}`
      mode = merged.mode
      timeScale = merged.timeScale
      heartbeatIntervalMs = merged.heartbeatIntervalMs
      armChaos(merged.chaos ?? null)
      // What the maps of this series look like, asked before the story is
      // built: a position tick is emitted in world units and drawn on a radar
      // image, so the transform has to be in hand by the time the dice decide
      // where anybody stands.
      const radars = assignment.maps.map(entry =>
        radarFor({ game: assignment.game, map: entry.map }),
      )
      const current = {
        assignment,
        scenario,
        seed,
        bootDelayMs: merged.bootDelayMs,
        positionTickIntervalMs: merged.positionTickIntervalMs,
        radars,
      }
      assigned = { ...current, story: buildStory(current, scenario) }
      lifecycle = 'starting'
    },

    restore(point) {
      const current = requireAssigned('restore')
      if (playing || cursor > 0) {
        throw new Error(`simulator: restore on ${serverId} only before it started`)
      }
      // The full story, crash disarmed: the same dice up to the crash, then
      // the rest of the match the dead server never got to play.
      const { crashAfterRound: _crash, ...uncut } = current.scenario
      const full = buildStory(current, uncut)
      const story = resumeStory({
        story: full,
        assignment: current.assignment,
        source,
        point,
        prng: createPrng(current.seed).fork('restore'),
        bootDelayMs: current.bootDelayMs,
      })
      assigned = { ...current, scenario: uncut, story }
    },

    start() {
      requireAssigned('start')
      if (crashed) throw new Error(`simulator: ${serverId} crashed — allocate a new one`)
      if (playing) return
      playing = true
      lifecycle = readyEmitted ? 'running' : 'starting'
      if (mode === 'auto') {
        scheduleNext()
        if (readyEmitted && !completed) armHeartbeat()
      }
    },

    stop() {
      if (crashed) return
      playing = false
      cancelTimers()
      if (assigned) lifecycle = 'stopped'
    },

    async step() {
      if (mode !== 'step') {
        throw new Error('simulator: step() only in step mode — call setMode("step") first')
      }
      if (crashed || !playing) return null
      const emitted = emitBeat()
      if (!emitted) return null
      await emitted.done
      return emitted.event
    },

    mode: () => mode,
    setMode(next) {
      if (next === mode) return
      mode = next
      if (next === 'step') {
        cancelTimers()
      } else if (playing) {
        scheduleNext()
        if (readyEmitted && !completed && !crashed) armHeartbeat()
      }
    },

    timeScale: () => timeScale,
    setSpeed(next) {
      if (!Number.isFinite(next) || next <= 0) {
        throw new Error(`simulator: timeScale must be positive, got ${next}`)
      }
      timeScale = next
      // Re-arm the pending beat at the new pace.
      if (mode === 'auto' && playing && beatTimer) {
        beatTimer.cancel()
        scheduleNext()
      }
    },

    chaos: () => chaosProfile,
    setChaos: profile => armChaos(profile),

    kill() {
      crash()
    },

    announce(line) {
      if (!assigned || crashed || !playing) return Promise.resolve(false)
      const said = sanitizeChatLine(line)
      announced.push(said)
      return deliver({
        type: 'plugin_event',
        matchId: assigned.assignment.matchId,
        source,
        seq: ++seq,
        name: SIM_CHAT_EVENT,
        data: { line: said },
      }).then(() => true)
    },
    announced: () => [...announced],

    status: () => ({
      serverId,
      matchId: assigned?.assignment.matchId ?? null,
      state: crashed ? 'gone' : lifecycle,
      playerCount: connected,
      seq,
      sim: assigned
        ? {
            scenario: assigned.scenario.name,
            seed: assigned.seed,
            mode,
            timeScale,
            remainingBeats: assigned.story.beats.length - cursor,
            finished: completed || crashed,
            outcome: assigned.story.outcome,
            chaos: chaosProfile,
          }
        : null,
    }),

    events(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    record(mapNumber = 1) {
      if (!assigned || !dealtDemos.has(mapNumber)) return null
      return assigned.story.demos.find(demo => demo.mapNumber === mapNumber) ?? null
    },
    backups: () => backups.map(backup => ({ ...backup })),

    outcome: () => assigned?.story.outcome ?? null,
    remainingBeats: () => (assigned ? assigned.story.beats.length - cursor : 0),
    finished: () => completed || crashed,

    close() {
      cancelTimers()
      playing = false
      listeners.clear()
    },
  }
}
