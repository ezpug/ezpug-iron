/**
 * **What a simulated box's players say.** Three lines per match, drawn from a
 * small fixture on a seeded stream: one in warmup, one to a team after the
 * opening pistol, one `gg` when the last round falls. That is deliberately
 * not a conversation — it is enough for a chat bridge to be exercised end to
 * end on every box that never sees a real server, and no more, because a
 * simulator that chatted plausibly would be a second thing to keep plausible.
 *
 * Two decisions worth their names:
 *
 * - **Its own stream.** The lines are drawn from `prng.fork('chatter')`, not
 *   from the story's own dice, so adding chat to the simulator did not change
 *   a single existing match: every seed still plays the same rounds, the same
 *   kills and the same winner (`fork` is "order-independent" by contract,
 *   `@ezpug/core`). A seed still reproduces the *lines* too.
 * - **One line is a team line.** The post-pistol one has scope `team`, so
 *   every simulated match proves a bridge's scope rule (team chat stays in
 *   the server) rather than only its happy path.
 *
 * The platform's `chatter.ts` on 2026-09-05, verbatim.
 */

import type { Prng } from '@ezpug/core'
import type { ServerChatScope } from '@ezpug/match-api'

/** The three moments a simulated match speaks at. */
export const simulatedChatMoments = ['warmup', 'pistol', 'end'] as const
export type SimulatedChatMoment = (typeof simulatedChatMoments)[number]

/**
 * The fixture: short, German, and free of anything a chat line cannot carry.
 * A LAN says these things; nothing here is trying to be clever.
 */
export const SIMULATED_CHAT_LINES = {
  warmup: ['moin', 'alle da?', 'wer ist noch nicht drin', 'gl hf', 'los gehts'],
  pistol: ['schöne pistol', 'unlucky', 'zusammen rein', 'ich hab awp', 'eco jetzt'],
  end: ['gg', 'gg wp', 'ggwp', 'gg gut gespielt'],
} as const satisfies Record<SimulatedChatMoment, readonly string[]>

/** Which window each moment is said in. */
export const SIMULATED_CHAT_SCOPES = {
  warmup: 'all',
  pistol: 'team',
  end: 'all',
} as const satisfies Record<SimulatedChatMoment, ServerChatScope>

/** One line, decided at assign time like every other beat of a story. */
export interface SimulatedChatLine {
  speaker: number
  text: string
  scope: ServerChatScope
}

/**
 * Decide the match's three lines: who says each and what it is. `speakers` is
 * how many players are on the box; the answer indexes into that list, so this
 * function never learns what a player is.
 */
export function planSimulatedChatter(
  prng: Prng,
  speakers: number,
): Record<SimulatedChatMoment, SimulatedChatLine> | null {
  if (speakers <= 0) return null
  const line = (moment: SimulatedChatMoment): SimulatedChatLine => ({
    speaker: prng.int(0, speakers),
    text: prng.pick(SIMULATED_CHAT_LINES[moment]),
    scope: SIMULATED_CHAT_SCOPES[moment],
  })
  // Drawn in the published order, so the moments are stable under a seed.
  return { warmup: line('warmup'), pistol: line('pistol'), end: line('end') }
}
