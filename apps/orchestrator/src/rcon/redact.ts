import { redactSecrets } from '../log'

/**
 * **Never a password in a response** (PRD-02 T20, CLAUDE.md "secrets stay in
 * the process"). A console tail and an RCON answer are the two places in this
 * service where raw game-server text reaches a client, and a game server
 * prints its own secrets: `rcon_password` echoed back by the console,
 * `sv_password` in a `status` block, the GSLT in `sv_setsteamaccount`. An
 * operator asked for the console, not for the credentials of a server they can
 * already drive through the API.
 *
 * So every line that leaves here — and every line written into the ledger's
 * audit column — passes through this: the value after a password-ish cvar
 * becomes a marker, and any token of ours that somehow reached a line is
 * shortened to its prefix by {@link redactSecrets}.
 */

/** What a masked value says it was. Greppable, and obviously not a secret. */
export const CONSOLE_REDACTED = '<redacted>'

/**
 * A cvar or command whose *argument* is a credential, matched on the whole
 * word so `sv_password_check` is not mistaken for `sv_password`. The list is
 * what a CS2 server of ours can actually print: the engine's own passwords,
 * the GSLT (`sv_setsteamaccount`), MatchZy's remote-log and remote-backup
 * header values (which carry the server token, `match-config/matchzy.ts`),
 * and the presigned demo upload URL, whose signature *is* the credential.
 */
const SECRET_CVAR =
  /\b([a-z0-9_]*(?:password|passwd|secret)|sv_setsteamaccount|[a-z0-9_]*_token|[a-z0-9_]*api_?key|[a-z0-9_]*_header_value|[a-z0-9_]*_upload_url)\b([ \t]*[:=]?[ \t]*)("[^"\n]*"|[^\s]+)/gi

export function redactConsoleLine(line: string): string {
  return redactSecrets(
    line.replace(
      SECRET_CVAR,
      (_whole, cvar: string, gap: string, value: string) =>
        // The gap cannot cross a newline, so `rcon_password` alone at the end
        // of a line is a *read* and the line under it is left alone.
        `${cvar}${gap}${value.startsWith('"') ? `"${CONSOLE_REDACTED}"` : CONSOLE_REDACTED}`,
    ),
  )
}
