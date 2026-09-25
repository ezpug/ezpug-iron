using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>The format on the record</b> (PRD-05 T2d, ezpug/ezpug-iron#4): <c>server_ready</c> and
/// <c>going_live</c> carry the <c>game_type</c> / <c>game_mode</c> the map loaded under, and
/// <c>going_live</c> the format that is, so the platform proves wingman from a fact instead
/// of an RCON probe. Read at the map's start, because the engine reads them at level init:
/// a value set after that decides the next map, not this one.
/// </summary>
public class EngineGameTests
{
    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static GameRules Rules(bool warmup) =>
        new(warmup, 0, Paused: false, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: false);

    private static GamemodeTestHost GoLive(string gameType, string gameMode, Action<GamemodeTestHost>? onMapLoaded = null)
    {
        var host = new GamemodeTestHost();
        host.World.SetCvar("game_type", gameType);
        host.World.SetCvar("game_mode", gameMode);
        if (onMapLoaded is not null)
        {
            host.Runtime.MapLoaded += (_, _) => onMapLoaded(host);
        }

        host.World.Rules = Rules(warmup: true);
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("flying-scoutsman"), map: "de_dust2"));
        host.World.Rules = Rules(warmup: false);
        host.World.StartRound();
        return host;
    }

    [Fact]
    public void ACompetitiveMapSaysSoOnServerReadyAndGoingLive()
    {
        using var host = GoLive("0", "1");
        var ready = Assert.Single(host.Link.EventsOf<ServerReadyEvent>());
        Assert.Equal((0L, 1L), (ready.Engine!.GameType, ready.Engine.GameMode));
        var live = Assert.Single(host.Link.EventsOf<GoingLiveEvent>());
        Assert.Equal((0L, 1L), (live.Engine!.GameType, live.Engine.GameMode));
        Assert.Equal(MatchFormat.Competitive, live.Format);
    }

    [Fact]
    public void AWingmanMapIsWingman()
    {
        using var host = GoLive("0", "2");
        var live = Assert.Single(host.Link.EventsOf<GoingLiveEvent>());
        Assert.Equal((0L, 2L), (live.Engine!.GameType, live.Engine.GameMode));
        Assert.Equal(MatchFormat.Wingman, live.Format);
    }

    [Fact]
    public void DeathmatchCarriesItsEngineGameAndNoFormat()
    {
        using var host = GoLive("1", "2");
        var live = Assert.Single(host.Link.EventsOf<GoingLiveEvent>());
        Assert.Equal((1L, 2L), (live.Engine!.GameType, live.Engine.GameMode));
        Assert.Null(live.Format);
    }

    [Fact]
    public void WhatTheMapsCfgSetsDecidesTheNextMapNotThisOne()
    {
        // flying-scoutsman.cfg sets `game_type 0` / `game_mode 0` for whatever loads next,
        // and powerup-dm.cfg sets deathmatch: neither is the game this map is played in.
        using var host = GoLive("0", "1", onMapLoaded: loaded =>
        {
            loaded.World.SetCvar("game_type", "1");
            loaded.World.SetCvar("game_mode", "2");
        });
        var live = Assert.Single(host.Link.EventsOf<GoingLiveEvent>());
        Assert.Equal((0L, 1L), (live.Engine!.GameType, live.Engine.GameMode));
        Assert.Equal(MatchFormat.Competitive, live.Format);
    }

    [Fact]
    public void AMapLoadedAgainIsReadAgain()
    {
        // MatchZy's wingman switch: it sets `game_mode 2` and loads the map again, and the
        // server says `server_ready` a second time, now for the game it will play.
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("flying-scoutsman"), map: "de_dust2"));
        host.World.SetCvar("game_mode", "2");
        host.World.StartMap("de_dust2");
        var readies = host.Link.EventsOf<ServerReadyEvent>();
        Assert.Equal([1L, 2L], readies.Select(ready => ready.Engine!.GameMode));
    }

    [Fact]
    public void AnEngineGameThatCannotBeReadIsLeftOffRatherThanGuessed()
    {
        using var host = GoLive("", "1");
        Assert.Null(Assert.Single(host.Link.EventsOf<ServerReadyEvent>()).Engine);
        var live = Assert.Single(host.Link.EventsOf<GoingLiveEvent>());
        Assert.Null(live.Engine);
        Assert.Null(live.Format);
    }

    [Theory]
    [InlineData(0, 1, MatchFormat.Competitive)]
    [InlineData(0, 2, MatchFormat.Wingman)]
    [InlineData(0, 0, null)]
    [InlineData(1, 2, null)]
    [InlineData(1, 1, null)]
    public void TheFormatIsMatchZysOwnTest(long gameType, long gameMode, MatchFormat? format) =>
        Assert.Equal(format, Facts.FormatOf(new EngineGame { GameType = gameType, GameMode = gameMode }));
}
