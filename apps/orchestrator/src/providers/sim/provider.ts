import { createHash } from 'node:crypto'
import type { Clock } from '@ezpug/core'
import { createPrng } from '@ezpug/core'
import type {
  GameserverEvent,
  GameserverPlayer,
  MatchRequest,
  RosterEntry,
  SimStatus,
} from '@ezpug/match-api'
import type { MatchAssignment, SimPlan, SimulatedServer, SimulatorScenario } from '@ezpug/sim'
import {
  assignmentFromMatchRequest,
  createSimulatedServer,
  findScenario,
  resolveScenario,
  SIM_PROVIDER_ID,
  SIMULATED_MATCH_RECORD_CONTENT_TYPE,
} from '@ezpug/sim'
import type { LinkRegistry, ServerEventSink, ServerRef } from '../../link/channels'
import type {
  AllocatedServer,
  GameServerProvider,
  ProvisionedServer,
  ServerConfiguration,
  ServerOffering,
  ServerStatus,
} from '../provider'
import { createSimChannel } from './channel'

/**
 * **The `sim` provider** (decision 9, PRD-02 T3/T4): `packages/sim`'s engine
 * behind the provider interface. A simulated server is allocated like any
 * other (a handle, an address nobody can connect to, a GOTV relay that does
 * not exist, all `.invalid`), told its match through `configure`, started,
 * probed, stopped and deallocated — and once started it is the server side
 * of the link: its events reach the machine through the same
 * {@link ServerEventSink} a real plugin's do, and commands reach it through
 * a {@link ServerChannel} attached to the same registry. Whoever sits on the
 * other end cannot tell the two apart; if they could, that is a bug here.
 *
 * The story a server tells is decided by one seed per **match**, not per
 * server (`<root>#<matchId>`, or the request's own `sim.seed`): a replacement
 * server for a match that lost its box is handed the dead one's story, which
 * is what makes {@link GameServerProvider.restore} — load a round backup and
 * play on from it — mean anything at all (T14 walks that path; the verb and
 * its determinism are here).
 *
 * **Backups** (T14): a real plugin follows every `backup_written` with a
 * `backup` frame carrying the file; a simulated server has no file, so the
 * provider reports a small stand-in through the same sink verb the link
 * uses, and the machine cannot tell the two apart. {@link SimProvider.setFaults}
 * is the conformance suite's crash door: the same knobs the published fake
 * takes (`crash.afterRound`, `crash.backup`), mapped onto the `server-crash`
 * scenario and onto whether backups are reported at all.
 */

/** The fault knobs a test arms before a match is created — the conformance suite's `faults`. */
export interface SimFaults {
  /** The server dies after this round of map 1; `backup: false` takes its backups with it. */
  crash?: { afterRound: number; backup: boolean } | null
}

/** The game port and the GOTV port every simulated server states. */
export const SIM_SERVER_PORT = 27_015
export const SIM_TV_PORT = 27_020

export interface SimProviderOptions {
  clock: Clock
  /** Where a started server's events go. */
  sink: ServerEventSink
  /** Where a started server's channel attaches. */
  links: LinkRegistry
  /** Servers the provider can run at once. Default 8. */
  capacity?: number
  /** The region badge. Default `sim`. */
  region?: string
  /** What a server costs per hour, so a monthly ceiling can be reached in a test. Default 0. */
  hourlyCents?: number
  /** The GOTV delay every server states. Default 90. */
  tvDelaySeconds?: number
  /** Per-server defaults under the request's own `sim` block (time scale, mode, boot delay…). */
  defaults?: SimPlan
  /** The determinism root; every story seed derives from it. Default `sim`. */
  seed?: string
  /**
   * How a simulated server PUTs its recording at the request's
   * `demoUploadUrl` (T21). A simulated box is the server side of the link, so
   * the upload is *its* job exactly as it is a real plugin's — the
   * orchestrator only relays the fact. Default: the global `fetch`.
   */
  fetch?: typeof globalThis.fetch
  onError?: (error: unknown, context: Record<string, unknown>) => void
}

interface SimServer {
  serverId: string
  matchId: string
  fleetServerId: string
  server: SimulatedServer | null
  configured: boolean
  /** Whether this box's round backups reach the orchestrator (a faulted box keeps them). */
  reportsBackups: boolean
}

/** A real request may carry an empty roster (open join); the story needs names. */
export function inventRoster(
  request: MatchRequest,
  teamSize: number,
  seed: string,
): { teams: MatchRequest['teams']; invented: RosterEntry[] } {
  const prng = createPrng(`${seed}#roster`)
  const invented: RosterEntry[] = []
  const fill = (team: MatchRequest['teams']['teamA'], label: string) => {
    if (team.players.length > 0) return team
    const count = Math.max(1, Math.min(5, teamSize))
    const players: RosterEntry[] = []
    for (let i = 0; i < count; i += 1) {
      const steamId64 = `7656119${String(prng.int(0, 1_000_000_000)).padStart(10, '0')}`
      const player: RosterEntry = { steamId64, name: `${label}-${i + 1}`, locale: 'de' }
      invented.push(player)
      players.push(player)
    }
    return { ...team, players }
  }
  return {
    teams: { teamA: fill(request.teams.teamA, 'sim-a'), teamB: fill(request.teams.teamB, 'sim-b') },
    invented,
  }
}

/** The engine's assignment for a request — rosters invented where the request left them empty. */
export function simAssignmentFor(
  configuration: ServerConfiguration,
  seed: string,
): { assignment: MatchAssignment; invented: RosterEntry[] } {
  const { request, gamemode, matchId, game } = configuration
  const { teams, invented } = inventRoster(
    request,
    Math.ceil(gamemode.slots.teamSize / gamemode.slots.teams),
    seed,
  )
  return {
    assignment: assignmentFromMatchRequest({
      matchId,
      game,
      teams,
      maps: request.maps,
      ...(request.rules && { rules: request.rules }),
      // The engine's stand-in mode enforces the manifest's verbs (T24).
      commands: gamemode.commands,
      openJoin: gamemode.slots.openJoin,
      // Said out loud while the simulated server waits, exactly as a plugin
      // would print them (T30).
      ...(request.warmupLines && { warmupLines: request.warmupLines }),
    }),
    invented,
  }
}

export class SimPlanError extends Error {
  override readonly name = 'SimPlanError'
}

/** The engine's plan from the request's `sim` block over the provider's defaults. */
export function simPlanFor(request: MatchRequest, defaults: SimPlan = {}): SimPlan {
  const name = request.sim?.scenario
  const scenario = name === undefined ? undefined : findScenario(name)
  if (name !== undefined && !scenario) throw new SimPlanError(`unknown sim scenario ${name}`)
  return {
    ...defaults,
    ...(scenario && { scenario }),
    ...(request.sim?.seed !== undefined && { seed: request.sim.seed }),
    ...(request.sim?.mode !== undefined && { mode: request.sim.mode }),
    ...(request.sim?.timeScale !== undefined && { timeScale: request.sim.timeScale }),
    ...(request.sim?.chaos !== undefined && { chaos: request.sim.chaos }),
  }
}

export interface SimProvider extends GameServerProvider {
  /** The engine handle behind a server, for a test that drives it directly. */
  engine: (serverId: string) => SimulatedServer | null
  /** How many servers exist right now. */
  size: () => number
  /**
   * Events this provider has spoken and the machine has not finished taking
   * — what a barrier must wait for, and what it must be able to see is *not*
   * zero before it declares the world quiet.
   */
  pending: () => number
  /** Resolve once every event spoken so far has been taken (T10a). */
  settle: () => Promise<void>
  /** Arm (or clear, with `{}`) the fault knobs for every server configured from now on. */
  setFaults: (faults: SimFaults) => void
  faults: () => SimFaults
}

export function createSimProvider(options: SimProviderOptions): SimProvider {
  const { clock, sink, links } = options
  const capacity = options.capacity ?? 8
  const region = options.region ?? 'sim'
  const hourlyCents = options.hourlyCents ?? 0
  const tvDelaySeconds = options.tvDelaySeconds ?? 90
  const root = options.seed ?? 'sim'
  const report =
    options.onError ??
    ((error: unknown, context: Record<string, unknown>) => console.error('[sim]', context, error))
  const servers = new Map<string, SimServer>()
  let counter = 0
  let faults: SimFaults = {}

  const ref = (serverId: string): ServerRef => ({ provider: SIM_PROVIDER_ID, serverId })
  const host = (serverId: string): string => `${serverId}.sim.invalid`
  const fetchImpl = options.fetch ?? globalThis.fetch

  /**
   * **Every ingest this provider has started and not yet finished** (T10a).
   * A simulated server speaks from a timer callback and a channel reports
   * what a command did while the machine still holds that match's chain, so
   * neither promise is anybody's to await — but both must be *visible*, or a
   * barrier ({@link SimProvider.settle}) returns while the match is still
   * moving and the next thing a test reads is a half-played story. The
   * promise joins the set inside `ingest`, before it is handed back, so
   * there is no window in which the work exists and the set does not know it.
   */
  const ingesting = new Set<Promise<unknown>>()
  const trackedSink: ServerEventSink = {
    backup: (source, backup) => sink.backup(source, backup),
    ingest: (source, event) => {
      const promise = sink.ingest(source, event)
      ingesting.add(promise)
      void promise.then(
        () => ingesting.delete(promise),
        () => ingesting.delete(promise),
      )
      return promise
    },
  }

  /** The plan for a server: the request's over the defaults, then the armed crash on top. */
  const planFor = (request: MatchRequest): SimPlan => {
    const plan = simPlanFor(request, options.defaults)
    const crash = faults.crash
    if (!crash) return plan
    const base: SimulatorScenario = resolveScenario(plan.scenario)
    return {
      ...plan,
      scenario: { ...base, name: 'server-crash', crashAfterRound: crash.afterRound },
    }
  }

  const offering = (): ServerOffering => ({
    capabilities: { games: ['cs2'], region, tickrate: 128, lan: false, workshopMaps: true },
    hourlyCents,
    available: Math.max(0, capacity - servers.size),
  })

  const lifecycle = (entry: SimServer): ServerStatus['state'] => {
    if (!entry.server) return 'allocated'
    return entry.server.status().state
  }

  return {
    id: SIM_PROVIDER_ID,

    offerings: () => Promise.resolve([offering()]),

    allocate(request): Promise<AllocatedServer> {
      if (servers.size >= capacity)
        return Promise.reject(new Error(`sim: no free server (${capacity} in use)`))
      counter += 1
      const serverId = `sim-${counter}`
      servers.set(serverId, {
        serverId,
        matchId: request.matchId,
        fleetServerId: request.fleetServerId,
        server: null,
        configured: false,
        reportsBackups: faults.crash?.backup !== false,
      })
      return Promise.resolve({
        serverId,
        connect: { host: host(serverId), port: SIM_SERVER_PORT },
        tv: { host: host(serverId), port: SIM_TV_PORT, delaySeconds: tvDelaySeconds },
      })
    },

    configure(serverId, configuration) {
      const entry = servers.get(serverId)
      if (!entry) return Promise.reject(new Error(`sim: no server ${serverId}`))
      if (entry.configured)
        return Promise.reject(new Error(`sim: ${serverId} is already configured`))
      const plan = planFor(configuration.request)
      const seed = plan.seed ?? `${root}#${configuration.matchId}`
      const { assignment } = simAssignmentFor(configuration, seed)
      const server = createSimulatedServer({
        clock,
        serverId,
        seed: root,
        onError: (error, info) => report(error, { ...info, where: 'sim' }),
      })
      server.assign(assignment, { ...plan, seed })
      const presence = new Map<string, GameserverPlayer>()
      let currentMap = 1
      /**
       * **The story reaches the sink in the order it was told**, even when one
       * beat has to go to the network first: a `demo_available` is held until
       * the recording behind it has been PUT, and the `series_end` two seconds
       * behind it must not overtake it — the machine ends the match on that
       * one and would reject the demo that arrived after it. Each queued step
       * is tracked so the barrier ({@link SimProvider.settle}) still sees it.
       */
      let tail: Promise<void> = Promise.resolve()
      const feed = (step: () => Promise<unknown>): void => {
        const next = tail.then(step, step).then(
          () => undefined,
          (error: unknown) => {
            report(error, { serverId, matchId: configuration.matchId, where: 'ingest' })
          },
        )
        tail = next
        ingesting.add(next)
        void next.then(
          () => ingesting.delete(next),
          () => ingesting.delete(next),
        )
      }
      const demoUploadUrl =
        configuration.gamemode.records === 'demo'
          ? configuration.request.callbacks.demoUploadUrl
          : undefined

      /**
       * What a real plugin does with a finished demo (decision 10, T21): PUT
       * it where the request said and say what landed. The simulator's
       * recording is not a `.dem` and never pretends to be one — it goes up as
       * the JSON it is, under its own content type.
       */
      const uploadRecording = async (
        event: Extract<GameserverEvent, { type: 'demo_available' }>,
      ): Promise<GameserverEvent> => {
        const recording = server.record(event.mapNumber)
        if (!recording || !demoUploadUrl) return event
        try {
          const response = await fetchImpl(demoUploadUrl, {
            method: 'PUT',
            headers: { 'content-type': SIMULATED_MATCH_RECORD_CONTENT_TYPE },
            body: recording.bytes as Uint8Array<ArrayBuffer>,
          })
          if (!response.ok) throw new Error(`the demo upload answered ${response.status}`)
        } catch (error) {
          // Honest: the demo exists on the box and nowhere else. The event
          // still travels, without a hash, and `match.ended` says
          // `upload_failed`.
          report(error, { serverId, matchId: configuration.matchId, where: 'demo' })
          return event
        }
        return {
          ...event,
          sizeBytes: recording.sizeBytes,
          sha256: createHash('sha256').update(recording.bytes).digest('hex'),
          contentType: SIMULATED_MATCH_RECORD_CONTENT_TYPE,
        }
      }

      server.events(event => {
        if (event.type === 'player_connected') presence.set(event.player.steamId64, event.player)
        else if (event.type === 'player_disconnected') presence.delete(event.player.steamId64)
        else if (event.type === 'going_live') currentMap = event.mapNumber
        if (event.type === 'demo_available' && demoUploadUrl)
          feed(async () => sink.ingest(ref(serverId), await uploadRecording(event)))
        else feed(() => sink.ingest(ref(serverId), event))
        // What a plugin does after `backup_written`: the file, up the link.
        // A faulted box keeps its files, and the loss is then a real one.
        if (event.type === 'backup_written' && entry.reportsBackups) {
          const promise = sink.backup(ref(serverId), {
            mapNumber: event.mapNumber,
            roundNumber: event.roundNumber,
            filename: event.filename,
            content: JSON.stringify({
              simulated: true,
              serverId,
              matchId: configuration.matchId,
              mapNumber: event.mapNumber,
              roundNumber: event.roundNumber,
            }),
          })
          ingesting.add(promise)
          void promise.then(
            () => ingesting.delete(promise),
            (error: unknown) => {
              ingesting.delete(promise)
              report(error, { serverId, matchId: configuration.matchId, where: 'backup' })
            },
          )
        }
      })
      entry.server = server
      entry.configured = true
      links.attach(
        createSimChannel({
          server: ref(serverId),
          engine: server,
          matchId: configuration.matchId,
          sink: trackedSink,
          presence,
          currentMap: () => currentMap,
        }),
      )
      return Promise.resolve()
    },

    start(serverId) {
      const entry = servers.get(serverId)
      if (!entry?.server) return Promise.reject(new Error(`sim: ${serverId} is not configured`))
      entry.server.start()
      return Promise.resolve()
    },

    stop(serverId) {
      servers.get(serverId)?.server?.stop()
      return Promise.resolve()
    },

    status(serverId) {
      const entry = servers.get(serverId)
      if (!entry) return Promise.resolve({ state: 'gone' })
      const status = entry.server?.status()
      return Promise.resolve({
        state: lifecycle(entry),
        connect: { host: host(serverId), port: SIM_SERVER_PORT },
        tv: { host: host(serverId), port: SIM_TV_PORT, delaySeconds: tvDelaySeconds },
        ...(status && { playerCount: status.playerCount }),
      })
    },

    deallocate(serverId) {
      const entry = servers.get(serverId)
      if (!entry) return Promise.resolve()
      entry.server?.close()
      links.detach(ref(serverId))
      servers.delete(serverId)
      return Promise.resolve()
    },

    list(): Promise<ProvisionedServer[]> {
      return Promise.resolve(
        [...servers.values()].map(entry => ({
          serverId: entry.serverId,
          matchId: entry.matchId,
          fleetServerId: entry.fleetServerId,
        })),
      )
    },

    announce(serverId, line) {
      const server = servers.get(serverId)?.server
      return server ? server.announce(line) : Promise.resolve(false)
    },

    // A simulated server has no RCON and no console backlog of its own.
    rcon: () => Promise.resolve(null),
    console: () => Promise.resolve(null),

    /**
     * Put a round backup on a configured, not yet started server: the story
     * becomes a boot, the reconnects, `backup_restored` and the match from
     * that round on (T14's recovery, offline). `false` when there is nothing
     * to restore onto; a backup the story never wrote throws
     * (`SimulatorRestoreError`), because asking for a round that does not
     * exist is a bug in the caller, not a provider that cannot oblige.
     */
    restore(serverId, backup) {
      const server = servers.get(serverId)?.server
      if (!server) return Promise.resolve(false)
      server.restore({ mapNumber: backup.mapNumber, roundNumber: backup.roundNumber })
      return Promise.resolve(true)
    },

    sim(serverId): SimStatus | null {
      return servers.get(serverId)?.server?.status().sim ?? null
    },

    engine: serverId => servers.get(serverId)?.server ?? null,
    size: () => servers.size,
    pending: () => ingesting.size,
    setFaults: next => {
      faults = { ...next }
    },
    faults: () => ({ ...faults }),
    async settle() {
      while (ingesting.size > 0) await Promise.allSettled([...ingesting])
    },
  }
}
