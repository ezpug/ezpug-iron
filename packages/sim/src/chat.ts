/**
 * **What a gameserver may be told to say** — the `announce` verb's line.
 *
 * A chat line is the one payload a server *executes* rather than stores: the
 * RCON fallback dialect is `say "<line>"`, a command string in which a `;`
 * starts the next command and a `"` ends the argument. Every adapter
 * sanitizes here rather than trusting its caller, and the simulator does it
 * too, so the rule is exercised on every box that never sees a real server.
 *
 * Truncation is ours for the same reason it is not the game's: CS2 drops
 * whatever does not fit into one chat line, and a line that is cut at a
 * different place on every provider is a line no test can pin.
 *
 * The platform's `chat.ts` on 2026-09-05, verbatim, plus {@link SIM_CHAT_EVENT}:
 * the name a simulated server says a line under, which lives here rather than
 * beside the playback so the story builder can reach it too.
 */

/**
 * **What a simulated server says out loud** — the `plugin_event` it deals for
 * every line it was told to say: a client's `announce`, and each of the
 * assignment's warmup lines while the match waits (PRD-02 T30). A real plugin
 * prints the line and says nothing back; the simulator publishes it through
 * the same delivery path as every other beat, so the line is *ordered* against
 * the match's own events and a test can prove an announcement landed after the
 * round that triggered it.
 */
export const SIM_CHAT_EVENT = 'chat_announced'

/** One chat line's budget, in characters — CS2's own, and what a test can pin. */
export const CHAT_LINE_MAX_LENGTH = 127

/**
 * The line as a server may be handed it: no control characters, no command
 * separators, no stray quoting, one space between words, bounded length.
 *
 * Throws when nothing survives — an empty announcement is a caller's bug, and
 * a server that shrugged at it would print a blank line into a match nobody
 * asked to be confused by.
 */
export function sanitizeChatLine(line: string): string {
  const cleaned = [...line]
    // Control characters (a newline ends an RCON command as surely as a `;`),
    // the two RCON metacharacters, and the backslash that would escape them —
    // all replaced by a space rather than deleted, so a line broken across two
    // does not come back as one run-on word.
    .map(char => {
      const code = char.codePointAt(0) ?? 0
      return code < 0x20 || code === 0x7f ? ' ' : char
    })
    .join('')
    .replaceAll(/[;"\\]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
  const said = [...cleaned].slice(0, CHAT_LINE_MAX_LENGTH).join('').trim()
  if (said.length === 0) {
    throw new Error('simulator: refusing to announce an empty chat line')
  }
  return said
}
