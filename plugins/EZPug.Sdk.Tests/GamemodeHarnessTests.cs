using System.Text.Json.Nodes;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using EZPug.Sdk.Tests.Modes;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// The sample mode from <c>docs/sdk.md</c> played end to end on the harness, from the
/// shipped <c>powerup-dm</c> manifest: assignment, players, a tap that lands, the SDK's
/// refusals (no charge, dead, unknown verb), the chat door, a death and the respawn timer
/// on the clock, the relayed commands, the release — and the exact events emitted.
/// </summary>
public class GamemodeHarnessTests
{
    private const ulong Tk = 76561198279375306;
    private const ulong Maex = 76561198279375307;

    private static AssignedGamemode Manifest() =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", "powerup-dm", "manifest.json")));

    private static JsonObject Args(string json) => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void AMatchOfPowerupDmOnTheHarness()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        var world = host.World;
        var link = host.Link;

        // Assign from the shipped manifest; the first map comes up.
        var assignment = host.Start(GamemodeTestHost.AssignmentFor(
            Manifest(),
            teamA: [GamemodeTestHost.Player(Tk, "tk", Locale.De, 1820), GamemodeTestHost.Player(Maex, "maex", Locale.En, 1500)]));
        Assert.Equal("powerup-dm", assignment.Gamemode.Id);
        Assert.Equal([LinkServerState.Assigned], link.States.Select(state => state.State));
        Assert.Equal("plugins loaded", link.States[0].Detail);
        var ready = Assert.IsType<ServerReadyEvent>(Assert.Single(link.Events));
        Assert.Equal(("de_mirage", 1L), (ready.Map, ready.Seq));

        // Two rostered humans and a bot connect; the bot is nobody's event.
        var tk = world.Connect(Tk, "tk", PlayerTeam.Terrorist);
        var maex = world.Connect(Maex, "maex", PlayerTeam.CounterTerrorist);
        world.Connect(1, "Bot Cliff", PlayerTeam.Terrorist, bot: true);
        Assert.Equal(["server_ready", "player_connected", "player_connected"], link.EventTypes);
        Assert.All(link.EventsOf<PlayerConnectedEvent>(), connected => Assert.Equal(ServerSlot.TeamA, connected.Player.Team));
        Assert.Contains("Ein Power-up pro Leben – tipp auf dem Handy oder schreib !powerup.", world.Said[Tk]);
        Assert.Contains("One power-up per life – tap on your phone or type !powerup.", world.Said[Maex]);

        // A tap that lands: the SDK checked the args, the charge; the mode did the thing in German.
        world.Spawn(tk);
        var landed = link.PlayerCommand(Tk, "powerup", Args("""{"kind":"haste"}"""));
        Assert.Equal(LinkCommandStatus.Applied, landed.Status);
        Assert.Equal(0, landed.ChargesLeft);
        Assert.Contains(new WorldAction("speed", Tk, "1.4"), world.Actions);
        Assert.Contains("Power-up aktiv: Tempo.", world.Said[Tk]);
        var claimed = Assert.Single(link.EventsOf<PluginEvent>());
        Assert.Equal("powerup_claimed", claimed.Name);
        Assert.Equal("haste", claimed.Data["kind"]!.GetValue<string>());

        // No charge left this life; the phone hears it in the player's language.
        var spent = link.PlayerCommand(Tk, "powerup", Args("""{"kind":"armor"}"""));
        Assert.Equal((LinkCommandStatus.Rejected, PlayerCommandRefusal.NoCharges), (spent.Status, spent.Code));
        Assert.Equal("Keine Ladung mehr in diesem Leben.", spent.Message);

        // Dead players get told so, in English for maex.
        var dead = link.PlayerCommand(Maex, "powerup");
        Assert.Equal((PlayerCommandRefusal.NotAlive, "Only while alive."), (dead.Code, dead.Message));
        Assert.Equal(1, dead.ChargesLeft);

        // Bad args and unknown verbs never reach the mode.
        Assert.Equal(PlayerCommandRefusal.InvalidArgs, link.PlayerCommand(Tk, "powerup", Args("""{"kind":"speed"}""")).Code);
        Assert.Equal(PlayerCommandRefusal.UnknownCommand, link.PlayerCommand(Tk, "teleport").Code);
        Assert.Equal(PlayerCommandRefusal.NotInMatch, link.PlayerCommand(42, "powerup").Code);

        // The chat door: `!powerup` is the same verb, answered in chat; conversation is relayed as it is.
        world.Spawn(maex);
        world.SayAs(maex, "!powerup");
        Assert.Contains("Power-up on: haste.", world.Said[Maex]);
        var command = Assert.Single(link.EventsOf<ChatCommandEvent>());
        Assert.Equal(("powerup", Maex.ToString()), (command.Command, command.Player.SteamId64));
        world.SayAs(tk, "gg wp", teamOnly: true);
        var message = Assert.Single(link.EventsOf<ChatMessageEvent>());
        Assert.Equal(("gg wp", ServerChatScope.Team), (message.Text, message.Scope));

        // A death: the event, and the respawn two seconds later on the clock, which refills the life's charge.
        world.StartRound();
        world.Kill(tk, maex, weapon: "weapon_deagle", headshot: true);
        var death = Assert.Single(link.EventsOf<PlayerDeathEvent>());
        Assert.Equal((Tk.ToString(), Maex.ToString(), true, 1L), (death.Victim.SteamId64, death.Killer!.SteamId64, death.Headshot, death.RoundNumber));
        Assert.False(tk.IsAlive);
        world.Elapse(1_999);
        Assert.False(tk.IsAlive);
        world.Elapse(1);
        Assert.True(tk.IsAlive);
        Assert.Equal(LinkCommandStatus.Applied, link.PlayerCommand(Tk, "powerup", Args("""{"kind":"heal"}""")).Status);
        Assert.Contains(new WorldAction("health", Tk, "100"), world.Actions);

        // Commands from the platform: the runtime answers what it can, the mode the rest.
        Assert.Equal(LinkCommandStatus.Applied, link.Command(new AnnounceCommand { CorrelationId = "c1", Text = "GLHF" })!.Status);
        Assert.Contains("GLHF", world.Broadcasts);
        Assert.Equal(LinkCommandStatus.Applied, link.Command(new KickCommand { CorrelationId = "c2", SteamId64 = Maex.ToString(), Reason = "afk" })!.Status);
        Assert.Null(world.Find(Maex));
        Assert.Single(link.EventsOf<PlayerDisconnectedEvent>());
        var unsupported = link.Command(new PauseCommand { CorrelationId = "c3" })!;
        Assert.Equal((LinkCommandStatus.Rejected, MatchApiErrorCode.CommandUnsupported), (unsupported.Status, unsupported.Code));
        Assert.Equal(MatchApiErrorCode.PlayerNotInMatch, link.Command(new KickCommand { CorrelationId = "c4", SteamId64 = "76561198000000000" })!.Code);

        // Release: the mode says goodbye, timers and state are gone, the server is idle.
        world.Kill(tk, null, weapon: "world");
        link.Release("ended: completed");
        Assert.Contains("Danke fürs Spielen!", world.Said[Tk]);
        Assert.Equal(LinkServerState.Idle, link.States[^1].State);
        Assert.Equal("ended: completed", link.States[^1].Detail);
        Assert.Null(host.Runtime.Assignment);
        world.Elapse(5_000);
        Assert.False(tk.IsAlive);
        Assert.Equal(0, host.Clock.Pending);

        Assert.Equal(
            ["server_ready", "player_connected", "player_connected", "plugin_event", "chat_command", "plugin_event", "chat_message", "player_death", "plugin_event", "player_disconnected", "player_death"],
            link.EventTypes);
        Assert.Equal(Enumerable.Range(1, link.Events.Count).Select(seq => (long?)seq), link.Events.Select(EventStamper.SeqOf));
    }

    [Fact]
    public void AModeAttachedAfterTheAssignmentHearsItAtOnce()
    {
        var clock = new FakeClock();
        var world = new FakeGameWorld(clock);
        var link = new FakePlatformLink();
        using var runtime = new GamemodeRuntime(world, link);
        link.Welcome();
        var loads = new List<string>();
        runtime.Assigned += assignment => loads.AddRange(assignment.Plugins);
        link.Assign(GamemodeTestHost.AssignmentFor(Manifest()));
        Assert.Equal(["EZPug.PowerupDm"], loads);
        world.StartMap("de_mirage");

        // The loader hot-loaded the plugin; it attaches now and is told what it missed.
        runtime.Attach(new PowerupDemo());
        var tk = world.Connect(Tk, "tk", PlayerTeam.Terrorist);
        world.Spawn(tk);
        Assert.Equal(LinkCommandStatus.Applied, link.PlayerCommand(Tk, "powerup").Status);
        Assert.Equal(["server_ready", "player_connected", "plugin_event"], link.EventTypes);
    }

    [Fact]
    public void AnAssignmentForAnotherModeLeavesTheAttachedOneOut()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        var pug = GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", "pug", "manifest.json")));
        host.Start(GamemodeTestHost.AssignmentFor(pug));
        var tk = host.World.Connect(Tk, "tk", PlayerTeam.Terrorist);
        host.World.Spawn(tk);
        Assert.Equal(PlayerCommandRefusal.UnknownCommand, host.Link.PlayerCommand(Tk, "powerup").Code);
        Assert.Empty(host.World.Said);
    }

    [Fact]
    public void FlowEventsAdvanceTheContextAndSidesDecideTheSlots()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        var pug = GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", "pug", "manifest.json")));
        var assignment = GamemodeTestHost.AssignmentFor(pug, teamA: [GamemodeTestHost.Player(Tk, "tk")]);
        host.Start(assignment with { Maps = [new MapPlan { Map = "de_mirage", Sides = MapPlanSides.T }] });
        var runtime = host.Runtime;
        Assert.Equal(TeamSide.T, runtime.Match.TeamASide);

        var open = host.World.Connect(Maex, "maex", PlayerTeam.CounterTerrorist);
        Assert.Equal(ServerSlot.TeamB, runtime.Facts.SlotOf(open));
        Assert.Equal(ServerSlot.TeamA, runtime.Facts.SlotOf(host.World.Connect(Tk, "tk", PlayerTeam.CounterTerrorist)));

        runtime.Emit(runtime.Facts.GoingLive("de_mirage"));
        Assert.True(runtime.Match.Live);
        host.World.StartRound();
        host.World.StartRound();
        Assert.Equal(2, runtime.Match.RoundNumber);
        runtime.Emit(runtime.Facts.SideSwap(TeamSide.Ct));
        Assert.Equal(ServerSlot.TeamA, runtime.Facts.SlotOf(open));
        runtime.Emit(runtime.Facts.MapEnd(new TeamScore { TeamA = 13, TeamB = 7 }, MatchTeam.TeamA));
        Assert.Equal((2L, 0L, false), (runtime.Match.MapNumber, runtime.Match.RoundNumber, runtime.Match.Live));
        Assert.Equal(["server_ready", "player_connected", "player_connected", "going_live", "side_swap", "map_end"], host.Link.EventTypes);
    }

    [Fact]
    public void AnAssignmentWithARestoreStartsTheContextWhereTheDeadServerLeftOff()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        var pug = GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", "pug", "manifest.json")));
        var assignment = GamemodeTestHost.AssignmentFor(pug) with
        {
            Maps = [new MapPlan { Map = "de_mirage", Sides = MapPlanSides.Knife }, new MapPlan { Map = "de_inferno", Sides = MapPlanSides.Knife }],
            Restore = new RoundBackup { MapNumber = 2, RoundNumber = 7, Filename = "matchzy_1_1_round06.json", Content = "{}" },
        };
        host.Link.Assign(assignment);
        var runtime = host.Runtime;
        // Map 2, six rounds played: the next round start is the seventh, and a backup
        // frame or a round event names the series' map, not this box's first.
        Assert.Equal((2L, 6L, false), (runtime.Match.MapNumber, runtime.Match.RoundNumber, runtime.Match.Live));
        host.World.StartMap("de_inferno");
        Assert.Equal(2L, runtime.Match.MapNumber);
        host.World.StartRound();
        Assert.Equal(7L, runtime.Match.RoundNumber);
    }
}
