using System.Text.RegularExpressions;
using EZPug.Sdk;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Core.Tests;

/// <summary>
/// <b>A puppet in a pug is announced too</b> (PRD-03 T7a). MatchZy-Enhanced seats the
/// bodies for a <c>matchzy</c> flow and keeps which bot is which roster entry to itself;
/// what is pinned here is that the core plugin reads that mapping off the fork's own
/// console lines instead of forming one, casts the body it names, and announces it like
/// the person it plays — so a <c>kick</c> or a widget tap for the rostered SteamID has
/// somebody to find.
/// </summary>
public class MatchZyPuppetsTests
{
    private const ulong Tk = 76561198279375306;
    private const ulong Maex = 76561198279375307;
    private const ulong Stranger = 76561198279375399;

    private sealed class Rig : IDisposable
    {
        private readonly Dictionary<int, int> _slots = new();

        public Rig()
        {
            World = new FakeGameWorld(map: "de_mirage");
            Link = new FakePlatformLink();
            Runtime = new GamemodeRuntime(World, Link, Log);
            Puppets = new MatchZyPuppets(World, Runtime, userId => _slots.TryGetValue(userId, out var slot) ? slot : null, on => Listening = on, Log);
            Puppets.Bind();
            Link.Welcome();
        }

        public FakeGameWorld World { get; }
        public FakePlatformLink Link { get; }
        public GamemodeRuntime Runtime { get; }
        public MatchZyPuppets Puppets { get; }
        public GamemodeLoaderTests.RecordingLog Log { get; } = new();

        /// <summary>What the console tap was last told: whether anybody wants lines read.</summary>
        public bool Listening { get; private set; }

        /// <summary>A pug assigned, simulated unless said otherwise, with tk and maex rostered a side.</summary>
        public void Start(bool simulated = true, string mode = "pug")
        {
            var manifest = GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", mode, "manifest.json")));
            var frame = GamemodeTestHost.AssignmentFor(
                manifest,
                map: "de_mirage",
                teamA: [GamemodeTestHost.Player(Tk, "tk")],
                teamB: [GamemodeTestHost.Player(Maex, "maex", Locale.En)]);
            Link.Assign(simulated ? frame with { Simulation = new MatchSimulation() } : frame);
            Link.Events.Clear();
        }

        /// <summary>A bot the engine put on the server, and the UserId MatchZy will call it by.</summary>
        public FakePlayer Bot(int userId, string name = "BOT Quintin")
        {
            var player = World.ArriveBot(name);
            _slots[userId] = player.Slot;
            return player;
        }

        /// <summary>MatchZy said a line on the console, and a quarter of a second passed.</summary>
        public void Said(string line)
        {
            Puppets.Heard(line);
            World.Elapse(MatchZyPuppets.DrainIntervalMs);
        }

        public void Dispose()
        {
            Runtime.Dispose();
        }
    }

    private static string Assigned(int userId, ulong steamId64, string name, string bot = "BOT Quintin", string slot = "team1") =>
        $"{SimulationLog.Prefix}Assigned bot {bot} (UserId {userId}, TeamNum=3) to simulated player {name} ({steamId64}) on {slot}";

    // ---------------------------------------------------------------- the lines

    [Fact]
    public void TheForksOwnLinesAreRead()
    {
        Assert.Equal(
            new SimulationMapping(12, Tk, "tk", "team1"),
            SimulationLog.Mapped(Assigned(12, Tk, "tk")));
        Assert.Equal(
            new SimulationMapping(15, Maex, "maex", "team2"),
            SimulationLog.Mapped($"{SimulationLog.Prefix}Reconcile: mapped bot UserId=15 (BOT Cliffe) to maex ({Maex}, team2)."));
        Assert.Equal(7, SimulationLog.Released($"{SimulationLog.Prefix}Released roster slot tk ({Tk}, team1) from UserId=7 (disconnect)."));
        Assert.Equal(9, SimulationLog.Released($"{SimulationLog.Prefix}Reconcile: dropped stale mapping for UserId=9."));
    }

    /// <summary>A name with brackets in it is a name, not a parse: the anchors are the fork's, not the player's.</summary>
    [Fact]
    public void ANameFullOfBracketsIsStillAName()
    {
        Assert.Equal(
            new SimulationMapping(4, Tk, "tk (the (real) one)", "team1"),
            SimulationLog.Mapped(Assigned(4, Tk, "tk (the (real) one)", bot: "BOT (UserId 99, TeamNum=2)")));
    }

    [Fact]
    public void EverythingElseOnTheConsoleIsNoneOfOurBusiness()
    {
        foreach (var line in new[]
                 {
                     "",
                     "[MatchZy] Match started",
                     "[ezpug] warn: something",
                     $"{SimulationLog.Prefix}Observed bot 'BOT Quintin' (UserId=12, TeamNum=3, Connected=PlayerConnected).",
                     $"{SimulationLog.Prefix}No available simulated player identity for bot BOT Quintin (UserId 12)",
                 })
        {
            Assert.Null(SimulationLog.Mapped(line));
            Assert.Null(SimulationLog.Released(line));
        }
    }

    /// <summary>
    /// The fork's own format strings, rendered out of the pinned clone and parsed
    /// (<c>references/MatchZy-Enhanced</c>, gitignored — skipped where it is not).
    /// A release that rewords one of these is a red test here rather than a room of
    /// anonymous bots on a real server, which is the whole reason the mapping is read in
    /// its words and not guessed from arrival order.
    /// </summary>
    [Fact]
    public void TheForkStillSaysItTheWayThisParserReadsIt()
    {
        var source = Repo.Path("references", "MatchZy-Enhanced", "src", "SimulationMode.cs");
        if (!File.Exists(source))
        {
            return;
        }

        var holes = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["player.PlayerName"] = "BOT Quintin",
            ["bot.PlayerName"] = "BOT Quintin",
            ["liveControllers[kv.Key].PlayerName"] = "BOT Quintin",
            ["userId"] = "12",
            ["kv.Key"] = "12",
            ["staleId"] = "12",
            ["player.TeamNum"] = "3",
            ["candidate.ConfigName"] = "tk",
            ["candidate.ConfigSteamId"] = Tk.ToString(),
            ["candidate.TeamSlot"] = "team1",
            ["identity.ConfigName"] = "tk",
            ["identity.ConfigSteamId"] = Tk.ToString(),
            ["identity.TeamSlot"] = "team1",
            ["reason"] = "disconnect",
        };

        var found = 0;
        foreach (Match log in Regex.Matches(File.ReadAllText(source), @"Log\(\$""(?<text>\[SimulationMode\][^""]*)""\)", RegexOptions.None, TimeSpan.FromSeconds(5)))
        {
            var text = log.Groups["text"].Value;
            if (!text.Contains("Assigned bot", StringComparison.Ordinal)
                && !text.Contains("Reconcile: mapped bot", StringComparison.Ordinal)
                && !text.Contains("Released roster slot", StringComparison.Ordinal)
                && !text.Contains("dropped stale mapping", StringComparison.Ordinal))
            {
                continue;
            }

            var rendered = Regex.Replace(text, @"\{(?<hole>[^{}]+)\}", hole =>
                holes.TryGetValue(hole.Groups["hole"].Value, out var value)
                    ? value
                    : throw new InvalidOperationException($"the fork's line has a hole nobody scripted: {hole.Groups["hole"].Value} in \"{text}\""),
                RegexOptions.None,
                TimeSpan.FromSeconds(5));
            var line = "[MatchZy] " + rendered;
            found++;
            Assert.True(
                SimulationLog.Mapped(line) is not null || SimulationLog.Released(line) is not null,
                $"the fork says \"{line}\" and nothing here reads it");
        }

        // Two ways a mapping is said and two ways one is freed, transcribed in
        // SimulationLog; a fork that grew a fifth is worth a look rather than a pass.
        Assert.Equal(4, found);
    }

    // ---------------------------------------------------------------- the casting

    [Fact]
    public void ABotMatchZyNamedBecomesThatPlayerAndIsAnnounced()
    {
        using var rig = new Rig();
        rig.Start();
        Assert.True(rig.Puppets.Active);
        Assert.True(rig.Listening);

        var bot = rig.Bot(12);
        Assert.Equal(BotIdentity.SteamId64Of(bot.Slot), bot.SteamId64);
        Assert.Empty(rig.Link.EventsOf<PlayerConnectedEvent>());

        rig.Said(Assigned(12, Tk, "tk"));

        var player = Assert.Single(rig.World.Players);
        Assert.Equal(Tk, player.SteamId64);
        Assert.Equal("tk", player.Name);
        Assert.True(player is { IsBot: true, IsPuppet: true });
        Assert.Equal(bot.Slot, player.Slot);
        Assert.Equal(1, rig.Puppets.Seated);

        // The announcement is the first word anything said about that body, and it names
        // the person a client holds an id for.
        var connected = Assert.Single(rig.Link.EventsOf<PlayerConnectedEvent>());
        Assert.Equal(Tk.ToString(), connected.Player.SteamId64);
        Assert.Equal("tk", connected.Player.Name);
    }

    /// <summary>The fork re-checks its roster and says the same thing again; a durable log hears it once.</summary>
    [Fact]
    public void TheSameMappingSaidTwiceIsOneArrival()
    {
        using var rig = new Rig();
        rig.Start();
        rig.Bot(12);
        rig.Said(Assigned(12, Tk, "tk"));
        rig.Said(Assigned(12, Tk, "tk"));

        Assert.Single(rig.Link.EventsOf<PlayerConnectedEvent>());
        Assert.Empty(rig.Link.EventsOf<PlayerDisconnectedEvent>());
    }

    /// <summary>A body handed another roster entry: the person it was is seen out before the new one moves in.</summary>
    [Fact]
    public void ARemappedBodySeesTheFirstPlayerOut()
    {
        using var rig = new Rig();
        rig.Start();
        rig.Bot(12);
        rig.Said(Assigned(12, Tk, "tk"));
        rig.Said(Assigned(12, Maex, "maex", slot: "team2"));

        Assert.Equal([Tk.ToString(), Maex.ToString()], rig.Link.EventsOf<PlayerConnectedEvent>().Select(fact => fact.Player.SteamId64));
        Assert.Equal([Tk.ToString()], rig.Link.EventsOf<PlayerDisconnectedEvent>().Select(fact => fact.Player.SteamId64));
        Assert.Equal(Maex, Assert.Single(rig.World.Players).SteamId64);
    }

    /// <summary>A puppet that leaves is announced leaving, which is what fills and empties the orchestrator's presence map.</summary>
    [Fact]
    public void APuppetThatLeavesIsAnnouncedLeaving()
    {
        using var rig = new Rig();
        rig.Start();
        rig.Bot(12);
        rig.Said(Assigned(12, Tk, "tk"));
        rig.World.Disconnect(rig.World.Players.Single());
        rig.Said($"{SimulationLog.Prefix}Released roster slot tk ({Tk}, team1) from UserId=12 (disconnect).");

        Assert.Equal([Tk.ToString()], rig.Link.EventsOf<PlayerDisconnectedEvent>().Select(fact => fact.Player.SteamId64));
        Assert.Empty(rig.World.Players);
        Assert.Equal(0, rig.Puppets.Seated);
    }

    /// <summary>A SteamID the request never named is not a player of this match, whatever the fork thinks.</summary>
    [Fact]
    public void AnUnrosteredIdIsRefusedRatherThanInvented()
    {
        using var rig = new Rig();
        rig.Start();
        rig.Bot(12);
        rig.Said(Assigned(12, Stranger, "nobody"));

        Assert.False(Assert.Single(rig.World.Players).IsPuppet);
        Assert.Empty(rig.Link.EventsOf<PlayerConnectedEvent>());
        Assert.Contains(rig.Log.Lines, line => line.Contains("not on this match's roster", StringComparison.Ordinal));
    }

    /// <summary>A mapping for a body that has already gone is a warning and nothing else — never a player invented out of a log line.</summary>
    [Fact]
    public void AMappingForABodyThatHasGoneChangesNothing()
    {
        using var rig = new Rig();
        rig.Start();
        rig.Said(Assigned(88, Tk, "tk"));

        Assert.Empty(rig.World.Players);
        Assert.Empty(rig.Link.EventsOf<PlayerConnectedEvent>());
        Assert.Contains(rig.Log.Lines, line => line.Contains("is already gone", StringComparison.Ordinal));
    }

    // ---------------------------------------------------------------- when it listens

    [Fact]
    public void NobodyListensToAMatchThatAskedForNoPuppets()
    {
        using var rig = new Rig();
        rig.Start(simulated: false);
        Assert.False(rig.Puppets.Active);
        Assert.False(rig.Listening);

        rig.Bot(12);
        rig.Said(Assigned(12, Tk, "tk"));
        Assert.False(Assert.Single(rig.World.Players).IsPuppet);
    }

    /// <summary>A mode the SDK seats puppets for itself (T7) is the <see cref="Puppeteer"/>'s, and this class stays out of it.</summary>
    [Fact]
    public void AModeOutsideMatchZyIsThePuppeteersRoom()
    {
        using var rig = new Rig();
        rig.Start(mode: "powerup-dm");
        Assert.False(rig.Puppets.Active);
        Assert.False(rig.Listening);
    }

    [Fact]
    public void TheConsoleIsLetGoWhenTheMatchIs()
    {
        using var rig = new Rig();
        rig.Start();
        Assert.True(rig.Listening);
        rig.Link.Release("ended: completed");
        Assert.False(rig.Puppets.Active);
        Assert.False(rig.Listening);
    }

    // ---------------------------------------------------------------- the tap

    [Fact]
    public void TheTapForwardsEveryWriteAndHandsOverWholeLines()
    {
        var heard = new List<string>();
        var inner = new StringWriter();
        var tap = ConsoleTap.Over(inner, heard.Add);

        tap.WriteLine("nobody is listening yet");
        Assert.Empty(heard);

        tap.Listening = true;
        tap.WriteLine("[MatchZy] one");
        tap.Write("[MatchZy] tw");
        Assert.Equal(["[MatchZy] one"], heard);
        tap.Write("o\r\n");
        Assert.Equal(["[MatchZy] one", "[MatchZy] two"], heard);

        // Nothing is swallowed: the writer behind the tap saw all of it, in order.
        Assert.Equal(
            $"nobody is listening yet{Environment.NewLine}[MatchZy] one{Environment.NewLine}[MatchZy] two\r\n",
            inner.ToString());
    }

    /// <summary>A writer that never breaks a line cannot grow the buffer for ever.</summary>
    [Fact]
    public void ALineNobodyEndsIsHandedOverAnyway()
    {
        var heard = new List<string>();
        var tap = ConsoleTap.Over(new StringWriter(), heard.Add);
        tap.Listening = true;
        tap.Write(new string('x', ConsoleTap.MaxLineLength + 10));

        Assert.Single(heard);
        Assert.Equal(ConsoleTap.MaxLineLength, heard[0].Length);
    }

    /// <summary>
    /// Installing takes the process's one console and removing gives it back. The only
    /// test that touches it, because a tap that forgot to stand down would take every
    /// later line with it.
    /// </summary>
    [Fact]
    public void InstallingTakesTheConsoleAndRemovingGivesItBack()
    {
        // `Console.SetOut` wraps what it is given in a synchronised writer, so the tap is
        // never `Console.Out` itself and standing down cannot be a reference check — it
        // is unconditional, and this is the behaviour that says whether it worked.
        var heard = new List<string>();
        var tap = ConsoleTap.Install(heard.Add);
        try
        {
            tap.Listening = true;
            Console.WriteLine("[SimulationMode] the tap is in the console");
            Assert.Equal(["[SimulationMode] the tap is in the console"], heard);
        }
        finally
        {
            tap.Remove();
        }

        Assert.False(tap.Listening);
        heard.Clear();
        Console.WriteLine("[SimulationMode] and out of it again");
        Assert.Empty(heard);
    }

    /// <summary>The tap hands over whatever the console is given; what is worth queueing is the queue's business.</summary>
    [Fact]
    public void OnlySimulationModesLinesAreEverQueued()
    {
        Assert.True(SimulationLog.Ours("[MatchZy] [SimulationMode] anything at all"));
        Assert.False(SimulationLog.Ours("[MatchZy] Match started"));
        Assert.False(SimulationLog.Ours(new string('x', 200)));
    }
}
