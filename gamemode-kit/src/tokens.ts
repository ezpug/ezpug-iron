import type { WidgetTokens } from './protocol'

/**
 * **The design tokens a widget may read, with fallbacks.** The names are the
 * platform's own custom properties (`packages/ui/app/assets/css/signal.css`
 * — Signal, its token layer) and the list is the one its host injects
 * (`packages/ui/src/widget.ts`, `WIDGET_TOKEN_NAMES`), so a widget author
 * writes `var(--ui-text)` and gets the same word the page around the frame
 * uses. The values are Signal's on 2026-09-07 — dark only, warm ivory on
 * warm black, CT blue and T gold — and they are *fallbacks*: the host's
 * `init` and `tokens` messages carry the live values, and a widget mounted
 * with nothing injected still renders as the platform would.
 *
 * `applyWidgetTokens` writes every name onto the element's own style, the
 * injected value where there is one and the fallback where there is not, so
 * `var(--ui-…)` never resolves to nothing inside the shadow root. (A
 * `--x: var(--x, fallback)` rule would be a cycle; setting the property on the
 * host is the way that is not.)
 */
export const WIDGET_TOKEN_FALLBACKS: Readonly<Record<string, string>> = Object.freeze({
  '--ui-primary': '#f0ece3',
  '--ui-on-primary': '#0b0a09',
  '--ui-bg': '#0b0a09',
  '--ui-bg-muted': '#110f0d',
  '--ui-bg-elevated': '#171512',
  '--ui-bg-accented': '#1f1c18',
  '--ui-border': '#242019',
  '--ui-border-muted': '#1b1814',
  '--ui-border-accented': '#332e27',
  '--ui-text-dimmed': '#5c564d',
  '--ui-text-muted': '#8a8378',
  '--ui-text-toned': '#b0a99d',
  '--ui-text': '#dad4c9',
  '--ui-text-highlighted': '#f7f3ec',
  '--ui-ct': '#86a6ff',
  '--ui-t': '#f0b655',
  '--ui-live': '#f43f5e',
  '--ui-success': '#7bd69a',
  '--ui-info': '#86a6ff',
  '--ui-warning': '#f0b655',
  '--ui-radius': '0.5rem',
  '--ui-motion-hover': '150ms',
  '--ui-motion-layout': '400ms',
  '--ui-motion-media': '800ms',
  '--font-sans': '"Manrope", ui-sans-serif, system-ui, sans-serif',
  '--font-mono': '"DM Mono", ui-monospace, monospace',
})

/** The names, in the table's order. */
export const WIDGET_TOKEN_NAMES: readonly string[] = Object.keys(WIDGET_TOKEN_FALLBACKS)

const NAME = /^--[a-zA-Z0-9_-]+$/

/** An injected token is a custom property name and a short value; anything else is dropped, never set. */
export function sanitiseWidgetTokens(injected: unknown): WidgetTokens {
  const out: WidgetTokens = {}
  if (!injected || typeof injected !== 'object') return out
  for (const [name, value] of Object.entries(injected as Record<string, unknown>)) {
    if (!NAME.test(name)) continue
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) continue
    out[name] = value
  }
  return out
}

/**
 * Set every known token on `host`: the injected value, else the fallback.
 * An injected name outside the table is set too (the platform may grow one
 * before this table does); a fallback never overrides an injected value.
 */
export function applyWidgetTokens(host: HTMLElement, injected: WidgetTokens = {}): void {
  const clean = sanitiseWidgetTokens(injected)
  for (const name of WIDGET_TOKEN_NAMES) {
    host.style.setProperty(name, clean[name] ?? WIDGET_TOKEN_FALLBACKS[name] ?? '')
  }
  for (const [name, value] of Object.entries(clean)) {
    if (!(name in WIDGET_TOKEN_FALLBACKS)) host.style.setProperty(name, value)
  }
}

/**
 * The `:host` rules every widget gets: a block, Signal's type and colour off
 * the tokens, a transparent background (the frame is the platform's
 * surface), and reduced motion honoured the way `signal.css` does it —
 * transitions off and everything at its final state.
 */
export const WIDGET_BASE_CSS = `
:host {
  display: block;
  box-sizing: border-box;
  font-family: var(--font-sans);
  color: var(--ui-text);
  background: transparent;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
}
:host *, :host *::before, :host *::after { box-sizing: inherit; }
@media (prefers-reduced-motion: reduce) {
  :host *, :host *::before, :host *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
`
