using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>A tower map told from the engine's events</b> (PRD-06 T3): the line of seven that
/// <c>rush_001</c>'s script walks, followed by the SDK from nothing but who won each round
/// and who was standing when it ended, and the generic flow saying it on every
/// <c>round_end</c> and on <c>map_end</c>. The rules are the script's, as
/// <c>packages/sim/src/tower.ts</c> reads them too.
/// </summary>
public class TowerLineTests
{
    [Fact]
    public void TheLineStartsInTheMiddleWithEachHalfHeldByItsSide()
    {
        var line = new TowerLine();
        Assert.Equal(TeamSide.Ct, line.HeldBy);
        Assert.Null(line.LastIndex);
        Assert.Null(line.End());

        // A T win in the start room takes CT's tower and moves play one room towards CT's
        // castle, into a room CT still holds; a CT win walks back down into T's half.
        var (first, captured) = line.Play(TeamSide.T, attackersStanding: true);
        Assert.Equal((4L, TeamSide.Ct, (RushRoomId?)null), (first.Room, first.HeldBy, first.RoomId));
        Assert.Equal(RoundWinCondition.TowerCaptured, captured);
        Assert.Equal(TeamSide.Ct, line.HeldBy);

        var (second, held) = line.Play(TeamSide.Ct, attackersStanding: true);
        Assert.Equal((5L, TeamSide.Ct), (second.Room, second.HeldBy));
        Assert.Equal(RoundWinCondition.TowerHeld, held);

        // Back in the start room, which T took in round 1 and still holds.
        Assert.Equal(TeamSide.T, line.HeldBy);
        var (third, eliminated) = line.Play(TeamSide.T, attackersStanding: false);
        Assert.Equal((4L, TeamSide.T), (third.Room, third.HeldBy));
        Assert.Equal(RoundWinCondition.Elimination, eliminated);
    }

    [Fact]
    public void ADrawLeavesTheRoomNobodysAndReplaysIt()
    {
        var line = new TowerLine();
        var (drawn, condition) = line.Play(null, attackersStanding: true);
        Assert.Equal((4L, TeamSide.Ct), (drawn.Room, drawn.HeldBy));
        Assert.Null(condition);

        // Same room, nobody's: whoever wins it took it.
        Assert.Null(line.HeldBy);
        var (replayed, taken) = line.Play(TeamSide.Ct, attackersStanding: false);
        Assert.Equal((4L, (TeamSide?)null), (replayed.Room, replayed.HeldBy));
        Assert.Equal(RoundWinCondition.TowerCaptured, taken);
    }

    [Fact]
    public void AWinInTheEnemyCastleEndsTheMapThere()
    {
        var line = new TowerLine();
        RoundTower last = null!;
        for (var round = 0; round < 4; round++)
        {
            (last, _) = line.Play(TeamSide.T, attackersStanding: true);
            Assert.Equal(round < 3 ? null : TowerMapEnding.Castle, line.Ending);
        }

        // Room 7 is CT's castle, and the rules name it.
        Assert.Equal((7L, (RushRoomId?)RushRoomId._301), (last.Room, last.RoomId));
        Assert.Equal(new MapTower { Room = 7, RoomId = RushRoomId._301, Ending = TowerMapEnding.Castle }, line.End());
    }

    [Fact]
    public void SevenAllSwapsConvoyIntoTheNextRoom()
    {
        var line = new TowerLine();
        // Fourteen rounds that go up and come back: 7–7, and play is in the start room.
        for (var round = 0; round < 14; round++)
        {
            var (tower, _) = line.Play(round % 2 == 0 ? TeamSide.T : TeamSide.Ct, attackersStanding: true);
            Assert.Null(tower.RoomId);
        }

        var (decider, _) = line.Play(TeamSide.Ct, attackersStanding: true);
        Assert.Equal((4L, (RushRoomId?)RushRoomId.Convoy), (decider.Room, decider.RoomId));
        Assert.Null(line.Ending);
        Assert.Equal(new MapTower { Room = 4, RoomId = RushRoomId.Convoy, Ending = TowerMapEnding.Rounds }, line.End());
    }

    [Fact]
    public void OnlyTheTowerMapIsOne()
    {
        Assert.True(TowerLine.IsTowerMap("rush_001"));
        Assert.False(TowerLine.IsTowerMap("de_dust2"));
        Assert.False(TowerLine.IsTowerMap(null));
    }

    // ------------------------------------------------------------------ the flow

    private static GameRules Rules(bool warmup, int roundsPlayed) =>
        new(warmup, roundsPlayed, Paused: false, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: false);

    [Fact]
    public void TheGenericFlowSaysEveryTowerRoundAndTheCastleThatEndedTheMap()
    {
        using var host = new GamemodeTestHost();
        host.World.Rules = Rules(warmup: false, roundsPlayed: 0);
        var manifest = GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", "rush", "manifest.json")));
        host.Start(GamemodeTestHost.AssignmentFor(
            manifest,
            map: "rush_001",
            maps: [new MapPlan { Map = "rush_001", Sides = MapPlanSides.Ct }]));
        var ct = Enumerable.Range(0, 3).Select(index => host.World.Connect(100UL + (ulong)index, $"ct{index}", PlayerTeam.CounterTerrorist)).ToList();
        var t = Enumerable.Range(0, 3).Select(index => host.World.Connect(200UL + (ulong)index, $"t{index}", PlayerTeam.Terrorist)).ToList();
        int tScore = 0, ctScore = 0;

        // One round: everybody spawns, `dead` die, the engine names the winner (null for
        // a draw the script ends with nobody's tower).
        void Round(PlayerTeam winner, params FakePlayer[] dead)
        {
            host.World.StartRound();
            foreach (var body in ct.Concat(t))
            {
                host.World.Spawn(body);
            }

            foreach (var body in dead)
            {
                host.World.Kill(body, null);
            }

            if (winner == PlayerTeam.Terrorist)
            {
                tScore++;
            }
            else if (winner == PlayerTeam.CounterTerrorist)
            {
                ctScore++;
            }

            // Whatever reason the engine gives, the tower decides the condition.
            host.World.EndRound(winner, RoundEndReason.Elimination, tScore, ctScore);
            host.World.Rules = host.World.Rules! with { RoundsPlayed = tScore + ctScore };
        }

        Round(PlayerTeam.CounterTerrorist, [.. t]);        // room 4, CT holds and kills every attacker
        Round(PlayerTeam.CounterTerrorist);                 // room 3, T's: CT takes it on the clock
        Round(PlayerTeam.Terrorist, ct[0]);                 // room 2, T's: held to the clock
        Round(PlayerTeam.None);                             // room 3, CT's now: a draw leaves it nobody's
        Round(PlayerTeam.CounterTerrorist, [.. t]);         // room 3, nobody's: CT takes it
        Round(PlayerTeam.CounterTerrorist, t[0], t[1]);     // room 2, T's: CT takes it
        Round(PlayerTeam.CounterTerrorist, [.. ct]);        // room 1, T's castle: CT takes it and the match
        host.World.EndMap();

        var rounds = host.Link.EventsOf<RoundEndEvent>();
        Assert.Equal(
            [
                (4L, (TeamSide?)TeamSide.Ct, RoundWinCondition.Elimination, TeamSide.Ct),
                (3L, TeamSide.T, RoundWinCondition.TowerCaptured, TeamSide.Ct),
                (2L, TeamSide.T, RoundWinCondition.TowerHeld, TeamSide.T),
                (3L, null, RoundWinCondition.TowerCaptured, TeamSide.Ct),
                (2L, TeamSide.T, RoundWinCondition.TowerCaptured, TeamSide.Ct),
                (1L, TeamSide.T, RoundWinCondition.TowerCaptured, TeamSide.Ct),
            ],
            rounds.Select(round => (round.Tower!.Room, round.Tower.HeldBy, round.WinCondition, round.Winner.Side)));
        Assert.Equal(RushRoomId._401, rounds[^1].Tower!.RoomId);
        Assert.All(rounds.SkipLast(1), round => Assert.Null(round.Tower!.RoomId));

        var ended = Assert.Single(host.Link.EventsOf<MapEndEvent>());
        Assert.Equal(new MapTower { Room = 1, RoomId = RushRoomId._401, Ending = TowerMapEnding.Castle }, ended.Tower);
        // Team A was CT, and CT won five rounds to one.
        Assert.Equal((MatchTeam.TeamA, 5L, 1L), (ended.Winner, ended.Score.TeamA, ended.Score.TeamB));
    }

    [Fact]
    public void AnyOtherMapSaysNoTower()
    {
        using var host = new GamemodeTestHost();
        host.World.Rules = Rules(warmup: false, roundsPlayed: 0);
        var manifest = GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", "flying-scoutsman", "manifest.json")));
        host.Start(GamemodeTestHost.AssignmentFor(manifest, map: "de_dust2"));
        host.World.StartRound();
        host.World.EndRound(PlayerTeam.CounterTerrorist, RoundEndReason.TimeExpired, 0, 1);
        host.World.EndMap();

        var round = Assert.Single(host.Link.EventsOf<RoundEndEvent>());
        Assert.Equal(RoundWinCondition.TimeExpired, round.WinCondition);
        Assert.Null(round.Tower);
        Assert.Null(Assert.Single(host.Link.EventsOf<MapEndEvent>()).Tower);
    }
}
