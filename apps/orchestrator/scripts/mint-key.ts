/**
 * Mint an API key from a terminal on the box — the operator's door until the
 * CLI (T33) and the dev bootstrap key (T4) exist. The secret is printed
 * once, to stdout, and nowhere else.
 *
 *   pnpm --filter @ezpug/orchestrator keys:mint -- --name platform --scopes matches,fleet
 *   pnpm --filter @ezpug/orchestrator keys:mint -- --name root --scopes admin \
 *     --max-concurrent 4 --max-lifetime-minutes 240 --monthly-cents 0
 */
import process from 'node:process'
import { systemClock } from '@ezpug/core'
import { apiKeyCreateRequestSchema } from '@ezpug/match-api'
import { readDatabaseConfig } from '../src/config'
import { createDatabase, errorMessage } from '../src/db/client'
import { loadRootEnv } from '../src/env'
import { createPostgresKeyStore } from '../src/keys/postgres-store'
import { createKeys } from '../src/keys/service'

loadRootEnv()

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const request = apiKeyCreateRequestSchema.parse({
  name: argument('name'),
  scopes: (argument('scopes', 'matches') ?? '').split(',').map(scope => scope.trim()),
  budget: {
    maxConcurrentServers: Number(argument('max-concurrent', '4')),
    maxServerLifetimeMinutes: Number(argument('max-lifetime-minutes', '240')),
    monthlyCents: Number(argument('monthly-cents', '0')),
  },
})

const handle = createDatabase(readDatabaseConfig(process.env), {
  applicationName: 'ezpug-iron-mint-key',
})

try {
  await handle.ping()
  const keys = createKeys({ store: createPostgresKeyStore(handle.db), clock: systemClock })
  const { key, secret } = await keys.mint(request)
  console.error(
    `[orchestrator] minted API key ${key.id} (${key.name}, ${key.scopes.join(',')}) — the secret follows once:`,
  )
  console.log(secret)
} catch (error) {
  console.error(`[orchestrator] ${errorMessage(error)}`)
  process.exitCode = 1
} finally {
  await handle.close()
}
