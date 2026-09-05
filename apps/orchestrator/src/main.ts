/**
 * The process: read the environment, compose the orchestrator, ping the
 * rails once so a wrong URL fails the boot instead of the first request,
 * migrate and adopt the dev bootstrap key where the environment asks for
 * them (the image does both — `docs/operations.md`), arm the drain, listen.
 * Everything else is `orchestrator.ts`.
 */
import { systemClock } from '@ezpug/core'
import { readOrchestratorConfig, redactUrl } from './config'
import { runMigrations } from './db/migrate'
import { loadRootEnv } from './env'
import { ensureBootstrapKey } from './keys/bootstrap'
import { createConsoleLog } from './log'
import { createOrchestrator } from './orchestrator'

loadRootEnv()

const log = createConsoleLog()
const config = readOrchestratorConfig(process.env)
const orchestrator = createOrchestrator({ config, clock: systemClock, log })

try {
  await orchestrator.database.ping()
  await orchestrator.redis.ping()
} catch (error) {
  log.error('a rail is unreachable at boot', error)
  await orchestrator.database.close().catch(() => {})
  await orchestrator.redis.close().catch(() => {})
  process.exit(1)
}

// Both of these run before the port opens: a request must never meet a
// half-migrated schema, and the key the dev world was handed must work on
// the very first call.
if (config.migrateOnBoot) {
  try {
    await runMigrations(
      orchestrator.database,
      config.migrationsDir ? { migrationsFolder: config.migrationsDir } : {},
    )
    log.info('migrations applied')
  } catch (error) {
    log.error('the migrations did not apply', error)
    await orchestrator.close('boot').catch(() => {})
    process.exit(1)
  }
}

if (config.bootstrapApiKey) {
  const outcome = await ensureBootstrapKey({
    keys: orchestrator.keys,
    secret: config.bootstrapApiKey,
    production: config.production,
  })
  log.info(
    `the bootstrap API key ${outcome.key.id} (${outcome.key.name}, ${outcome.key.scopes.join(',')}) is live` +
      `${outcome.created ? ' — adopted from the environment' : ''}` +
      `${outcome.revoked ? `; the previous one (${outcome.revoked}) was revoked` : ''}`,
  )
}

orchestrator.shutdown.listen()
await orchestrator.start()
const { url } = await orchestrator.listen()
log.info(
  `listening on ${url} (${config.baseUrl}); providers=${config.providers.join(',') || 'none'}; ` +
    `database=${redactUrl(config.database.url)}; redis=${redactUrl(config.redis.url)}`,
)
