/**
 * The harness the fake's own tests share: a fake clock at a fixed instant, a
 * `matches` key with one registered webhook secret, a capturing webhook
 * endpoint whose answers a test scripts, a capturing demo bucket, and a
 * ten-player Bo1 request on `pug`. Not published — `fixtures` will carry the
 * conformance runner (PRD-01 T8); this is for the suites beside the fake.
 */
import { createFakeClock, type FakeClock } from '@ezpug/core'
import type { ApiKeyCreated, MatchRequestInput } from '../index'
import { createFakeOrchestrator } from './orchestrator'
import type {
  FakeListener,
  FakeOrchestrator,
  FakeOrchestratorOptions,
  FakeWebhookRequest,
} from './types'

export type { FakeListener }

export const T0 = Date.parse('2026-09-05T18:00:00.000Z')
export const WEBHOOK_SECRET_ID = 'whsec-fake-2026-09'
export const WEBHOOK_SECRET = 'fixture-webhook-secret-2026-09-not-a-real-one-0123456789'
export const WEBHOOK_URL = 'https://platform.invalid/hooks/ezpug'
export const DEMO_UPLOAD_URL =
  'https://bucket.invalid/demos/platform-match-1/map-1.dem?signed=fixture'

const TEAM_A = ['hunzR', 'maex', 'Zerberus', 'flippo', 'Kessi'] as const
const TEAM_B = ['wickeD', 'Jörg', 'schnitzL', 'BastiGHG', 'moepL'] as const

export function rosterOf(names: readonly string[], offset: number) {
  return names.map((name, index) => ({
    steamId64: `7656119800000${String(offset + index).padStart(4, '0')}`,
    name,
  }))
}

export function pugRequest(overrides: Partial<MatchRequestInput> = {}): MatchRequestInput {
  return {
    clientMatchId: 'platform-match-1',
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'Team hunzR', players: rosterOf(TEAM_A, 0) },
      teamB: { name: 'Team wickeD', players: rosterOf(TEAM_B, 100) },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    rules: {
      regulationRounds: 24,
      overtime: { enabled: true, maxRounds: 6, startMoney: 10_000 },
      warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
    },
    callbacks: {
      webhookUrl: WEBHOOK_URL,
      webhookSecretId: WEBHOOK_SECRET_ID,
      demoUploadUrl: DEMO_UPLOAD_URL,
    },
    ttlMinutes: 180,
    ...overrides,
  }
}

export interface Harness {
  clock: FakeClock
  fake: FakeOrchestrator
  /** A `matches` key with the webhook secret registered. */
  platform: ApiKeyCreated
  /** Every webhook POST the fake made, in order. */
  posted: FakeWebhookRequest[]
  /** What the endpoint answers a POST with; a test replaces it. Default: always 200. */
  respond: (request: FakeWebhookRequest) => number | null
  /** Every demo PUT: url and bytes. */
  uploads: { url: string; bytes: Uint8Array; contentType: string | null }[]
  errors: unknown[]
}

export function createHarness(
  options: Partial<Omit<FakeOrchestratorOptions, 'clock'>> & {
    budget?: ApiKeyCreated['key']['budget']
  } = {},
): Harness {
  const clock = createFakeClock({ start: T0 })
  const posted: FakeWebhookRequest[] = []
  const uploads: Harness['uploads'] = []
  const errors: unknown[] = []
  const { budget, ...rest } = options
  const fake = createFakeOrchestrator({
    clock,
    webhooks: {
      deliver: request => {
        posted.push(request)
        return harness.respond(request)
      },
    },
    fetch: ((url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      uploads.push({
        url: String(url),
        bytes: init?.body as Uint8Array,
        contentType: headers.get('content-type'),
      })
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as typeof globalThis.fetch,
    onError: error => {
      errors.push(error)
    },
    ...rest,
  })
  const harness: Harness = {
    clock,
    fake,
    platform: undefined as unknown as ApiKeyCreated,
    posted,
    respond: () => 200,
    uploads,
    errors,
  }
  harness.platform = fake.mintKey({
    name: 'platform',
    scopes: ['matches'],
    budget: budget ?? { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [{ id: WEBHOOK_SECRET_ID, secret: WEBHOOK_SECRET }],
  })
  return harness
}
