import {
  type Component,
  computed,
  defineComponent,
  defineCustomElement,
  h,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  toRef,
} from 'vue'
import { browserClock, type WidgetClock, type WidgetTimer } from './clock'
import { WIDGET_CONTEXT, type WidgetContext } from './context'
import { createT, normaliseLocale } from './i18n'
import { useWidgetLink } from './link'
import type { Locale } from './protocol'
import { WIDGET_BASE_CSS } from './tokens'

/**
 * **The element** — the gamemode's widget as the custom element the platform
 * mounts. The tag is `<ezpug-widget>`, its contract four attributes (or
 * properties) — `orchestrator-url`, `player-token`, `locale`, `match-id` —
 * and the design tokens as CSS custom properties on the element itself
 * (`applyWidgetTokens`; every name has a fallback, so the element renders
 * acceptably with nothing set). Inside, the kit provides the link, the
 * locale and `t()` (`useWidget()`), and the mode's component draws the rest.
 *
 * `defineWidget` in `mount.ts` is what a gamemode calls; this is the half
 * that defines the element without touching the document.
 */

export const WIDGET_TAG = 'ezpug-widget'

export interface DefineWidgetOptions {
  /** The custom element's tag. Default `ezpug-widget`. */
  tag?: string
  clock?: WidgetClock
  /** How often `now` ticks for countdowns. Default 250 ms. */
  tickMs?: number
  /** Extra shadow-root CSS after the kit's base rules. */
  styles?: string[]
}

/** The element's properties — what the attributes map to. */
export interface WidgetElementProps {
  orchestratorUrl?: string | null
  playerToken?: string | null
  locale?: string | null
  matchId?: string | null
}

/** The root every widget component mounts under: props in, context out. */
function createRoot(component: Component, options: DefineWidgetOptions) {
  const clock = options.clock ?? browserClock
  const tickMs = options.tickMs ?? 250
  return defineComponent({
    name: 'EzpugWidgetRoot',
    props: {
      orchestratorUrl: { type: String, default: null },
      playerToken: { type: String, default: null },
      locale: { type: String, default: null },
      matchId: { type: String, default: null },
    },
    setup(props) {
      const link = useWidgetLink({
        orchestratorUrl: () => props.orchestratorUrl,
        playerToken: () => props.playerToken,
        clock,
      })
      const locale = computed<Locale>(() =>
        normaliseLocale(props.locale ?? link.hello.value?.locale ?? 'de'),
      )
      const t = computed(() => createT(locale.value))
      const now = ref(clock.now())
      let tick: WidgetTimer | null = null
      const arm = (): void => {
        tick = clock.after(tickMs, () => {
          now.value = clock.now()
          arm()
        })
      }
      onMounted(arm)
      onBeforeUnmount(() => {
        tick?.cancel()
        tick = null
        link.close()
      })
      const context: WidgetContext = {
        link,
        locale,
        t,
        matchId: toRef(props, 'matchId') as WidgetContext['matchId'],
        playerToken: toRef(props, 'playerToken') as WidgetContext['playerToken'],
        clock,
        now,
      }
      provide(WIDGET_CONTEXT, context)
      return () => h(component)
    },
  })
}

export type WidgetElementConstructor = ReturnType<typeof defineCustomElement>

/**
 * Define the element (once per tag) and return its constructor. Safe to call
 * in a test with `happy-dom`: it touches nothing but `customElements`.
 */
export function defineWidgetElement(
  component: Component,
  options: DefineWidgetOptions = {},
): WidgetElementConstructor {
  const tag = options.tag ?? WIDGET_TAG
  const Root = createRoot(component, options)
  const Element = defineCustomElement(Root, {
    shadowRoot: true,
    styles: [WIDGET_BASE_CSS, ...(options.styles ?? [])],
  })
  const registry = globalThis.customElements
  if (registry && !registry.get(tag)) registry.define(tag, Element)
  return Element
}
