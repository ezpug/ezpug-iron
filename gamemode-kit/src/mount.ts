import type { Component } from 'vue'
import { watch } from 'vue'
import { browserClock, type WidgetClock } from './clock'
import {
  type DefineWidgetOptions,
  defineWidgetElement,
  WIDGET_TAG,
  type WidgetElementConstructor,
  type WidgetElementProps,
} from './element'
import { connectToHost, type HostShell, type HostShellOptions, isFramed } from './host'
import { applyWidgetTokens } from './tokens'

/**
 * **`mountWidget(Element)`** — the shell that runs inside the document the
 * orchestrator serves: create the element in the body (or take the one the
 * document already has), run the host handshake, and keep the element's
 * props and tokens in step with what the host says: `init` sets the
 * orchestrator URL, the match, the locale and the token; `tokens` restyles;
 * the element's content height goes back as `size`. A `null` token is a
 * viewer — the element gets none and the mode shows its watching state.
 */
export interface MountWidgetOptions extends HostShellOptions {
  /** The document to mount into. Default: `document`. */
  document?: Document
  /** The element's tag. Default `ezpug-widget`. */
  tag?: string
  clock?: WidgetClock
}

export interface MountedWidget {
  element: HTMLElement & WidgetElementProps
  host: HostShell
  dispose: () => void
}

export function mountWidget(
  _Element: WidgetElementConstructor,
  options: MountWidgetOptions = {},
): MountedWidget {
  const doc = options.document ?? document
  const tag = options.tag ?? WIDGET_TAG
  const clock = options.clock ?? browserClock
  let element = doc.querySelector(tag) as (HTMLElement & WidgetElementProps) | null
  if (!element) {
    element = doc.createElement(tag) as HTMLElement & WidgetElementProps
    doc.body.appendChild(element)
  }
  const el = element
  applyWidgetTokens(el)
  const host = connectToHost({ ...options, clock })

  const stop = watch(
    host.state,
    state => {
      if (state.status !== 'ready') return
      el.orchestratorUrl = state.orchestratorUrl
      el.matchId = state.matchId
      el.locale = state.locale
      el.playerToken = state.playerToken
      applyWidgetTokens(el, state.tokens)
    },
    { immediate: true, deep: true },
  )

  let observer: ResizeObserver | null = null
  const report = (): void => host.reportSize(el.getBoundingClientRect().height)
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(report)
    observer.observe(el)
  }

  return {
    element: el,
    host,
    dispose() {
      stop()
      observer?.disconnect()
      host.dispose()
    },
  }
}

/**
 * **`defineWidget(Component)`** — what a gamemode's `widget/index.ts` calls:
 * define `<ezpug-widget>` around the component and, when the script runs
 * inside a frame (the document the orchestrator serves, mounted by the
 * platform or the kit's harness), mount it and run the host handshake.
 * Returns the element's constructor either way.
 */
export function defineWidget(
  component: Component,
  options: DefineWidgetOptions & { mount?: boolean } = {},
): WidgetElementConstructor {
  const Element = defineWidgetElement(component, options)
  const shouldMount = options.mount ?? (typeof window !== 'undefined' && isFramed())
  if (shouldMount) mountWidget(Element, { tag: options.tag, clock: options.clock })
  return Element
}
