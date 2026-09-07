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
    public void AHostThatAsksForABeatGetsOneAndServerReadyWaitsForIt()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        var said = new List<string>();
        host.Runtime.MapLoaded += (_, _) =>
        {
            said.Add("cfg");
            // What the core plugin's loader does: the rest of the console lines belong in
            // a frame of their own, because the engine reconciles a cvar once per frame
            // (PRD-02 T22a).
            host.Runtime.SettleThen(1_000, () => said.Add("cvars"));
        };
        host.Link.Assign(GamemodeTestHost.AssignmentFor(Manifest("powerup-dm")));
        host.World.StartMap("de_mirage");

        // The map is up, the cfg is said, and nobody has been told the server is ready.
        Assert.Equal(["cfg"], said);
        Assert.Empty(host.Link.Events);

        host.World.Elapse(999);
        Assert.Empty(host.Link.Events);

        // The beat lands: the rest first, then server_ready — so "the map is up" still
        // means "and configured".
        host.World.Elapse(1);
        Assert.Equal(["cfg", "cvars"], said);
        Assert.Equal(["server_ready"], host.Link.EventTypes);

        // One beat, one server_ready: the timer is spent.
        host.World.Elapse(5_000);
        Assert.Equal(["cfg", "cvars"], said);
        Assert.Equal(["server_ready"], host.Link.EventTypes);
    }

    [Fact]
    public void AReleaseInsideTheBeatDropsItAndTheServerIsNeverCalledReady()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        var said = new List<string>();
        host.Runtime.MapLoaded += (_, _) => host.Runtime.SettleThen(1_000, () => said.Add("cvars"));
        host.Link.Assign(GamemodeTestHost.AssignmentFor(Manifest("powerup-dm")));
        host.World.StartMap("de_mirage");
        host.Link.Release("ended: cancelled");
        host.World.Elapse(5_000);

        Assert.Empty(said);
        Assert.Empty(host.Link.EventTypes);
        Assert.Equal(LinkServerState.Idle, host.Runtime.State);
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
    public void ProfiledFiresOnceTheAssignmentHoldsThePushAndBeforeTheMode()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("powerup-dm"), teamA: [GamemodeTestHost.Player(Tk, "tk", rating: 1000)]));
        var seen = new List<string>();
        host.Runtime.Profiled += player =>
            seen.Add($"{player.Name} rating={host.Runtime.Assignment?.ProfileOf(Tk)?.Rating} loadout={player.Loadout is not null}");

        // A refresh of a rostered player: what the hook reads back through the assignment is
        // the pushed entry, not the roster's copy (PRD-02 T28: the skins source hangs here).
        host.Link.PushProfile(GamemodeTestHost.Player(Tk, "tk", rating: 1820) with { Loadout = new Loadout { T = new SideLoadout { Knife = "weapon_knife_karambit" } } });
        Assert.Equal(["tk rating=1820 loadout=True"], seen);

        // A profile with no match assigned is announced too; there is just nowhere to keep it.
        host.Link.Release();
        host.Link.PushProfile(GamemodeTestHost.Player(Tk, "tk"));
        Assert.Equal(["tk rating=1820 loadout=True", "tk rating= loadout=False"], seen);
    }

    private sealed class RecordingLoadouts : ILoadoutSource
    {
        public Loadout? LoadoutOf(ulong steamId64) => null;

        public event Action<ulong>? LoadoutChanged;

        public void Raise(ulong steamId64) => LoadoutChanged?.Invoke(steamId64);
    }

    [Fact]
    public void TheLoadoutCapabilityIsNullSafeAndFollowsThePublisher()
    {
        // The skins layer's door (PRD-02 T28), shaped like the gamemode host's: null while
        // nothing is published, the newest publisher otherwise, and a withdrawn old one is
        // not first in line.
        LoadoutSource.Withdraw(LoadoutSource.Current ?? new RecordingLoadouts());
        Assert.Null(LoadoutSource.Current);

        var first = new RecordingLoadouts();
        LoadoutSource.Publish(first);
        Assert.Same(first, LoadoutSource.Find());

        var second = new RecordingLoadouts();
        LoadoutSource.Publish(second);
        Assert.Same(second, LoadoutSource.Find());
        LoadoutSource.Withdraw(first);
        Assert.Same(second, LoadoutSource.Find());
        LoadoutSource.Withdraw(second);
        Assert.Null(LoadoutSource.Current);
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
