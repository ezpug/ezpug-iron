using System.Text.RegularExpressions;

namespace EZPug.Sdk;

/// <summary>
/// The vocabulary's chat split, decided once at the edge
/// (<c>parseServerChatLine</c> in <c>@ezpug/match-api</c>): a line beginning with
/// <c>!</c>, <c>.</c> or <c>/</c> followed by a bare command name is a <c>chat_command</c>;
/// everything else — a prefix alone, <c>!!!</c>, an empty remainder — is a
/// <c>chat_message</c>, because refusing to relay a line for its first character would
/// lose a real one.
/// </summary>
public static partial class ChatParser
{
    public static readonly IReadOnlyList<char> CommandPrefixes = ['!', '.', '/'];

    public abstract record Parsed
    {
        public sealed record Command(string Name, string? Args) : Parsed;

        public sealed record Message(string Text) : Parsed;
    }

    [GeneratedRegex("^[a-z0-9][a-z0-9_-]*$")]
    private static partial Regex BareCommand();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();

    public static Parsed Parse(string raw)
    {
        var text = raw.Trim();
        if (text.Length > 0 && CommandPrefixes.Contains(text[0]))
        {
            var remainder = text[1..].Trim();
            var parts = remainder.Length == 0 ? [""] : Whitespace().Split(remainder);
            var command = parts[0].ToLowerInvariant();
            if (BareCommand().IsMatch(command))
            {
                var args = string.Join(' ', parts.Skip(1));
                return new Parsed.Command(command, args.Length > 0 ? args : null);
            }
        }

        return new Parsed.Message(text);
    }
}
