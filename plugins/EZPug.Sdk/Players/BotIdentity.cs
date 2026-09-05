namespace EZPug.Sdk;

/// <summary>
/// <b>Bots on the wire.</b> The vocabulary names every player by a 17-digit SteamID64
/// and the engine gives a bot none (its SteamID is <c>0</c>), yet a bot's death or kill
/// is a real event in a match bots play. So a bot is named by its slot in a range no
/// Steam account can occupy: real SteamID64s start at <c>76561197960265728</c>; these
/// start at <c>90000000000000000</c>. Stable for the bot's connection, obviously synthetic
/// to anything that reads it, and one rule for the core plugin, the harness and the sim.
/// </summary>
public static class BotIdentity
{
    /// <summary>The first synthetic id; the slot is added to it.</summary>
    public const ulong Base = 90_000_000_000_000_000;

    /// <summary>One past the last synthetic id (64 slots is the engine's ceiling, 1000 leaves room).</summary>
    public const ulong End = Base + 1_000;

    /// <summary>The SteamID64 a bot in <paramref name="slot"/> is known by.</summary>
    public static ulong SteamId64Of(int slot) =>
        slot is >= 0 and < 1_000 ? Base + (ulong)slot : throw new ArgumentOutOfRangeException(nameof(slot), slot, "a slot is 0..999");

    /// <summary>Whether a SteamID64 is one of ours rather than Steam's.</summary>
    public static bool IsBot(ulong steamId64) => steamId64 is >= Base and < End;
}
