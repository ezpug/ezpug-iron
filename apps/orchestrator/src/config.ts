import { z } from 'zod'
import { DEFAULT_DEPLOYMENT } from './deployment'
import { DATHOST_DEFAULT_LOCATION } from './providers/dathost/provider'
import { looksLikeToken } from './tokens'

/**
 * **The orchestrator's configuration, read from the environment and
 * validated once.** Every name is `EZPUG_IRON_*` (`.env.example` says why:
 * the platform runs on the same box with `EZPUG_*` names of its own) and
 * every value has a documented home there. This module reads a plain env
 * record, never `process.env` directly, so a test hands it a literal.
 */

/** Env record shape — `process.env` satisfies it. */
export type EnvRecord = Readonly<Record<string, string | undefined>>

/** Which of the two databases a process talks to. */
export type DatabaseTarget = 'app' | 'test'

export const DATABASE_URL_VAR = 'EZPUG_IRON_DATABASE_URL'
export const TEST_DATABASE_URL_VAR = 'EZPUG_IRON_TEST_DATABASE_URL'
export const REDIS_URL_VAR = 'EZPUG_IRON_REDIS_URL'

/**
 * Where the migration SQL is, when it is not beside the source. The image
 * puts it at `/app/drizzle` and says so with this, because a bundle at
 * `/app/dist/` cannot find the folder by walking up from itself
 * (`db/migrate.ts`).
 */
export const MIGRATIONS_DIR_VAR = 'EZPUG_IRON_MIGRATIONS_DIR'

/**
 * The dev-only bootstrap key (PRD-02 T4): a key with this exact secret is
 * ensured at boot, so another project's compose can hand the orchestrator a
 * key it already knows instead of running a mint step. **Refused under
 * `NODE_ENV=production`** — a key nobody minted is a key nobody can rotate.
 */
export const BOOTSTRAP_API_KEY_VAR = 'EZPUG_IRON_BOOTSTRAP_API_KEY'

/**
 * The dev-only trace file (PRD-02 T13): when set, every `/link` and `/node`
 * frame and every MatchZy payload is appended to it as scrubbed NDJSON, for
 * `scripts/iron-match.mjs` to turn into fixtures. **Refused under
 * `NODE_ENV=production`** — a production orchestrator does not write the
 * servers' conversations to disk.
 */
export const TRACE_FILE_VAR = 'EZPUG_IRON_TRACE_FILE'

/**
 * What a node runs when nothing says otherwise: the local dev build
 * `pnpm cs2:build` writes. A deployment sets
 * `EZPUG_IRON_NODE_SERVER_IMAGE` to a published, digest-pinned tag.
 */
export const DEFAULT_NODE_SERVER_IMAGE = 'ghcr.io/ezpug/ezpug-iron/cs2:dev'

/**
 * The dev-only fake Steam (PRD-02 T17): the pool mints its login tokens
 * against the in-process fake instead of Valve, so a developer's box has a
 * working pool without a partner key. **Refused under `NODE_ENV=production`.**
 */
export const STEAM_FAKE_TOKENS_VAR = 'EZPUG_IRON_STEAM_FAKE_TOKENS'

/** How many Steam game server accounts a deployment holds unless it says otherwise. */
export const DEFAULT_GSLT_POOL_MAX = 16

/** The dev port, decided in `.env.example` against `ss -tlnp` on this box. */
export const DEFAULT_PORT = 3430

export interface DatabaseConfig {
  /** postgres:// connection string. */
  readonly url: string
  /** Which env var it came from — quoted in connection errors. */
  readonly source: string
  /** Pool size. One process, one pool. */
  readonly poolMax: number
  /** Seconds an idle pooled connection is kept before it is closed. */
  readonly idleTimeoutSeconds: number
  /** Seconds to wait for a connection before giving up. */
  readonly connectTimeoutSeconds: number
  /** Server-side statement timeout; a runaway query never wedges the pool. */
  readonly statementTimeoutMs: number
  /** Log every statement (dev noise, off by default). */
  readonly logQueries: boolean
}

export interface RedisConfig {
  readonly url: string
  readonly source: string
}

/**
 * The per-key rate limit (`docs/match-api.md` `rate_limited`): a token
 * bucket per API key, `burst` deep, refilled at `perSecond`. Per process —
 * a second replica would double it, which is fine for a ceiling that exists
 * to stop a runaway client, not to meter one.
 */
export interface RateLimitConfig {
  readonly burst: number
  readonly perSecond: number
}

/**
 * **The Dathost account** (PRD-02 T16): the Basic-auth pair, the template
 * server every match is cloned from, and where clones are created. The
 * provider is registered *iff* all three secrets are present — a build
 * without them still runs on `sim` and `nodes`, which is what a developer's
 * box and a credential-less deploy get (T35).
 *
 * The names are `EZPUG_IRON_DATHOST_*` like everything else this process
 * reads (`.env.example`); the PRD's unprefixed `EZPUG_DATHOST_*` are
 * accepted as aliases, because that is what an operator who read the PRD
 * types. Neither is ever logged: the password and the email are the account.
 */
export interface DathostConfig {
  readonly email: string
  readonly password: string
  /** `EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID` — `scripts/dathost-image.mjs` prints it. */
  readonly templateServerId: string
  /** Frankfurt is `dusseldorf` (`references/dathost.md`). */
  readonly location: string
}

/**
 * **The GSLT pool** (PRD-02 T17). A CS2 server without a Steam Game Server
 * Login Token accepts LAN connections only, so a rented server needs one and
 * a node at a venue does not. `STEAM_WEB_API_KEY` (the name the PRD and
 * every Steam document use; `EZPUG_IRON_STEAM_WEB_API_KEY` is the prefixed
 * alias) is what mints them.
 *
 * Without a key the pool leases whatever accounts the table already holds
 * and mints nothing, which is the honest state of a developer's box —
 * `EZPUG_IRON_STEAM_FAKE_TOKENS` gives that box a working pool against the
 * in-process fake Steam instead, and is refused under `NODE_ENV=production`
 * for the same reason the bootstrap key is: a token nobody at Valve minted
 * would let a server boot believing it can be joined.
 */
export interface GsltConfig {
  /** `STEAM_WEB_API_KEY`, or null. Never logged, never in an answer. */
  readonly steamApiKey: string | null
  /** Mint against the in-process fake Steam. Dev only. */
  readonly fakeSteam: boolean
  /** How many Steam accounts this deployment will hold (`EZPUG_IRON_GSLT_POOL_MAX`). */
  readonly poolMax: number
}

export interface OrchestratorConfig {
  /** The orchestrator's own public origin — `baseUrl` for clients, webhook and token audience. */
  readonly baseUrl: string
  readonly host: string
  readonly port: number
  /** `NODE_ENV === 'production'`: refuses dev-only doors. */
  readonly production: boolean
  /**
   * **Which deployment this process is** (T21c, `EZPUG_IRON_DEPLOYMENT`,
   * default {@link DEFAULT_DEPLOYMENT}). It is stamped on every ledger row
   * and it is the Dathost `user_data` tag, so both halves of "these servers
   * are ours" are one setting: the reaper acts only on rows carrying this
   * name, and the provider claims only clones carrying it. Two deployments
   * sharing a database or a Dathost account — dev beside production, two
   * test suites on one test database — must not reap each other.
   */
  readonly deployment: string
  /** The providers to register, in `EZPUG_IRON_PROVIDERS` order (T3/T4/T12 register them). */
  readonly providers: readonly string[]
  /**
   * The CS2 server image a node runs (T12). Pin it by digest in production:
   * this is the one string that decides which build a venue's hardware
   * plays on, and `docs/pins.md` is where the tag lives.
   */
  readonly nodeServerImage: string
  /**
   * The secret of the dev bootstrap key, or null. Never logged, never in an
   * answer: `main.ts` hands it to `ensureBootstrapKey` and forgets it.
   */
  readonly bootstrapApiKey: string | null
  /**
   * Where the dev trace is written, or null ({@link TRACE_FILE_VAR}). Only
   * `scripts/iron-match.mjs` sets it.
   */
  readonly traceFile: string | null
  /** Apply pending migrations before the port opens — what the image does. */
  readonly migrateOnBoot: boolean
  /** Where the migration SQL lives, when it is not beside the code (the image). */
  readonly migrationsDir: string | null
  /**
   * Where the gamemodes' built widgets are (T25): `<dir>/<id>/dist/widget.js`
   * per `sdk` mode, `EZPUG_IRON_GAMEMODES_DIR`. `null` means "find the
   * workspace's `gamemodes/` through `@ezpug/gamemodes`", the dev box's
   * answer; the image sets the directory it copied the bundles into.
   */
  readonly gamemodesDir: string | null
  readonly database: DatabaseConfig
  readonly redis: RedisConfig
  readonly rateLimit: RateLimitConfig
  /** The Dathost account, or `null` when this deployment has no credentials. */
  readonly dathost: DathostConfig | null
  /** The GSLT pool's Steam door and ceiling (T17). */
  readonly gslt: GsltConfig
}

function numberFromEnv(fallback: number) {
  return z.preprocess(
    value => (value === undefined || value === '' ? fallback : Number(value)),
    z.number().int().positive(),
  )
}

function booleanFromEnv(fallback: boolean) {
  return z.preprocess(
    value =>
      value === undefined || value === ''
        ? fallback
        : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()),
    z.boolean(),
  )
}

const urlWithProtocol = (protocols: readonly string[], what: string) =>
  z
    .string()
    .min(1)
    .refine(value => {
      try {
        return protocols.includes(new URL(value).protocol)
      } catch {
        return false
      }
    }, `must be a ${what}`)

const postgresUrl = urlWithProtocol(['postgres:', 'postgresql:'], 'postgres:// connection string')
const redisUrl = urlWithProtocol(['redis:', 'rediss:'], 'redis:// connection string')

function fail(issues: z.core.$ZodIssue[], names: Record<string, string>): never {
  const lines = issues
    .map(issue => `${names[String(issue.path[0])] ?? String(issue.path[0])}: ${issue.message}`)
    .join('; ')
  throw new Error(`invalid orchestrator configuration (${lines})`)
}

/**
 * Pool defaults per target. The test database is reached by **many processes
 * at once** — Vitest gives every test file its own worker, and a cold
 * `pnpm verify` runs the whole workspace in parallel — so its defaults are
 * sized for a crowd, not for a server (PRD-02 T37c):
 *
 * - `poolMax` **5**: one worker's suite runs its tests one at a time, and
 *   `workers × poolMax` is what meets Postgres's `max_connections` (100 on
 *   the compose image). Twelve workers at 10 apiece overruns it and the
 *   loser gets `53300 sorry, too many clients already` on the connection its
 *   next transaction opens — measured, this box peaks at 18, so this is
 *   headroom being kept rather than a ceiling being escaped.
 * - `connectTimeoutSeconds` **5**: the test database is on the same box, so
 *   five seconds of silence is already pathological. What survives a loaded
 *   box is redialling (`withTransientRetry` in `db/testing.ts`), not waiting
 *   longer — a shorter budget is what leaves room to retry inside a test's.
 *
 * Both are still the same env vars: an explicit setting wins for either
 * target.
 */
const DATABASE_DEFAULTS = {
  app: { poolMax: 10, connectTimeoutSeconds: 10 },
  test: { poolMax: 5, connectTimeoutSeconds: 5 },
} as const satisfies Record<DatabaseTarget, { poolMax: number; connectTimeoutSeconds: number }>

/**
 * Read + validate the connection settings for one database. `target: 'test'`
 * reads {@link TEST_DATABASE_URL_VAR} instead of {@link DATABASE_URL_VAR},
 * and takes the crowd-sized pool defaults above.
 */
export function readDatabaseConfig(
  env: EnvRecord,
  options: { target?: DatabaseTarget } = {},
): DatabaseConfig {
  const target: DatabaseTarget = options.target ?? 'app'
  const source = target === 'test' ? TEST_DATABASE_URL_VAR : DATABASE_URL_VAR
  const defaults = DATABASE_DEFAULTS[target]
  const parsed = z
    .object({
      url: postgresUrl,
      poolMax: numberFromEnv(defaults.poolMax),
      idleTimeoutSeconds: numberFromEnv(30),
      connectTimeoutSeconds: numberFromEnv(defaults.connectTimeoutSeconds),
      statementTimeoutMs: numberFromEnv(15_000),
      logQueries: booleanFromEnv(false),
    })
    .safeParse({
      url: env[source],
      poolMax: env.EZPUG_IRON_DATABASE_POOL_MAX,
      idleTimeoutSeconds: env.EZPUG_IRON_DATABASE_IDLE_TIMEOUT,
      connectTimeoutSeconds: env.EZPUG_IRON_DATABASE_CONNECT_TIMEOUT,
      statementTimeoutMs: env.EZPUG_IRON_DATABASE_STATEMENT_TIMEOUT,
      logQueries: env.EZPUG_IRON_DATABASE_LOG,
    })
  if (!parsed.success) fail(parsed.error.issues, { url: source })
  return { ...parsed.data, source }
}

export function readRedisConfig(env: EnvRecord): RedisConfig {
  const parsed = redisUrl.safeParse(env[REDIS_URL_VAR])
  if (!parsed.success) fail(parsed.error.issues, { '': REDIS_URL_VAR, undefined: REDIS_URL_VAR })
  return { url: parsed.data, source: REDIS_URL_VAR }
}

/**
 * The Dathost trio, or `null`. All three or none: half a credential set is a
 * deployment mistake that would otherwise only surface when the first match
 * looked for capacity, so it fails at boot with the names it wants.
 */
export function readDathostConfig(env: EnvRecord): DathostConfig | null {
  const email = env.EZPUG_IRON_DATHOST_EMAIL ?? env.EZPUG_DATHOST_EMAIL ?? ''
  const password = env.EZPUG_IRON_DATHOST_PASSWORD ?? env.EZPUG_DATHOST_PASSWORD ?? ''
  const templateServerId =
    env.EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID ?? env.EZPUG_DATHOST_TEMPLATE_SERVER_ID ?? ''
  const location =
    env.EZPUG_IRON_DATHOST_LOCATION ?? env.EZPUG_DATHOST_LOCATION ?? DATHOST_DEFAULT_LOCATION
  const given = [
    ['EZPUG_IRON_DATHOST_EMAIL', email],
    ['EZPUG_IRON_DATHOST_PASSWORD', password],
    ['EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID', templateServerId],
  ] as const
  const missing = given.filter(([, value]) => value.trim() === '').map(([name]) => name)
  if (missing.length === given.length) return null
  if (missing.length > 0)
    throw new Error(
      `invalid orchestrator configuration (Dathost is half-configured: ${missing.join(', ')} ` +
        'missing; set all three or none)',
    )
  return {
    email: email.trim(),
    password,
    templateServerId: templateServerId.trim(),
    location: location.trim() || DATHOST_DEFAULT_LOCATION,
  }
}

/**
 * The Steam key, the dev fake and the pool's ceiling. A key and the fake
 * together are a configuration mistake worth refusing: one of them is being
 * ignored and the operator does not know which.
 */
export function readGsltConfig(env: EnvRecord, production: boolean): GsltConfig {
  const steamApiKey =
    (env.EZPUG_IRON_STEAM_WEB_API_KEY ?? env.STEAM_WEB_API_KEY ?? '').trim() || null
  const parsed = z
    .object({
      fakeSteam: booleanFromEnv(false),
      poolMax: numberFromEnv(DEFAULT_GSLT_POOL_MAX),
    })
    .safeParse({
      fakeSteam: env[STEAM_FAKE_TOKENS_VAR],
      poolMax: env.EZPUG_IRON_GSLT_POOL_MAX ?? env.EZPUG_GSLT_POOL_MAX,
    })
  if (!parsed.success)
    fail(parsed.error.issues, {
      fakeSteam: STEAM_FAKE_TOKENS_VAR,
      poolMax: 'EZPUG_IRON_GSLT_POOL_MAX',
    })
  if (parsed.data.fakeSteam && production)
    throw new Error(
      `invalid orchestrator configuration (${STEAM_FAKE_TOKENS_VAR}: refused under NODE_ENV=production — ` +
        'a token Valve never minted lets a server boot believing it can be joined; set STEAM_WEB_API_KEY)',
    )
  if (parsed.data.fakeSteam && steamApiKey !== null)
    throw new Error(
      `invalid orchestrator configuration (${STEAM_FAKE_TOKENS_VAR} is set beside STEAM_WEB_API_KEY: ` +
        'one of the two would be ignored; set exactly one)',
    )
  return { steamApiKey, ...parsed.data }
}

/** Read the whole configuration; throws with every problem named. */
export function readOrchestratorConfig(env: EnvRecord): OrchestratorConfig {
  const parsed = z
    .object({
      baseUrl: z.url(),
      host: z.string().min(1),
      port: numberFromEnv(DEFAULT_PORT),
      deployment: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, 'must be a lower-case name, e.g. `ezpug-prod`'),
      providers: z.string().transform(value =>
        value
          .split(',')
          .map(name => name.trim())
          .filter(name => name.length > 0),
      ),
      rateLimitBurst: numberFromEnv(120),
      rateLimitPerSecond: numberFromEnv(10),
      bootstrapApiKey: z
        .string()
        .nullable()
        .refine(
          value => value === null || looksLikeToken('apiKey', value),
          'must be an API key of this service’s own grammar (`ezik_` and 43 base64url characters)',
        ),
      traceFile: z.string().min(1).nullable(),
      migrateOnBoot: booleanFromEnv(false),
      migrationsDir: z.string().min(1).nullable(),
      gamemodesDir: z.string().min(1).nullable(),
      nodeServerImage: z.string().min(1).max(512),
    })
    .safeParse({
      // `EZPUG_IRON_PUBLIC_URL` is the name the dev contract other projects'
      // compose files use (docs/operations.md); `EZPUG_IRON_BASE_URL` is the
      // name this repo's own .env has always used. Same value, one wins.
      baseUrl:
        env.EZPUG_IRON_PUBLIC_URL ??
        env.EZPUG_IRON_BASE_URL ??
        `http://localhost:${env.EZPUG_IRON_PORT ?? DEFAULT_PORT}`,
      host: env.EZPUG_IRON_HOST ?? '127.0.0.1',
      port: env.EZPUG_IRON_PORT,
      deployment: env.EZPUG_IRON_DEPLOYMENT || DEFAULT_DEPLOYMENT,
      providers: env.EZPUG_IRON_PROVIDERS ?? 'sim',
      rateLimitBurst: env.EZPUG_IRON_RATE_LIMIT_BURST,
      rateLimitPerSecond: env.EZPUG_IRON_RATE_LIMIT_PER_SECOND,
      bootstrapApiKey: env[BOOTSTRAP_API_KEY_VAR] || null,
      traceFile: env[TRACE_FILE_VAR] || null,
      migrateOnBoot: env.EZPUG_IRON_MIGRATE_ON_BOOT,
      migrationsDir: env[MIGRATIONS_DIR_VAR] || null,
      gamemodesDir: env.EZPUG_IRON_GAMEMODES_DIR || null,
      nodeServerImage: env.EZPUG_IRON_NODE_SERVER_IMAGE || DEFAULT_NODE_SERVER_IMAGE,
    })
  if (!parsed.success)
    fail(parsed.error.issues, {
      baseUrl: env.EZPUG_IRON_PUBLIC_URL ? 'EZPUG_IRON_PUBLIC_URL' : 'EZPUG_IRON_BASE_URL',
      host: 'EZPUG_IRON_HOST',
      port: 'EZPUG_IRON_PORT',
      deployment: 'EZPUG_IRON_DEPLOYMENT',
      providers: 'EZPUG_IRON_PROVIDERS',
      rateLimitBurst: 'EZPUG_IRON_RATE_LIMIT_BURST',
      rateLimitPerSecond: 'EZPUG_IRON_RATE_LIMIT_PER_SECOND',
      bootstrapApiKey: BOOTSTRAP_API_KEY_VAR,
      traceFile: TRACE_FILE_VAR,
      migrateOnBoot: 'EZPUG_IRON_MIGRATE_ON_BOOT',
      migrationsDir: 'EZPUG_IRON_MIGRATIONS_DIR',
      gamemodesDir: 'EZPUG_IRON_GAMEMODES_DIR',
      nodeServerImage: 'EZPUG_IRON_NODE_SERVER_IMAGE',
    })
  const { rateLimitBurst, rateLimitPerSecond, ...rest } = parsed.data
  const production = env.NODE_ENV === 'production'
  // A key the environment carries in clear is a dev convenience and nothing
  // else; in production keys are minted, shown once and stored hashed.
  if (production && rest.bootstrapApiKey !== null)
    throw new Error(
      `invalid orchestrator configuration (${BOOTSTRAP_API_KEY_VAR}: refused under NODE_ENV=production — ` +
        'mint a key instead, or set NODE_ENV=development if this is a dev world; the image defaults to production)',
    )
  if (production && rest.traceFile !== null)
    throw new Error(
      `invalid orchestrator configuration (${TRACE_FILE_VAR}: refused under NODE_ENV=production — ` +
        'the trace is a recording of every link frame and belongs on a developer’s box only)',
    )
  return {
    ...rest,
    baseUrl: rest.baseUrl.replace(/\/+$/, ''),
    production,
    database: readDatabaseConfig(env),
    redis: readRedisConfig(env),
    rateLimit: { burst: rateLimitBurst, perSecond: rateLimitPerSecond },
    dathost: readDathostConfig(env),
    gslt: readGsltConfig(env, production),
  }
}

/** Connection string with the password masked — safe for logs and errors. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return '<unparseable url>'
  }
}
