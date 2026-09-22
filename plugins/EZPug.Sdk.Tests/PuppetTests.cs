using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using EZPug.Sdk.Tests.Modes;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>Puppets in the SDK</b> (PRD-03 T7): an assignment that carries <c>simulation</c>
/// has its roster played by bots that are those players on the wire. What is pinned
/// here is the difference the task draws — a puppet is rostered and announced, a plain
/// bot is neither — and the doors a puppet has to be reachable through: a <c>kick</c>
/// and a tap addressed to the SteamID the request named.
/// </summary>
public class PuppetTests
{
    private const ulong Tk = 76561198279375306;
    private const ulong Maex = 76561198279375307;
    private const ulong Third = 76561198279375308;

    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static AssignOrchestratorFrame Simulated(AssignedGamemode manifest, double? timeScale = null) =>
        GamemodeTestHost.AssignmentFor(
            manifest,
            teamA: [GamemodeTestHost.Player(Tk, "tk"), GamemodeTestHost.Player(Third, "third")],
            teamB: [GamemodeTestHost.Player(Maex, "maex", Locale.En)]) with
        {
            Simulation = new MatchSimulation { TimeScale = timeScale },
        };

    /// <summary>Let the puppeteer ask, and the engine answer, until the room stops changing.</summary>
    private static void Fill(GamemodeTestHost host)
    {
        for (var pass = 0; pass < 12; pass++)
        {
            host.World.Elapse(Puppeteer.SeatIntervalMs);
            host.World.ArriveAskedBots();
        }
    }

    [Fact]
    public void ARosterOfPuppetsIsSeatedAnnouncedAndMarked()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        host.Start(Simulated(Manifest("powerup-dm")));
        Assert.True(host.Runtime.Puppets.Active);
        Fill(host);

        // Three roster entries, three bodies, each asked for once and by turns a team.
        Assert.Equal(3, host.World.Actions.Count(action => action.Verb == "add_bot"));
        Assert.Equal(3, host.Runtime.Puppets.Seated);
        Assert.Equal([Tk, Maex, Third], host.World.Players.Select(player => player.SteamId64));
        Assert.All(host.World.Players, player => Assert.True(player is { IsBot: true, IsPuppet: true }));

        // Announced like people, under the roster's names and teams, and every fact says
        // what kind of match this is.
        var connected = host.Link.EventsOf<PlayerConnectedEvent>();
        Assert.Equal(["tk", "maex", "third"], connected.Select(fact => fact.Player.Name));
        Assert.Equal([ServerSlot.TeamA, ServerSlot.TeamB, ServerSlot.TeamA], connected.Select(fact => fact.Player.Team));
        Assert.All(host.Link.Events, fact => Assert.True(Source(fact).Simulated));

        // A one-team mode leaves the side to the engine.
        Assert.All(host.World.Actions.Where(action => action.Verb == "add_bot"), action => Assert.Equal("any", action.Detail));
    }

    [Fact]
    public void APuppetIsReachableByTheSteamIdTheRequestNamed()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        host.Start(Simulated(Manifest("powerup-dm")));
        Fill(host);
        var tk = host.World.Find(Tk)!;

        // The widget door: a tap for the rostered id lands on the body that plays it.
        host.World.Spawn(tk);
        Assert.Equal(LinkCommandStatus.Applied, host.Link.PlayerCommand(Tk, "powerup", System.Text.Json.Nodes.JsonNode.Parse("""{"kind":"speed"}""")!.AsObject()).Status);

        // The front door out: a kick for the rostered id. The puppet is announced
        // leaving, its seat is filled again, and it is announced coming back.
        var kicked = host.Link.Command(new KickCommand { CorrelationId = "kick-1", SteamId64 = Tk.ToString() });
        Assert.Equal(LinkCommandStatus.Applied, kicked!.Status);
        Assert.Equal(Tk.ToString(), Assert.Single(host.Link.EventsOf<PlayerDisconnectedEvent>()).Player.SteamId64);
        Assert.Equal(2, host.Runtime.Puppets.Seated);
        Fill(host);
        Assert.Equal(3, host.Runtime.Puppets.Seated);
        Assert.Equal(2, host.Link.EventsOf<PlayerConnectedEvent>().Count(fact => fact.Player.SteamId64 == Tk.ToString()));
    }

    [Fact]
    public void APlainBotStaysABot()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        // The mode's cfg filled the server before the map was ready: named before
        // anybody could cast them, so they go home and the roster is seated fresh.
        host.Link.Welcome();
        host.Link.Assign(Simulated(Manifest("powerup-dm")));
        var early = host.World.ArriveBot("BOT Early", PlayerTeam.Terrorist);
        Assert.False(early.IsPuppet);
        Assert.True(BotIdentity.IsBot(early.SteamId64));
        host.World.StartMap();
        Assert.Contains(host.World.Actions, action => action.Verb == "kick_bots");
        Assert.Empty(host.World.Players);
        Fill(host);
        Assert.Equal(3, host.Runtime.Puppets.Seated);

        // A full roster casts nobody else: one more body is a plain bot — never rostered,
        // never announced, `unrostered` in what it does.
        var extra = host.World.ArriveBot("BOT Extra", PlayerTeam.CounterTerrorist);
        Assert.False(extra.IsPuppet);
        Assert.Equal(3, host.Link.EventsOf<PlayerConnectedEvent>().Count);
        host.World.Kill(host.World.Find(Tk)!, extra);
        var death = Assert.Single(host.Link.EventsOf<PlayerDeathEvent>());
        Assert.Equal(ServerSlot.Unrostered, death.Killer!.Team);
        Assert.Equal(ServerSlot.TeamA, death.Victim.Team);
    }

    [Fact]
    public void ABotThatNeverArrivesIsAskedForAgain()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        host.Start(Simulated(Manifest("powerup-dm")));
        host.World.Elapse(Puppeteer.SeatIntervalMs);
        host.World.Elapse(Puppeteer.SeatIntervalMs);
        Assert.Single(host.World.Actions, action => action.Verb == "add_bot");
        host.World.Elapse(Puppeteer.ArrivalPatienceMs);
        Assert.Equal(2, host.World.Actions.Count(action => action.Verb == "add_bot"));
    }

    [Fact]
    public void ATwoTeamModePutsAPuppetOnItsTeamsSideAndTheClockIsTheRequests()
    {
        using var host = new GamemodeTestHost();
        host.Start(Simulated(Manifest("flying-scoutsman"), timeScale: 2));
        Assert.Contains(new WorldAction("command", null, "sv_cheats 1; host_timescale 2"), host.World.Actions);
        Fill(host);
        Assert.Equal(
            ["CounterTerrorist", "Terrorist", "CounterTerrorist"],
            host.World.Actions.Where(action => action.Verb == "add_bot").Select(action => action.Detail));

        // Released: the bodies go, the casting stops, the clock goes back.
        host.Link.Release();
        Assert.Empty(host.World.Players);
        Assert.Null(host.World.Casting);
        Assert.Contains(new WorldAction("command", null, "host_timescale 1; sv_cheats 0"), host.World.Actions);
    }

    /// <summary>
    /// <b>A mixed roster</b> (PRD-04 T2): <c>simulation.puppets</c> names who is a puppet,
    /// and the rest of the roster are people whose chairs stay empty — a bot that arrives
    /// while one is empty is a plain bot, never the person.
    /// </summary>
    [Fact]
    public void AMixedRosterSeatsOnlyWhoIsNamedAndNeverCastsABotAsThePerson()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        var assignment = Simulated(Manifest("powerup-dm")) with
        {
            Simulation = new MatchSimulation { Puppets = [Tk.ToString(), Maex.ToString()] },
        };
        host.Start(assignment);
        Assert.True(host.Runtime.Puppets.Active);
        Assert.True(host.Runtime.Assignment!.IsPuppet(Tk));
        Assert.True(host.Runtime.Assignment.IsPuppet(Maex));
        Assert.False(host.Runtime.Assignment.IsPuppet(Third));
        Assert.Equal(1, host.Runtime.Assignment.HumansAmongPuppets);
        Fill(host);

        // Two seats asked for, two bodies, the third chair empty.
        Assert.Equal(2, host.World.Actions.Count(action => action.Verb == "add_bot"));
        Assert.Equal(2, host.Runtime.Puppets.Seated);
        Assert.Equal([Tk, Maex], host.World.Players.Select(player => player.SteamId64));
        Assert.Equal(["tk", "maex"], host.Link.EventsOf<PlayerConnectedEvent>().Select(fact => fact.Player.Name));

        // A bot nobody asked for turns up: it is furniture, not the person, and nothing
        // is announced for the SteamID the request left to a human.
        host.World.ArriveBot("BOT Cliff");
        Fill(host);
        Assert.Equal(2, host.Runtime.Puppets.Seated);
        Assert.Null(host.World.Find(Third));
        Assert.Contains(host.World.Players, player => player is { IsBot: true, IsPuppet: false });
        Assert.DoesNotContain(host.Link.EventsOf<PlayerConnectedEvent>(), fact => fact.Player.SteamId64 == Third.ToString());
        Assert.Equal(2, host.Link.EventsOf<PlayerConnectedEvent>().Count);
    }

    [Fact]
    public void MatchZySeatsItsOwnAndARealMatchSeatsNobody()
    {
        using var pug = new GamemodeTestHost();
        pug.Start(Simulated(Manifest("pug")));
        Fill(pug);
        Assert.False(pug.Runtime.Puppets.Active);
        Assert.Null(pug.World.Casting);
        Assert.DoesNotContain(pug.World.Actions, action => action.Verb == "add_bot");
        // …but the match is still a simulated one, and says so.
        Assert.True(Source(pug.Link.Events[0]).Simulated);

        using var real = new GamemodeTestHost(new PowerupDemo());
        real.Start(Simulated(Manifest("powerup-dm")) with { Simulation = null });
        Fill(real);
        Assert.DoesNotContain(real.World.Actions, action => action.Verb == "add_bot");
        Assert.Null(Source(real.Link.Events[0]).Simulated);
    }

    /// <summary>
    /// <b>A scenario is a seating plan</b> (PRD-03 T11): the orchestrator resolves the
    /// story the request named into knobs and the puppeteer seats by them, so the two
    /// knobs a real server can honestly execute — a roster entry with no body, and a
    /// server nobody ever joins — are the room this class ends up with. Everything else
    /// a scenario can ask for is refused at the door, which is why there is nothing else
    /// to pin here.
    /// </summary>
    [Fact]
    public void AScenarioLeavesRosterEntriesWithoutABody()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        host.Start(Simulated(Manifest("powerup-dm")) with
        {
            Puppets = new PuppetScript { Scenario = "no-show", AbsentPlayers = 1 },
        });
        Fill(host);

        // Two of the three seats: the last of the seating order goes without, and the
        // seating order is team A and team B by turns, so a 2v1 becomes tk and maex.
        Assert.Equal(2, host.Runtime.Puppets.Seated);
        Assert.Equal([Tk, Maex], host.World.Players.Select(player => player.SteamId64));
        Assert.Equal(["tk", "maex"], host.Link.EventsOf<PlayerConnectedEvent>().Select(fact => fact.Player.Name));
    }

    [Fact]
    public void AnIdleScenarioSeatsNobodyAtAll()
    {
        using var host = new GamemodeTestHost(new PowerupDemo());
        host.Start(Simulated(Manifest("powerup-dm")) with
        {
            Puppets = new PuppetScript { Scenario = "idle", Idle = true },
        });
        Fill(host);

        // The match is still a puppets match — it is the *room* that is empty, which is
        // what the mode's idle timeout is there to end (PRD-03 T9).
        Assert.True(host.Runtime.Puppets.Active);
        Assert.Equal(0, host.Runtime.Puppets.Seated);
        Assert.Empty(host.World.Players);
        Assert.DoesNotContain(host.World.Actions, action => action.Verb == "add_bot");
        Assert.Empty(host.Link.EventsOf<PlayerConnectedEvent>());
        Assert.True(host.Runtime.Length.Idling);
    }

    private static GameserverSource Source(GameserverEvent fact) =>
        (GameserverSource)fact.GetType().GetProperty("Source")!.GetValue(fact)!;
}
