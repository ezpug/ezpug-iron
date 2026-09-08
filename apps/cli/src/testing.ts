import { createFakeClock, type FakeClock } from '@ezpug/core'
import type { ApiKeyCreated, MatchRequestInput } from '@ezpug/match-api'
import type { StreamWebSocketConstructor } from '@ezpug/match-api/client'
import { createMatchApiClient } from '@ezpug/match-api/client'
import {
  createFakeOrchestrator,
  type FakeListener,
  type FakeOrchestrator,
} from '@ezpug/match-api/fake'
import WebSocket from 'ws'
import { runCli } from './cli'
import type { EnvRecord } from './config'
import { API_KEY_VAR } from './config'
import type { DathostImageRunner } from './context'

/**
 * **The CLI's own harness.** The fake orchestrator on a real port, and
 * `runCli` driven over it exactly as a terminal would — real HTTP, a real
 * WebSocket upgrade for `matches watch`, the real typed client. What the
 * suite asserts on is what an operator would have seen: the two captured
 * streams and the exit code.
 *
 * The clock is fake and shared, so a Bo1 plays out in microseconds and no
 * test waits on a wall. Nothing here is exported from the package's build:
 * it is a test module beside the code, the way the node agent's is.
 */

export interface CliRun {
  code: number
  /** Everything written to stdout, joined. */
  out: string
  /** Everything written to stderr, joined. */
  err: string
  /** stdout parsed as one JSON document — for a `--json` run. */
  json: <T = unknown>() => T
  /** stdout parsed as one JSON document per line — for `matches watch --json`. */
  ndjson: () => unknown[]
}

export interface CliHarness {
  clock: FakeClock
  fake: FakeOrchestrator
  listener: FakeListener
  /** The fake's root key: `admin`, and therefore every scope (`scopeAllows`). */
  admin: ApiKeyCreated
  /** Every stream either channel ever carried, across every run — the secret sweep reads this. */
  everything: string[]
  /** Run one command line. `stdin` is what `--file -` reads. */
  run: (line: string, options?: { stdin?: string; env?: EnvRecord }) => Promise<CliRun>
  /** What `dathost image` calls; a test replaces it. */
  dathost: { calls: { argv: readonly string[] }[]; code: number; stdout: string; stderr: string }
  close: () => Promise<void>
}

/** The webhook secret the harness registers on the admin key, named by every request. */
export const WEBHOOK_SECRET_ID = 'whsec-cli-2026-09'
const WEBHOOK_SECRET = 'harness-webhook-secret-2026-09-not-a-real-one-0123456789'

/** What a simulated server costs here, and what the admin key may spend on it. */
export const HOURLY_CENTS = 42
export const MONTHLY_CENTS = 100_000

/** A six-player Bo1 on `pug`, the shape `matches create --file` takes. */
export function pugRequest(overrides: Partial<MatchRequestInput> = {}): MatchRequestInput {
  const roster = (names: readonly string[], offset: number) =>
    names.map((name, index) => ({
      steamId64: `7656119800000${String(offset + index).padStart(4, '0')}`,
      name,
    }))
  return {
    clientMatchId: 'cli-match-1',
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'Team A', players: roster(['hunzR', 'maex', 'Zerberus'], 0) },
      teamB: { name: 'Team B', players: roster(['wickeD', 'schnitzL', 'moepL'], 100) },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    rules: {
      regulationRounds: 24,
      overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
      warmup: { minPlayersToReady: 0, minSpectatorsToReady: 0 },
    },
    callbacks: {
      webhookUrl: 'https://platform.invalid/hooks/ezpug',
      webhookSecretId: WEBHOOK_SECRET_ID,
      demoUploadUrl: 'https://bucket.invalid/demos/cli-match-1/map-1.dem?signed=fixture',
    },
    ttlMinutes: 180,
    ...overrides,
  }
}

/**
 * The secret out of a `reveal` block — the framed, indented line the mint
 * prints once. Matched by shape rather than by grammar, so it holds whatever
 * the orchestrator's tokens look like.
 */
export function revealedSecret(out: string): string | undefined {
  return out.match(/\n\n {4}(\S+)\n\n/)?.[1]
}

/** What a test bends about the fake before it starts; everything else is fixed. */
export interface CliHarnessOptions {
  /** The GSLT pool `providers gslt` reads (`GET /v1/fleet/gslt`). Default 0. */
  gsltTotal?: number
}

export async function createCliHarness(options: CliHarnessOptions = {}): Promise<CliHarness> {
  const clock = createFakeClock({ start: Date.parse('2026-09-07T18:00:00.000Z') })
  const fake = createFakeOrchestrator({
    clock,
    gsltTotal: options.gsltTotal,
    // Nothing leaves the process: webhooks are answered in memory, the demo
    // PUT is swallowed. A CLI test must not open a socket it did not open.
    webhooks: { deliver: () => 200 },
    fetch: (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof globalThis.fetch,
    providers: { sim: { hourlyCents: HOURLY_CENTS } },
    onError: () => {},
  })
  // The request document the suite posts names a webhook secret by id, and
  // the orchestrator refuses one the key never registered. Registering it is
  // what the platform does at setup, so the harness does it too.
  const admin = fake.client(fake.admin.secret)
  await admin.keys.setWebhookSecrets({
    params: { keyId: fake.admin.key.id },
    body: { secrets: [{ id: WEBHOOK_SECRET_ID, secret: WEBHOOK_SECRET }] },
  })
  // The sim here costs money on purpose, so a ledger row has a price to
  // print and `budget` has a ceiling to be a fraction of; the root key's
  // default monthly ceiling is 0, which means "no spending at all".
  await admin.keys.setBudget({
    params: { keyId: fake.admin.key.id },
    body: { monthlyCents: MONTHLY_CENTS },
  })
  const listener = await fake.listen()
  const everything: string[] = []
  let correlations = 0
  let commands = 0
  const dathost: CliHarness['dathost'] = { calls: [], code: 0, stdout: '', stderr: '' }
  const dathostImage: DathostImageRunner = options => {
    dathost.calls.push({ argv: options.argv })
    if (dathost.stdout) options.stdout(dathost.stdout)
    if (dathost.stderr) options.stderr(dathost.stderr)
    return Promise.resolve(dathost.code)
  }

  const harness: CliHarness = {
    clock,
    fake,
    listener,
    admin: fake.admin,
    everything,
    dathost,
    run: async (line, options = {}) => {
      correlations += 1
      const runOfLine = correlations
      const out: string[] = []
      const err: string[] = []
      const code = await runCli(splitLine(line), {
        env: options.env ?? {
          [API_KEY_VAR]: fake.admin.secret,
          EZPUG_IRON_CLI_URL: listener.url,
        },
        clock,
        stdout: text => {
          out.push(text)
          everything.push(text)
        },
        stderr: text => {
          err.push(text)
          everything.push(text)
        },
        WebSocket: WebSocket as unknown as StreamWebSocketConstructor,
        // One attempt per call. The published retry schedule waits on the
        // injected clock, and the injected clock here is the fake one the
        // orchestrator's story runs on: a retry nobody advances past would
        // hang the suite. Riding out a 503 is `@ezpug/match-api`'s own
        // concern and is tested there; what this suite is about is what the
        // command does with the answer it got.
        createClient: config =>
          createMatchApiClient({
            ...config,
            clock,
            retry: false,
            WebSocket: WebSocket as unknown as StreamWebSocketConstructor,
          }),
        // Unique per call: a `correlationId` is a command's idempotency key,
        // and two commands sharing one would have the second answered with
        // the first's result (`resources/commands.ts`).
        newId: () => {
          commands += 1
          return `cli-correlation-${runOfLine}-${commands}`
        },
        readInput: path =>
          path === '-'
            ? Promise.resolve(options.stdin ?? '')
            : Promise.reject(new Error(`the harness reads stdin only, not ${path}`)),
        onSignal: () => () => {},
        dathostImage,
      })
      const text = out.join('')
      return {
        code,
        out: text,
        err: err.join(''),
        json: <T>() => JSON.parse(text) as T,
        ndjson: () =>
          text
            .split('\n')
            .filter(line => line.startsWith('{'))
            .map(line => JSON.parse(line) as unknown),
      }
    },
    close: async () => {
      await listener.close()
      fake.close()
    },
  }
  return harness
}

/** A command line as a shell would split it, with single quotes for one argument. */
export function splitLine(line: string): string[] {
  return (line.match(/'[^']*'|\S+/g) ?? []).map(token =>
    token.startsWith("'") ? token.slice(1, -1) : token,
  )
}
