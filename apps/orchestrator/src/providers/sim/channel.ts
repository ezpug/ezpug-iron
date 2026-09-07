import type { GameserverPlayer, MatchCommand, SimStatus } from '@ezpug/match-api'
import { SIM_PROVIDER_ID, type SimulatedServer } from '@ezpug/sim'
import type {
  ChannelCommandResult,
  ServerChannel,
  ServerEventSink,
  ServerRef,
} from '../../link/channels'

/**
 * **A simulated server's end of the link.** What a real plugin does when a
 * command arrives — pause the match and report `match_paused`, kick a player
 * and report `player_disconnected`, print a line — the engine does here, and
 * reports through the same sink, so the machine sees a server answering a
 * command exactly as it would over a socket. What a scripted story cannot
 * do (`restart_round`, `reroll`) and what a sim has not got (`rcon`) is
 * `command_unsupported`.
 *
 * On top of that this channel takes the **`sim.*` family** (PRD-02 T4,
 * decision 9) — the knobs that exist only because the server is simulated:
 * deal one beat (`sim.step`), switch between playing on the clock and
 * stepping by hand (`sim.mode`), compress time (`sim.speed`), make the box
 * flaky (`sim.chaos`) and pull its plug (`sim.kill`). Each answers with the
 * simulator's state after it, exactly as the published fake does, so a client
 * that drives the fake drives the real service unchanged. The machine refuses
 * the family for any other provider long before it reaches a channel.
 */
export interface SimChannelOptions {
  server: ServerRef
  engine: SimulatedServer
  matchId: string
  sink: ServerEventSink
  /** Who is on the server, kept by the provider from the engine's own events. */
  presence: ReadonlyMap<string, GameserverPlayer>
  currentMap: () => number
}

export function createSimChannel(options: SimChannelOptions): ServerChannel {
  const { engine, matchId, sink, presence } = options
  const source = { provider: SIM_PROVIDER_ID, serverId: options.server.serverId }
  const rejected = (code: ChannelCommandResult['code'], message: string): ChannelCommandResult => ({
    status: 'rejected',
    code,
    message,
  })
  const applied: ChannelCommandResult = { status: 'applied' }
  /** What the simulator says about itself right now — every `sim.*` answer carries it. */
  const simStatus = (): SimStatus | undefined => engine.status().sim ?? undefined
  // Reported, never awaited: the command that caused the event is still
  // holding the match's chain, and the event queues right behind it.
  const say = (event: Parameters<ServerEventSink['ingest']>[1]): void => {
    void sink.ingest(source, event).catch(() => undefined)
  }

  return {
    server: options.server,
    async playerCommand(tap) {
      // The engine's stand-in mode enforces the manifest (T24); the
      // `plugin_event` an applied tap leaves is reported through the sink
      // like every other beat, in order.
      const { result } = await engine.playerCommand({
        steamId64: tap.steamId64,
        command: tap.command,
        ...(tap.args && { args: tap.args }),
      })
      return {
        correlationId: tap.correlationId,
        steamId64: tap.steamId64,
        command: tap.command,
        ...result,
      }
    },
    async send(command: MatchCommand): Promise<ChannelCommandResult> {
      switch (command.type) {
        case 'pause':
          engine.stop()
          say({
            type: 'match_paused',
            matchId,
            source,
            mapNumber: options.currentMap(),
            kind: command.kind ?? 'admin',
            pausedBy: 'admin',
          })
          return applied
        case 'unpause':
          engine.start()
          say({ type: 'match_unpaused', matchId, source, mapNumber: options.currentMap() })
          return applied
        case 'announce':
          return (await engine.announce(command.text))
            ? applied
            : rejected('invalid_state', 'the server is not playing')
        case 'kick': {
          const player = presence.get(command.steamId64)
          if (!player)
            return rejected('player_not_in_match', `${command.steamId64} is not on the server`)
          say({ type: 'player_disconnected', matchId, source, player })
          return applied
        }
        case 'profile':
          // A simulated server has nothing to dress; the machine keeps the roster.
          return applied
        case 'restart_round':
        case 'reroll':
          return rejected('command_unsupported', 'a simulated server plays a scripted story')
        case 'rcon':
          return rejected('command_unsupported', 'a simulated server has no RCON')
        case 'sim.step': {
          // Only in step mode: on the clock the story deals itself, and a
          // beat dealt by hand beside it would break the order it promises.
          if (engine.mode() !== 'step') return rejected('invalid_state', 'sim.step needs step mode')
          const event = await engine.step()
          return { ...applied, stepped: event?.type ?? null, sim: simStatus() }
        }
        case 'sim.mode':
          engine.setMode(command.mode)
          return { ...applied, sim: simStatus() }
        case 'sim.speed':
          engine.setSpeed(command.timeScale)
          return { ...applied, sim: simStatus() }
        case 'sim.chaos':
          engine.setChaos(command.chaos)
          return { ...applied, sim: simStatus() }
        case 'sim.kill':
          // The box dies where it stands: status answers `gone`, heartbeats
          // stop, and the machine's loss detector opens the recovery window
          // from its own clock — nothing here tells it, exactly as a real
          // server that lost power tells nobody.
          engine.kill()
          return { ...applied, sim: simStatus() }
        default:
          return rejected('command_unsupported', `the server does not take ${command.type}`)
      }
    },
    announce: line => engine.announce(line),
  }
}
