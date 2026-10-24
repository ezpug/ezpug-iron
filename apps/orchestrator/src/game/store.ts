import type { GameCanary, GameFact, GameFactType } from '@ezpug/match-api'

/**
 * **What the build watcher needs from storage** (PRD-10 T2), and nothing
 * more — the same posture as the match store: a Postgres implementation
 * over the three `game_*` tables and a memory one, held to each other by
 * `store.contract.test.ts`, so the watcher is proven on a fake clock with
 * no database and the store against one.
 *
 * Facts are **append-only**: nothing here updates or deletes one. A build
 * row is written once and only its issue columns ever move; a provider's
 * picture is one row, rewritten.
 */

export interface GameFactRow {
  id: string
  at: Date
  /** The build the fact is about, for the per-build reads; null where none applies. */
  build: string | null
  fact: GameFact
}

export interface GameBuildRow {
  build: string
  steamBuildId: string | null
  sourceRevision: string | null
  observedAt: Date
  issueNumber: number | null
  issueUrl: string | null
}

export interface GameProviderStateRow {
  provider: string
  build: string | null
  buildSince: Date | null
  stack: string | null
  canary: GameCanary
  hud: GameCanary
  updatedAt: Date
}

export interface GameStore {
  /** Write one fact. `id` is the writer's (determinism rule, `db/columns.ts`). */
  appendFact: (row: GameFactRow) => Promise<void>
  /** Newest first, at most `limit`; narrowed to one type when given. */
  listFacts: (limit: number, type?: GameFactType) => Promise<GameFactRow[]>
  /** The build seen last — by `observedAt`, newest. */
  latestBuild: () => Promise<GameBuildRow | undefined>
  findBuild: (build: string) => Promise<GameBuildRow | undefined>
  /** Write a build once; a second insert of the same build is a no-op. */
  insertBuild: (row: GameBuildRow) => Promise<void>
  /** Fill in what was learned later: the labels, or the issue once filed. */
  updateBuild: (
    build: string,
    patch: Partial<
      Pick<GameBuildRow, 'steamBuildId' | 'sourceRevision' | 'issueNumber' | 'issueUrl'>
    >,
  ) => Promise<void>
  /** Every provider's picture, in provider order. */
  listProviderStates: () => Promise<GameProviderStateRow[]>
  /** Insert or rewrite one provider's picture. */
  upsertProviderState: (row: GameProviderStateRow) => Promise<void>
}
