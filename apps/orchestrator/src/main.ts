/**
 * The process: read the environment, compose the orchestrator, ping the
 * rails once so a wrong URL fails the boot instead of the first request,
 * arm the drain, listen. Everything else is `orchestrator.ts`.
 */
import { systemClock } from '@ezpug/core'
import { readOrchestratorConfig, redactUrl } from './config'
import { loadRootEnv } from './env'
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

orchestrator.shutdown.listen()
const { url } = await orchestrator.listen()
log.info(
  `listening on ${url} (${config.baseUrl}); providers=${config.providers.join(',') || 'none'}; ` +
    `database=${redactUrl(config.database.url)}; redis=${redactUrl(config.redis.url)}`,
)
