using System.Text;

namespace EZPug.Sdk;

/// <summary>
/// <b>A line from outside, made safe to say</b> — the C# twin of the simulator's
/// <c>sanitizeChatLine</c> (<c>packages/sim/src/chat.ts</c>), applied to the two kinds of
/// text a server is handed rather than writes: a client's <c>announce</c> and the
/// assignment's warmup lines (PRD-02 T30). The rule is one rule on both boxes, so a line
/// a simulated match printed and a line a real server printed are the same line.
///
/// What it takes out, and why each:
///
/// <list type="bullet">
/// <item><b>Control characters</b> become a space. A newline ends an RCON command as
/// surely as a <c>;</c> does — the operator fallback's dialect is <c>say "&lt;line&gt;"</c>
/// — and the engine's chat palette lives in the same range (<see cref="ChatColor"/>), so
/// this is also what stops a client from painting the rest of a line green.</item>
/// <item><b><c>;</c>, <c>"</c> and <c>\</c></b> become a space, for the same console.</item>
/// <item><b>Runs of whitespace</b> collapse, so a line broken across two does not come
/// back as one run-on word and a line of spaces is nothing at all.</item>
/// <item><b>Length</b> is clamped to <see cref="MaxLength"/> here rather than left to
/// the game: CS2 drops whatever does not fit, and a line cut at a different place on
/// every provider is a line no test can pin. Counted in code points, so an emoji is
/// never cut in half.</item>
/// </list>
///
/// A line with nothing left is <c>null</c>: the caller decides what an empty
/// announcement means (the runtime refuses the command, the warmup printer drops the
/// line), because printing a blank line into a match nobody asked to be confused by is
/// not one of the choices.
/// </summary>
public static class SaidLine
{
    /// <summary>One chat line's budget, in code points — CS2's own, and the simulator's <c>CHAT_LINE_MAX_LENGTH</c>.</summary>
    public const int MaxLength = 127;

    /// <summary><paramref name="line"/> as a server may be handed it, or <c>null</c> when nothing survived.</summary>
    public static string? Sanitize(string line)
    {
        var cleaned = new StringBuilder(line.Length);
        var spaced = true;
        var kept = 0;
        foreach (var rune in line.EnumerateRunes())
        {
            var safe = rune.Value < 0x20 || rune.Value == 0x7f || rune.Value is ';' or '"' or '\\'
                ? new System.Text.Rune(' ')
                : rune;
            if (System.Text.Rune.IsWhiteSpace(safe))
            {
                // One space between words, and never one in front of the first.
                spaced = true;
                continue;
            }

            if (spaced && cleaned.Length > 0)
            {
                if (kept == MaxLength)
                {
                    break;
                }

                cleaned.Append(' ');
                kept++;
            }

            if (kept == MaxLength)
            {
                break;
            }

            cleaned.Append(safe);
            kept++;
            spaced = false;
        }

        var said = cleaned.ToString().TrimEnd();
        return said.Length == 0 ? null : said;
    }
}
