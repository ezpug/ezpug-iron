using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using EZPug.Sdk.Tests.Modes;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>The SDK's generic flow emitter</b> (PRD-02 T22): a whole map of
/// <c>flying-scoutsman</c> — the shipped manifest, <c>flow: none</c>, no gamemode class
/// anywhere — played on the harness, and the complete story it tells from the engine's
/// own events. Then the edges: warmup says nothing, a matchzy flow is somebody else's,
/// a mode that owns its flow silences it, and a series says <c>series_end</c> only after
/// the last map the assignment planned.
/// </summary>
public class GenericFlowTests
{
    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static GameRules Rules(bool warmup, int roundsPlayed, bool switching = false) =>
        new(warmup, roundsPlayed, Paused: false, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: switching);

    /// <summary>A round: the engine starts it, somebody wins it, the count moves on.</summary>
    private static void PlayRound(GamemodeTestHost host, PlayerTeam winner, RoundEndReason reason, int t, int ct)
    {
        host.World.StartRound();
        host.World.EndRound(winner, reason, t, ct);
        host.World.Rules = host.World.Rules! with { RoundsPlayed = t + ct };
    }

    [Fact]
    public void AWholeMapOfFlyingScoutsmanWithNoPluginAnywhere()
    {
        // No mode: a config-tier manifest has no class to attach, so the runtime and this
        // emitter are the entire server side of the match.
        using var host = new GamemodeTestHost();
        var link = host.Link;
        host.World.Rules = Rules(warmup: true, roundsPlayed: 0);
        var assignment = host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("flying-scoutsman"),
            map: "de_dust2",
            maps: [new MapPlan { Map = "de_dust2", Sides = MapPlanSides.Ct }]));
        Assert.Equal(GamemodeFlow.None, assignment.Gamemode.Flow);
        Assert.True(host.Runtime.Flow.Active);
        Assert.Equal(["server_ready"], link.EventTypes);

        // Warmup is nobody's round: the engine restarts one every few seconds and none of
        // them is the match.
        host.World.StartRound();
        host.World.StartRound();
        Assert.Equal(["server_ready"], link.EventTypes);
        Assert.False(host.Runtime.Flow.Live);

        // Warmup ends. The first round after it is round 1, and the match is live.
        host.World.Rules = Rules(warmup: false, roundsPlayed: 0);
        PlayRound(host, PlayerTeam.CounterTerrorist, RoundEndReason.Elimination, t: 0, ct: 1);
        Assert.Equal(["server_ready", "going_live", "round_start", "round_end"], link.EventTypes);
        var live = Assert.Single(link.EventsOf<GoingLiveEvent>());
        Assert.Equal(("de_dust2", 1L), (live.Map, live.MapNumber));
        var first = Assert.Single(link.EventsOf<RoundStartEvent>());
        Assert.Equal((1L, 0L, 0L), (first.RoundNumber, first.Score!.TeamA, first.Score.TeamB));
        var won = Assert.Single(link.EventsOf<RoundEndEvent>());
        // Team A started CT, so the CT round is team A's — one apiece in team order.
        Assert.Equal((MatchTeam.TeamA, TeamSide.Ct, RoundWinCondition.Elimination), (won.Winner.Team, won.Winner.Side, won.WinCondition));
        Assert.Equal((1L, 1L, 0L), (won.RoundNumber, won.Score.TeamA, won.Score.TeamB));

        PlayRound(host, PlayerTeam.Terrorist, RoundEndReason.TimeExpired, t: 1, ct: 1);
        Assert.Equal((1L, 1L), (host.Runtime.Flow.Score.TeamA, host.Runtime.Flow.Score.TeamB));

        // Halftime: the engine flags the swap between the rounds, the poll sees it, and
        // the round that follows opens with `side_swap` — without which team A's rounds
        // would land on team B from here on, because CS2 swaps the scores with the sides.
        host.World.Rules = Rules(warmup: false, roundsPlayed: 2, switching: true);
        host.World.Elapse(GenericFlow.PollIntervalMs);
        host.World.Rules = Rules(warmup: false, roundsPlayed: 2);
        PlayRound(host, PlayerTeam.Terrorist, RoundEndReason.Elimination, t: 2, ct: 1);
        var swap = Assert.Single(link.EventsOf<SideSwapEvent>());
        Assert.Equal((TeamSide.T, TeamSide.Ct), (swap.Sides.TeamA, swap.Sides.TeamB));
        // Team A is on T now, so the T round is team A's second.
        var third = link.EventsOf<RoundEndEvent>()[2];
        Assert.Equal((MatchTeam.TeamA, TeamSide.T, 2L, 1L), (third.Winner.Team, third.Winner.Side, third.Score.TeamA, third.Score.TeamB));

        PlayRound(host, PlayerTeam.CounterTerrorist, RoundEndReason.BombDefused, t: 2, ct: 2);
        Assert.Equal((2L, 2L), (host.Runtime.Flow.Score.TeamA, host.Runtime.Flow.Score.TeamB));

        // The win panel: the map is over, and it was the only one planned.
        host.World.EndMap();
        var ended = Assert.Single(link.EventsOf<MapEndEvent>());
        Assert.Equal(("de_dust2", 2L, 2L), (ended.Map, ended.Score.TeamA, ended.Score.TeamB));
        Assert.Null(ended.Winner);
        var series = Assert.Single(link.EventsOf<SeriesEndEvent>());
        Assert.Equal((0L, 0L), (series.SeriesScore.TeamA, series.SeriesScore.TeamB));
        Assert.Null(series.Winner);
        Assert.False(host.Runtime.Flow.Live);

        // A second win panel says nothing twice, and the whole story is in order.
        host.World.EndMap();
        Assert.Equal(
            [
                "server_ready", "going_live", "round_start", "round_end", "round_start", "round_end",
                "side_swap", "round_start", "round_end", "round_start", "round_end", "map_end", "series_end",
            ],
            link.EventTypes);
        Assert.Equal(Enumerable.Range(1, link.Events.Count).Select(seq => (long?)seq), link.Events.Select(EventStamper.SeqOf));
    }

    [Fact]
    public void ItEndsTheWarmupItself_BecauseNobodyElseCan()
    {
        using var host = new GamemodeTestHost();
        host.World.Rules = Rules(warmup: true, roundsPlayed: 0);
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("flying-scoutsman"), map: "de_dust2"));

        // Nothing while the roster and the bots are still arriving.
        host.World.Elapse(GenericFlow.GoLiveDelayMs - GenericFlow.PollIntervalMs);
        Assert.DoesNotContain(host.World.Actions, action => action.Detail == "mp_warmup_end");

        // Then once — and again, because the engine re-enters warmup after an early one.
        host.World.Elapse(GenericFlow.PollIntervalMs);
        Assert.Equal(1, host.World.Actions.Count(action => action.Detail == "mp_warmup_end"));
        host.World.Elapse(GenericFlow.WarmupEndRetryMs - GenericFlow.PollIntervalMs);
        Assert.Equal(1, host.World.Actions.Count(action => action.Detail == "mp_warmup_end"));
        host.World.Elapse(GenericFlow.PollIntervalMs);
        Assert.Equal(2, host.World.Actions.Count(action => action.Detail == "mp_warmup_end"));

        // Warmup is over: the emitter stops asking and the first round is the match's.
        host.World.Rules = Rules(warmup: false, roundsPlayed: 0);
        host.World.Elapse(3 * GenericFlow.WarmupEndRetryMs);
        Assert.Equal(2, host.World.Actions.Count(action => action.Detail == "mp_warmup_end"));
        PlayRound(host, PlayerTeam.CounterTerrorist, RoundEndReason.Elimination, t: 0, ct: 1);
        Assert.Equal(["server_ready", "going_live", "round_start", "round_end"], host.Link.EventTypes);

        // Warmup coming back underneath a live match is ended again — the engine does
        // exactly that after a restart, and nobody else is going to.
        host.World.Rules = Rules(warmup: true, roundsPlayed: 1);
        host.World.Elapse(GenericFlow.WarmupEndRetryMs);
        Assert.Equal(3, host.World.Actions.Count(action => action.Detail == "mp_warmup_end"));

        // The map is over: the emitter is finished with it.
        host.World.EndMap();
        host.World.Elapse(3 * GenericFlow.WarmupEndRetryMs);
        Assert.Equal(3, host.World.Actions.Count(action => action.Detail == "mp_warmup_end"));
    }

    [Fact]
    public void ItLeavesAMatchZyFlowsWarmupAlone()
    {
        using var host = new GamemodeTestHost();
        host.World.Rules = Rules(warmup: true, roundsPlayed: 0);
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("pug")));
        host.World.Elapse(5 * GenericFlow.GoLiveDelayMs);
        Assert.DoesNotContain(host.World.Actions, action => action.Detail == "mp_warmup_end");
    }

    [Fact]
    public void ASeriesSaysSeriesEndOnlyAfterTheLastMapPlanned()
    {
        using var host = new GamemodeTestHost();
        host.World.Rules = Rules(warmup: false, roundsPlayed: 0);
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("flying-scoutsman"),
            map: "de_dust2",
            maps: [new MapPlan { Map = "de_dust2", Sides = MapPlanSides.Ct }, new MapPlan { Map = "de_mirage", Sides = MapPlanSides.T }]));

        PlayRound(host, PlayerTeam.CounterTerrorist, RoundEndReason.Elimination, t: 0, ct: 1);
        host.World.EndMap();
        Assert.Empty(host.Link.EventsOf<SeriesEndEvent>());
        Assert.Equal((1L, 0L), host.Runtime.Flow.SeriesScore);
        Assert.Equal(2, host.Runtime.Match.MapNumber);

        // Map two, from nothing: the score starts again, the series score does not, and
        // the ends the plan named for this map are taken before a round is played on them.
        host.World.StartMap("de_mirage");
        host.World.Rules = Rules(warmup: false, roundsPlayed: 0);
        Assert.Equal((0L, 0L), host.Runtime.Flow.Score);
        Assert.Equal(TeamSide.T, host.Runtime.Match.TeamASide);
        Assert.Equal(TeamSide.T, Assert.Single(host.Link.EventsOf<SideSwapEvent>()).Sides.TeamA);
        PlayRound(host, PlayerTeam.Terrorist, RoundEndReason.Elimination, t: 1, ct: 0);
        host.World.EndMap();
        var series = Assert.Single(host.Link.EventsOf<SeriesEndEvent>());
        // Team A is on T for map two (the plan says so), so map two is team A's as well.
        Assert.Equal((2L, 0L, MatchTeam.TeamA), (series.SeriesScore.TeamA, series.SeriesScore.TeamB, series.Winner));
        Assert.Equal(2, host.Link.EventsOf<MapEndEvent>().Count);
        Assert.Equal(2, host.Link.EventsOf<GoingLiveEvent>().Count);
    }

    [Fact]
    public void AMatchZyFlowIsSomebodyElsesStory()
    {
        using var host = new GamemodeTestHost();
        host.World.Rules = Rules(warmup: false, roundsPlayed: 0);
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("pug")));
        Assert.False(host.Runtime.Flow.Active);

        PlayRound(host, PlayerTeam.CounterTerrorist, RoundEndReason.Elimination, t: 0, ct: 1);
        host.World.EndMap();
        Assert.Equal(["server_ready"], host.Link.EventTypes);
    }

    [Fact]
    public void AModeThatOwnsItsFlowSilencesTheEmitter()
    {
        using var host = new GamemodeTestHost(new OwnFlowDemo());
        host.World.Rules = Rules(warmup: false, roundsPlayed: 0);
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("powerup-dm")));
        Assert.False(host.Runtime.Flow.Active);

        PlayRound(host, PlayerTeam.Terrorist, RoundEndReason.Elimination, t: 1, ct: 0);
        host.World.EndMap();
        // Only what the mode said itself.
        Assert.Equal(["server_ready", "plugin_event"], host.Link.EventTypes);
    }

    /// <summary>A plugin-flow mode that speaks for itself; only its round is on the wire.</summary>
    private sealed class OwnFlowDemo : Gamemode
    {
        public override string Id => "powerup-dm";

        public override bool OwnsFlow => true;

        public override void OnRoundEnd(RoundEnd roundEnd) => EmitPluginEvent("own_round_end", new { winner = roundEnd.Winner.ToString() });
    }
}
