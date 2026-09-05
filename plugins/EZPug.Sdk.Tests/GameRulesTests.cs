using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using EZPug.Sdk.Tests.Modes;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// The runtime numbers rounds from the engine's own count when the world has one
/// (PRD-02 T9): warmup and a knife round never count, <c>mp_restartgame</c> resets it —
/// and keeps counting by itself when the world has no gamerules to read (the harness's
/// default). A second map while a matchzy flow is assigned is the series' next map.
/// </summary>
public class GameRulesTests
{
    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    [Fact]
    public void RoundsAreNumberedFromTheEngineCountWhenThereIsOne()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("powerup-dm")));

        host.World.StartRound();
        Assert.Equal(1, host.Runtime.Match.RoundNumber);
        host.World.StartRound();
        Assert.Equal(2, host.Runtime.Match.RoundNumber);

        host.World.Rules = new GameRules(Warmup: false, RoundsPlayed: 0, Paused: false, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: false);
        host.World.StartRound();
        Assert.Equal(1, host.Runtime.Match.RoundNumber);
        host.World.Rules = host.World.Rules with { RoundsPlayed = 7 };
        host.World.StartRound();
        Assert.Equal(8, host.Runtime.Match.RoundNumber);

        host.World.Rules = null;
        host.World.StartRound();
        Assert.Equal(9, host.Runtime.Match.RoundNumber);
    }

    [Fact]
    public void StandingIsAnyPauseOrTimeout()
    {
        var quiet = new GameRules(false, 3, false, false, false, false, false);
        Assert.False(quiet.Standing);
        Assert.True((quiet with { Paused = true }).Standing);
        Assert.True((quiet with { TerroristTimeout = true }).Standing);
        Assert.True((quiet with { CounterTerroristTimeout = true }).Standing);
        Assert.True((quiet with { TechnicalTimeout = true }).Standing);
    }

    [Fact]
    public void ASecondMapAdvancesTheMapNumberOnlyForAMatchZyFlow()
    {
        using var pug = new GamemodeTestHost(new PowerupDemo());
        pug.Start(GamemodeTestHost.AssignmentFor(Manifest("pug")));
        pug.World.StartRound();
        Assert.Equal((1L, 1L), (pug.Runtime.Match.MapNumber, pug.Runtime.Match.RoundNumber));
        pug.World.StartMap("de_nuke");
        Assert.Equal((2L, 0L), (pug.Runtime.Match.MapNumber, pug.Runtime.Match.RoundNumber));
        // server_ready is said for the new map too; the machine ignores one past configuring.
        Assert.Equal(["server_ready", "server_ready"], pug.Link.EventTypes);

        // A mode that owns its flow advances the map by emitting map_end; a map change alone does not.
        using var mode = new GamemodeTestHost(new PowerupDemo());
        mode.Start(GamemodeTestHost.AssignmentFor(Manifest("powerup-dm")));
        mode.World.StartMap("de_nuke");
        Assert.Equal(1, mode.Runtime.Match.MapNumber);
    }
}
