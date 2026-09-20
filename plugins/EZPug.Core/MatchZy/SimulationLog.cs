using System.Globalization;
using System.Text.RegularExpressions;

namespace EZPug.Core;

/// <summary>Who MatchZy-Enhanced decided a bot is: the engine's <c>UserId</c> for the body, and the roster entry it plays.</summary>
public sealed record SimulationMapping(int UserId, ulong SteamId64, string Name, string TeamSlot);

/// <summary>
/// <b>Reading the fork's mind, in its own words</b> (PRD-03 T7a).
///
/// <para>MatchZy-Enhanced's simulation mode keeps which bot is which roster entry in a
/// private dictionary (<c>SimulationMode.cs</c>, <c>simulationPlayersByUserId</c>) and
/// offers it to nobody: its <c>player_connect</c> payloads carry the rostered SteamID but
/// not the body, and the remote log leaves the process over HTTP to the orchestrator, not
/// to a plugin beside it. What it does do is <i>say</i> every decision on the server
/// console, and the two plugins share one process and therefore one
/// <see cref="Console.Out"/> — so the mapping is read from the horse's mouth
/// (<see cref="ConsoleTap"/>) rather than guessed at from arrival order, which would be a
/// second opinion about something only the fork knows.</para>
///
/// <para>These are the fork's own format strings, transcribed. A release that reworded one
/// is a red test, not a silent room of anonymous bots: <c>SimulationLogTests</c> renders
/// each of them out of the pinned clone and parses the result. Anything else on the
/// console is none of our business.</para>
/// </summary>
public static partial class SimulationLog
{
    /// <summary>The prefix <c>MatchZy.Log</c> writes before every line of its own (<c>Utility.cs</c>).</summary>
    public const string Prefix = "[MatchZy] [SimulationMode] ";

    /// <summary>Whether a console line is worth queueing at all — cheap, because every line the server writes is offered.</summary>
    public static bool Ours(string line) => line.Contains("[SimulationMode]", StringComparison.Ordinal);

    /// <summary>
    /// The mapping a line announces, or <c>null</c>. Two lines say one:
    /// <c>AssignSimulationIdentityForBot</c> when a bot is first given an identity, and the
    /// reconcile pass when a bot that lost one is given another.
    /// </summary>
    public static SimulationMapping? Mapped(string line)
    {
        var trimmed = line.Trim();
        if (Assigned().Match(trimmed) is { Success: true } assigned)
        {
            return Read(assigned);
        }

        return Remapped().Match(trimmed) is { Success: true } remapped ? Read(remapped) : null;
    }

    /// <summary>
    /// The <c>UserId</c> whose roster slot a line frees, or <c>null</c>. The world hears the
    /// body leave by itself; this is only how the log says why the room went one short.
    /// </summary>
    public static int? Released(string line)
    {
        var trimmed = line.Trim();
        var match = ReleasedSlot().Match(trimmed);
        if (!match.Success)
        {
            match = DroppedStale().Match(trimmed);
        }

        return match.Success && int.TryParse(match.Groups["uid"].ValueSpan, CultureInfo.InvariantCulture, out var userId)
            ? userId
            : null;
    }

    private static SimulationMapping? Read(Match match) =>
        int.TryParse(match.Groups["uid"].ValueSpan, CultureInfo.InvariantCulture, out var userId)
        && ulong.TryParse(match.Groups["steam"].ValueSpan, CultureInfo.InvariantCulture, out var steamId64)
            ? new SimulationMapping(userId, steamId64, match.Groups["name"].Value, match.Groups["slot"].Value)
            : null;

    // `Assigned bot {PlayerName} (UserId {userId}, TeamNum={n}) to simulated player {ConfigName} ({ConfigSteamId}) on {TeamSlot}`
    [GeneratedRegex(@"^\[MatchZy\] \[SimulationMode\] Assigned bot .* \(UserId (?<uid>\d+), TeamNum=-?\d+\) to simulated player (?<name>.*) \((?<steam>\d+)\) on (?<slot>\S+)$")]
    private static partial Regex Assigned();

    // `Reconcile: mapped bot UserId={u} ({PlayerName}) to {ConfigName} ({ConfigSteamId}, {TeamSlot}).`
    [GeneratedRegex(@"^\[MatchZy\] \[SimulationMode\] Reconcile: mapped bot UserId=(?<uid>\d+) \(.*\) to (?<name>.*) \((?<steam>\d+), (?<slot>[^)]*)\)\.$")]
    private static partial Regex Remapped();

    // `Released roster slot {ConfigName} ({ConfigSteamId}, {TeamSlot}) from UserId={u} ({reason}).`
    [GeneratedRegex(@"^\[MatchZy\] \[SimulationMode\] Released roster slot .* \(\d+, [^)]*\) from UserId=(?<uid>\d+) \(.*\)\.$")]
    private static partial Regex ReleasedSlot();

    // `Reconcile: dropped stale mapping for UserId={u}.`
    [GeneratedRegex(@"^\[MatchZy\] \[SimulationMode\] Reconcile: dropped stale mapping for UserId=(?<uid>\d+)\.$")]
    private static partial Regex DroppedStale();
}
