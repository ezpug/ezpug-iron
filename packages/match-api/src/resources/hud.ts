import type { z } from 'zod'
import { kebabNameSchema } from '../vocabulary/naming'
import { HUD_ART_KEYS, HUD_BANNER_KEYS } from './hud-keys'

/**
 * **The pictures a server can show** (PRD-07 T4, decision 34). A server's HUD
 * draws from a client addon, and a picture in it was compiled in before the
 * match: nothing can put a new one on screen at runtime. So a client names a
 * picture by **key**, and these two lists are every key the addon ships —
 * generated from the addon's own folders (`pnpm hud:keys`), so the list and
 * the files cannot disagree.
 *
 * The lists are for a picker. They are **not** what the schemas accept: a
 * key is any kebab-case name ({@link hudKeySchema}), and one the addon does
 * not hold shows the default picture, never a refusal — a client a release
 * ahead of the server, or an item nobody has drawn yet, costs a picture and
 * nothing else. {@link hudBannerKey} and {@link hudArtKey} are that rule,
 * for anyone who wants to show what a server would.
 *
 * A client that never looks at a HUD needs none of this: a server without
 * one ignores every key it is handed.
 */
export { HUD_ART_KEYS, HUD_BANNER_KEYS }

/** A banner the addon ships: the picture on the welcome (`branding.banner`). */
export type HudBannerKey = (typeof HUD_BANNER_KEYS)[number]

/** A picture the addon ships for a {@link momentCommandSchema | moment} (`moment.art`). */
export type HudArtKey = (typeof HUD_ART_KEYS)[number]

/** The longest key a request may carry. */
export const HUD_KEY_MAX = 64

/** A picture's key as a request carries it: kebab-case, known to the addon or not. */
export const hudKeySchema = kebabNameSchema.max(HUD_KEY_MAX)
export type HudKey = z.infer<typeof hudKeySchema>

/** The banner a match without one shows, and every unknown key falls back to: the house one. */
export const HUD_DEFAULT_BANNER_KEY = 'default' satisfies HudBannerKey

/** The picture a moment without one shows, and every unknown key falls back to: the empty card sleeve. */
export const HUD_DEFAULT_ART_KEY = 'empty' satisfies HudArtKey

/** The banner a server shows for `key`: the key itself when the addon ships it, the house banner otherwise. */
export function hudBannerKey(key: string | undefined): HudBannerKey {
  return (HUD_BANNER_KEYS as readonly string[]).includes(key ?? '')
    ? (key as HudBannerKey)
    : HUD_DEFAULT_BANNER_KEY
}

/** The picture a server shows for `key`: the key itself when the addon ships it, the empty sleeve otherwise. */
export function hudArtKey(key: string | undefined): HudArtKey {
  return (HUD_ART_KEYS as readonly string[]).includes(key ?? '')
    ? (key as HudArtKey)
    : HUD_DEFAULT_ART_KEY
}
