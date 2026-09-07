import { WIDGET_COMMAND_REFUSALS } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { PLAYER_COMMAND_REFUSALS } from './server-link'

/**
 * The SDK's refusal set (this package, relayed over the link as
 * `player_command_result.code`) is the head of the widget socket's
 * (`@ezpug/match-api`, `command_result.code` on `/v1/widget`): a code the
 * plugin answers with is forwarded to the phone as it is, and the socket
 * adds only what the orchestrator refuses at its own door. A code added
 * here without the socket learning it would reach a widget that cannot
 * name it.
 */
describe('the player command refusals', () => {
  it('are a prefix of the widget socket’s refusals', () => {
    expect(WIDGET_COMMAND_REFUSALS.slice(0, PLAYER_COMMAND_REFUSALS.length)).toEqual([
      ...PLAYER_COMMAND_REFUSALS,
    ])
  })
})
