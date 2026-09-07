import type { WidgetHostMessage } from '@ezpug/match-api'
import { WIDGET_HOST_PROTOCOL, WIDGET_TOKEN_FALLBACKS } from '../src/index'

/**
 * **The harness's host** — what the platform's `GamemodeWidget` does, in a
 * page with switches: mount the frame, answer `ready` with `init`, re-post
 * `tokens` when the switch flips, size the frame to `size`, print `error`.
 * The session — the fake orchestrator's URL, the match, the player token —
 * comes from the dev server (`/__harness/session`), never from a URL.
 *
 * The frame is sandboxed without `allow-same-origin`, so its origin is
 * opaque and `event.origin` reads `"null"`: the host trusts the frame by
 * `event.source` instead, as any host of a sandboxed widget must.
 */

interface Session {
  orchestratorUrl: string
  gamemode: string
  matchId: string
  steamId64: string
  playerToken: string
  expiresAt: string
  state: string
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const frame = $<HTMLIFrameElement>('frame')
const localeSelect = $<HTMLSelectElement>('locale')
const watching = $<HTMLInputElement>('watching')
const tokensSwitch = $<HTMLInputElement>('tokens')
const fresh = $<HTMLButtonElement>('fresh')
const log = $<HTMLPreElement>('log')
const sessionLine = $<HTMLSpanElement>('session')
const gamemodeLine = $<HTMLSpanElement>('gamemode')

let session: Session | null = null
let ready = false
let lines = 0
let reloads = 0

function say(line: string): void {
  lines += 1
  log.textContent = `${String(lines).padStart(3, ' ')} ${line}
${log.textContent ?? ''}`.slice(0, 8_000)
}

function tokens(): Record<string, string> {
  return tokensSwitch.checked ? { ...WIDGET_TOKEN_FALLBACKS } : {}
}

function post(message: WidgetHostMessage): void {
  frame.contentWindow?.postMessage(message, '*')
  say(`→ ${message.type}`)
}

function init(): void {
  if (!session || !frame.contentWindow) return
  post({
    type: 'ezpug.widget.init',
    protocol: WIDGET_HOST_PROTOCOL,
    orchestratorUrl: session.orchestratorUrl,
    matchId: session.matchId,
    locale: localeSelect.value === 'en' ? 'en' : 'de',
    tokens: tokens(),
    playerToken: watching.checked ? null : session.playerToken,
  })
}

async function loadSession(freshMatch: boolean): Promise<void> {
  sessionLine.textContent = freshMatch ? 'starte ein neues Match …' : 'lade Session …'
  const response = await fetch('/__harness/session', { method: freshMatch ? 'POST' : 'GET' })
  if (!response.ok) {
    sessionLine.textContent = `Session fehlgeschlagen: ${response.status}`
    return
  }
  session = (await response.json()) as Session
  gamemodeLine.textContent = session.gamemode
  sessionLine.textContent = `match ${session.matchId} · ${session.state} · orchestrator ${session.orchestratorUrl} · token bis ${session.expiresAt}`
  if (ready) init()
  else {
    reloads += 1
    frame.src = `/frame.html?reload=${reloads}`
  }
}

window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow) return
  const data = event.data as Partial<WidgetHostMessage> | null
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return
  say(
    `← ${data.type}${data.type === 'ezpug.widget.size' ? ` ${data.height}` : ''}${data.type === 'ezpug.widget.error' ? ` ${data.message}` : ''}`,
  )
  switch (data.type) {
    case 'ezpug.widget.ready':
      if (data.protocol !== WIDGET_HOST_PROTOCOL) {
        say(`protocol mismatch: the widget speaks ${String(data.protocol)}`)
        return
      }
      ready = true
      init()
      return
    case 'ezpug.widget.size':
      if (typeof data.height === 'number') frame.style.height = `${Math.max(48, data.height)}px`
      return
    case 'ezpug.widget.error':
      sessionLine.textContent = `widget error: ${String(data.message)}`
      return
    default:
      return
  }
})

frame.addEventListener('load', () => {
  ready = false
})
localeSelect.addEventListener('change', () => init())
watching.addEventListener('change', () => init())
tokensSwitch.addEventListener('change', () =>
  post({ type: 'ezpug.widget.tokens', tokens: tokens() }),
)
fresh.addEventListener('click', () => void loadSession(true))

void loadSession(false)
