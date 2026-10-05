using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>Rush seats its people</b> (PRD-09 T2, decision 35): on the fake world, a 3v3 Rush
/// whose whole roster clicked CT ends up three a side, somebody who switches is put back,
/// a stranger never gets past the door, and the modes somebody else seats are left alone.
/// </summary>
public class SeatingTests
{
    private const ulong Ada = 76561198000000001;
    private const ulong Ana = 76561198000000002;
    private const ulong Avi = 76561198000000003;
    private const ulong Ben = 76561198000000011;
    private const ulong Bob = 76561198000000012;
    private const ulong Bea = 76561198000000013;
    private const ulong Stranger = 76561198000000099;

    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static GameRules Rules(bool warmup, bool switching = false) =>
        new(warmup, RoundsPlayed: 0, Paused: false, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: switching);

    /// <summary>A 3v3 of <paramref name="gamemode"/> in warmup: team A German and on CT (the plan's default), team B English and on T.</summary>
    private static GamemodeTestHost Match(string gamemode = "rush", string map = "rush_001", MatchSimulation? simulation = null)
    {
        var host = new GamemodeTestHost();
        host.World.Rules = Rules(warmup: true);
        var assignment = GamemodeTestHost.AssignmentFor(
            Manifest(gamemode),
            map: map,
            teamA: [GamemodeTestHost.Player(Ada, "Ada"), GamemodeTestHost.Player(Ana, "Ana"), GamemodeTestHost.Player(Avi, "Avi")],
            teamB: [GamemodeTestHost.Player(Ben, "Ben", Locale.En), GamemodeTestHost.Player(Bob, "Bob", Locale.En), GamemodeTestHost.Player(Bea, "Bea", Locale.En)],
            maps: [new MapPlan { Map = map, Sides = MapPlanSides.Ct }]);
        host.Start(simulation is null ? assignment : assignment with { Simulation = simulation });
        return host;
    }

    private static List<FakePlayer> EverybodyOn(GamemodeTestHost host, PlayerTeam team) =>
        [.. new[] { (Ada, "Ada"), (Ana, "Ana"), (Avi, "Avi"), (Ben, "Ben"), (Bob, "Bob"), (Bea, "Bea") }
            .Select(entry => host.World.Connect(entry.Item1, entry.Item2, team))];

    private static string Placed(GamemodeTestHost host, MatchTeam team, string side, Locale locale) =>
        host.Runtime.Brand.Line(locale == Locale.De
            ? $"Du spielst für {host.Runtime.Brand.TeamName(team)}, deshalb bist du jetzt {side}."
            : $"You play for {host.Runtime.Brand.TeamName(team)}, so you are on {side} now.");

    private static IReadOnlyList<WorldAction> Moves(GamemodeTestHost host) =>
        [.. host.World.Actions.Where(action => action.Verb == "team")];

    [Fact]
    public void AWholeRosterThatClickedCtIsSeatedThreeASide_AndOnlyThenTheCountdownRuns()
    {
        using var host = Match();
        Assert.True(host.Runtime.Seating.Seats);
        Assert.True(host.Runtime.Seating.KeepsTheDoor);
        var players = EverybodyOn(host, PlayerTeam.CounterTerrorist);

        host.World.Elapse(Seating.SeatIntervalMs);
        Assert.Equal(
            [PlayerTeam.CounterTerrorist, PlayerTeam.CounterTerrorist, PlayerTeam.CounterTerrorist, PlayerTeam.Terrorist, PlayerTeam.Terrorist, PlayerTeam.Terrorist],
            players.Select(player => player.Team));
        // Only the three who were off their side were moved, each told once in their own language.
        Assert.Equal([Ben, Bob, Bea], Moves(host).Select(action => action.SteamId64!.Value));
        // (The first line is the greeting every connect gets, which names the team already.)
        Assert.Equal([Placed(host, MatchTeam.TeamB, "T", Locale.En)], host.World.Said[Bea].Skip(1));
        Assert.Single(host.World.Said[Ada]);
        Assert.Contains("info: seating: Ben (76561198000000011) was on CT; their side is T", host.Logged);
        Assert.Equal("3 on CT, 3 on T; 6 of 6 rostered on their side; the roster is the guest list", host.Runtime.Seating.Report());

        // The flow counted them on the beat before; on this one everybody is where they belong.
        host.World.Elapse(GenericFlow.PollIntervalMs);
        Assert.False(host.Runtime.Flow.WaitingForPeople);
        Assert.Contains(host.World.Said[Ada], line => line.Contains("Alle sind da"));
        Assert.Equal(3, Moves(host).Count);
    }

    [Fact]
    public void SomebodyInTheTeamMenuOrSpectatingIsSeatedToo()
    {
        using var host = Match();
        var ada = host.World.Connect(Ada, "Ada");
        var ben = host.World.Connect(Ben, "Ben", PlayerTeam.Spectator);
        host.World.Elapse(Seating.SeatIntervalMs);
        Assert.Equal(PlayerTeam.CounterTerrorist, ada.Team);
        Assert.Equal(PlayerTeam.Terrorist, ben.Team);
        Assert.Equal(Placed(host, MatchTeam.TeamA, "CT", Locale.De), host.World.Said[Ada].Last());
    }

    [Fact]
    public void SomebodyWhoSwitchesIsPutBack_LiveToo()
    {
        using var host = Match();
        EverybodyOn(host, PlayerTeam.None);
        host.World.Elapse(Seating.SeatIntervalMs);
        var ben = (FakePlayer)host.World.Find(Ben)!;
        host.World.Rules = Rules(warmup: false);
        host.World.StartRound();
        Assert.Equal(1, host.World.Said[Ben].Count(line => line.Contains("so you are on")));

        // He picks CT in the middle of the map: the next beat puts him back and says so again.
        ben.Team = PlayerTeam.CounterTerrorist;
        host.World.Elapse(Seating.SeatIntervalMs);
        Assert.Equal(PlayerTeam.Terrorist, ben.Team);
        Assert.Equal(2, host.World.Said[Ben].Count(line => line.Contains("so you are on")));
    }

    [Fact]
    public void ABodyTheEngineWillNotMoveIsTriedAgainOnlyAfterAWhile_AndTalkedToOnce()
    {
        using var host = Match();
        var ben = host.World.Connect(Ben, "Ben", PlayerTeam.CounterTerrorist);
        // The engine says yes and does nothing.
        host.World.Acted += action =>
        {
            if (action.Verb == "team")
            {
                ben.Team = PlayerTeam.CounterTerrorist;
            }
        };

        host.World.Elapse(Seating.SeatIntervalMs);
        host.World.Elapse(Seating.RetryMs - Seating.SeatIntervalMs);
        Assert.Single(Moves(host));
        host.World.Elapse(Seating.SeatIntervalMs);
        Assert.Equal(2, Moves(host).Count);
        Assert.Contains(host.Logged, line => line == "warn: seating: Ben (76561198000000011) is still on CT; moving them to T again");
        Assert.Single(host.World.Said[Ben], line => line.Contains("so you are on"));
        // What an operator reads at the console while it lasts.
        host.World.Connect(Ada, "Ada", PlayerTeam.CounterTerrorist);
        Assert.Equal(
            "2 on CT, 0 on T; 1 of 2 rostered on their side, off it: Ben on CT for T; the roster is the guest list",
            host.Runtime.Seating.Report());
    }

    [Fact]
    public void APuppetOffItsSideIsMovedWithoutALine()
    {
        using var host = Match(simulation: new MatchSimulation());
        host.World.Elapse(Puppeteer.SeatIntervalMs);
        var bodies = host.World.ArriveAskedBots();
        Assert.All(bodies, body => Assert.True(body.IsPuppet));
        var ada = bodies.Single(body => body.SteamId64 == Ada);
        Assert.Equal(PlayerTeam.CounterTerrorist, ada.Team);

        ada.Team = PlayerTeam.Terrorist;
        host.World.Elapse(Seating.SeatIntervalMs);
        Assert.Equal(PlayerTeam.CounterTerrorist, ada.Team);
        Assert.Empty(host.World.Said);
    }

    [Fact]
    public void NobodyIsMovedWhileTheEngineSwapsTheSides()
    {
        // flying-scoutsman keeps halftime on, so its sides change in the middle of the map.
        using var host = Match("flying-scoutsman", "de_mirage");
        var ada = host.World.Connect(Ada, "Ada", PlayerTeam.CounterTerrorist);
        var ben = host.World.Connect(Ben, "Ben", PlayerTeam.Terrorist);
        host.World.Rules = Rules(warmup: false);
        host.World.StartRound();
        host.World.EndRound(PlayerTeam.CounterTerrorist, RoundEndReason.Elimination, 0, 1);

        // Halftime: the gamerules flag the swap, and at the reset the engine moves everybody.
        host.World.Rules = Rules(warmup: false, switching: true);
        host.World.Elapse(Seating.SeatIntervalMs);
        (ada.Team, ben.Team) = (PlayerTeam.Terrorist, PlayerTeam.CounterTerrorist);
        host.World.Elapse(Seating.SeatIntervalMs);
        host.World.Rules = Rules(warmup: false);
        host.World.Elapse(5 * Seating.SeatIntervalMs);
        Assert.Empty(Moves(host));

        // The round start says the swap, and everybody is where the new sides want them.
        host.World.StartRound();
        host.World.Elapse(5 * Seating.SeatIntervalMs);
        Assert.Equal(TeamSide.T, host.Runtime.Match.TeamASide);
        Assert.Empty(Moves(host));
        Assert.Equal(PlayerTeam.Terrorist, ada.Team);
    }

    [Fact]
    public void AStrangerIsTurnedAwayAtTheDoor_AndNothingSaysTheyWereEverHere()
    {
        using var host = Match();
        host.World.Connect(Ada, "Ada", PlayerTeam.CounterTerrorist);
        host.World.Connect(Stranger, "Eve", PlayerTeam.CounterTerrorist);
        var bot = host.World.ArriveBot("BOT Kim");
        host.World.Elapse(Seating.SeatIntervalMs);

        Assert.Equal(
            [new WorldAction("kick", Stranger, "Du stehst nicht auf der Liste dieses Matches / You are not on this match's roster")],
            host.World.Actions.Where(action => action.Verb == "kick"));
        Assert.Null(host.World.Find(Stranger));
        // A plain bot is nobody's guest and nobody's stranger.
        Assert.NotNull(host.World.Find(bot.SteamId64));
        Assert.Equal(["server_ready", "player_connected"], host.Link.EventTypes);
        Assert.Contains($"info: door: Eve ({Stranger}) is not on the roster of 6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b; turned away", host.Logged);
    }

    [Fact]
    public void AStrangerWhoWasHereBeforeTheMatchIsTurnedAwayOnTheFirstBeat()
    {
        using var host = new GamemodeTestHost();
        host.World.Rules = Rules(warmup: true);
        host.World.Connect(Stranger, "Eve", PlayerTeam.CounterTerrorist);
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("rush"), map: "rush_001", teamA: [GamemodeTestHost.Player(Ada, "Ada")]));
        host.World.Elapse(Seating.SeatIntervalMs);
        Assert.Null(host.World.Find(Stranger));
        Assert.Single(host.World.Actions, action => action.Verb == "kick");
    }

    [Fact]
    public void AnOpenModeLetsAnybodyIn_AndStillSeatsItsRoster()
    {
        using var host = Match("flying-scoutsman", "de_mirage");
        Assert.True(host.Runtime.Seating.Seats);
        Assert.False(host.Runtime.Seating.KeepsTheDoor);
        host.World.Connect(Stranger, "Eve", PlayerTeam.CounterTerrorist);
        var ben = host.World.Connect(Ben, "Ben", PlayerTeam.CounterTerrorist);
        host.World.Elapse(Seating.SeatIntervalMs);
        Assert.NotNull(host.World.Find(Stranger));
        Assert.Equal(PlayerTeam.Terrorist, ben.Team);
        // Somebody who joined open has no roster side, so nothing moves them.
        Assert.Equal([Ben], Moves(host).Select(action => action.SteamId64!.Value));
    }

    [Theory]
    [InlineData("pug", "de_mirage")]
    [InlineData("retakes", "de_mirage")]
    public void AModeSomebodyElseSeatsIsLeftAlone(string gamemode, string map)
    {
        // MatchZy seats and guards a pug (decision 19); retakes splits its one group itself every round (decision 27).
        using var host = Match(gamemode, map);
        Assert.False(host.Runtime.Seating.Seats);
        Assert.False(host.Runtime.Seating.KeepsTheDoor);
        host.World.Connect(Stranger, "Eve", PlayerTeam.CounterTerrorist);
        host.World.Connect(Ben, "Ben", PlayerTeam.CounterTerrorist);
        host.World.Elapse(10 * Seating.SeatIntervalMs);
        Assert.Empty(Moves(host));
        Assert.DoesNotContain(host.World.Actions, action => action.Verb == "kick");
        Assert.Equal("not the SDK's for this mode", host.Runtime.Seating.Report());
    }

    [Fact]
    public void AReleasedServerSeatsNobody()
    {
        using var host = Match();
        host.Link.Release("completed");
        host.World.Connect(Stranger, "Eve", PlayerTeam.CounterTerrorist);
        host.World.Elapse(10 * Seating.SeatIntervalMs);
        Assert.DoesNotContain(host.World.Actions, action => action.Verb is "team" or "kick");
        Assert.Equal("no match", host.Runtime.Seating.Report());
    }
}
