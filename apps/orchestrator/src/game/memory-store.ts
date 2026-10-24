import type { GameBuildRow, GameFactRow, GameProviderStateRow, GameStore } from './store'

/**
 * The in-memory {@link GameStore}: what the watcher's tests and the test app
 * run on. Rows are copied on the way in and out, as the match store does,
 * so a test cannot edit the store's truth by accident.
 */
export function createMemoryGameStore(): GameStore & {
  readonly rows: {
    facts: GameFactRow[]
    builds: GameBuildRow[]
    providers: GameProviderStateRow[]
  }
} {
  const facts: GameFactRow[] = []
  const builds: GameBuildRow[] = []
  const providers: GameProviderStateRow[] = []

  const copyFact = (row: GameFactRow): GameFactRow => ({
    ...row,
    at: new Date(row.at),
    fact: structuredClone(row.fact),
  })
  const copyBuild = (row: GameBuildRow): GameBuildRow => ({
    ...row,
    observedAt: new Date(row.observedAt),
  })
  const copyState = (row: GameProviderStateRow): GameProviderStateRow => ({
    ...row,
    buildSince: row.buildSince ? new Date(row.buildSince) : null,
    updatedAt: new Date(row.updatedAt),
    canary: { ...row.canary },
    hud: { ...row.hud },
  })

  return {
    rows: { facts, builds, providers },
    appendFact: row => {
      facts.push(copyFact(row))
      return Promise.resolve()
    },
    listFacts: (limit, type) =>
      Promise.resolve(
        [...facts]
          .filter(row => type === undefined || row.fact.type === type)
          .sort((a, b) => b.at.getTime() - a.at.getTime() || facts.indexOf(b) - facts.indexOf(a))
          .slice(0, limit)
          .map(copyFact),
      ),
    // Newest by `observedAt`; two builds seen in the same instant (a fake
    // clock's tick) resolve to the one written last, as a sequence would.
    latestBuild: () =>
      Promise.resolve(
        [...builds]
          .sort(
            (a, b) =>
              b.observedAt.getTime() - a.observedAt.getTime() ||
              builds.indexOf(b) - builds.indexOf(a),
          )
          .map(copyBuild)[0],
      ),
    findBuild: build => {
      const row = builds.find(candidate => candidate.build === build)
      return Promise.resolve(row ? copyBuild(row) : undefined)
    },
    insertBuild: row => {
      if (!builds.some(candidate => candidate.build === row.build)) builds.push(copyBuild(row))
      return Promise.resolve()
    },
    updateBuild: (build, patch) => {
      const row = builds.find(candidate => candidate.build === build)
      if (row) Object.assign(row, patch)
      return Promise.resolve()
    },
    listProviderStates: () =>
      Promise.resolve(
        [...providers].sort((a, b) => a.provider.localeCompare(b.provider)).map(copyState),
      ),
    upsertProviderState: row => {
      const index = providers.findIndex(candidate => candidate.provider === row.provider)
      if (index === -1) providers.push(copyState(row))
      else providers[index] = copyState(row)
      return Promise.resolve()
    },
  }
}
