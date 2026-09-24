using System.Text.RegularExpressions;

namespace EZPug.Sdk;

/// <summary>
/// <b>The wire's map name, read on the server side</b> (PRD-05 T1, ezpug/ezpug-iron#3). A
/// match plan names an official map by its engine name (<c>de_mirage</c>) and a workshop
/// map <c>workshop/&lt;id&gt;/&lt;name&gt;</c> (<c>@ezpug/match-api</c>'s
/// <c>mapIdentifierSchema</c>). The engine takes neither spelling for a workshop map: it is
/// hosted with <c>host_workshop_map &lt;id&gt;</c>, and <c>changelevel workshop/…</c> is a
/// map that does not exist. This is the one place the SDK takes the identifier apart, so a
/// loader asks <see cref="WorkshopIdOf"/> and never matches the string itself.
/// </summary>
public static class MapIdentifier
{
    private static readonly Regex WorkshopPlan = new(
        "^workshop/([1-9][0-9]{0,19})/([a-z0-9_]+)$",
        RegexOptions.CultureInvariant);

    /// <summary>
    /// A bare published-file id. The wire's grammar lets one through as an engine name, and
    /// no engine map is called that, so it is hosted as the workshop map it can only mean.
    /// </summary>
    private static readonly Regex BareWorkshopId = new("^[0-9]{6,20}$", RegexOptions.CultureInvariant);

    /// <summary>The published-file id to host for <paramref name="map"/>, or <c>null</c> for an official map.</summary>
    public static string? WorkshopIdOf(string map)
    {
        if (WorkshopPlan.Match(map) is { Success: true } plan)
        {
            return plan.Groups[1].Value;
        }

        return BareWorkshopId.IsMatch(map) ? map : null;
    }

    /// <summary>
    /// What a person reads for <paramref name="map"/>: the engine name for an official map
    /// and the <c>&lt;name&gt;</c> of a workshop plan (<c>workshop/3084291314/aim_map</c> →
    /// <c>aim_map</c>). A bare id stays an id; nothing better is known about it here.
    /// </summary>
    public static string NameOf(string map) =>
        WorkshopPlan.Match(map) is { Success: true } plan ? plan.Groups[2].Value : map;
}
