import type { GamemodeManifest, MatchRequest } from '@ezpug/match-api'

/**
 * **The one precedence rule for cvars**, decided here and used by both the
 * assignment (`link/assign.ts`) and the MatchZy config (`matchzy.ts`): a
 * request's `rules.cvars` sit **under** the mode's, which sit **under** what
 * the rules derive — a request can never undo what a mode needs, and a mode
 * never redirects the round format behind the rules' back.
 */

/** The engine cvars the Match API's rules translate to. Nothing when the request has no rules: the mode's cfg decides. */
export function derivedCvars(rules: MatchRequest['rules']): Record<string, string> {
  if (!rules) return {}
  return {
    mp_maxrounds: String(rules.regulationRounds),
    mp_overtime_enable: rules.overtime.enabled ? '1' : '0',
    mp_overtime_maxrounds: String(rules.overtime.maxRounds),
    mp_overtime_startmoney: String(rules.overtime.startMoney),
  }
}

/** The flat cvar map the server applies: request under mode under rules. */
export function mergeCvars(
  request: MatchRequest,
  manifest: GamemodeManifest,
): Record<string, string> {
  return { ...(request.rules?.cvars ?? {}), ...manifest.cvars, ...derivedCvars(request.rules) }
}
