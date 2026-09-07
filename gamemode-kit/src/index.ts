/**
 * `@ezpug/gamemode-kit` — the runtime a gamemode's phone widget is written
 * on (decision 17). A widget is a Vue component, `defineWidget(Component)`
 * makes it the `<ezpug-widget>` custom element the platform mounts, and the
 * kit's Vite preset (`@ezpug/gamemode-kit/vite`, `ezpug-widget build`) turns
 * `gamemodes/<id>/widget/` into `gamemodes/<id>/dist/widget.js` — one file,
 * Vue and the kit inside, no runtime fetch beyond its socket.
 *
 * - `defineWidget` / `mountWidget`: the element and the host handshake.
 * - `useWidget()`, `useT()`: the link, the locale and `t()` inside a component.
 * - `useWidgetLink()`: the socket to the orchestrator on its own, for a test
 *   or a page that is not the platform.
 * - `WIDGET_TOKEN_FALLBACKS`, `applyWidgetTokens`: the design tokens.
 * - `createT`, `KIT_COPY`: bilingual copy the manifest's way.
 */

export { browserClock, type WidgetClock, type WidgetTimer } from './clock'
export { useT, useWidget, WIDGET_CONTEXT, type WidgetContext } from './context'
export {
  type DefineWidgetOptions,
  defineWidgetElement,
  WIDGET_TAG,
  type WidgetElementConstructor,
  type WidgetElementProps,
} from './element'
export {
  connectToHost,
  type HostPort,
  type HostShell,
  type HostShellOptions,
  type HostState,
  isFramed,
} from './host'
export {
  type Bilingual,
  createT,
  DEFAULT_LOCALE,
  KIT_COPY,
  LOCALES,
  normaliseLocale,
  type Translate,
  type TranslateParams,
} from './i18n'
export {
  useWidgetLink,
  type WidgetCommandView,
  type WidgetLink,
  type WidgetLinkOptions,
  type WidgetLinkState,
  type WidgetSocket,
  widgetSocketUrl,
} from './link'
export { defineWidget, type MountWidgetOptions, mountWidget } from './mount'
export * from './protocol'
export {
  applyWidgetTokens,
  sanitiseWidgetTokens,
  WIDGET_BASE_CSS,
  WIDGET_TOKEN_FALLBACKS,
  WIDGET_TOKEN_NAMES,
} from './tokens'
