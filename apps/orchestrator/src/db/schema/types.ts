/**
 * The JSON column shapes the schema names, re-exported from the contracts so
 * a row's typed column and the wire shape it is read into are one type. Kept
 * out of the table files so the schema module stays importable by
 * `drizzle-kit` without pulling the whole contract graph.
 */
export type { FleetServerAddress, ServerTv } from '@ezpug/match-api'
export type { ServerVersions } from '@ezpug/protocol'
