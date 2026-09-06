/**
 * **Which deployment this process is** (PRD-02 T21c).
 *
 * Provider truth is per-deployment: the Dathost `user_data` tag says which
 * clones on a shared account are ours, a `sim` server lives in the process
 * that made it, a node dials exactly one orchestrator. So a row another
 * deployment opened is one this process cannot judge, and the three things a
 * process does on its own initiative all used to read the whole database and
 * act on what they found:
 *
 * - the **reaper** finds no server behind a neighbour's ledger row, calls it
 *   lost and ends that match `provider_error: server lost before going live`;
 * - the boot's **`resume()`** re-arms a neighbour's open matches and restarts
 *   the walks it believes died with a process — two machines on one row, and a
 *   second server allocated for a match that already has one;
 * - the **webhook worker** POSTs a neighbour's due deliveries and races it for
 *   the row.
 *
 * So every match (`matches.deployment`) and every ledger row
 * (`servers.deployment`) carries the name of the deployment that wrote it, and
 * those three reads — and the fleet's "what is running" — ask only for their
 * own. Read-only history is not narrowed: a month's spend and a key's matches
 * belong to the key, not to the process.
 *
 * `EZPUG_IRON_DEPLOYMENT` sets it. A single deployment never needs to: the
 * default is one name for everybody, which is correct exactly as long as
 * there is one. Two worlds that share a database or a Dathost account — dev
 * beside production, two Vitest suites on one test database — each need
 * their own.
 *
 * It lives in its own file, imported by both the schema and the config,
 * because a value exported from `db/schema/*` would land in the barrel that
 * `additive-safe.test.ts` reads as "every table".
 */
export const DEFAULT_DEPLOYMENT = 'ezpug'
