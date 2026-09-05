import { describe, expect, it } from 'vitest'
import {
  BOOTSTRAP_API_KEY_VAR,
  DATABASE_URL_VAR,
  REDIS_URL_VAR,
  readDatabaseConfig,
  readOrchestratorConfig,
  readRedisConfig,
  redactUrl,
  TEST_DATABASE_URL_VAR,
} from './config'

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
    expect(config.rateLimit).toEqual({ burst: 10, perSecond: 1 })
    expect(config.database.poolMax).toBe(3)
    expect(config.database.logQueries).toBe(true)
    expect(config.production).toBe(true)
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

describe('readDatabaseConfig', () => {
  it('reads the test database on demand', () => {
    expect(readDatabaseConfig(env, { target: 'test' })).toMatchObject({
      url: env.EZPUG_IRON_TEST_DATABASE_URL,
      source: TEST_DATABASE_URL_VAR,
      poolMax: 10,
      statementTimeoutMs: 15_000,
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
