import { type Ref, readonly, ref } from 'vue'
import { browserClock, type WidgetClock, type WidgetTimer } from './clock'
import { normaliseLocale } from './i18n'
import {
  type Locale,
  WIDGET_HOST_PROTOCOL,
  type WidgetHostMessage,
  type WidgetHostMessageOf,
  type WidgetTokens,
} from './protocol'
import { sanitiseWidgetTokens } from './tokens'

/**
 * **The widget's side of the host handshake** (decision 17, `WidgetHostMessage`
 * in `@ezpug/match-api`, `docs/gamemodes.md` "The widget host"). The platform
 * mounts the document the orchestrator serves in a sandboxed `iframe` and
 * talks to it by `postMessage` at protocol 1: the widget posts `ready`, the
 * host answers `init` with everything at once — the orchestrator URL, the
 * match, the locale, the design tokens, the player token or `null` — and
 * posts `tokens` again when the theme changes; the widget posts `size` as
 * its content grows and `error` for what the host should show instead.
 *
 * **Origin.** The widget accepts messages only from the origin it was
 * mounted from: it learns that origin (and the window) from the first valid
 * `init` and pins both; everything else is ignored. `ready` has to go out
 * with `'*'` — before `init` nothing is known and the message carries
 * nothing — and everything after goes to the pinned origin.
 *
 * **Patience.** `ready` is re-posted every second until `init` arrives, so a
 * host whose script attaches its listener after the frame ran still hears
 * it; after `orphanAfterMs` of silence the state says `orphan` and the
 * widget shows that it belongs on a match page.
 */

export interface HostState {
  /** `waiting` until `init`, `ready` after, `orphan` when nobody answered. */
  status: 'waiting' | 'ready' | 'orphan'
  orchestratorUrl: string | null
  matchId: string | null
  locale: Locale
  tokens: WidgetTokens
  playerToken: string | null
}

/** The corner of `Window` the shell posts to — the parent frame, or a stand-in in a test. */
export interface HostPort {
  postMessage: (message: unknown, targetOrigin: string) => void
}

export interface HostShellOptions {
  /** Where messages arrive. Default: `window`. */
  target?: EventTarget
  /** Who to post to. Default: `window.parent`. */
  parent?: HostPort
  clock?: WidgetClock
  /** How often `ready` is repeated until `init`. Default one second. */
  readyEveryMs?: number
  /** Silence this long after the first `ready` and the state is `orphan`. Default ten seconds. */
  orphanAfterMs?: number
}

export interface HostShell {
  state: Readonly<Ref<HostState>>
  /** Post `size` — the widget's content height in CSS pixels. */
  reportSize: (height: number) => void
  /** Post `error` — what the host should show instead of the widget. */
  reportError: (message: string) => void
  /** Stop listening and stop repeating `ready`. */
  dispose: () => void
}

type Init = WidgetHostMessageOf<'ezpug.widget.init'>

function isInit(data: unknown): data is Init {
  if (!data || typeof data !== 'object') return false
  const m = data as Record<string, unknown>
  return (
    m.type === 'ezpug.widget.init' &&
    m.protocol === WIDGET_HOST_PROTOCOL &&
    typeof m.orchestratorUrl === 'string' &&
    typeof m.matchId === 'string' &&
    (typeof m.playerToken === 'string' || m.playerToken === null)
  )
}

function isTokens(data: unknown): data is WidgetHostMessageOf<'ezpug.widget.tokens'> {
  if (!data || typeof data !== 'object') return false
  const m = data as Record<string, unknown>
  return m.type === 'ezpug.widget.tokens' && typeof m.tokens === 'object' && m.tokens !== null
}

/** True inside a frame — the only place the handshake has a counterpart. */
export function isFramed(): boolean {
  try {
    return typeof window !== 'undefined' && window.parent !== window
  } catch {
    return true
  }
}

export function connectToHost(options: HostShellOptions = {}): HostShell {
  const clock = options.clock ?? browserClock
  const target = options.target ?? window
  const parent = options.parent ?? window.parent
  const readyEveryMs = options.readyEveryMs ?? 1_000
  const orphanAfterMs = options.orphanAfterMs ?? 10_000

  const state = ref<HostState>({
    status: 'waiting',
    orchestratorUrl: null,
    matchId: null,
    locale: 'de',
    tokens: {},
    playerToken: null,
  })
  let pinnedOrigin: string | null = null
  let pinnedSource: unknown = null
  let repeat: WidgetTimer | null = null
  let orphan: WidgetTimer | null = null
  let disposed = false

  const post = (message: WidgetHostMessage): void => {
    if (disposed) return
    try {
      parent.postMessage(message, pinnedOrigin ?? '*')
    } catch {
      // a parent that cannot be reached is the orphan case; the timer says so
    }
  }

  const ready = (): void => {
    if (disposed || pinnedOrigin !== null) return
    post({ type: 'ezpug.widget.ready', protocol: WIDGET_HOST_PROTOCOL })
    repeat = clock.after(readyEveryMs, ready)
  }

  const onMessage = (event: Event): void => {
    const { data, origin, source } = event as MessageEvent
    if (pinnedOrigin === null) {
      if (!isInit(data)) return
      pinnedOrigin = origin
      pinnedSource = source
      if (repeat) {
        repeat.cancel()
        repeat = null
      }
      if (orphan) {
        orphan.cancel()
        orphan = null
      }
    } else if (origin !== pinnedOrigin || (pinnedSource !== null && source !== pinnedSource)) {
      return
    }
    if (isInit(data)) {
      state.value = {
        status: 'ready',
        orchestratorUrl: data.orchestratorUrl,
        matchId: data.matchId,
        locale: normaliseLocale(data.locale),
        tokens: sanitiseWidgetTokens(data.tokens),
        playerToken: data.playerToken,
      }
    } else if (isTokens(data)) {
      state.value = { ...state.value, tokens: sanitiseWidgetTokens(data.tokens) }
    }
  }

  target.addEventListener('message', onMessage)
  ready()
  orphan = clock.after(orphanAfterMs, () => {
    orphan = null
    if (pinnedOrigin === null) state.value = { ...state.value, status: 'orphan' }
  })

  return {
    state: readonly(state) as Readonly<Ref<HostState>>,
    reportSize(height) {
      if (pinnedOrigin === null) return
      post({ type: 'ezpug.widget.size', height: Math.max(0, Math.min(10_000, Math.round(height))) })
    },
    reportError(message) {
      if (pinnedOrigin === null) return
      post({ type: 'ezpug.widget.error', message: message.slice(0, 512) || 'error' })
    },
    dispose() {
      disposed = true
      target.removeEventListener('message', onMessage)
      repeat?.cancel()
      orphan?.cancel()
      repeat = null
      orphan = null
    },
  }
}
