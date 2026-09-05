import { z } from 'zod'

/**
 * The locale alphabet (CLAUDE.md "Bilingual where a human reads it"): German
 * and English, German first. A locale is a wire value here because a server
 * prints lines to a person — the roster entry carries the player's locale and
 * the plugin picks the language per player — and because a manifest's title
 * and description ship in both. Nothing the orchestrator says to a machine is
 * translated. The platform's `locale.ts` alphabet, verbatim.
 */
export const locales = ['de', 'en'] as const
export const localeSchema = z.enum(locales)
export type Locale = (typeof locales)[number]

/** What a player gets before anyone has said otherwise: German. */
export const DEFAULT_LOCALE: Locale = 'de'

/** One value per locale — the shape every translated thing takes. */
export type Localized<T> = Record<Locale, T>

/** A translated string on the wire: both languages, always, neither empty. */
export const localizedTextSchema = z.object({
  de: z.string().min(1),
  en: z.string().min(1),
})
export type LocalizedText = z.infer<typeof localizedTextSchema>
