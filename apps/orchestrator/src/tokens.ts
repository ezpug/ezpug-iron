import { createHash, randomBytes } from 'node:crypto'

/**
 * **Every secret this process mints, in one grammar.** `ezi<kind>_<43 chars
 * base64url>`: the prefix makes a leaked one greppable in a log, a fixture or
 * a paste (a test greps recorded fixtures for these prefixes, the platform's
 * `FAKE_SECRET_PREFIXES` rule), the kind letter says what it opens, and the
 * 32 random bytes behind it come from the platform CSPRNG — never from a
 * seeded stream, because a previous token must say nothing about the next.
 *
 * Nothing but the SHA-256 of a token is stored ({@link hashToken}); the
 * lookup is by hash, so a database dump opens nothing.
 */
export const TOKEN_KINDS = {
  /** An API key (`Authorization: Bearer`). */
  apiKey: 'ezik',
  /** A server's link token (`hello.token` on `/link`). */
  server: 'ezis',
  /** A node's link token (`hello.token` on `/node`, after enrolment). */
  node: 'ezin',
  /** A node's one-time enrolment token (`POST /v1/fleet/nodes`). */
  enrolment: 'ezie',
  /** A player token, for a widget's socket. */
  player: 'ezip',
} as const
export type TokenKind = keyof typeof TOKEN_KINDS

/** Every prefix a minted token may start with — what a fixture scrub greps for. */
export const TOKEN_PREFIXES: readonly string[] = Object.values(TOKEN_KINDS).map(kind => `${kind}_`)

/** Random bytes behind a token. 256 bits — not guessable, still short. */
export const TOKEN_SECRET_BYTES = 32

/** How many leading characters of an API key its public `prefix` shows. */
export const API_KEY_PREFIX_LENGTH = 12

/** A source of random bytes; injectable so a test can pin a token's shape. */
export type RandomBytes = (size: number) => Buffer

/** Mint a token of one kind. */
export function mintToken(kind: TokenKind, random: RandomBytes = randomBytes): string {
  return `${TOKEN_KINDS[kind]}_${random(TOKEN_SECRET_BYTES).toString('base64url')}`
}

/** SHA-256 of a token, lowercase hex — what a token table stores. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** True when `token` is shaped like one of ours of `kind` — a cheap refusal before any lookup. */
export function looksLikeToken(kind: TokenKind, token: string): boolean {
  return token.startsWith(`${TOKEN_KINDS[kind]}_`) && token.length <= 128 && !/\s/.test(token)
}

/** The characters of an API key an operator sees in a list. */
export function apiKeyPrefix(secret: string): string {
  return secret.slice(0, API_KEY_PREFIX_LENGTH)
}
