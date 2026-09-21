using System.Numerics;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>The movement spike's instrument</b> (PRD-03 T12). What is pinned here is what the
/// lane's measurement rests on: the path is the one that was asked for, it is commanded
/// once an engine frame, a body that is not a puppet is never touched, and a death is the
/// only seam in a walker's path.
/// </summary>
public class PuppetWalkTests
{
    private const ulong Tk = 76561198279375306;
    private const ulong Maex = 76561198279375307;

    /// <summary>One engine frame at 64 tick, the rate the real world's <c>Tick</c> fires at.</summary>
    private const long FrameMs = 16;

    private static FakePlayer Puppet(FakeGameWorld world, ulong steamId64, string name, Vector3 at)
    {
        var player = world.Connect(steamId64, name, PlayerTeam.Terrorist, bot: true);
        player.IsPuppet = true;
        player.Position = at;
        world.Spawn(player);
        return player;
    }

    [Fact]
    public void TheCircleIsTheOneThatWasAskedFor()
    {
        var world = new FakeGameWorld();
        var walk = new PuppetWalk(world);
        var centre = new Vector3(-1000, 500, 64);
        var tk = Puppet(world, Tk, "tk", centre);

        Assert.True(walk.Start(seconds: 4, speed: 250, radius: 128).Started);
        Assert.True(walk.Walking);

        // Sampled the way the runtime samples for the wire: about every 100 ms of engine
        // time, which at 64 tick is every seventh frame and never exactly a hundred.
        var samples = new List<(long At, Vector3 Where)>();
        var next = world.Clock.NowMs;
        for (var frame = 0; frame < 4_000 / FrameMs; frame++)
        {
            world.Elapse(FrameMs);
            if (world.Clock.NowMs < next)
            {
                continue;
            }

            samples.Add((world.Clock.NowMs, tk.Position!.Value));
            next = world.Clock.NowMs + 100;
        }

        Assert.True(samples.Count > 30, $"only {samples.Count} samples");
        // Every one of them on the circle, at the height the body started at.
        Assert.All(samples, sample =>
        {
            Assert.Equal(128, Vector2.Distance(new Vector2(sample.Where.X, sample.Where.Y), new Vector2(centre.X, centre.Y)), 1);
            Assert.Equal(centre.Z, sample.Where.Z, 3);
        });
        // And the speed between two samples is the speed that was asked for — the chord
        // of a 25-unit arc is 24.96, so a 10 Hz sample of a run is within half a percent
        // of it. That is what the radar draws, and what the lane measures on hardware.
        var speeds = samples
            .Zip(samples.Skip(1), (a, b) => Vector3.Distance(a.Where, b.Where) * 1000 / (b.At - a.At))
            .ToList();
        Assert.All(speeds, speed => Assert.InRange(speed, 245, 255));
    }

    [Fact]
    public void ItIsCommandedOncePerFramePerBody()
    {
        var world = new FakeGameWorld();
        var walk = new PuppetWalk(world);
        Puppet(world, Tk, "tk", new Vector3(0, 0, 0));
        Puppet(world, Maex, "maex", new Vector3(600, 0, 0));

        walk.Start(seconds: 1);
        for (var frame = 0; frame < 10; frame++)
        {
            world.Elapse(FrameMs);
        }

        Assert.Equal(2, walk.Bodies);
        Assert.Equal(10, walk.Frames);
        Assert.Equal(20, walk.Teleports);
        Assert.Equal(20, world.Actions.Count(action => action.Verb == "teleport"));
    }

    [Fact]
    public void APersonIsNeverWalked()
    {
        var world = new FakeGameWorld();
        var walk = new PuppetWalk(world);
        var person = world.Connect(Tk, "tk", PlayerTeam.Terrorist);
        person.Position = new Vector3(0, 0, 0);
        world.Spawn(person);
        var bot = world.Connect(Maex, "Bot Cliffe", PlayerTeam.CounterTerrorist, bot: true);
        bot.Position = new Vector3(100, 0, 0);
        world.Spawn(bot);

        // A room with nobody a request named in it: there is nothing here to measure, and
        // moving the two bodies that are here would be a cheat rather than a measurement.
        var outcome = walk.Start();
        Assert.False(outcome.Started);
        Assert.Contains("nobody to walk", outcome.Message);

        Puppet(world, 76561198279375308, "third", new Vector3(500, 0, 0));
        Assert.True(walk.Start(seconds: 1).Started);
        world.Elapse(FrameMs);
        Assert.Equal(1, walk.Bodies);
        Assert.All(
            world.Actions.Where(action => action.Verb == "teleport"),
            action => Assert.Equal(76561198279375308ul, action.SteamId64));
    }

    [Fact]
    public void ADeathIsTheOnlySeamInAPath()
    {
        var world = new FakeGameWorld();
        var walk = new PuppetWalk(world);
        var tk = Puppet(world, Tk, "tk", new Vector3(0, 0, 0));
        walk.Start(seconds: 5, speed: 250, radius: 128);
        for (var frame = 0; frame < 20; frame++)
        {
            world.Elapse(FrameMs);
        }

        // Dead: the engine owns the body, and nothing is commanded at it.
        world.Kill(tk, null);
        var teleports = walk.Teleports;
        for (var frame = 0; frame < 20; frame++)
        {
            world.Elapse(FrameMs);
        }

        Assert.Equal(teleports, walk.Teleports);

        // Back, and the engine put it across the map. The next circle is drawn around
        // where it woke up rather than around where it died — one jump in the path, the
        // death's own, and not two.
        tk.Position = new Vector3(2000, -2000, 96);
        world.Spawn(tk);
        world.Elapse(FrameMs);
        Assert.Equal(1, walk.Restarts);
        Assert.Equal(
            128,
            Vector2.Distance(new Vector2(tk.Position!.Value.X, tk.Position.Value.Y), new Vector2(2000, -2000)),
            1);
    }

    [Fact]
    public void AWalkEndsItselfAndGivesTheBodiesBack()
    {
        var world = new FakeGameWorld();
        var walk = new PuppetWalk(world);
        Puppet(world, Tk, "tk", new Vector3(0, 0, 0));

        walk.Start(seconds: 1);
        while (world.Clock.NowMs < 1_100)
        {
            world.Elapse(FrameMs);
        }

        Assert.False(walk.Walking);
        var teleports = walk.Teleports;
        world.Elapse(FrameMs);
        Assert.Equal(teleports, walk.Teleports);
    }

    [Fact]
    public void AWalkNobodyCouldMeasureIsRefused()
    {
        var world = new FakeGameWorld();
        var walk = new PuppetWalk(world);
        Puppet(world, Tk, "tk", new Vector3(0, 0, 0));

        Assert.False(walk.Start(seconds: 0).Started);
        Assert.False(walk.Start(seconds: PuppetWalk.MaxSeconds + 1).Started);
        Assert.Contains("speed and radius", walk.Start(seconds: 5, speed: 0).Message);
        Assert.Contains("speed and radius", walk.Start(seconds: 5, radius: -1).Message);
        Assert.False(walk.Walking);
    }
}
