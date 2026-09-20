using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>A length for a mode with nothing to win</b> (PRD-03 T9): the shipped
/// <c>powerup-dm</c> manifest played on the harness until its duration runs out, a frag
/// limit reached, a server nobody comes to and a server everybody left — each ending in
/// the terminal facts the orchestrator releases a server on, with the reason, and with no
/// winner for one team. Then what the length must never do: end a <c>matchzy</c> match,
/// or count a plain bot as somebody being there.
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
    public void AMatchzyMatchIsNeverTheLengthsToEnd()
    {
        // No shipped matchzy manifest may declare one (the schema refuses it); a frame that
        // carried one anyway is still MatchZy's match.
        var manifest = Manifest("pug") with { Length = new GamemodeLength { DurationSeconds = 60, IdleTimeoutSeconds = 30 } };
        using var host = Started(manifest);

        Assert.False(host.Runtime.Length.Armed);
        host.World.Elapse(120_000);
        Assert.Empty(host.Link.EventsOf<SeriesEndEvent>());
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
