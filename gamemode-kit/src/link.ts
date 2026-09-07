import { computed, type MaybeRefOrGetter, onScopeDispose, type Ref, ref, toValue, watch } from 'vue'
import { browserClock, type WidgetClock, type WidgetTimer } from './clock'
import {
  type WebhookEnvelope,
  WIDGET_CLOSE_CODES,
  WIDGET_COMMAND_TIMEOUT_MS,
  WIDGET_SOCKET_PATH,
  WIDGET_SOCKET_PROTOCOL,
  type WidgetCommandResultFrame,
  type WidgetCommandState,
  type WidgetPushFrame,
  type WidgetServerFrame,
  type WidgetWelcomeFrame,
} from './protocol'

/**
 * **`useWidgetLink()`** — the widget's own socket to the orchestrator
 * (decision 17, `GET /v1/widget`, `docs/match-api.md` "The widget socket"),
 * as a Vue composable. Give it the orchestrator URL and the player token the
 * host injected and it opens the socket, says `hello` with the token in the
 * first frame (never in the URL), keeps the welcome and the verbs it named,
 * hands every `event` frame to whoever listens, answers each `send()` with
 * the `command_result` that carried its `correlationId`, and reconnects on a
 * network close with a backoff — never on a close code the orchestrator
 * decided (`WIDGET_CLOSE_CODES`), and `4000` is the match ending.
 *
 * What it keeps about the verbs is a *hint* for the buttons: the manifest's
 * spec plus `chargesLeft` and `readyAt` as the orchestrator last said them,
 * refreshed by every result. The SDK on the server is the truth and a tap is
 * enforced there whatever the button showed.
 *
 * A `null` token is a viewer who may watch but not tap: the state is
 * `watching`, nothing is opened, and `send()` answers `unavailable`.
 */

export type WidgetLinkState =
  /** No token: nothing to open. */
  | 'watching'
  | 'connecting'
  | 'open'
  /** A network close; the next attempt is armed. */
  | 'reconnecting'
  /** Close `4000`: the match is over, the token is spent. */
  | 'ended'
  /** A close code the orchestrator decided (`4001`…`4009`): no retry. */
  | 'refused'
  /** `close()` was called. */
  | 'closed'

/** A declared verb as the buttons should draw it. */
export interface WidgetCommandView extends WidgetCommandState {
  /** The clock instant the cooldown passes, per the last word from the orchestrator. */
  readyAt: number
}

/** The corner of `WebSocket` the link uses — injectable, so a test can hand in a stand-in. */
export interface WidgetSocket {
  readyState: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export interface WidgetLinkOptions {
  /** The orchestrator's base URL (`https://gs.ezpug.com`), from the host's `init`. */
  orchestratorUrl: MaybeRefOrGetter<string | null | undefined>
  /** The player token, or `null` for a viewer. */
  playerToken: MaybeRefOrGetter<string | null | undefined>
  clock?: WidgetClock
  /** Opens a socket at a `ws(s)://…/v1/widget` URL. Default: the browser's `WebSocket`. */
  connect?: (url: string) => WidgetSocket
  /** The backoff after a network close: doubled each time from `initialMs` up to `maxMs`. */
  reconnect?: { initialMs?: number; maxMs?: number }
}

export interface WidgetLink {
  state: Readonly<Ref<WidgetLinkState>>
  /** The orchestrator's welcome, once said; `null` before and after a reconnect until the next. */
  hello: Readonly<Ref<WidgetWelcomeFrame | null>>
  /** The verbs the mode declares, as last reported. */
  commands: Readonly<Ref<readonly WidgetCommandView[]>>
  /** The last durable fact that crossed the socket. */
  lastEvent: Readonly<Ref<WebhookEnvelope | null>>
  /** The last close code, `null` while open or before any close. */
  closeCode: Readonly<Ref<number | null>>
  /** Every `event` frame, in order; returns the unsubscribe. */
  onEvent: (handler: (envelope: WebhookEnvelope) => void) => () => void
  /**
   * Every `push` frame — a moment the gamemode aimed at this phone and
   * nothing else (`powerup-dm`'s `radar_peek`). Ephemeral: nothing here
   * keeps one, so a widget that wants a push on screen holds it itself.
   * Returns the unsubscribe.
   */
  onPush: (handler: (push: WidgetPushFrame) => void) => () => void
  /** A tap. Resolves with the orchestrator's `command_result`; a local refusal is a rejected result too, never a throw. */
  send: (command: string, args?: Record<string, unknown>) => Promise<WidgetCommandResultFrame>
  /** Hang up and stop reconnecting. */
  close: () => void
}

/** `https://gs.ezpug.com` → `wss://gs.ezpug.com/v1/widget`. */
export function widgetSocketUrl(orchestratorUrl: string): string {
  const url = new URL(orchestratorUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${WIDGET_SOCKET_PATH}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

const OPEN = 1

function browserSocket(url: string): WidgetSocket {
  return new WebSocket(url) as unknown as WidgetSocket
}

let sessionCounter = 0

export function useWidgetLink(options: WidgetLinkOptions): WidgetLink {
  const clock = options.clock ?? browserClock
  const connect = options.connect ?? browserSocket
  const initialMs = options.reconnect?.initialMs ?? 1_000
  const maxMs = options.reconnect?.maxMs ?? 30_000

  const state = ref<WidgetLinkState>('watching')
  const hello = ref<WidgetWelcomeFrame | null>(null)
  const commands = ref<WidgetCommandView[]>([])
  const lastEvent = ref<WebhookEnvelope | null>(null)
  const closeCode = ref<number | null>(null)
  const listeners = new Set<(envelope: WebhookEnvelope) => void>()
  const pushListeners = new Set<(push: WidgetPushFrame) => void>()

  sessionCounter += 1
  const session = `w${sessionCounter}-${clock.now().toString(36)}`
  let tapCounter = 0
  const pending = new Map<
    string,
    { resolve: (result: WidgetCommandResultFrame) => void; timer: WidgetTimer }
  >()

  let socket: WidgetSocket | null = null
  let attempt = 0
  let retry: WidgetTimer | null = null
  let closed = false

  const rejected = (
    correlationId: string,
    command: string,
    code: WidgetCommandResultFrame['code'],
  ): WidgetCommandResultFrame => ({
    type: 'command_result',
    correlationId,
    command,
    status: 'rejected',
    code,
  })

  const flushPending = (code: WidgetCommandResultFrame['code']): void => {
    for (const [correlationId, entry] of pending) {
      entry.timer.cancel()
      entry.resolve(rejected(correlationId, correlationId.split(':')[1] ?? '', code))
    }
    pending.clear()
  }

  const settleCommands = (frame: WidgetCommandResultFrame): void => {
    commands.value = commands.value.map(view =>
      view.name === frame.command
        ? {
            ...view,
            ...(frame.chargesLeft !== undefined && { chargesLeft: frame.chargesLeft }),
            readyAt:
              frame.cooldownMs !== undefined && frame.code !== 'rate_limited'
                ? clock.now() + frame.cooldownMs
                : frame.status === 'applied' && view.cooldownMs > 0
                  ? clock.now() + view.cooldownMs
                  : view.readyAt,
          }
        : view,
    )
  }

  const onFrame = (raw: unknown): void => {
    let frame: WidgetServerFrame
    try {
      frame = JSON.parse(String(raw)) as WidgetServerFrame
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    switch (frame.type) {
      case 'hello': {
        hello.value = frame
        const now = clock.now()
        commands.value = frame.commands.map(spec => ({ ...spec, readyAt: now + spec.readyInMs }))
        state.value = 'open'
        attempt = 0
        return
      }
      case 'event': {
        lastEvent.value = frame.envelope
        for (const listener of listeners) listener(frame.envelope)
        return
      }
      case 'push': {
        for (const listener of pushListeners) listener(frame)
        return
      }
      case 'command_result': {
        settleCommands(frame)
        const entry = pending.get(frame.correlationId)
        if (!entry) return
        pending.delete(frame.correlationId)
        entry.timer.cancel()
        entry.resolve(frame)
        return
      }
      default:
        return
    }
  }

  const hangUp = (): void => {
    if (retry) {
      retry.cancel()
      retry = null
    }
    if (socket) {
      const s = socket
      socket = null
      s.onopen = null
      s.onmessage = null
      s.onclose = null
      s.onerror = null
      try {
        s.close(1000, 'widget closed')
      } catch {
        // already gone
      }
    }
  }

  const open = (): void => {
    if (closed) return
    const url = toValue(options.orchestratorUrl)
    const token = toValue(options.playerToken)
    if (!url || !token) {
      state.value = 'watching'
      return
    }
    let target: string
    try {
      target = widgetSocketUrl(url)
    } catch {
      state.value = 'refused'
      return
    }
    state.value = attempt === 0 ? 'connecting' : 'reconnecting'
    hello.value = null
    let s: WidgetSocket
    try {
      s = connect(target)
    } catch {
      scheduleRetry()
      return
    }
    socket = s
    s.onopen = () => {
      s.send(JSON.stringify({ type: 'hello', protocol: WIDGET_SOCKET_PROTOCOL, token }))
    }
    s.onmessage = event => onFrame(event.data)
    s.onerror = () => {
      // The close that follows decides; an error alone is not a state.
    }
    s.onclose = event => {
      if (socket !== s) return
      socket = null
      closeCode.value = event.code
      hello.value = null
      if (closed) {
        state.value = 'closed'
        flushPending('unavailable')
        return
      }
      if (event.code === WIDGET_CLOSE_CODES.matchEnded) {
        state.value = 'ended'
        flushPending('not_live')
        return
      }
      if (event.code >= 4000 && event.code < 5000) {
        state.value = 'refused'
        flushPending('unavailable')
        return
      }
      flushPending('unavailable')
      scheduleRetry()
    }
  }

  const scheduleRetry = (): void => {
    if (closed) return
    state.value = 'reconnecting'
    const delay = Math.min(maxMs, initialMs * 2 ** attempt)
    attempt += 1
    retry = clock.after(delay, () => {
      retry = null
      open()
    })
  }

  const reopen = (): void => {
    hangUp()
    attempt = 0
    closeCode.value = null
    open()
  }

  const send: WidgetLink['send'] = (command, args) => {
    tapCounter += 1
    const correlationId = `${session}:${command}:${tapCounter}`
    const s = socket
    if (state.value !== 'open' || !s || s.readyState !== OPEN) {
      return Promise.resolve(
        rejected(correlationId, command, state.value === 'ended' ? 'not_live' : 'unavailable'),
      )
    }
    return new Promise(resolve => {
      const timer = clock.after(WIDGET_COMMAND_TIMEOUT_MS, () => {
        pending.delete(correlationId)
        resolve(rejected(correlationId, command, 'unavailable'))
      })
      pending.set(correlationId, { resolve, timer })
      s.send(JSON.stringify({ type: 'command', correlationId, command, ...(args && { args }) }))
    })
  }

  const close = (): void => {
    closed = true
    hangUp()
    flushPending('unavailable')
    state.value = 'closed'
  }

  const stop = watch(
    () => [toValue(options.orchestratorUrl) ?? null, toValue(options.playerToken) ?? null],
    () => reopen(),
    { immediate: true },
  )
  onScopeDisposeSafe(() => {
    stop()
    close()
  })

  return {
    state,
    hello,
    commands: computed(() => commands.value),
    lastEvent,
    closeCode,
    onEvent(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    onPush(handler) {
      pushListeners.add(handler)
      return () => pushListeners.delete(handler)
    },
    send,
    close,
  }
}

/** `onScopeDispose` outside any effect scope warns; a composable used from a plain test has none. */
function onScopeDisposeSafe(fn: () => void): void {
  try {
    onScopeDispose(fn, true)
  } catch {
    // no active scope: the caller closes by hand
  }
}
