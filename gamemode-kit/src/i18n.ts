import type { Locale } from './protocol'

/**
 * **Bilingual copy, the manifest's way.** Everything a widget says is a
 * `{ de, en }` pair picked by the locale the host injected (or the roster's,
 * from the socket's `hello`), German by default — the same rule the
 * manifests and the plugin follow (CLAUDE.md "Bilingual where a human reads
 * it"). No catalogue, no keys: the copy sits where it is used, and a widget
 * author who forgets one language gets a type error, not an English fallback.
 */

/** One line in both languages. */
export interface Bilingual {
  de: string
  en: string
}

export const LOCALES: readonly Locale[] = ['de', 'en']
export const DEFAULT_LOCALE: Locale = 'de'

/** `'de' | 'en'` from whatever the host or an attribute handed over; anything else is the default. */
export function normaliseLocale(value: unknown): Locale {
  if (typeof value !== 'string') return DEFAULT_LOCALE
  const short = value.trim().toLowerCase().slice(0, 2)
  return short === 'en' ? 'en' : DEFAULT_LOCALE
}

export type TranslateParams = Record<string, string | number>

/** `t({ de, en }, params?)`: the line for the widget's locale, `{name}` placeholders filled in. */
export type Translate = (copy: Bilingual, params?: TranslateParams) => string

export function createT(locale: Locale): Translate {
  return (copy, params) => {
    const line = copy[locale] ?? copy[DEFAULT_LOCALE]
    if (!params) return line
    return line.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    )
  }
}

/** The kit's own lines — the states every widget passes through before the mode's own copy takes over. */
export const KIT_COPY = {
  connecting: { de: 'Verbinde …', en: 'Connecting…' },
  reconnecting: {
    de: 'Verbindung verloren – versuche es erneut …',
    en: 'Connection lost – retrying…',
  },
  watching: { de: 'Nur zuschauen', en: 'Watching only' },
  watchingHint: {
    de: 'Du bist nicht in diesem Match. Zuschauen geht, tippen nicht.',
    en: 'You are not in this match. You may watch, not tap.',
  },
  ended: { de: 'Das Match ist vorbei.', en: 'The match is over.' },
  refused: {
    de: 'Der Server hat die Verbindung abgelehnt.',
    en: 'The server refused the connection.',
  },
  closed: { de: 'Getrennt.', en: 'Disconnected.' },
  noHost: {
    de: 'Kein Host: dieses Widget gehört in die Match-Seite.',
    en: 'No host: this widget belongs on the match page.',
  },
  unavailable: {
    de: 'Keine Antwort vom Server – versuch es gleich noch mal.',
    en: 'No answer from the server – try again in a moment.',
  },
  notLive: { de: 'Das Match läuft noch nicht.', en: 'The match is not live yet.' },
  applied: { de: 'Angekommen.', en: 'Landed.' },
} as const satisfies Record<string, Bilingual>
