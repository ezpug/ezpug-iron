/**
 * Mint an API key from a terminal on the box. The secret is printed once, to
 * stdout, and nowhere else.
 *
 *   pnpm --filter @ezpug/orchestrator keys:mint -- --name platform --scopes matches,fleet
 *   pnpm --filter @ezpug/orchestrator keys:mint -- --name root --scopes admin \
 *     --max-concurrent 4 --max-lifetime-minutes 240 --monthly-cents 0
 *
 * **This is the first key of a deployment, and only the first.** Every other
 * key is `ezpug-iron keys create` over the Match API (T33), which needs an
 * `admin` key to already exist; the dev bootstrap key (T4) is refused under
 * `NODE_ENV=production` on purpose. So production needs this script and has
 * neither a checkout nor a published database port to run it from — which is
 * why `tsdown.config.ts` bundles it into the image as `dist/mint-key.mjs`
 * and `./scripts/deploy.sh key` is how an operator reaches it (ralph/DEPLOY.md).
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
