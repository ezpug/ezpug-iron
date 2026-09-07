import { type ComputedRef, type InjectionKey, inject, type Ref } from 'vue'
import type { WidgetClock } from './clock'
import type { Translate } from './i18n'
import type { WidgetLink } from './link'
import type { Locale } from './protocol'

/**
 * **What a widget's components get from the kit** — provided by the root
 * `defineWidget` mounts, injected with `useWidget()` anywhere below it.
 */
export interface WidgetContext {
  /** The socket to the orchestrator, or a `watching` link for a viewer. */
  link: WidgetLink
  /** The locale the host injected, else the roster's from the socket's `hello`, else German. */
  locale: ComputedRef<Locale>
  /** `t({ de, en })` for that locale. */
  t: ComputedRef<Translate>
  /** The match this widget was mounted for. */
  matchId: Ref<string | null>
  /** The player token, or `null` for a viewer. */
  playerToken: Ref<string | null>
  /** The clock every countdown reads. */
  clock: WidgetClock
  /** Epoch milliseconds, ticking while the widget is mounted — for cooldown rings and countdowns. */
  now: Ref<number>
}

export const WIDGET_CONTEXT: InjectionKey<WidgetContext> = Symbol('ezpug.widget')

export function useWidget(): WidgetContext {
  const context = inject(WIDGET_CONTEXT, null)
  if (!context)
    throw new Error('useWidget() needs a widget root: mount this component through defineWidget()')
  return context
}

/** The `t()` of the widget's locale. */
export function useT(): ComputedRef<Translate> {
  return useWidget().t
}
