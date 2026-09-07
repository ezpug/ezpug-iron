import type { FakeClock } from '@ezpug/core'
import { createFakeCore } from './core'
import { createDispatch, createInProcessClient } from './dispatch'
import { createFakeHandlers } from './handlers'
import { createFakeHandler } from './http'
import { listenFake } from './listen'
import type { FakeOrchestrator, FakeOrchestratorOptions } from './types'

/**
 * **The fake orchestrator** (decision 3, 9): every route of the Match API
 * in-process and over HTTP, matches played by the simulator engine on the
 * injected clock, webhooks signed and retried on the published schedule, the
 * stream as a subscription and as a `ws` upgrade, a ledger and budgets real
 * enough to refuse. The platform's tests and its history seed run on this;
 * the conformance suite runs on this first and on the real orchestrator
 * second, and if the two ever disagree the fixture decides.
 *
 * ```ts
 * const clock = createFakeClock()
 * const fake = createFakeOrchestrator({ clock, webhooks: { deliver: () => 200 } })
 * const { secret } = fake.mintKey({ name: 'platform', scopes: ['matches'], budget, webhookSecrets })
 * const client = fake.client(secret)
 * const match = await client.matches.create({ body: request })
 * await fake.playOut()                 // the whole Bo1, its webhooks, their retries
 * const { items } = await client.matches.events({ params: { matchId: match.id }, query: {} })
 * ```
 */
export function createFakeOrchestrator(options: FakeOrchestratorOptions): FakeOrchestrator {
  const core = createFakeCore(options)
  const dispatch = createDispatch(core, createFakeHandlers(core))
  const report =
    options.onError ??
    ((error: unknown, context: Record<string, unknown>) => {
      console.error('[fake orchestrator]', context, error)
    })
  const handler = createFakeHandler(dispatch, report)

  const isFakeClock = (clock: unknown): clock is FakeClock =>
    typeof (clock as FakeClock).runAll === 'function' &&
    typeof (clock as FakeClock).pending === 'function'

  const fake: FakeOrchestrator = {
    clock: core.clock,
    admin: core.admin,
    handler,
    client: apiKey => createInProcessClient(dispatch, apiKey),
    dispatch,
    mintKey: request => core.mintKey(request),
    stream: (subscription, listener, onClose) => core.stream(subscription, listener, onClose),
    playerCommand: command => core.playerCommand(command),
    widget: (token, listener, onClose) => core.widget(token, listener, onClose),
    deliveries: matchId => core.deliveries(matchId),
    get faults() {
      return core.faults
    },
    setFaults: patch => core.setFaults(patch),
    providerDownFor: durationMs => core.providerDownFor(durationMs),
    server: matchId => core.server(matchId),
    settle: () => core.settle(),
    async playOut() {
      const { clock } = core
      if (!isFakeClock(clock))
        throw new Error('fake orchestrator: playOut() needs a fake clock (createFakeClock)')
      // Timers arm promises and promises arm timers; alternate until neither
      // has anything left. The bound is a runaway guard, not a budget.
      for (let round = 0; round < 10_000; round += 1) {
        await clock.runAll()
        await core.settle()
        if (clock.pending() === 0) {
          await core.settle()
          if (clock.pending() === 0) return
        }
      }
      throw new Error('fake orchestrator: playOut() did not settle')
    },
    listen: listenOptions => listenFake(fake, listenOptions),
    close: () => core.close(),
  }
  return fake
}
