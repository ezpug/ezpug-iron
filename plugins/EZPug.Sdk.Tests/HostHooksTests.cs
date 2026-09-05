using EZPug.Sdk.Hosting;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using EZPug.Sdk.Tests.Modes;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// What the core plugin builds on (PRD-02 T8): the runtime's <c>MapLoaded</c> hook runs
/// before <c>server_ready</c>, position ticks stream on the clock only while linked and
/// asked for, bots are named on the wire, and the shared host capability is null-safe
/// and survives a re-publish.
/// </summary>
public class HostHooksTests
{
    private const ulong Tk = 76561198279375306;

    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    [Fact]
    public void MapLoadedRunsAfterTheMapIsUpAndBeforeServerReady()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        var seen = new List<string>();
        host.Runtime.Assigned += assignment => seen.Add($"assigned {assignment.MatchId} events={host.Link.Events.Count}");
        host.Runtime.MapLoaded += (assignment, map) => seen.Add($"map {map} events={host.Link.Events.Count} state={host.Runtime.State}");
        host.Link.Assign(GamemodeTestHost.AssignmentFor(Manifest("powerup-dm")));
        Assert.Empty(host.Link.Events);
        host.World.StartMap("de_mirage");
        Assert.Equal(
            ["assigned 6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b events=0", "map de_mirage events=0 state=Assigned"],
            seen);
        Assert.Equal(["server_ready"], host.Link.EventTypes);
    }

    [Fact]
    public void PositionsStreamEveryHundredMillisecondsForAliveHumansAndBots()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("powerup-dm"), teamA: [GamemodeTestHost.Player(Tk, "tk")]));
        var tk = host.World.Connect(Tk, "tk", PlayerTeam.Terrorist);
        var bot = host.World.Connect(BotIdentity.SteamId64Of(1), "Bot Cliff", PlayerTeam.Terrorist, bot: true);

        // Nobody alive: nothing streams.
        host.World.Elapse(GamemodeRuntime.PositionTickIntervalMs);
        Assert.Empty(host.Link.Ticks);

        host.World.Spawn(tk);
        host.World.Spawn(bot);
        ((FakePlayer)tk).Position = new System.Numerics.Vector3(10, 20, 30);
        host.World.Elapse(GamemodeRuntime.PositionTickIntervalMs);
        var tick = Assert.Single(host.Link.Ticks);
        Assert.Null(tick.Seq);
        Assert.Equal([Tk.ToString(), "90000000000000001"], tick.Positions.Select(position => position.SteamId64));
        Assert.Equal((10f, 20f, 30f), ((float)tick.Positions[0].X, (float)tick.Positions[0].Y, (float)tick.Positions[0].Z));

        // Ticks are apart from the story; the durable events do not see them.
        Assert.Equal(["server_ready", "player_connected"], host.Link.EventTypes);

        host.World.Elapse(GamemodeRuntime.PositionTickIntervalMs * 3);
        Assert.Equal(4, host.Link.Ticks.Count);

        host.Link.Release();
        host.World.Elapse(GamemodeRuntime.PositionTickIntervalMs * 2);
        Assert.Equal(4, host.Link.Ticks.Count);
    }

    [Fact]
    public void AModeWithoutThePositionsCapabilityStreamsNothing()
    {
        var manifest = Manifest("powerup-dm") with
        {
            Capabilities = new GamemodeCapabilities { Positions = false, Chat = true, PlayerCommands = true, Widget = true, Backups = false, ScoreboardRating = false },
        };
        using var host = new GamemodeTestHost(new PowerupDemo());
        host.Start(GamemodeTestHost.AssignmentFor(manifest));
        host.World.Spawn(host.World.Connect(Tk, "tk", PlayerTeam.Terrorist));
        host.World.Elapse(GamemodeRuntime.PositionTickIntervalMs * 5);
        Assert.Empty(host.Link.Ticks);
    }

    [Theory]
    [InlineData(0, 90000000000000000UL)]
    [InlineData(63, 90000000000000063UL)]
    public void BotsAreNamedBySlotInARangeSteamNeverUses(int slot, ulong expected)
    {
        var id = BotIdentity.SteamId64Of(slot);
        Assert.Equal(expected, id);
        Assert.Equal(17, id.ToString().Length);
        Assert.True(BotIdentity.IsBot(id));
        Assert.False(BotIdentity.IsBot(Tk));
        Assert.Throws<ArgumentOutOfRangeException>(() => BotIdentity.SteamId64Of(-1));
    }

    private sealed class RecordingHost : IGamemodeHost
    {
        public List<string> Log { get; } = [];

        public void Attach(Gamemode mode) => Log.Add($"attach {mode.Id}");

        public void Detach(Gamemode mode) => Log.Add($"detach {mode.Id}");
    }

    [Fact]
    public void TheHostCapabilityIsNullSafeAndFollowsThePublisher()
    {
        // Nothing published yet (or withdrawn): the lookup answers null rather than throwing.
        GamemodeHost.Withdraw(GamemodeHost.Current ?? new RecordingHost());
        Assert.Null(GamemodeHost.Current);

        var first = new RecordingHost();
        GamemodeHost.Publish(first);
        Assert.Same(first, GamemodeHost.Find());

        // A hot reload of the core publishes a new host; the old one is not first in line.
        var second = new RecordingHost();
        GamemodeHost.Publish(second);
        Assert.Same(second, GamemodeHost.Find());
        GamemodeHost.Withdraw(first);
        Assert.Same(second, GamemodeHost.Find());
        GamemodeHost.Withdraw(second);
        Assert.Null(GamemodeHost.Current);
    }
}
