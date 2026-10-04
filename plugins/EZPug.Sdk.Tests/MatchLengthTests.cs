using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>A length for a mode with nothing to win</b> (PRD-03 T9): the shipped
/// <c>powerup-dm</c> manifest played on the harness until its duration runs out, a frag
/// limit reached, a server nobody comes to and a server everybody left — each ending in
/// the terminal facts the orchestrator releases a server on, with the reason, and with no
/// winner for one team. Then what the length must never do: end a <c>matchzy</c> match on
/// anything but an empty server, count a plain bot as somebody being there, or count a
/// stranger at the door of a mode whose roster is its guest list.
/// </summary>
public class MatchLengthTests
{
    private const ulong Tk = 76561198000000001;
    private const ulong Maex = 76561198000000002;

    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static GameRules Live =>
        new(Warmup: false, RoundsPlayed: 0, Paused: false, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: false);

    private static GamemodeTestHost Started(AssignedGamemode manifest, MatchSimulation? simulation = null)
    {
        var host = new GamemodeTestHost();
        host.World.Rules = Live;
        host.Start(GamemodeTestHost.AssignmentFor(manifest, teamA: [GamemodeTestHost.Player(Tk, "tk", Locale.De)]) with { Simulation = simulation });
        return host;
    }

    [Fact]
    public void TheShippedDeathmatchEndsWhenItsTenMinutesAreUp()
    {
        using var host = Started(Manifest("powerup-dm"));
        var tk = host.World.Connect(Tk, "tk", PlayerTeam.Terrorist);
        host.World.StartRound();

        var live = Assert.Single(host.Link.EventsOf<GoingLiveEvent>());
        Assert.Equal((600L, (long?)null), (live.Length!.DurationSeconds, live.Length.FragLimit));

        host.World.Elapse(599_000);
        Assert.Empty(host.Link.EventsOf<SeriesEndEvent>());
        host.World.Elapse(1_000);

        var map = Assert.Single(host.Link.EventsOf<MapEndEvent>());
        var series = Assert.Single(host.Link.EventsOf<SeriesEndEvent>());
        Assert.Equal((MatchEndReason.TimeLimit, (MatchTeam?)null), (map.Reason, map.Winner));
        Assert.Equal((MatchEndReason.TimeLimit, (MatchTeam?)null), (series.Reason, series.Winner));
        Assert.Contains(host.World.Said[Tk], line => line.Contains("Die Zeit ist um"));

        // The engine plays on until the release arrives. None of it is this match's.
        host.World.StartRound();
        host.World.EndMap();
        Assert.Single(host.Link.EventsOf<GoingLiveEvent>());
        Assert.Single(host.Link.EventsOf<SeriesEndEvent>());
        Assert.False(host.Runtime.Length.Armed);
        _ = tk;
    }

    [Fact]
    public void AOneTeamModeNamesNoWinnerOnTheWinPanelEither()
    {
        using var host = Started(Manifest("powerup-dm"));
        host.World.Connect(Tk, "tk", PlayerTeam.Terrorist);
        host.World.StartRound();
        host.World.EndRound(PlayerTeam.Terrorist, RoundEndReason.TimeExpired, tScore: 1, ctScore: 0);
        host.World.EndMap();

        var map = Assert.Single(host.Link.EventsOf<MapEndEvent>());
        var series = Assert.Single(host.Link.EventsOf<SeriesEndEvent>());
        Assert.Null(map.Winner);
        Assert.Null(series.Winner);
        // The game ended it, not the length.
        Assert.Null(map.Reason);
        Assert.Null(series.Reason);
    }

    [Fact]
    public void ATimeScaleDividesTheClockAndTheFactSaysTheSecondsInForce()
    {
        using var host = Started(Manifest("powerup-dm"), new MatchSimulation { TimeScale = 2 });
        host.World.Connect(Tk, "tk", PlayerTeam.Terrorist);
        host.World.StartRound();

        Assert.Equal(300L, Assert.Single(host.Link.EventsOf<GoingLiveEvent>()).Length!.DurationSeconds);
        host.World.Elapse(300_000);
        Assert.Equal(MatchEndReason.TimeLimit, Assert.Single(host.Link.EventsOf<SeriesEndEvent>()).Reason);
    }

    [Fact]
    public void TheFirstPlayerToTheFragLimitEndsItAndASuicideIsNobodysFrag()
    {
        var manifest = Manifest("powerup-dm") with { Length = new GamemodeLength { FragLimit = 3 } };
        using var host = Started(manifest);
        var tk = host.World.Connect(Tk, "tk", PlayerTeam.Terrorist);
        var maex = host.World.Connect(Maex, "maex", PlayerTeam.CounterTerrorist);

        // Warmup frags count for nothing: the map is not live.
        host.World.Kill(maex, tk);
        host.World.StartRound();
        Assert.Equal((long?)3, Assert.Single(host.Link.EventsOf<GoingLiveEvent>()).Length!.FragLimit);

        host.World.Kill(maex, tk);
        host.World.Kill(tk, tk);
        host.World.Kill(tk, null);
        host.World.Kill(maex, tk);
        Assert.Equal(2, host.Runtime.Length.LeadingFrags);
        Assert.Empty(host.Link.EventsOf<SeriesEndEvent>());

        host.World.Kill(maex, tk);
        var series = Assert.Single(host.Link.EventsOf<SeriesEndEvent>());
        Assert.Equal(MatchEndReason.FragLimit, series.Reason);
        // The frag that ended it is in the log before the end is.
        Assert.Equal(["player_death", "map_end", "series_end"], host.Link.EventTypes.TakeLast(3));
        Assert.Contains(host.World.Said[Tk], line => line.Contains("Frag-Limit"));
    }

    [Fact]
    public void AServerNobodyComesToEndsItselfBeforeItEverWentLive()
    {
        using var host = Started(Manifest("powerup-dm"));
        Assert.True(host.Runtime.Length.Idling);

        host.World.Elapse(300_000);

        // Never live, so there is no map to have ended — and still a terminal fact.
        Assert.Empty(host.Link.EventsOf<MapEndEvent>());
        var series = Assert.Single(host.Link.EventsOf<SeriesEndEvent>());
        Assert.Equal((MatchEndReason.Idle, (MatchTeam?)null), (series.Reason, series.Winner));
    }

    [Fact]
    public void TheIdleClockStartsWhenTheLastPersonLeavesAndStopsWhenSomebodyComes()
    {
        using var host = Started(Manifest("powerup-dm"));
        var tk = host.World.Connect(Tk, "tk", PlayerTeam.Terrorist);
        var maex = host.World.Connect(Maex, "maex", PlayerTeam.CounterTerrorist);
        Assert.False(host.Runtime.Length.Idling);
        host.World.StartRound();

        host.World.Disconnect(tk);
        Assert.False(host.Runtime.Length.Idling);
        host.World.Disconnect(maex);
        Assert.True(host.Runtime.Length.Idling);

        // Somebody comes back in time, and the clock starts from nought the next time the
        // room empties.
        host.World.Elapse(200_000);
        maex = host.World.Connect(Maex, "maex", PlayerTeam.CounterTerrorist);
        Assert.False(host.Runtime.Length.Idling);
        host.World.Elapse(10_000);
        Assert.Empty(host.Link.EventsOf<SeriesEndEvent>());

        host.World.Disconnect(maex);
        host.World.Elapse(299_000);
        Assert.Empty(host.Link.EventsOf<SeriesEndEvent>());
        host.World.Elapse(1_000);
        var map = Assert.Single(host.Link.EventsOf<MapEndEvent>());
        var series = Assert.Single(host.Link.EventsOf<SeriesEndEvent>());
        Assert.Equal((MatchEndReason.Idle, MatchEndReason.Idle), (map.Reason, series.Reason));
    }

    [Fact]
    public void APlainBotKeepsNobodysSeatWarm()
    {
        using var host = Started(Manifest("powerup-dm"));
        host.World.ArriveBot("BOT Krikey", PlayerTeam.Terrorist);
        Assert.True(host.Runtime.Length.Idling);

        host.World.Elapse(300_000);
        Assert.Equal(MatchEndReason.Idle, Assert.Single(host.Link.EventsOf<SeriesEndEvent>()).Reason);
    }

    [Fact]
    public void RetakesEndsOnItsRoundsAndOnAnEmptyServerOnly()
    {
        using var host = Started(Manifest("retakes"));
        host.World.Connect(Tk, "tk", PlayerTeam.Terrorist);
        host.World.StartRound();

        // No duration and no frag limit: nothing for a client to count, so nothing said.
        Assert.Null(Assert.Single(host.Link.EventsOf<GoingLiveEvent>()).Length);
        host.World.Elapse(3_600_000);
        Assert.Empty(host.Link.EventsOf<SeriesEndEvent>());
    }

    [Fact]
    public void AMatchzyMatchKeepsOnlyTheIdleTimeoutAndTheHostSaysTheEnd()
    {
        // MatchZy's rounds are MatchZy's: a duration a frame carried anyway ends nothing.
        // An empty server is nobody's game (decision 26 as amended, 2026-10-04), so the
        // idle clock runs — and the end is the host's to say, never the generic flow's.
        var manifest = Manifest("pug") with { Length = new GamemodeLength { DurationSeconds = 60, IdleTimeoutSeconds = 30 } };
        using var host = Started(manifest);
        var asked = new List<MatchEndReason>();
        var told = new List<MatchEndReason>();
        host.Runtime.EndHook = reason =>
        {
            asked.Add(reason);
            return true;
        };
        host.Runtime.LengthEnded += told.Add;

        Assert.True(host.Runtime.Length.Armed);
        Assert.Null(host.Runtime.Length.InForce);
        // Before the host says the match went live, nobody being there is the join
        // window's to judge.
        Assert.False(host.Runtime.Length.Idling);
        host.Runtime.Length.HostWentLive();
        Assert.True(host.Runtime.Length.Idling);
        host.World.Elapse(29_000);
        Assert.Empty(asked);
        host.World.Elapse(1_000);

        Assert.Equal([MatchEndReason.Idle], asked);
        Assert.Equal([MatchEndReason.Idle], told);
        Assert.Empty(host.Link.EventsOf<SeriesEndEvent>());
        Assert.False(host.Runtime.Length.Armed);
        host.World.Elapse(120_000);
        Assert.Single(asked);
    }

    [Fact]
    public void TheShippedPugEndsTenMinutesAfterTheLastRosteredPlayerLeft()
    {
        using var host = Started(Manifest("pug"));
        var asked = new List<(MatchEndReason Reason, long AtMs)>();
        host.Runtime.EndHook = reason =>
        {
            asked.Add((reason, host.World.Clock.NowMs));
            return true;
        };
        var tk = host.World.Connect(Tk, "tk", PlayerTeam.CounterTerrorist);
        host.Runtime.Length.HostWentLive();
        host.World.Elapse(3_600_000);
        Assert.Empty(asked);

        host.World.Disconnect(tk);
        var leftAt = host.World.Clock.NowMs;
        // Somebody the roster does not name is turned away at the door, and is never on the
        // server for the clock's purposes: knocking every minute holds nothing open.
        for (var knock = 0; knock < 5; knock++)
        {
            host.World.Elapse(60_000);
            host.World.Disconnect(host.World.Connect(76561198145418067, "stranger", PlayerTeam.Spectator));
        }

        host.World.Elapse(600_000 - 5 * 60_000 - 1_000);
        Assert.Empty(asked);
        host.World.Elapse(1_000);
        var end = Assert.Single(asked);
        Assert.Equal((MatchEndReason.Idle, leftAt + 600_000), end);
    }

    [Fact]
    public void AMatchzyMatchNobodyReachedIsTheJoinWindowsToJudge()
    {
        // A cup's join window is fifteen minutes and a pug's idle timeout ten: counting from
        // server_ready would end a match its players were still allowed to reach.
        using var host = Started(Manifest("pug"));
        var asked = new List<MatchEndReason>();
        host.Runtime.EndHook = reason =>
        {
            asked.Add(reason);
            return true;
        };
        var tk = host.World.Connect(Tk, "tk", PlayerTeam.CounterTerrorist);
        host.World.Disconnect(tk);
        host.World.Elapse(3_600_000);
        Assert.Empty(asked);
        Assert.False(host.Runtime.Length.Idling);
    }

    [Fact]
    public void AMatchzyMatchWhoseHostCannotEndItEndsNothingByItself()
    {
        // A server whose host never took the hook — an SDK host without MatchZy's flow —
        // ends nothing on its own: the generic flow does not speak for MatchZy.
        using var host = Started(Manifest("pug"));
        host.Runtime.Length.HostWentLive();
        host.World.Elapse(600_000);
        Assert.Empty(host.Link.EventsOf<SeriesEndEvent>());
        Assert.Empty(host.Link.EventsOf<MapEndEvent>());
    }

    [Fact]
    public void WhereTheRosterIsTheGuestListOnlyTheRosterKeepsTheServerWarm()
    {
        using var host = Started(Manifest("rush"));
        host.World.Connect(76561198145418067, "stranger", PlayerTeam.Terrorist);
        Assert.True(host.Runtime.Length.Idling);

        var tk = host.World.Connect(Tk, "tk", PlayerTeam.CounterTerrorist);
        Assert.False(host.Runtime.Length.Idling);
        host.World.Disconnect(tk);
        Assert.True(host.Runtime.Length.Idling);
        host.World.Elapse(300_000);
        Assert.Equal(MatchEndReason.Idle, Assert.Single(host.Link.EventsOf<SeriesEndEvent>()).Reason);
    }

    [Fact]
    public void AReleaseStopsEveryClock()
    {
        using var host = Started(Manifest("powerup-dm"));
        Assert.True(host.Runtime.Length.Idling);

        host.Link.Release("force_ended");
        Assert.False(host.Runtime.Length.Idling);
        host.World.Elapse(600_000);
        Assert.Empty(host.Link.EventsOf<SeriesEndEvent>());
    }
}
