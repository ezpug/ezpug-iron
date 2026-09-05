using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// Where the match stands, as the runtime tracks it from what the world and the mode
/// say: the map and round numbers every scoped event carries (1-based, the
/// vocabulary's rule), whether the map is live, and which side team A plays so a
/// player's engine team becomes <c>team_a</c>/<c>team_b</c> in an event. The runtime
/// advances it — a round start bumps the round, a <c>map_end</c> the map, a
/// <c>side_swap</c> the sides — and a mode reads it.
/// </summary>
public sealed class MatchContext
{
    public string? MatchId { get; internal set; }

    /// <summary>1-based map within the series.</summary>
    public long MapNumber { get; internal set; } = 1;

    /// <summary>1-based round within the map; <c>0</c> before the first round starts.</summary>
    public long RoundNumber { get; internal set; }

    /// <summary>Between <c>going_live</c> and <c>map_end</c>.</summary>
    public bool Live { get; internal set; }

    /// <summary>The side team A is on right now. From the map plan at assignment, swapped by a <c>side_swap</c>.</summary>
    public TeamSide TeamASide { get; internal set; } = TeamSide.Ct;

    /// <summary>The per-match sequence hint the last emitted event carried.</summary>
    public long LastSeq { get; internal set; }

    /// <summary>Which vocabulary team a player on <paramref name="team"/> belongs to, by the sides in effect.</summary>
    public MatchTeam? TeamOf(PlayerTeam team) =>
        team switch
        {
            PlayerTeam.CounterTerrorist => TeamASide == TeamSide.Ct ? MatchTeam.TeamA : MatchTeam.TeamB,
            PlayerTeam.Terrorist => TeamASide == TeamSide.T ? MatchTeam.TeamA : MatchTeam.TeamB,
            _ => null,
        };

    internal void Reset(string matchId, TeamSide teamASide)
    {
        MatchId = matchId;
        MapNumber = 1;
        RoundNumber = 0;
        Live = false;
        TeamASide = teamASide;
        LastSeq = 0;
    }

    internal void Clear()
    {
        MatchId = null;
        MapNumber = 1;
        RoundNumber = 0;
        Live = false;
        LastSeq = 0;
    }
}
