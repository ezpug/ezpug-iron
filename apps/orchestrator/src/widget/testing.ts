import type { Clock } from '@ezpug/core'
import type {
  MatchApiErrorCode,
  WebhookEnvelope,
  WidgetCommandResultFrame,
  WidgetServerFrame,
} from '@ezpug/match-api'
import {
  ApiError,
  MATCH_API_ERROR_STATUS,
  WIDGET_SOCKET_PROTOCOL,
  widgetServerFrameSchema,
} from '@ezpug/match-api'
import type { ConformancePlayerCommand } from '@ezpug/match-api/fixtures'
import { WebSocket } from 'ws'
import type { WidgetService } from './service'

/**
 * **The conformance suite's tap, through the widget door** (T24). The
 * suite's `playerCommand` capability is the fake's in-process door: a token,
 * a verb, and the `plugin_event` envelope the tap left — or an `ApiError`
 * for a refusal, with the fake's mapping. The orchestrator has no such
 * in-process door on purpose (the socket is the door), so these helpers
 * drive the socket's frames the way a widget would — in-process over the
 * service for the memory tier, over a real `ws` for the extended one — and
 * translate the result into what the suite expects.
 */

/** A refused tap as the `ApiError` the fake's `playerCommand` throws for the same code. */
export function widgetTapError(
  result: Pick<WidgetCommandResultFrame, 'code' | 'message' | 'cooldownMs' | 'chargesLeft'>,
): ApiError {
  const code: MatchApiErrorCode = (() => {
    switch (result.code) {
      case 'unknown_command':
        return 'command_unsupported'
      case 'invalid_args':
        return 'validation_failed'
      case 'not_in_match':
        return 'player_not_in_match'
      case 'rate_limited':
        return 'rate_limited'
      default:
        return 'invalid_state'
    }
  })()
  return new ApiError(
    MATCH_API_ERROR_STATUS[code],
    code,
    result.message ?? `the command was ${result.code ?? 'refused'}`,
    {
      code: result.code,
      ...(result.cooldownMs !== undefined && { cooldownMs: result.cooldownMs }),
      ...(result.chargesLeft !== undefined && { chargesLeft: result.chargesLeft }),
    },
  )
}

/** One tap's frames, gathered until the result and — when applied — its `plugin_event` arrived. */
function collector(command: ConformancePlayerCommand, correlationId: string) {
  let result: WidgetCommandResultFrame | undefined
  let envelope: WebhookEnvelope | undefined
  let settle: (() => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const done = new Promise<void>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  const check = (): void => {
    if (!result) return
    if (result.status === 'rejected' || envelope) settle?.()
  }
  return {
    done,
    steamId64: undefined as string | undefined,
    frame(frame: WidgetServerFrame): void {
      if (frame.type === 'hello') this.steamId64 = frame.steamId64
      else if (frame.type === 'command_result' && frame.correlationId === correlationId)
        result = frame
      else if (
        frame.type === 'event' &&
        frame.envelope.payload.type === 'plugin_event' &&
        frame.envelope.payload.name === 'player_command' &&
        frame.envelope.payload.data.command === command.command &&
        frame.envelope.payload.data.steamId64 === this.steamId64
      )
        envelope = frame.envelope
      check()
    },
    closed(code: number, reason: string): void {
      fail?.(new ApiError(401, 'unauthorized', `the widget socket closed ${code}: ${reason}`))
    },
    outcome(): WebhookEnvelope {
      if (!result) throw new Error('no command_result')
      if (result.status === 'applied' && envelope) return envelope
      throw widgetTapError(result)
    },
  }
}

/** The tap in-process, over the service the socket wraps. */
export async function tapThroughWidget(
  widgets: WidgetService,
  command: ConformancePlayerCommand,
): Promise<WebhookEnvelope> {
  const correlationId = `conformance-${command.command}`
  const gather = collector(command, correlationId)
  const opened = await widgets.open(
    { token: command.token },
    { send: frame => gather.frame(frame), close: (code, reason) => gather.closed(code, reason) },
  )
  if (!opened.ok)
    throw new ApiError(
      MATCH_API_ERROR_STATUS.unauthorized,
      'unauthorized',
      `the widget door refused ${opened.code}: ${opened.reason}`,
    )
  try {
    await opened.session.command({
      type: 'command',
      correlationId,
      command: command.command,
      ...(command.args && { args: command.args }),
    })
    await gather.done
    return gather.outcome()
  } finally {
    opened.session.close()
  }
}

/** The tap over a real socket — what a widget in a browser does. */
export async function tapOverWidgetSocket(
  url: string,
  command: ConformancePlayerCommand,
  options: { clock: Clock; timeoutMs?: number },
): Promise<WebhookEnvelope> {
  const correlationId = `conformance-${command.command}`
  const gather = collector(command, correlationId)
  const socket = new WebSocket(url)
  const timer = options.clock.after(options.timeoutMs ?? 30_000, () =>
    gather.closed(1006, 'the tap timed out'),
  )
  socket.on('message', data => {
    const parsed = widgetServerFrameSchema.safeParse(JSON.parse(String(data)))
    if (parsed.success) gather.frame(parsed.data)
  })
  socket.on('close', (code, reason) => gather.closed(code, String(reason)))
  socket.on('error', error => gather.closed(1006, error.message))
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  socket.send(
    JSON.stringify({ type: 'hello', protocol: WIDGET_SOCKET_PROTOCOL, token: command.token }),
  )
  socket.send(
    JSON.stringify({
      type: 'command',
      correlationId,
      command: command.command,
      ...(command.args && { args: command.args }),
    }),
  )
  try {
    await gather.done
    return gather.outcome()
  } finally {
    timer.cancel()
    socket.close()
  }
}
