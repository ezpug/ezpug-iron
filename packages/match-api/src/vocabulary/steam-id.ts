import { z } from 'zod'

/**
 * A SteamID64 as it travels: a 17-digit decimal string, never a number —
 * it exceeds `Number.MAX_SAFE_INTEGER`, so JSON would round it into a
 * different person's account. The platform's `identity.ts` grammar, verbatim:
 * Steam is the source of truth for "who" on both sides of this contract, and
 * the orchestrator never keeps a player registry of its own — a SteamID64 is
 * the only person-shaped key it ever sees.
 */
export const steamId64Schema = z
  .string()
  .regex(/^\d{17}$/, 'expected a 17-digit SteamID64 as a string')
export type SteamId64 = z.infer<typeof steamId64Schema>
