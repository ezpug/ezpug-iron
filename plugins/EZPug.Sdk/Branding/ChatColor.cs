namespace EZPug.Sdk;

/// <summary>
/// <b>The engine's chat palette</b>, as the control characters CS2 reads inside a chat
/// line: <c>0x04</c> turns the rest of the line green, <c>0x01</c> turns it back to the
/// client's own colour. The values are CounterStrikeSharp's <c>ChatColors</c> (1.0.373,
/// read off the restored assembly), written as code points and copied here rather than
/// referenced, so the SDK keeps no game type on this seam — a line the SDK builds is a
/// string, and the world implementation only has to print it.
///
/// Colour belongs to chat and nowhere else: the centre card is HTML (see
/// <see cref="Branding.CardHtml"/>), and a hostname, an event name or a team name that
/// reaches either goes through <see cref="Strip"/> first, because a control character
/// inside a name is a colour nobody asked for.
/// </summary>
public static class ChatColor
{
    /// <summary>Back to the client's own colour — every painted run ends with this.</summary>
    public const char Default = (char)0x01;
    public const char White = (char)0x01;
    public const char DarkRed = (char)0x02;
    public const char LightPurple = (char)0x03;
    /// <summary>EZPug's own: the prefix, and anything the server says about itself.</summary>
    public const char Green = (char)0x04;
    public const char Olive = (char)0x05;
    public const char Lime = (char)0x06;
    public const char Red = (char)0x07;
    public const char Grey = (char)0x08;
    public const char Yellow = (char)0x09;
    public const char Silver = (char)0x0A;
    /// <summary>What the engine paints the CT side; the team playing CT is named in it.</summary>
    public const char Blue = (char)0x0B;
    public const char DarkBlue = (char)0x0C;
    public const char Purple = (char)0x0E;
    public const char LightRed = (char)0x0F;
    /// <summary>What the engine paints the T side; the team playing T is named in it.</summary>
    public const char Gold = (char)0x10;

    /// <summary>The lowest code point the palette occupies — with <see cref="Highest"/>, the range <see cref="Strip"/> removes.</summary>
    private const char Lowest = (char)0x01;
    private const char Highest = (char)0x10;

    /// <summary><paramref name="text"/> in <paramref name="color"/>, with the line's colour handed back afterwards.</summary>
    public static string Paint(char color, string text) => $"{color}{text}{Default}";

    /// <summary>
    /// <paramref name="text"/> with every palette character removed. What a name from
    /// outside — an event, a roster entry, a line a client wrote — goes through before it
    /// is pasted into one of ours, so nobody paints the rest of a line by putting a
    /// colour in their team's name.
    /// </summary>
    public static string Strip(string text) =>
        text.Any(character => character is >= Lowest and <= Highest)
            ? new string(text.Where(character => character is < Lowest or > Highest).ToArray())
            : text;
}
