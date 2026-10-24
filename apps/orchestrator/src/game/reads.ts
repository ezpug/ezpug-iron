import type { FleetGame, GameCanary, ProviderGame } from '@ezpug/match-api'
import { GAME_FACTS_RECENT_MAX } from '@ezpug/match-api'
import type { ProviderRegistry } from '../providers/registry'
import { GAME_PINS, GAME_UPSTREAMS, type GameUpstreamSource } from './pins'
import type { GameStore } from './store'

/**
 * **What a client reads of the game** (PRD-10 T2): the `game` block on
 * every `ProviderHealth`, and `GET /v1/fleet/game`. Both are reads of what
 * the watcher keeps in the store — nothing here calls Steam or GitHub on a
 * request, and a deployment whose watcher has not ticked yet reads the
 * honest nothing: no build, both canaries `unproven` with no build named.
 */
export interface GameReads {
  /** One provider's picture; the unknown picture for a provider the watcher has not written yet. */
  provider: (id: string) => Promise<ProviderGame>
  fleet: () => Promise<FleetGame>
}

export interface GameReadsOptions {
  store: GameStore
  registry: ProviderRegistry
  pins?: Readonly<Record<string, string>>
  upstreams?: readonly GameUpstreamSource[]
}

const UNPROVEN: GameCanary = { state: 'unproven', build: null, since: null, reason: null }

/** What a provider reads before the watcher has written a word about it. */
export const UNKNOWN_PROVIDER_GAME: ProviderGame = {
  build: null,
  stack: null,
  canary: UNPROVEN,
  hud: UNPROVEN,
}

export function createGameReads(options: GameReadsOptions): GameReads {
  const { store, registry } = options
  const pins = options.pins ?? GAME_PINS
  const upstreams = options.upstreams ?? GAME_UPSTREAMS

  const providerGame = async (id: string): Promise<ProviderGame> => {
    const state = (await store.listProviderStates()).find(row => row.provider === id)
    if (!state) return UNKNOWN_PROVIDER_GAME
    return {
      build:
        state.build === null || state.buildSince === null
          ? null
          : { id: state.build, since: state.buildSince.toISOString() },
      stack: state.stack,
      canary: state.canary,
      hud: state.hud,
    }
  }

  return {
    provider: providerGame,
    async fleet() {
      const [latest, states, recent, released] = await Promise.all([
        store.latestBuild(),
        store.listProviderStates(),
        store.listFacts(GAME_FACTS_RECENT_MAX),
        store.listFacts(500, 'game.upstream_released'),
      ])
      const stateOf = (id: string): ProviderGame => {
        const state = states.find(row => row.provider === id)
        if (!state) return UNKNOWN_PROVIDER_GAME
        return {
          build:
            state.build === null || state.buildSince === null
              ? null
              : { id: state.build, since: state.buildSince.toISOString() },
          stack: state.stack,
          canary: state.canary,
          hud: state.hud,
        }
      }
      return {
        build: latest
          ? {
              id: latest.build,
              since: latest.observedAt.toISOString(),
              steamBuildId: latest.steamBuildId,
              sourceRevision: latest.sourceRevision,
            }
          : null,
        upstream: upstreams.map(source => {
          const newest = released.find(
            row => row.fact.type === 'game.upstream_released' && row.fact.repo === source.repo,
          )?.fact
          return {
            repo: source.repo,
            pinned: pins[source.pin] ?? 'unknown',
            latest: newest?.type === 'game.upstream_released' ? newest.version : null,
            publishedAt: newest?.type === 'game.upstream_released' ? newest.publishedAt : null,
          }
        }),
        providers: registry
          .all()
          .map(provider => ({ id: provider.id, game: stateOf(provider.id) })),
        recent: recent.map(row => row.fact),
      }
    },
  }
}
