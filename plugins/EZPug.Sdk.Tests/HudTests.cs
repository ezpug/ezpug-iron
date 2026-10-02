using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>The HUD's lifetime rules</b> (decision 34, PRD-07 T3). The layouts a server shows
/// through CS2's <c>custom_hud_layout</c> break silently when any of these is got wrong,
/// on a client nobody is watching, so each rule <see cref="Hud"/> owns is a test here on
/// a world that keeps a slot's state the way the engine does: after its player has gone.
/// </summary>
public class HudTests
{
    private const string Addon = "3811574606";
    private const string Welcome = "panorama/layout/custom_game/ezpug_welcome.xml";
    private const string Toast = "panorama/layout/custom_game/ezpug_toast.xml";
    /// <summary>The runtime's own second layout (T6), declared by its <c>Moments</c> before any test declares one.</summary>
    private const string Card = EZPug.Sdk.Moments.Layout;
    private const ulong Ada = 76561198000000001;
    private const ulong Ben = 76561198000000002;

    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static AssignOrchestratorFrame Match(bool hud = true, MatchSimulation? simulation = null) =>
        GamemodeTestHost.AssignmentFor(
            Manifest("flying-scoutsman"),
            teamA: [GamemodeTestHost.Player(Ada, "Ada"), GamemodeTestHost.Player(Ben, "Ben")],
            hud: hud) with
        { Simulation = simulation };

    /// <summary>A server that has the addon, a match that asks for the HUD, one layout declared, the map up. No round has started.</summary>
    private static GamemodeTestHost Assigned(bool hud = true, string? addon = Addon, MatchSimulation? simulation = null)
    {
        var host = new GamemodeTestHost(hudAddon: addon);
        host.Runtime.Hud.Register(Welcome);
        host.Start(Match(hud, simulation));
        return host;
    }

    private static IReadOnlyList<string> Commands(GamemodeTestHost host) =>
        host.World.Actions.Where(action => action.Verb == "command").Select(action => action.Detail).ToList();

    // ------------------------------------------------------------------ off

    [Theory]
    [InlineData(null, true)]
    [InlineData(Addon, false)]
    [InlineData(null, false)]
    public void OffIsUntouchedToTheLastCall(string? addon, bool asked)
    {
        // Two switches, each enough on its own: a server without the addon's id, and a
        // match that does not ask. Everything a match does is done here, and the world
        // hears nothing of a HUD and no console line about an addon.
        using var host = Assigned(asked, addon);
        var hud = host.Runtime.Hud;
        var ada = host.World.Connect(Ada, "Ada", PlayerTeam.Terrorist);
        host.World.StartRound();
        host.World.Spawn(ada);
        hud.SetClass(Welcome, "card", "shown", true);
        hud.SetClass(ada, Welcome, "card", "shown", true);
        hud.SetVariable(Welcome, "title", "text", "EZPug");
        hud.SetVariable(ada, Welcome, "team", "text", "Team A");
        hud.Register(Toast);
        host.World.EndFreeze();
        host.World.EndRound(PlayerTeam.Terrorist, RoundEndReason.Elimination, 1, 0);
        host.World.Elapse(Hud.ResendDelayMs);
        host.World.Disconnect(ada);
        host.World.EndMap();
        host.Link.Release();
        host.Runtime.Dispose();

        Assert.False(hud.On);
        Assert.Null(hud.Quiet);
        Assert.Empty(host.World.HudActions);
        Assert.Empty(host.World.HudLayouts);
        Assert.DoesNotContain(Commands(host), line => line.StartsWith("mm_", StringComparison.Ordinal));
    }

    // ------------------------------------------------------------------ the addon

    [Fact]
    public void TheAddonIsHandedToClientsFromTheAssignmentToTheRelease()
    {
        using var host = Assigned();
        Assert.True(host.Runtime.Hud.On);
        Assert.Equal([$"mm_add_client_addon {Addon}"], Commands(host).Where(line => line.StartsWith("mm_", StringComparison.Ordinal)));

        host.Link.Release();
        Assert.False(host.Runtime.Hud.On);
        Assert.Equal(
            [$"mm_add_client_addon {Addon}", $"mm_remove_client_addon {Addon}"],
            Commands(host).Where(line => line.StartsWith("mm_", StringComparison.Ordinal)));
    }

    // ------------------------------------------------------------------ nothing before a round starts

    [Fact]
    public void NothingTouchesTheWorldBeforeTheFirstRoundStart()
    {
        using var host = Assigned();
        var hud = host.Runtime.Hud;
        var ada = host.World.Connect(Ada, "Ada", PlayerTeam.Terrorist);
        hud.SetClass(Welcome, "mark", "shown", true);
        hud.SetVariable(Welcome, "title", "text", "SaarLAN 2026");
        hud.SetClass(ada, Welcome, "card", "shown", true);
        hud.SetVariable(ada, Welcome, "team", "text", "Team A");
        host.World.Spawn(ada);
        host.World.Elapse(Hud.ResendDelayMs);

        // Asked for, connected, spawned, the second telling due: and not one entity call.
        Assert.False(hud.Spawned);
        Assert.Empty(host.World.HudActions);
        Assert.Equal(new Quiet(QuietReason.NoRound, null), hud.Quiet);

        // The first round start is when the layouts are made, and everything that was
        // asked for meanwhile is on them.
        host.World.StartRound();
        Assert.True(hud.Spawned);
        var layout = host.World.HudLayout(Welcome);
        Assert.True(layout.Has(ada.Slot, "mark", "shown"));
        Assert.Equal("SaarLAN 2026", layout.Variable(ada.Slot, "title", "text"));
        Assert.True(layout.Has(ada.Slot, "card", "shown"));
        Assert.Equal("Team A", layout.Variable(ada.Slot, "team", "text"));
        // Somebody else's slot has everybody's state and none of Ada's.
        Assert.True(layout.Has(7, "mark", "shown"));
        Assert.False(layout.Has(7, "card", "shown"));
        // Removed by name first, then created: in that order.
        Assert.Equal(["hud_remove", "hud_create"], host.World.HudActions.Take(2).Select(action => action.Verb));
    }

    [Fact]
    public void TheLayoutsAreMadeOncePerMap()
    {
        using var host = Assigned();
        host.Runtime.Hud.Register(Toast);
        host.World.StartRound();
        host.World.EndRound(PlayerTeam.Terrorist, RoundEndReason.Elimination, 1, 0);
        host.World.StartRound();
        host.World.StartRound();

        // The entity survives a round restart; making it again every round would blink
        // whatever is on screen.
        Assert.Equal([Welcome, Card, Toast], host.World.HudLayouts.Select(layout => layout.Layout));
        Assert.Equal(3, host.World.HudActions.Count(action => action.Verb == "hud_create"));
        Assert.Single(host.World.HudActions, action => action.Verb == "hud_remove");
    }

    [Fact]
    public void ALayoutDeclaredWhileTheHudIsUpExistsAtOnce()
    {
        using var host = Assigned();
        host.World.StartRound();
        host.Runtime.Hud.Register(Toast);
        host.Runtime.Hud.Register(Toast);
        Assert.Equal([Welcome, Card, Toast], host.World.HudLayouts.Select(layout => layout.Layout));
    }

    [Fact]
    public void ALayoutASpectatorSharesIsMadeThatWayEveryTimeItIsMade()
    {
        // Observable is the entity's own key and can only be given at its spawn, so it is
        // part of what a layout is: at the first round, declared late, and on the next map.
        using var host = Assigned();
        host.Runtime.Hud.Register(Toast, observable: true);
        host.World.StartRound();
        host.Runtime.Hud.Register("panorama/layout/custom_game/ezpug_late.xml", observable: true);
        Assert.False(host.World.HudLayout(Welcome).Observable);
        Assert.True(host.World.HudLayout(Toast).Observable);
        Assert.True(host.World.HudLayout("panorama/layout/custom_game/ezpug_late.xml").Observable);

        host.Clock.Advance(60_000);
        host.World.StartMap("de_inferno");
        host.World.StartRound();
        Assert.False(host.World.HudLayout(Welcome).Observable);
        Assert.True(host.World.HudLayout(Toast).Observable);
        Assert.True(host.World.HudLayout("panorama/layout/custom_game/ezpug_late.xml").Observable);
    }

    // ------------------------------------------------------------------ orphans

    [Fact]
    public void OrphansAreRemovedByNameBeforeAnythingIsCreated()
    {
        using var host = Assigned();
        // What a load of the plugin that never reached its Unload leaves standing: a
        // layout this runtime has no record of, with a card open on somebody's slot.
        var orphan = host.World.OrphanHudLayout(Welcome);
        orphan.SlotClasses[0] = new() { [("card", "shown")] = true };

        host.World.StartRound();

        var layout = host.World.HudLayout(Welcome);
        Assert.NotSame(orphan, layout);
        Assert.False(layout.Has(0, "card", "shown"));
    }

    // ------------------------------------------------------------------ the map takes them

    [Fact]
    public void AMapChangeTakesTheLayoutsAndTheNextRoundStartBringsThemBack()
    {
        using var host = Assigned();
        var hud = host.Runtime.Hud;
        var ada = host.World.Connect(Ada, "Ada", PlayerTeam.Terrorist);
        host.World.StartRound();
        hud.SetClass(Welcome, "mark", "shown", true);
        hud.SetClass(ada, Welcome, "card", "shown", true);

        host.Clock.Advance(60_000);
        host.World.StartMap("de_inferno");
        Assert.False(hud.Spawned);
        var before = host.World.HudActions.Count;
        hud.SetVariable(ada, Welcome, "team", "text", "Team A");
        Assert.Equal(before, host.World.HudActions.Count);

        host.World.StartRound();
        var layout = host.World.HudLayout(Welcome);
        Assert.True(layout.Has(ada.Slot, "mark", "shown"));
        Assert.True(layout.Has(ada.Slot, "card", "shown"));
        Assert.Equal("Team A", layout.Variable(ada.Slot, "team", "text"));
    }

    [Fact]
    public void ARoundThatStartedBeforeTheMapWasAnnouncedIsThatMapsRound()
    {
        // The world announces a map a beat after the engine started it, and the engine
        // may start a round inside that beat. The layouts made then are the new map's.
        using var host = new GamemodeTestHost(hudAddon: Addon);
        host.Runtime.Hud.Register(Welcome);
        host.Link.Assign(Match());
        var engineStartedAt = host.Clock.NowMs;
        host.Clock.Advance(400);
        host.World.StartRound();
        Assert.True(host.Runtime.Hud.Spawned);

        host.Clock.Advance(600);
        // The fake drops the entities on a map's news; the real ones were made after the
        // level came up and are still there. What is asserted is what the service believes.
        host.World.StartMap(startedAtMs: engineStartedAt);
        Assert.True(host.Runtime.Hud.Spawned);
        Assert.Equal([Welcome, Card], host.World.HudActions.Where(action => action.Verb == "hud_create").Select(action => action.Detail));
    }

    [Fact]
    public void LayoutsMadeOnTheMapBeforeAreMadeAgainWhenARoundBeatTheNewMapsAnnouncement()
    {
        // What the dev node did on every MatchZy match (PRD-07 T9): the lobby map's
        // round start made the layouts, the match's level change took them, and the
        // new map's first round started before the map was announced. That round start
        // found the layouts "in the world" and made none; the announcement is when the
        // service learns they went with the map before.
        using var host = Assigned();
        var hud = host.Runtime.Hud;
        var ada = host.World.Connect(Ada, "Ada", PlayerTeam.Terrorist);
        host.World.StartRound();
        hud.SetClass(Welcome, "mark", "shown", true);
        hud.SetClass(ada, Welcome, "card", "shown", true);
        Assert.Equal(2, host.World.HudLayouts.Count);

        host.Clock.Advance(60_000);
        var engineStartedAt = host.Clock.NowMs;
        host.Clock.Advance(400);
        host.World.StartRound();
        host.Clock.Advance(600);
        host.World.StartMap("de_inferno", startedAtMs: engineStartedAt);

        Assert.True(hud.Spawned);
        Assert.Equal([Welcome, Card], host.World.HudLayouts.Select(layout => layout.Layout));
        var layout = host.World.HudLayout(Welcome);
        Assert.True(layout.Has(ada.Slot, "mark", "shown"));
        Assert.True(layout.Has(ada.Slot, "card", "shown"));

        // And a later announcement of a map the layouts were made on makes nothing twice.
        var made = host.World.HudActions.Count(action => action.Verb == "hud_create");
        host.World.StartMap("de_inferno", startedAtMs: engineStartedAt);
        Assert.Equal(made, host.World.HudActions.Count(action => action.Verb == "hud_create"));
    }

    // ------------------------------------------------------------------ slots

    [Fact]
    public void ASlotIsCleanedOfItsLastOccupantWhenSomebodyTakesIt()
    {
        using var host = Assigned();
        var hud = host.Runtime.Hud;
        host.World.StartRound();
        var ada = host.World.Connect(Ada, "Ada", PlayerTeam.Terrorist);
        hud.SetClass(ada, Welcome, "card", "shown", true);
        hud.SetVariable(ada, Welcome, "team", "text", "Team A");
        var layout = host.World.HudLayout(Welcome);
        Assert.True(layout.Has(ada.Slot, "card", "shown"));

        // She leaves. The engine keeps what her slot was told: nobody is there to tell.
        host.World.Disconnect(ada);
        Assert.True(layout.Has(0, "card", "shown"));

        // Ben takes the slot and inherits nothing.
        var ben = host.World.Connect(Ben, "Ben", PlayerTeam.CounterTerrorist);
        Assert.Equal(0, ben.Slot);
        Assert.False(layout.Has(ben.Slot, "card", "shown"));
        Assert.Equal("", layout.Variable(ben.Slot, "team", "text"));
    }

    [Fact]
    public void ASlotIsToldEverythingAgainAtSpawnAndOnceMoreShortlyAfter()
    {
        using var host = Assigned();
        var hud = host.Runtime.Hud;
        host.World.StartRound();
        var ada = host.World.Connect(Ada, "Ada", PlayerTeam.Terrorist);
        host.World.Elapse(Hud.ResendDelayMs);
        hud.SetClass(ada, Welcome, "card", "shown", true);
        hud.SetVariable(ada, Welcome, "team", "text", "Team A");
        var layout = host.World.HudLayout(Welcome);

        // A client that was still loading dropped what it was told. The spawn says it again…
        layout.SlotClasses[ada.Slot].Clear();
        layout.SlotVariables[ada.Slot].Clear();
        host.World.Spawn(ada);
        Assert.True(layout.Has(ada.Slot, "card", "shown"));
        Assert.Equal("Team A", layout.Variable(ada.Slot, "team", "text"));

        // …and so does the beat after it, which is the one a slow client hears.
        layout.SlotClasses[ada.Slot].Clear();
        layout.SlotVariables[ada.Slot].Clear();
        host.World.Elapse(Hud.ResendDelayMs - 1);
        Assert.False(layout.Has(ada.Slot, "card", "shown"));
        host.World.Elapse(1);
        Assert.True(layout.Has(ada.Slot, "card", "shown"));
        Assert.Equal("Team A", layout.Variable(ada.Slot, "team", "text"));

        // What was taken off her screen in between stays off: the second telling says
        // what should be there now, not what was there at the spawn.
        host.World.Spawn(ada);
        hud.SetClass(ada, Welcome, "card", "shown", false);
        host.World.Elapse(Hud.ResendDelayMs);
        Assert.False(layout.Has(ada.Slot, "card", "shown"));
    }

    [Fact]
    public void TheSecondTellingIsNotOwedToSomebodyWhoLeft()
    {
        using var host = Assigned();
        host.World.StartRound();
        var ada = host.World.Connect(Ada, "Ada", PlayerTeam.Terrorist);
        host.Runtime.Hud.SetClass(ada, Welcome, "card", "shown", true);
        host.World.Spawn(ada);
        host.World.Disconnect(ada);
        var before = host.World.HudActions.Count;
        host.World.Elapse(Hud.ResendDelayMs);
        Assert.Equal(before, host.World.HudActions.Count);
    }

    [Fact]
    public void ACallForSomebodyWhoLeftIsDropped()
    {
        using var host = Assigned();
        var hud = host.Runtime.Hud;
        host.World.StartRound();
        var ada = host.World.Connect(Ada, "Ada", PlayerTeam.Terrorist);
        hud.SetClass(ada, Welcome, "card", "shown", true);
        host.World.Disconnect(ada);
        var ben = host.World.Connect(Ben, "Ben", PlayerTeam.CounterTerrorist);
        Assert.Equal(ada.Slot, ben.Slot);
        var layout = host.World.HudLayout(Welcome);

        // A timer that outlived her still holds her player, and her slot is Ben's now.
        var before = host.World.HudActions.Count;
        hud.SetClass(ada, Welcome, "card", "shown", true);
        hud.SetVariable(ada, Welcome, "team", "text", "Team A");
        Assert.Equal(before, host.World.HudActions.Count);
        Assert.False(layout.Has(ben.Slot, "card", "shown"));

        // She comes back in another slot: the same stale player now reaches her there.
        var back = host.World.Connect(Ada, "Ada", PlayerTeam.Terrorist);
        Assert.NotEqual(ben.Slot, back.Slot);
        hud.SetClass(ada, Welcome, "card", "shown", true);
        Assert.True(layout.Has(back.Slot, "card", "shown"));
        Assert.False(layout.Has(ben.Slot, "card", "shown"));
    }

    // ------------------------------------------------------------------ no memo

    [Fact]
    public void NothingIsRememberedAsAlreadySet()
    {
        using var host = Assigned();
        var hud = host.Runtime.Hud;
        host.World.StartRound();
        var ada = host.World.Connect(Ada, "Ada", PlayerTeam.Terrorist);
        host.World.Elapse(Hud.ResendDelayMs);

        // The same call twice is two calls: the client may have lost the first.
        var before = host.World.HudActions.Count;
        hud.SetClass(ada, Welcome, "card", "shown", true);
        hud.SetClass(ada, Welcome, "card", "shown", true);
        hud.SetClass(Welcome, "mark", "shown", true);
        hud.SetClass(Welcome, "mark", "shown", true);
        Assert.Equal(before + 4, host.World.HudActions.Count);

        // And across a connect nothing survives: she comes back to a clean slot, and is
        // told again when somebody decides she should see the card.
        host.World.Disconnect(ada);
        var back = host.World.Connect(Ada, "Ada", PlayerTeam.Terrorist);
        var layout = host.World.HudLayout(Welcome);
        Assert.False(layout.Has(back.Slot, "card", "shown"));
        host.World.Spawn(back);
        host.World.Elapse(Hud.ResendDelayMs);
        Assert.False(layout.Has(back.Slot, "card", "shown"));

        before = host.World.HudActions.Count;
        hud.SetClass(back, Welcome, "card", "shown", true);
        Assert.Equal(before + 1, host.World.HudActions.Count);
        Assert.True(layout.Has(back.Slot, "card", "shown"));
    }

    // ------------------------------------------------------------------ bots

    [Fact]
    public void ABotAndAPuppetHaveNoScreen()
    {
        using var host = new GamemodeTestHost(hudAddon: Addon);
        var hud = host.Runtime.Hud;
        hud.Register(Welcome);
        host.Start(Match(simulation: new MatchSimulation()));
        // The puppeteer seats one roster entry a beat; with both seated, the next bot
        // the engine adds is nobody's.
        for (var seat = 0; seat < 2; seat++)
        {
            host.World.Elapse(Puppeteer.SeatIntervalMs);
            host.World.ArriveAskedBots();
        }

        host.World.StartRound();
        var puppet = host.World.Players.First(player => player.IsPuppet);
        var bot = host.World.ArriveBot("BOT Chad", PlayerTeam.Terrorist);
        Assert.False(bot.IsPuppet);
        var before = host.World.HudActions.Count;

        hud.SetClass(puppet, Welcome, "card", "shown", true);
        hud.SetVariable(puppet, Welcome, "team", "text", "Team A");
        hud.SetClass(bot, Welcome, "card", "shown", true);
        hud.SetVariable(bot, Welcome, "team", "text", "Team A");
        host.World.Spawn(puppet);
        host.World.Spawn(bot);
        host.World.Elapse(Hud.ResendDelayMs);

        Assert.Equal(before, host.World.HudActions.Count);
        Assert.Empty(host.World.HudLayout(Welcome).SlotClasses);
        Assert.Empty(host.World.HudLayout(Welcome).SlotVariables);

        // A person on the same server is told about their own slot and nobody else's.
        var ada = host.World.Connect(Ada + 40, "Eve", PlayerTeam.Terrorist);
        hud.SetClass(ada, Welcome, "card", "shown", true);
        host.World.Spawn(ada);
        host.World.Elapse(Hud.ResendDelayMs);
        Assert.Equal([ada.Slot], host.World.HudLayout(Welcome).SlotClasses.Keys);
    }

    // ------------------------------------------------------------------ the end

    [Fact]
    public void EverythingIsGoneAtRelease()
    {
        using var host = Assigned();
        var hud = host.Runtime.Hud;
        host.World.StartRound();
        var ada = host.World.Connect(Ada, "Ada", PlayerTeam.Terrorist);
        hud.SetClass(ada, Welcome, "card", "shown", true);
        host.World.Spawn(ada);

        host.Link.Release();

        Assert.Empty(host.World.HudLayouts);
        Assert.Equal($"mm_remove_client_addon {Addon}", Commands(host).Last(line => line.StartsWith("mm_", StringComparison.Ordinal)));
        // Nothing is owed afterwards, and nothing said afterwards reaches the world.
        var before = host.World.HudActions.Count;
        host.World.Elapse(Hud.ResendDelayMs);
        hud.SetClass(ada, Welcome, "card", "shown", true);
        hud.SetClass(Welcome, "mark", "shown", true);
        host.World.StartRound();
        Assert.Equal(before, host.World.HudActions.Count);

        // The next match on this server starts from nothing: what the last one showed
        // is not put back.
        host.Start(Match());
        host.World.StartRound();
        Assert.False(host.World.HudLayout(Welcome).Has(ada.Slot, "card", "shown"));
        Assert.False(host.World.HudLayout(Welcome).Has(ada.Slot, "mark", "shown"));
    }

    [Fact]
    public void EverythingIsGoneWhenThePluginUnloads()
    {
        var host = Assigned();
        host.World.StartRound();
        Assert.Equal([Welcome, Card], host.World.HudLayouts.Select(layout => layout.Layout));

        // `Unload` disposes the runtime with the match still assigned.
        host.Dispose();

        Assert.Empty(host.World.HudLayouts);
        Assert.Equal($"mm_remove_client_addon {Addon}", Commands(host).Last(line => line.StartsWith("mm_", StringComparison.Ordinal)));
    }

    [Fact]
    public void AReleaseBeforeAnyRoundStartedReachesForNoEntity()
    {
        using var host = Assigned();
        host.Link.Release();
        Assert.Empty(host.World.HudActions);
        Assert.Equal($"mm_remove_client_addon {Addon}", Commands(host).Last(line => line.StartsWith("mm_", StringComparison.Ordinal)));
    }

    [Fact]
    public void WhatClientsAreHandedIsReadBackAndOnlyOnAServerThatCanDraw()
    {
        // MultiAddonManager's own list, not what the service once asked for: a status
        // report says what a client who connects now is told to mount.
        var world = new FakeGameWorld();
        var hud = new Hud(world, Addon);
        Assert.Null(hud.Handed);
        world.SetCvar(Hud.ClientAddons, Addon);
        Assert.Equal(Addon, hud.Handed);
        world.SetCvar(Hud.ClientAddons, "");
        Assert.Equal("", hud.Handed);

        // A server without the addon reads nothing at all.
        Assert.Null(new Hud(world).Handed);
    }

    // ------------------------------------------------------------------ freeze end, and who is playing

    [Fact]
    public void TheSeamSaysWhenTheFreezeEnds()
    {
        var world = new FakeGameWorld();
        var ended = 0;
        world.FreezeEnded += () => ended++;
        world.StartRound();
        Assert.Equal(0, ended);
        world.EndFreeze();
        Assert.Equal(1, ended);
    }

    private static GameRules Rules(bool warmup = false, bool paused = false, bool timeout = false, GamePhase phase = GamePhase.PlayingFirstHalf) =>
        new(warmup, RoundsPlayed: 3, paused, TerroristTimeout: timeout, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: false, phase);

    /// <summary>One row of the table: what the world did, and what <see cref="Hud.Quiet"/> says then.</summary>
    public sealed record Moment(string Name, Action<GamemodeTestHost> Arrange, Quiet? Expected, double TimeScale = 1)
    {
        public override string ToString() => Name;
    }

    private static void Freeze(GamemodeTestHost host, string seconds = "15", string restart = "7")
    {
        host.World.SetCvar("mp_freezetime", seconds);
        host.World.SetCvar("mp_round_restart_delay", restart);
        host.World.Rules = Rules();
        host.World.StartRound();
    }

    public static TheoryData<Moment> Moments() =>
        new()
        {
            new("no round has started on this map", _ => { }, new Quiet(QuietReason.NoRound, null)),
            new("warmup", host =>
            {
                host.World.Rules = Rules(warmup: true, phase: GamePhase.WarmupRound);
                host.World.StartRound();
                host.World.EndFreeze();
            }, new Quiet(QuietReason.Warmup, null)),
            new("the freeze time, with what is left of it", host =>
            {
                Freeze(host);
                host.Clock.Advance(4_000);
            }, new Quiet(QuietReason.FreezeTime, 11_000)),
            new("the freeze time under a time scale of two", host =>
            {
                Freeze(host);
                host.Clock.Advance(4_000);
            }, new Quiet(QuietReason.FreezeTime, 3_500), TimeScale: 2),
            new("the round is being played", host =>
            {
                Freeze(host);
                host.Clock.Advance(15_000);
                host.World.EndFreeze();
            }, null),
            new("the freeze ran out and nobody said so", host =>
            {
                Freeze(host);
                host.Clock.Advance(15_000);
            }, null),
            new("a mode with no freeze time", host => Freeze(host, seconds: "0"), null),
            new("a mode whose freeze cannot be read", host =>
            {
                host.World.Rules = Rules();
                host.World.StartRound();
            }, null),
            new("the round is decided", host =>
            {
                Freeze(host);
                host.World.EndFreeze();
                host.Clock.Advance(30_000);
                host.World.EndRound(PlayerTeam.Terrorist, RoundEndReason.Elimination, 1, 0);
                host.Clock.Advance(2_000);
            }, new Quiet(QuietReason.RoundOver, 5_000 + 15_000)),
            new("the round is decided and the restart is overdue", host =>
            {
                Freeze(host);
                host.World.EndFreeze();
                host.World.EndRound(PlayerTeam.Terrorist, RoundEndReason.Elimination, 1, 0);
                host.Clock.Advance(9_000);
            }, new Quiet(QuietReason.RoundOver, 15_000)),
            new("a pause, standing in the freeze", host =>
            {
                Freeze(host);
                host.World.Rules = Rules(paused: true);
                host.Clock.Advance(60_000);
            }, new Quiet(QuietReason.Paused, null)),
            new("a timeout, standing in the freeze", host =>
            {
                Freeze(host);
                host.World.Rules = Rules(timeout: true);
            }, new Quiet(QuietReason.Paused, null)),
            new("a pause asked for in the middle of a round", host =>
            {
                Freeze(host);
                host.World.EndFreeze();
                host.World.Rules = Rules(paused: true);
            }, null),
            new("halftime", host =>
            {
                Freeze(host);
                host.World.EndFreeze();
                host.World.EndRound(PlayerTeam.Terrorist, RoundEndReason.Elimination, 7, 5);
                host.World.Rules = Rules(phase: GamePhase.Halftime);
            }, new Quiet(QuietReason.Halftime, null)),
            new("the match is over", host =>
            {
                Freeze(host);
                host.World.EndFreeze();
                host.World.EndRound(PlayerTeam.Terrorist, RoundEndReason.Elimination, 13, 5);
                host.World.EndMap();
            }, new Quiet(QuietReason.MatchOver, null)),
            new("the match is over, as the engine's phase says it", host =>
            {
                Freeze(host);
                host.World.Rules = Rules(phase: GamePhase.MatchEnded);
            }, new Quiet(QuietReason.MatchOver, null)),
            new("the next map of a series", host =>
            {
                Freeze(host);
                host.World.EndMap();
                host.Clock.Advance(20_000);
                host.World.StartMap("de_inferno");
            }, new Quiet(QuietReason.NoRound, null)),
            new("the first round of the next map", host =>
            {
                Freeze(host);
                host.World.EndMap();
                host.Clock.Advance(20_000);
                host.World.StartMap("de_inferno");
                host.World.StartRound();
                host.World.EndFreeze();
            }, null),
        };

    [Theory]
    [MemberData(nameof(Moments))]
    public void IsAnybodyPlayingAndForHowLongNot(Moment moment)
    {
        using var host = Assigned(simulation: moment.TimeScale == 1 ? null : new MatchSimulation { TimeScale = moment.TimeScale });
        moment.Arrange(host);
        Assert.Equal(moment.Expected, host.Runtime.Hud.Quiet);
    }

    [Fact]
    public void AStretchFitsWhatIsOverBeforeAnybodyPlaysAgain()
    {
        Assert.True(new Quiet(QuietReason.FreezeTime, 5_000).Fits(5_000));
        Assert.False(new Quiet(QuietReason.FreezeTime, 4_999).Fits(5_000));
        // Nobody knows when a warmup ends, which is long enough for anything shown in one.
        Assert.True(new Quiet(QuietReason.Warmup, null).Fits(60_000));
    }

    // ------------------------------------------------------------------ everybody's and one player's

    [Fact]
    public void ANameToldToASlotIsWarnedAboutWhenItIsToldToEverybody()
    {
        var log = new RecordingLog();
        var world = new FakeGameWorld();
        var hud = new Hud(world, Addon, log);
        hud.Register(Welcome);
        hud.OnAssigned(new Assignment(Match()));
        var ada = world.Connect(Ada, "Ada");
        hud.SetClass(ada, Welcome, "card", "shown", true);
        Assert.Empty(log.Warnings);
        hud.SetClass(Welcome, "card", "shown", true);
        hud.SetClass(Welcome, "card", "shown", false);
        Assert.Single(log.Warnings);
    }

    private sealed class RecordingLog : ILinkLog
    {
        public List<string> Warnings { get; } = [];
        public List<string> Said { get; } = [];

        public void Info(string message) => Said.Add(message);

        public void Warn(string message) => Warnings.Add(message);
    }
}
