import { z } from 'zod'
import { assertClosedSet } from '../closed-set'
import { localeSchema } from '../vocabulary/locale'
import { matchIdSchema } from './common'

/**
 * **The widget host contract** (decision 17, the manifest's `widget.needs`).
 * The platform mounts a gamemode's widget in a sandboxed `iframe` served by
 * the orchestrator (`sandbox="allow-scripts"`, never same-origin) and injects
 * what the manifest says it needs. The transport is a `postMessage`
 * handshake, decided here so the platform's host and the kit's widget shell
 * implement one thing: a URL fragment would put a player token into browser
 * history and referrers, and a query string into the orchestrator's logs.
 *
 * The dance: the widget posts `ready` as soon as its script runs; the host
 * answers `init` with everything at once; the host posts `tokens` again
 * whenever the theme changes; the widget posts `size` whenever its content
 * height changes so the host can size the frame; the widget posts `error`
 * for what the host should show instead of a blank frame. Every message is
 * one JSON object with a `type`; the widget checks `event.origin` against the
 * origin it was mounted from, the host against the orchestrator's.
 */

/** The version of this handshake; a host and a widget on different majors do not talk. */
export const WIDGET_HOST_PROTOCOL = 1

/** A CSS custom property name, the platform's design tokens (`--signal-primary`). */
export const cssCustomPropertyNameSchema = z
  .string()
  .regex(/^--[a-zA-Z0-9_-]+$/, 'a CSS custom property name (`--signal-primary`)')

/** Design tokens as the host injects them: custom property → value. */
export const widgetTokensSchema = z.record(cssCustomPropertyNameSchema, z.string().max(256))
export type WidgetTokens = z.infer<typeof widgetTokensSchema>

export const widgetHostMessageSchema = z.discriminatedUnion('type', [
  /** Widget → host: the script runs, send `init`. */
  z.object({ type: z.literal('ezpug.widget.ready'), protocol: z.literal(WIDGET_HOST_PROTOCOL) }),
  /**
   * Host → widget: everything at once. `playerToken` is null for a viewer who
   * may watch but not tap (a spectator, an unrostered viewer); a widget whose
   * manifest `needs` it shows its own "watching only" state.
   */
  z.object({
    type: z.literal('ezpug.widget.init'),
    protocol: z.literal(WIDGET_HOST_PROTOCOL),
    /** The orchestrator's base URL; the widget opens its socket there. */
    orchestratorUrl: z.url(),
    matchId: matchIdSchema,
    locale: localeSchema,
    tokens: widgetTokensSchema,
    playerToken: z.string().min(1).nullable(),
  }),
  /** Host → widget: the theme changed. */
  z.object({ type: z.literal('ezpug.widget.tokens'), tokens: widgetTokensSchema }),
  /** Widget → host: my content is this tall now (CSS pixels). */
  z.object({ type: z.literal('ezpug.widget.size'), height: z.number().nonnegative().max(10_000) }),
  /** Widget → host: show this instead of me. */
  z.object({ type: z.literal('ezpug.widget.error'), message: z.string().min(1).max(512) }),
])
export type WidgetHostMessage = z.infer<typeof widgetHostMessageSchema>

export const WIDGET_HOST_MESSAGE_TYPES = [
  'ezpug.widget.ready',
  'ezpug.widget.init',
  'ezpug.widget.tokens',
  'ezpug.widget.size',
  'ezpug.widget.error',
] as const
export type WidgetHostMessageType = (typeof WIDGET_HOST_MESSAGE_TYPES)[number]

export type WidgetHostMessageOf<T extends WidgetHostMessageType> = Extract<
  WidgetHostMessage,
  { type: T }
>

assertClosedSet('widget host messages', widgetHostMessageSchema, 'type', WIDGET_HOST_MESSAGE_TYPES)
