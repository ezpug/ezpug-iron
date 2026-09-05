import { z } from 'zod'

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

export interface OrchestratorConfig {
  /** The orchestrator's own public origin — `baseUrl` for clients, webhook and token audience. */
  readonly baseUrl: string
  readonly host: string
  readonly port: number
  /** `NODE_ENV === 'production'`: refuses dev-only doors. */
  readonly production: boolean
  /** The providers to register, in `EZPUG_IRON_PROVIDERS` order (T3/T4 register them). */
  readonly providers: readonly string[]
  readonly database: DatabaseConfig
  readonly redis: RedisConfig
  readonly rateLimit: RateLimitConfig
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
 * Read + validate the connection settings for one database. `target: 'test'`
 * reads {@link TEST_DATABASE_URL_VAR} instead of {@link DATABASE_URL_VAR} —
 * the only difference between the two paths.
 */
export function readDatabaseConfig(
  env: EnvRecord,
  options: { target?: DatabaseTarget } = {},
): DatabaseConfig {
  const source = options.target === 'test' ? TEST_DATABASE_URL_VAR : DATABASE_URL_VAR
  const parsed = z
    .object({
      url: postgresUrl,
      poolMax: numberFromEnv(10),
      idleTimeoutSeconds: numberFromEnv(30),
      connectTimeoutSeconds: numberFromEnv(10),
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

/** Read the whole configuration; throws with every problem named. */
export function readOrchestratorConfig(env: EnvRecord): OrchestratorConfig {
  const parsed = z
    .object({
      baseUrl: z.url(),
      host: z.string().min(1),
      port: numberFromEnv(DEFAULT_PORT),
      providers: z.string().transform(value =>
        value
          .split(',')
          .map(name => name.trim())
          .filter(name => name.length > 0),
      ),
      rateLimitBurst: numberFromEnv(120),
      rateLimitPerSecond: numberFromEnv(10),
    })
    .safeParse({
      baseUrl: env.EZPUG_IRON_BASE_URL ?? `http://localhost:${env.EZPUG_IRON_PORT ?? DEFAULT_PORT}`,
      host: env.EZPUG_IRON_HOST ?? '127.0.0.1',
      port: env.EZPUG_IRON_PORT,
      providers: env.EZPUG_IRON_PROVIDERS ?? 'sim',
      rateLimitBurst: env.EZPUG_IRON_RATE_LIMIT_BURST,
      rateLimitPerSecond: env.EZPUG_IRON_RATE_LIMIT_PER_SECOND,
    })
  if (!parsed.success)
    fail(parsed.error.issues, {
      baseUrl: 'EZPUG_IRON_BASE_URL',
      host: 'EZPUG_IRON_HOST',
      port: 'EZPUG_IRON_PORT',
      providers: 'EZPUG_IRON_PROVIDERS',
      rateLimitBurst: 'EZPUG_IRON_RATE_LIMIT_BURST',
      rateLimitPerSecond: 'EZPUG_IRON_RATE_LIMIT_PER_SECOND',
    })
  const { rateLimitBurst, rateLimitPerSecond, ...rest } = parsed.data
  return {
    ...rest,
    baseUrl: rest.baseUrl.replace(/\/+$/, ''),
    production: env.NODE_ENV === 'production',
    database: readDatabaseConfig(env),
    redis: readRedisConfig(env),
    rateLimit: { burst: rateLimitBurst, perSecond: rateLimitPerSecond },
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
