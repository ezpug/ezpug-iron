import { describe, expect, it } from 'vitest'
import {
  BOOTSTRAP_API_KEY_VAR,
  DATABASE_URL_VAR,
  DEFAULT_GSLT_POOL_MAX,
  REDIS_URL_VAR,
  readDatabaseConfig,
  readDathostConfig,
  readGsltConfig,
  readOrchestratorConfig,
  readRedisConfig,
  redactUrl,
  STEAM_FAKE_TOKENS_VAR,
  TEST_DATABASE_URL_VAR,
} from './config'
import { DEFAULT_DEPLOYMENT } from './deployment'

const env = {
  EZPUG_IRON_DATABASE_URL: 'postgres://ezpug_iron:secret@127.0.0.1:5443/ezpug_iron',
  EZPUG_IRON_TEST_DATABASE_URL: 'postgres://ezpug_iron:secret@127.0.0.1:5443/ezpug_iron_test',
  EZPUG_IRON_REDIS_URL: 'redis://127.0.0.1:6383',
}

describe('readOrchestratorConfig', () => {
  it('reads the dev defaults from the two URLs alone', () => {
    const config = readOrchestratorConfig(env)
    expect(config.port).toBe(3430)
    expect(config.host).toBe('127.0.0.1')
    expect(config.baseUrl).toBe('http://localhost:3430')
    expect(config.providers).toEqual(['sim'])
    expect(config.deployment).toBe(DEFAULT_DEPLOYMENT)
    expect(config.production).toBe(false)
    expect(config.rateLimit).toEqual({ burst: 120, perSecond: 10 })
    expect(config.database.source).toBe(DATABASE_URL_VAR)
    expect(config.redis.source).toBe(REDIS_URL_VAR)
  })

  it('honours every documented variable', () => {
    const config = readOrchestratorConfig({
      ...env,
      EZPUG_IRON_BASE_URL: 'https://gs.ezpug.com/',
      EZPUG_IRON_HOST: '0.0.0.0',
      EZPUG_IRON_PORT: '3431',
      EZPUG_IRON_PROVIDERS: 'dathost, nodes ,',
      EZPUG_IRON_DEPLOYMENT: 'ezpug-prod',
      EZPUG_IRON_RATE_LIMIT_BURST: '10',
      EZPUG_IRON_RATE_LIMIT_PER_SECOND: '1',
      EZPUG_IRON_DATABASE_POOL_MAX: '3',
      EZPUG_IRON_DATABASE_LOG: 'yes',
      NODE_ENV: 'production',
    })
    expect(config.baseUrl).toBe('https://gs.ezpug.com')
    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(3431)
    expect(config.providers).toEqual(['dathost', 'nodes'])
    expect(config.deployment).toBe('ezpug-prod')
    expect(config.rateLimit).toEqual({ burst: 10, perSecond: 1 })
    expect(config.database.poolMax).toBe(3)
    expect(config.database.logQueries).toBe(true)
    expect(config.production).toBe(true)
  })

  it('refuses a deployment name that is not one', () => {
    expect(() => readOrchestratorConfig({ ...env, EZPUG_IRON_DEPLOYMENT: 'EZPug Prod!' })).toThrow(
      /EZPUG_IRON_DEPLOYMENT/,
    )
  })

  it('takes the dev contract’s EZPUG_IRON_PUBLIC_URL over the repo’s own name', () => {
    const config = readOrchestratorConfig({
      ...env,
      EZPUG_IRON_PUBLIC_URL: 'http://orchestrator:3430/',
      EZPUG_IRON_BASE_URL: 'http://localhost:3430',
    })
    expect(config.baseUrl).toBe('http://orchestrator:3430')
    expect(() =>
      readOrchestratorConfig({ ...env, EZPUG_IRON_PUBLIC_URL: 'orchestrator 3430' }),
    ).toThrow(/EZPUG_IRON_PUBLIC_URL/)
  })

  it('reads the image’s knobs: migrate on boot, where the SQL is, the bootstrap key', () => {
    const config = readOrchestratorConfig({
      ...env,
      EZPUG_IRON_MIGRATE_ON_BOOT: 'true',
      EZPUG_IRON_MIGRATIONS_DIR: '/app/drizzle',
      [BOOTSTRAP_API_KEY_VAR]: `ezik_${'a'.repeat(43)}`,
    })
    expect(config.migrateOnBoot).toBe(true)
    expect(config.migrationsDir).toBe('/app/drizzle')
    expect(config.bootstrapApiKey).toBe(`ezik_${'a'.repeat(43)}`)
    const defaults = readOrchestratorConfig(env)
    expect(defaults.migrateOnBoot).toBe(false)
    expect(defaults.migrationsDir).toBeNull()
    expect(defaults.bootstrapApiKey).toBeNull()
  })

  it('refuses a bootstrap key that is not one of ours, and any of them in production', () => {
    expect(() => readOrchestratorConfig({ ...env, [BOOTSTRAP_API_KEY_VAR]: 'hunter2' })).toThrow(
      /EZPUG_IRON_BOOTSTRAP_API_KEY.*grammar/s,
    )
    expect(() =>
      readOrchestratorConfig({
        ...env,
        NODE_ENV: 'production',
        [BOOTSTRAP_API_KEY_VAR]: `ezik_${'a'.repeat(43)}`,
      }),
    ).toThrow(/EZPUG_IRON_BOOTSTRAP_API_KEY.*NODE_ENV=production/s)
  })

  it('names the variable that is wrong', () => {
    expect(() => readOrchestratorConfig({ ...env, EZPUG_IRON_PORT: 'eighty' })).toThrow(
      /EZPUG_IRON_PORT/,
    )
    expect(() => readOrchestratorConfig({ ...env, EZPUG_IRON_DATABASE_URL: 'mysql://x' })).toThrow(
      /EZPUG_IRON_DATABASE_URL.*postgres/,
    )
    expect(() => readOrchestratorConfig({ ...env, EZPUG_IRON_REDIS_URL: undefined })).toThrow(
      /EZPUG_IRON_REDIS_URL/,
    )
  })
})

describe('readDathostConfig', () => {
  const account = {
    EZPUG_IRON_DATHOST_EMAIL: 'ops@ezpug.invalid',
    EZPUG_IRON_DATHOST_PASSWORD: 'not-a-real-password',
    EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID: '000000000000000000000001',
  }

  it('is null when the account is not configured — sim and nodes still run', () => {
    expect(readDathostConfig(env)).toBeNull()
    expect(readOrchestratorConfig(env).dathost).toBeNull()
  })

  it('defaults the location to Frankfurt’s id', () => {
    expect(readDathostConfig({ ...env, ...account })).toEqual({
      email: 'ops@ezpug.invalid',
      password: 'not-a-real-password',
      templateServerId: '000000000000000000000001',
      location: 'dusseldorf',
    })
  })

  it('accepts the PRD’s unprefixed names as aliases', () => {
    expect(
      readDathostConfig({
        ...env,
        EZPUG_DATHOST_EMAIL: 'ops@ezpug.invalid',
        EZPUG_DATHOST_PASSWORD: 'not-a-real-password',
        EZPUG_DATHOST_TEMPLATE_SERVER_ID: 'abc',
        EZPUG_DATHOST_LOCATION: 'chicago',
      }),
    ).toMatchObject({ templateServerId: 'abc', location: 'chicago' })
  })

  it('refuses half a credential set, by name', () => {
    expect(() =>
      readDathostConfig({ ...env, EZPUG_IRON_DATHOST_EMAIL: account.EZPUG_IRON_DATHOST_EMAIL }),
    ).toThrow(/EZPUG_IRON_DATHOST_PASSWORD, EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID missing/)
  })
})

describe('readGsltConfig', () => {
  it('has no Steam door by default — a rented server would be LAN only', () => {
    expect(readGsltConfig(env, false)).toEqual({
      steamApiKey: null,
      fakeSteam: false,
      poolMax: DEFAULT_GSLT_POOL_MAX,
    })
    expect(readOrchestratorConfig(env).gslt.steamApiKey).toBeNull()
  })

  it('reads the key under either name, and the ceiling under either', () => {
    expect(readGsltConfig({ STEAM_WEB_API_KEY: ' a-key ' }, false)).toMatchObject({
      steamApiKey: 'a-key',
    })
    expect(
      readGsltConfig(
        { EZPUG_IRON_STEAM_WEB_API_KEY: 'prefixed', STEAM_WEB_API_KEY: 'plain' },
        false,
      ).steamApiKey,
    ).toBe('prefixed')
    expect(readGsltConfig({ EZPUG_GSLT_POOL_MAX: '4' }, false).poolMax).toBe(4)
    expect(readGsltConfig({ EZPUG_IRON_GSLT_POOL_MAX: '8' }, false).poolMax).toBe(8)
  })

  it('refuses the dev fake in production, and beside a real key anywhere', () => {
    expect(readGsltConfig({ [STEAM_FAKE_TOKENS_VAR]: 'true' }, false).fakeSteam).toBe(true)
    expect(() => readGsltConfig({ [STEAM_FAKE_TOKENS_VAR]: 'true' }, true)).toThrow(
      /refused under NODE_ENV=production/,
    )
    expect(() =>
      readGsltConfig({ [STEAM_FAKE_TOKENS_VAR]: 'true', STEAM_WEB_API_KEY: 'a-key' }, false),
    ).toThrow(/one of the two would be ignored/)
  })
})

describe('readDatabaseConfig', () => {
  it('reads the test database on demand', () => {
    expect(readDatabaseConfig(env, { target: 'test' })).toMatchObject({
      url: env.EZPUG_IRON_TEST_DATABASE_URL,
      source: TEST_DATABASE_URL_VAR,
      statementTimeoutMs: 15_000,
    })
  })

  // T37c: the test database is reached by a dozen Vitest workers at once and
  // the app's by one process, so they cannot share a pool default —
  // `workers x poolMax` is what meets `max_connections`.
  it('sizes the test pool for a crowd and the app pool for a server', () => {
    expect(readDatabaseConfig(env)).toMatchObject({ poolMax: 10, connectTimeoutSeconds: 10 })
    expect(readDatabaseConfig(env, { target: 'test' })).toMatchObject({
      poolMax: 5,
      connectTimeoutSeconds: 5,
    })
  })

  it('lets the env override either target', () => {
    const tuned = {
      ...env,
      EZPUG_IRON_DATABASE_POOL_MAX: '3',
      EZPUG_IRON_DATABASE_CONNECT_TIMEOUT: '20',
    }
    expect(readDatabaseConfig(tuned)).toMatchObject({ poolMax: 3, connectTimeoutSeconds: 20 })
    expect(readDatabaseConfig(tuned, { target: 'test' })).toMatchObject({
      poolMax: 3,
      connectTimeoutSeconds: 20,
    })
  })
})

describe('readRedisConfig', () => {
  it('accepts rediss:// too', () => {
    expect(readRedisConfig({ EZPUG_IRON_REDIS_URL: 'rediss://host:6380' }).url).toBe(
      'rediss://host:6380',
    )
  })
})

describe('redactUrl', () => {
  it('masks the password and survives garbage', () => {
    expect(redactUrl(env.EZPUG_IRON_DATABASE_URL)).toBe(
      'postgres://ezpug_iron:***@127.0.0.1:5443/ezpug_iron',
    )
    expect(redactUrl('not a url')).toBe('<unparseable url>')
  })
})
