import type { GameserverPlayer, MatchCommand } from '@ezpug/match-api'
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
 * `command_unsupported`; the `sim.*` family is T4's.
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
  // Reported, never awaited: the command that caused the event is still
  // holding the match's chain, and the event queues right behind it.
  const say = (event: Parameters<ServerEventSink['ingest']>[1]): void => {
    void sink.ingest(source, event).catch(() => undefined)
  }

  return {
    server: options.server,
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
        case 'sim.step':
        case 'sim.mode':
        case 'sim.speed':
        case 'sim.chaos':
        case 'sim.kill':
          return rejected('command_unsupported', 'the sim.* commands arrive with PRD-02 T4')
        default:
          return rejected('command_unsupported', `the server does not take ${command.type}`)
      }
    },
    announce: line => engine.announce(line),
  }
}
