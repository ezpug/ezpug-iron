using System.Globalization;
using System.Text.RegularExpressions;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>The unboxing</b> (PRD-08 T4): a drop about somebody that carries a reel is played
/// for the whole server, where a stretch of nobody playing fits all of it. The call, the
/// reel, the reveal, each at its instant on the fake clock; and every way it is not
/// played, which is the moment as <see cref="MomentTests"/> holds it.
/// </summary>
public class UnboxingTests
{
    private const string Addon = "3811574606";
    private const ulong Ada = 76561198000000001;
    private const ulong Ben = 76561198000000002;
    private const ulong Cleo = 76561198000000003;
    private const ulong Dana = 76561198000000004;

    private const string AdaWins = "Ada zieht: BIG Trikot!";
    private const string YouWin = "Du ziehst: BIG Trikot!";
    private const string AdaWinsEnglish = "Ada wins: BIG jersey!";
    private const string YouWinEnglish = "You win: BIG jersey!";
    private const string CallGerman = "hat einen Drop! Mal sehen…";
    private const string CallEnglish = "got a drop! Let's see…";

    private static readonly MomentReelItem[] Decoys =
    [
        new() { Art = "category-skin", Tier = MomentTier.Common },
        new() { Art = "category-merch", Tier = MomentTier.Uncommon },
        new() { Art = "double-xp", Tier = MomentTier.Rare },
        new() { Art = "big-cap", Tier = MomentTier.Legendary },
    ];

    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static MomentCommand Drop(
        string correlationId,
        ulong? about = Ada,
        long inMs = 0,
        MomentTier tier = MomentTier.Rare,
        string kind = "drop",
        string? art = "big-jersey",
        IReadOnlyList<MomentReelItem>? reel = null,
        bool noReel = false,
        string? line = null) => new()
        {
            CorrelationId = correlationId,
            Kind = kind,
            SteamId64 = about?.ToString(CultureInfo.InvariantCulture),
            Tier = tier,
            Art = art,
            Text = new MomentCommandText
            {
                De = new MomentWords { Everyone = line ?? AdaWins, You = line is null ? YouWin : null },
                En = new MomentWords { Everyone = line ?? AdaWinsEnglish, You = line is null ? YouWinEnglish : null },
            },
            Reel = noReel ? null : reel ?? Decoys,
            InMs = inMs,
        };

    private static GameRules Rules(bool warmup = false, bool paused = false, GamePhase phase = GamePhase.PlayingFirstHalf) =>
        new(warmup, RoundsPlayed: 3, paused, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: false, phase);

    /// <summary>A pug for Ada (German) and Dana, who never comes, against Ben (English); Ada and Ben arrived after the assignment. No round has started.</summary>
    private static GamemodeTestHost Assigned(bool hud = true, string? addon = Addon)
    {
        var host = new GamemodeTestHost(hudAddon: addon);
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            teamA: [GamemodeTestHost.Player(Ada, "Ada"), GamemodeTestHost.Player(Dana, "Dana")],
            teamB: [GamemodeTestHost.Player(Ben, "Ben", Locale.En)],
            hud: hud));
        host.World.Connect(Ada, "Ada", PlayerTeam.CounterTerrorist);
        host.World.Connect(Ben, "Ben", PlayerTeam.Terrorist);
        return host;
    }

    private static IGamePlayer Player(GamemodeTestHost host, ulong steamId64) => host.World.Find(steamId64)!;

    private static void Warmup(GamemodeTestHost host)
    {
        host.World.Rules = Rules(warmup: true, phase: GamePhase.WarmupRound);
        host.World.StartRound();
    }

    /// <summary>A live round starts: its freeze time begins. Eighteen seconds is a PUG's.</summary>
    private static void Freeze(GamemodeTestHost host, string seconds = "18", string restart = "7")
    {
        host.World.SetCvar("mp_freezetime", seconds);
        host.World.SetCvar("mp_round_restart_delay", restart);
        host.World.Rules = Rules();
        host.World.StartRound();
    }

    private static void Decide(GamemodeTestHost host) =>
        host.World.EndRound(PlayerTeam.Terrorist, RoundEndReason.Elimination, 1, 0);

    private static FakeHudLayout Layout(GamemodeTestHost host) => host.World.HudLayout(Moments.Layout);

    private static bool On(GamemodeTestHost host, ulong steamId64, string className) =>
        host.World.HudLayouts.Count > 0 && Layout(host).Has(Player(host, steamId64).Slot, Moments.Unbox, className);

    /// <summary>The beats on this player's screen, in the order the stylesheet reads them.</summary>
    private static string Beats(GamemodeTestHost host, ulong steamId64) =>
        string.Join(' ', new[] { Moments.Shown, Moments.Slide, Moments.Revealed }
            .Concat(Enumerable.Range(1, Moments.ReelLandings).Select(Moments.Landing))
            .Where(className => On(host, steamId64, className)));

    /// <summary>The reel's step on everybody's screen, read off the layout: 0 at rest.</summary>
    private static int StepOn(GamemodeTestHost host) =>
        Enumerable.Range(1, Moments.ReelSteps).Where(step => Layout(host).Classes.GetValueOrDefault((Moments.Unbox, Moments.StepClass(step)))).DefaultIfEmpty(0).Max();

    /// <summary>How many step classes are on at once: never more than one.</summary>
    private static int StepsOn(GamemodeTestHost host) =>
        Enumerable.Range(1, Moments.ReelSteps).Count(step => Layout(host).Classes.GetValueOrDefault((Moments.Unbox, Moments.StepClass(step))));

    private static bool CardUp(GamemodeTestHost host, ulong steamId64) =>
        host.World.HudLayouts.Count > 0 && Layout(host).Has(Player(host, steamId64).Slot, Moments.Card, Moments.Shown);

    private static string? ToastOn(GamemodeTestHost host, ulong steamId64, int row = 1)
    {
        var slot = Player(host, steamId64).Slot;
        return host.World.HudLayouts.Count > 0 && Layout(host).Has(slot, Moments.Toast(row), Moments.Shown)
            ? Layout(host).Variable(slot, Moments.ToastText(row), Moments.Text)
            : null;
    }

    private static int Read(GamemodeTestHost host, ulong steamId64, string line) =>
        host.World.Said.GetValueOrDefault(steamId64, []).Count(said => said == host.Runtime.Brand.Line(line));

    /// <summary>The sounds this player heard that were not the reel's ticks.</summary>
    private static List<(string Event, float Volume)> Reveals(GamemodeTestHost host, ulong steamId64) =>
        [.. host.World.Sounds.GetValueOrDefault(steamId64, []).Where(sound => sound.Event != Moments.TickSound)];

    /// <summary>How many of the reel's ticks this player heard.</summary>
    private static int Ticks(GamemodeTestHost host, ulong steamId64) =>
        host.World.Sounds.GetValueOrDefault(steamId64, []).Count(sound => sound.Event == Moments.TickSound);

    /// <summary>What everybody's reel holds, slot by slot: the classes that are on.</summary>
    private static List<string> Reel(GamemodeTestHost host) =>
        [.. Enumerable.Range(1, Moments.ReelSlots).Select(slot => string.Join(' ', Layout(host).Classes
            .Where(entry => entry.Key.Panel == Moments.ReelSlot(slot) && entry.Value)
            .Select(entry => entry.Key.Class)
            .Order(StringComparer.Ordinal)))];

    // ------------------------------------------------------------------ the three beats

    [Fact]
    public void EverybodyWatchesTheCallTheReelAndTheReveal_EachAtItsInstant()
    {
        using var host = Assigned();
        Freeze(host);
        host.Clock.Advance(2_500);

        Assert.Equal(LinkCommandStatus.Applied, host.Link.Command(Drop("m1"))!.Status);

        // The call: the panel for both, the name for everybody, the words in each one's language.
        var layout = Layout(host);
        Assert.True(host.Runtime.Moments.Unboxing);
        Assert.Equal(Moments.Shown, Beats(host, Ada));
        Assert.Equal(Moments.Shown, Beats(host, Ben));
        Assert.Equal("Ada", layout.Variables[(Moments.UnboxName, Moments.Text)]);
        Assert.Equal(CallGerman, layout.Variable(Player(host, Ada).Slot, Moments.UnboxCall, Moments.Text));
        Assert.Equal(CallEnglish, layout.Variable(Player(host, Ben).Slot, Moments.UnboxCall, Moments.Text));
        Assert.True(layout.Classes[(Moments.Unbox, Moments.SideCt)]);
        // In chat too, and nothing yet that names the prize: no line, no toast, no card.
        Assert.Equal(1, Read(host, Ada, $"Ada {CallGerman}"));
        Assert.Equal(1, Read(host, Ben, $"Ada {CallEnglish}"));
        Assert.Equal(0, Read(host, Ada, YouWin));
        Assert.Equal(0, Read(host, Ben, AdaWinsEnglish));
        Assert.Null(ToastOn(host, Ben));
        Assert.False(CardUp(host, Ada));
        Assert.Empty(host.World.Sounds);

        // The reel, with one landing, and the strip at rest until its first step.
        host.Clock.Advance(Moments.CallMs - 1);
        Assert.Equal(Moments.Shown, Beats(host, Ben));
        Assert.Equal(0, StepOn(host));
        host.Clock.Advance(1);
        var rolling = Beats(host, Ben);
        Assert.Matches($"^{Moments.Shown} land-[1-{Moments.ReelLandings}]$", rolling);
        Assert.Equal(rolling, Beats(host, Ada));
        Assert.Equal(0, StepOn(host));
        host.Clock.Advance(Moments.Steps[0]);
        Assert.Equal(1, StepOn(host));

        // The reveal, at the contract's instant: the strip stands on the prize, the landing settles, the sound, the line.
        host.Clock.Advance(Moments.ReelMs - Moments.Steps[0] - 1);
        Assert.Equal(rolling, Beats(host, Ada));
        Assert.Equal(Moments.ReelSteps, StepOn(host));
        Assert.Equal(0, Read(host, Ben, AdaWinsEnglish));
        host.Clock.Advance(1);
        Assert.Equal(ProtocolConstants.MomentUnboxingRevealMs, Moments.RevealMs);
        Assert.Equal($"{Moments.Shown} {Moments.Revealed}", Beats(host, Ada));
        Assert.Equal($"{Moments.Shown} {Moments.Revealed}", Beats(host, Ben));
        Assert.Equal(Moments.ReelSteps, StepOn(host));
        Assert.Equal(YouWin, layout.Variable(Player(host, Ada).Slot, Moments.UnboxLine, Moments.Text));
        Assert.Equal(AdaWinsEnglish, layout.Variable(Player(host, Ben).Slot, Moments.UnboxLine, Moments.Text));
        Assert.Equal(1, Read(host, Ada, YouWin));
        Assert.Equal(1, Read(host, Ben, AdaWinsEnglish));
        Assert.Equal((Moments.RevealSoundOf(MomentTier.Rare), 1f), Assert.Single(Reveals(host, Ada)));
        Assert.Equal((Moments.RevealSoundOf(MomentTier.Rare), Moments.RevealVolume), Assert.Single(Reveals(host, Ben)));
        Assert.True(layout.Classes[(Moments.Unbox, "tier-rare")]);
        Assert.True(layout.Classes[(Moments.Unbox, "art-big-jersey")]);

        // Gone, with the freeze still running: it never needed the freeze to end. The
        // strip goes back once the panel has faded, unseen.
        host.Clock.Advance(Moments.PrizeMs - 1);
        Assert.Equal($"{Moments.Shown} {Moments.Revealed}", Beats(host, Ben));
        host.Clock.Advance(1);
        Assert.Equal("", Beats(host, Ada));
        Assert.Equal("", Beats(host, Ben));
        Assert.False(host.Runtime.Moments.Unboxing);
        Assert.Equal(Moments.ReelSteps, StepOn(host));
        host.Clock.Advance(Moments.StripBackMs);
        Assert.Equal(0, StepOn(host));
        Assert.Equal(0, host.Runtime.Moments.ReelStep);
        Assert.True(host.Runtime.Hud.Quiet is { Reason: QuietReason.FreezeTime, LeftMs: >= Moments.UnboxSpareMs });

        // In place of the toast and the card, to the end: said once, drawn once.
        host.World.EndFreeze();
        Decide(host);
        Assert.Null(ToastOn(host, Ben));
        Assert.False(CardUp(host, Ada));
        Assert.Equal(0, host.Runtime.Moments.CardsWaiting);
        Assert.Equal(1, Read(host, Ada, YouWin));
    }

    /// <summary>
    /// The reel is the server's motion (decision 36): from the instant it starts to the
    /// reveal the server writes exactly the step classes for everybody, the new one before
    /// the old one comes off, and plays a tick in the same frame, and nothing else to any
    /// layout, even where it is likeliest to: everybody spawned at the round start the
    /// unboxing began at, so the slot's second telling (<see cref="Hud.ResendDelayMs"/>,
    /// as long as the call) falls on the instant the reel starts.
    /// </summary>
    [Fact]
    public void OnlyTheStepsTouchTheLayoutWhileTheReelRuns_EachWithItsTick()
    {
        Assert.Equal(Hud.ResendDelayMs, Moments.CallMs);
        using var host = Assigned();
        Freeze(host);
        host.World.Spawn(Player(host, Ada));
        host.World.Spawn(Player(host, Ben));
        host.Link.Command(Drop("m1"));
        host.Clock.Advance(Moments.CallMs);
        var rolling = Beats(host, Ben);
        Assert.Matches($"^{Moments.Shown} land-[1-{Moments.ReelLandings}]$", rolling);
        Assert.Equal(rolling, Beats(host, Ada));

        var from = host.World.Actions.Count;
        var expected = new List<string>();
        for (var step = 1; step <= Moments.ReelSteps; step++)
        {
            expected.Add($"hud_class {Moments.Layout} {Moments.Unbox} +{Moments.StepClass(step)}");
            if (step > 1)
            {
                expected.Add($"hud_class {Moments.Layout} {Moments.Unbox} -{Moments.StepClass(step - 1)}");
            }

            expected.Add($"sound {Ada} {Moments.TickSound} {Moments.TickVolume}");
            expected.Add($"sound {Ben} {Moments.TickSound} {Moments.TickVolume}");
        }

        host.Clock.Advance(Moments.ReelMs - 1);
        var during = host.World.Actions.Skip(from).Select(action => action.ToString()).ToList();
        Assert.Equal(expected, during.Select(line => Regex.Replace(line, @"(sound \d+ \S+) .*", "$1 " + Moments.TickVolume.ToString(CultureInfo.InvariantCulture))));
        Assert.Equal(rolling, Beats(host, Ben));
        Assert.Equal(1, StepsOn(host));
    }

    /// <summary>The beats of the unboxing as the server's console says them, which is all a lane on a server of puppets can time (PRD-08 T6): a bot has no screen.</summary>
    private static List<string> Said(GamemodeTestHost host) =>
        [.. host.Logged.Where(line => line.Contains("unboxing", StringComparison.Ordinal))];

    [Fact]
    public void TheConsoleSaysEachBeatAtItsInstant_SoAServerOfPuppetsCanBeTimed()
    {
        using var host = Assigned();
        Freeze(host);
        host.Link.Command(Drop("m1"));
        Assert.Equal([$"info: hud: unboxing for {Ada} (FreezeTime, 18000 ms left), 2 watching; the prize shows in {Moments.RevealMs} ms"], Said(host));

        host.Clock.Advance(Moments.CallMs);
        Assert.Matches($"^info: hud: the unboxing for {Ada} rolls to landing [1-{Moments.ReelLandings}] \\({Moments.ReelSteps} steps\\)$", Said(host)[1]);
        host.Clock.Advance(Moments.ReelMs);
        Assert.Equal($"info: hud: the unboxing for {Ada} shows its prize (rare) and says its line", Said(host)[2]);
        host.Clock.Advance(Moments.PrizeMs - 1);
        Assert.Equal(3, Said(host).Count);
        host.Clock.Advance(1);
        Assert.Equal($"info: hud: the unboxing for {Ada} is put away: its prize was shown", Said(host)[3]);
        Assert.Equal(4, Said(host).Count);

        // Cut by the freeze's end before the prize, and a freeze too short to start one: each says why.
        host.World.EndFreeze();
        Decide(host);
        Freeze(host);
        host.Link.Command(Drop("m2", tier: MomentTier.Legendary));
        host.Clock.Advance(Moments.CallMs + 1_000);
        host.World.EndFreeze();
        Assert.Equal(
            $"info: hud: the unboxing for {Ada} is put away: somebody is playing before its prize, so it is shown without its reel",
            Said(host)[^1]);
        Decide(host);
        Freeze(host, "13");
        host.Link.Command(Drop("m3", tier: MomentTier.Uncommon));
        Assert.Equal(
            $"info: hud: no stretch fits the unboxing for {Ada} (FreezeTime, 13000 ms left, {Moments.UnboxMs + Moments.UnboxSpareMs} ms wanted); it is shown without its reel",
            Said(host)[^1]);
    }

    [Fact]
    public void ThePrizeIsInTheSlotTheReelStopsOn_AndEveryOtherSlotIsADecoy()
    {
        using var host = Assigned();
        Warmup(host);

        host.Link.Command(Drop("m1"));

        var reel = Reel(host);
        Assert.Equal("art-big-jersey tier-rare", reel[Moments.ReelStopSlot - 1]);
        var decoys = Decoys.Select(item => $"art-{item.Art} {Moments.TierClassOf(item.Tier)}").ToList();
        for (var slot = 1; slot <= Moments.ReelSlots; slot++)
        {
            if (slot == Moments.ReelStopSlot)
            {
                continue;
            }

            Assert.Contains(reel[slot - 1], decoys);
            // Never the same twice running, except across the prize.
            if (slot > 1 && slot - 1 != Moments.ReelStopSlot)
            {
                Assert.NotEqual(reel[slot - 2], reel[slot - 1]);
            }
        }

        // A reel of one thing is that thing in every slot, and still an unboxing.
        using var single = Assigned();
        Warmup(single);
        single.Link.Command(Drop("m1", reel: [Decoys[0]]));
        Assert.All(Reel(single).Where((_, index) => index != Moments.ReelStopSlot - 1), slot => Assert.Equal(decoys[0], slot));
    }

    [Fact]
    public void ARedeliveryShowsTheSameReel_AndAnotherMomentAnother()
    {
        (List<string> Reel, string Beats) Played(MomentCommand moment)
        {
            using var host = Assigned();
            Warmup(host);
            host.Link.Command(moment);
            host.Clock.Advance(moment.InMs + Moments.CallMs);
            return (Reel(host), Beats(host, Ben));
        }

        var first = Played(Drop("m1"));
        // The same win with another correlation id, due later: what the platform's retry sends.
        var again = Played(Drop("m2", inMs: 500));
        var other = Played(Drop("m3", about: Ben));

        Assert.Equal(first.Reel, again.Reel);
        Assert.Equal(first.Beats, again.Beats);
        Assert.NotEqual(first.Reel, other.Reel);
    }

    [Fact]
    public void TheNextReelSaysOnlyWhatChanged_AndLeavesNothingOfTheLastOne()
    {
        using var host = Assigned();
        Warmup(host);
        host.Link.Command(Drop("m1"));
        host.Clock.Advance(Moments.UnboxMs + Moments.UnboxRestMs);

        host.Link.Command(Drop("m2", about: Ben, tier: MomentTier.Legendary, art: "big-cap", reel: [Decoys[0], Decoys[1]]));

        var reel = Reel(host);
        Assert.Equal("art-big-cap tier-legendary", reel[Moments.ReelStopSlot - 1]);
        Assert.All(reel.Where((_, index) => index != Moments.ReelStopSlot - 1), slot =>
            Assert.Contains(slot, new[] { "art-category-skin tier-common", "art-category-merch tier-uncommon" }));
        Assert.True(Layout(host).Classes[(Moments.Unbox, "tier-legendary")]);
        Assert.False(Layout(host).Classes[(Moments.Unbox, "tier-rare")]);
        Assert.False(Layout(host).Classes[(Moments.Unbox, "art-big-jersey")]);
        Assert.False(Layout(host).Classes[(Moments.Unbox, Moments.SideCt)]);
        Assert.True(Layout(host).Classes[(Moments.Unbox, Moments.SideT)]);
        Assert.Equal("Ben", Layout(host).Variables[(Moments.UnboxName, Moments.Text)]);
    }

    // ------------------------------------------------------------------ where it does not fit

    public static TheoryData<string, string, long> TooShort() =>
        new()
        {
            { "Rush's thirteen seconds", "13", 0 },
            { "flying-scoutsman's five", "5", 0 },
            { "a PUG's freeze with the spare gone", "18", 18_000 - Moments.UnboxMs - Moments.UnboxSpareMs + 1 },
        };

    [Theory]
    [MemberData(nameof(TooShort))]
    public void AStretchTooShortForAllOfItGivesTheToastAndTheCard(string name, string freeze, long into)
    {
        Assert.NotEmpty(name);
        using var host = Assigned();
        Freeze(host, freeze);
        host.Clock.Advance(into);

        host.Link.Command(Drop("m1"));

        Assert.False(host.Runtime.Moments.Unboxing);
        Assert.Equal(0, host.Runtime.Moments.UnboxingsWaiting);
        Assert.Equal("", Beats(host, Ada));
        Assert.Equal("", Beats(host, Ben));
        // PRD-07's moment, at once: the line, the toast, and the card now or at the next stretch.
        Assert.Equal(1, Read(host, Ada, YouWin));
        Assert.Equal(1, Read(host, Ben, AdaWinsEnglish));
        Assert.Equal(0, Read(host, Ben, $"Ada {CallEnglish}"));
        Assert.Equal(AdaWinsEnglish, ToastOn(host, Ben));
        Assert.True(CardUp(host, Ada) || host.Runtime.Moments.CardsWaiting == 1);
        Assert.DoesNotContain(host.World.HudActions, action => action.Detail.Contains(Moments.ReelSlot(1), StringComparison.Ordinal));
    }

    [Fact]
    public void AFreezeWithExactlyTheSequenceAndTheSpareLeftPlaysIt()
    {
        using var host = Assigned();
        Freeze(host);
        host.Clock.Advance(18_000 - Moments.UnboxMs - Moments.UnboxSpareMs);

        host.Link.Command(Drop("m1"));

        Assert.Equal(Moments.Shown, Beats(host, Ben));
        // Rush never fits, even at the instant its freeze starts.
        Assert.True(Moments.UnboxMs + Moments.UnboxSpareMs > 13_000);
        // And a PUG's fits with the platform's beat of two and a half seconds spent, and a second for the road.
        Assert.True(Moments.UnboxMs + Moments.UnboxSpareMs <= 18_000 - 2_500 - 1_000);
    }

    [Theory]
    [InlineData("a round is being played")]
    [InlineData("no round has started on this map")]
    public void WithNoStretchAtAllItIsTheMomentItWasBeforeReels(string situation)
    {
        using var host = Assigned();
        if (situation == "a round is being played")
        {
            Freeze(host);
            host.World.EndFreeze();
        }

        host.Link.Command(Drop("m1"));

        Assert.False(host.Runtime.Moments.Unboxing);
        Assert.Equal(0, host.Runtime.Moments.UnboxingsWaiting);
        Assert.Equal(1, Read(host, Ada, YouWin));
        Assert.Equal(1, host.Runtime.Moments.CardsWaiting);
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData(Addon, false)]
    public void WithTheHudOffAnUnboxingIsItsLine_AtOnce_AndNothingElse(string? addon, bool asked)
    {
        using var host = Assigned(hud: asked, addon: addon);
        Freeze(host);

        Assert.Equal(LinkCommandStatus.Applied, host.Link.Command(Drop("m1"))!.Status);

        Assert.Equal(1, Read(host, Ada, YouWin));
        Assert.Equal(1, Read(host, Ben, AdaWinsEnglish));
        host.World.Elapse(Moments.UnboxMs);
        Assert.Equal(1, host.World.Said[Ben].Count(said => said.Contains("Ada", StringComparison.Ordinal)));
        Assert.Empty(host.World.HudActions);
        Assert.Empty(host.World.Sounds);
    }

    [Fact]
    public void OnlyADropAboutSomebodyWithAReelIsUnboxed()
    {
        using var host = Assigned();
        Warmup(host);

        host.Link.Command(Drop("m1", noReel: true));
        host.Link.Command(Drop("m2", kind: "perk", line: "perk"));
        host.Link.Command(Drop("m3", kind: "raffle", line: "raffle"));
        host.Link.Command(Drop("m4", about: null, line: "nobody's"));
        // Somebody this server has no name for: not on it, not on the roster.
        host.Link.Command(Drop("m5", about: 76561198000000099, line: "a stranger's"));

        Assert.False(host.Runtime.Moments.Unboxing);
        Assert.Equal("", Beats(host, Ben));
        foreach (var line in new[] { AdaWinsEnglish, "perk", "raffle", "nobody's", "a stranger's" })
        {
            Assert.Equal(1, Read(host, Ben, line));
        }
    }

    // ------------------------------------------------------------------ put away

    [Fact]
    public void AFreezeThatEndsBeforeTheRevealPutsItAwayInThatInstant_AndTheMomentIsToldTheOldWay()
    {
        using var host = Assigned();
        Freeze(host);
        host.Link.Command(Drop("m1"));
        host.Clock.Advance(Moments.CallMs + 3_000);
        Assert.Matches($"^{Moments.Shown} land-[1-{Moments.ReelLandings}]$", Beats(host, Ben));
        Assert.True(StepOn(host) > 0);

        // Somebody unpaused, or the cvar was wrong: the freeze is over early.
        var ticked = Ticks(host, Ben);
        Assert.True(ticked > 0);
        host.World.EndFreeze();

        Assert.Equal("", Beats(host, Ada));
        Assert.Equal("", Beats(host, Ben));
        Assert.False(host.Runtime.Moments.Unboxing);
        // Nobody saw the prize: the line and the toast now, the card at the next stretch.
        Assert.Equal(1, Read(host, Ada, YouWin));
        Assert.Equal(AdaWinsEnglish, ToastOn(host, Ben));
        Assert.Equal(YouWin, ToastOn(host, Ada));
        Assert.Equal(1, host.Runtime.Moments.CardsWaiting);

        // No beat of it comes back, no tick or reveal of it plays, and the line is not said again.
        host.Clock.Advance(Moments.UnboxMs);
        Assert.Equal("", Beats(host, Ben));
        Assert.Equal(ticked, Ticks(host, Ben));
        Assert.Empty(Reveals(host, Ben));
        Assert.Equal(1, Read(host, Ben, AdaWinsEnglish));
        Decide(host);
        Assert.True(CardUp(host, Ada));
        Assert.Equal("", Beats(host, Ben));
    }

    [Fact]
    public void AFreezeThatEndsAfterTheRevealPutsItAway_AndNothingFollows()
    {
        using var host = Assigned();
        Freeze(host);
        host.Link.Command(Drop("m1"));
        host.Clock.Advance(Moments.RevealMs + 1_000);

        host.World.EndFreeze();

        Assert.Equal("", Beats(host, Ada));
        Assert.Equal("", Beats(host, Ben));
        Assert.Null(ToastOn(host, Ben));
        Assert.Equal(0, host.Runtime.Moments.CardsWaiting);
        host.Clock.Advance(Moments.UnboxMs);
        Decide(host);
        Assert.Equal(1, Read(host, Ben, AdaWinsEnglish));
        Assert.False(CardUp(host, Ada));
    }

    // ------------------------------------------------------------------ one at a time

    [Fact]
    public void TwoUnboxingsNeverOverlap_TheSecondWaitsForTheNextFreeze()
    {
        using var host = Assigned();
        Freeze(host);
        host.Clock.Advance(2_500);
        host.Link.Command(Drop("m1"));
        host.Link.Command(Drop("m2", about: Ben, line: "Ben's"));

        // The second is held whole: no call, no line, no toast, while the first plays.
        Assert.Equal(1, host.Runtime.Moments.UnboxingsWaiting);
        Assert.Equal("Ada", Layout(host).Variables[(Moments.UnboxName, Moments.Text)]);
        Assert.Equal(0, Read(host, Ada, "Ben's"));

        // The first runs out with a second and a half of freeze left: no room, and it does not start.
        host.Clock.Advance(Moments.UnboxMs + Moments.UnboxRestMs);
        Assert.Equal("", Beats(host, Ada));
        Assert.Equal(1, host.Runtime.Moments.UnboxingsWaiting);
        // Nor in the decided round, under the win panel.
        host.World.EndFreeze();
        host.Clock.Advance(60_000);
        Decide(host);
        Assert.Equal("", Beats(host, Ada));
        Assert.Equal(1, host.Runtime.Moments.UnboxingsWaiting);

        // The next freeze is its own.
        host.Clock.Advance(7_000);
        host.World.StartRound();
        Assert.Equal(Moments.Shown, Beats(host, Ada));
        Assert.Equal("Ben", Layout(host).Variables[(Moments.UnboxName, Moments.Text)]);
        Assert.Equal(0, host.Runtime.Moments.UnboxingsWaiting);
        host.Clock.Advance(Moments.RevealMs);
        Assert.Equal(1, Read(host, Ada, "Ben's"));
    }

    [Fact]
    public void WhereNothingEndsTheStretchTheSecondFollowsTheFirstAfterARest()
    {
        using var host = Assigned();
        Warmup(host);
        host.Link.Command(Drop("m1"));
        host.Link.Command(Drop("m2", about: Ben, line: "Ben's"));

        host.Clock.Advance(Moments.UnboxMs);
        Assert.Equal("", Beats(host, Ada));
        host.Clock.Advance(Moments.UnboxRestMs - 1);
        Assert.Equal("", Beats(host, Ada));
        host.Clock.Advance(1);
        Assert.Equal(Moments.Shown, Beats(host, Ada));
        Assert.Equal("Ben", Layout(host).Variables[(Moments.UnboxName, Moments.Text)]);
    }

    [Theory]
    [InlineData(0, true)]
    [InlineData(1, false)]
    public void AnUnboxingThatWaitedPastTheCapIsToldTheOldWay(long past, bool plays)
    {
        using var host = Assigned();
        Freeze(host);
        host.Link.Command(Drop("m1"));
        host.Link.Command(Drop("m2", about: Ben, line: "Ben's"));
        // The first is cut by the round going live, and the round runs as long as a round can.
        host.World.EndFreeze();
        host.Clock.Advance(Moments.CardWaitMs + past);

        // The first stretch that would fit it: the map is over.
        host.World.EndMap();

        Assert.Equal(0, host.Runtime.Moments.UnboxingsWaiting);
        Assert.Equal(plays, host.Runtime.Moments.Unboxing);
        Assert.Equal(plays ? 0 : 1, Read(host, Ada, "Ben's"));
    }

    [Fact]
    public void NoMoreThanAFewUnboxingsWait_AndTheNextIsToldTheOldWay()
    {
        using var host = Assigned();
        Warmup(host);
        host.Link.Command(Drop("m0"));
        for (var n = 1; n <= Moments.UnboxingsWaitingMax + 1; n++)
        {
            host.Link.Command(Drop($"m{n}", about: Ben, line: $"line {n}"));
        }

        Assert.Equal(Moments.UnboxingsWaitingMax, host.Runtime.Moments.UnboxingsWaiting);
        Assert.Equal(1, Read(host, Ada, $"line {Moments.UnboxingsWaitingMax + 1}"));
        Assert.Equal(0, Read(host, Ada, "line 1"));
    }

    [Fact]
    public void ADecidedRoundWaitsForItsRoundStart_WhichPlaysItOrInAShortFreezeTellsItTheOldWay()
    {
        using var pug = Assigned();
        Freeze(pug);
        pug.World.EndFreeze();
        Decide(pug);
        pug.Link.Command(Drop("m1"));
        Assert.Equal("", Beats(pug, Ben));
        Assert.Equal(1, pug.Runtime.Moments.UnboxingsWaiting);
        Assert.Equal(0, Read(pug, Ben, AdaWinsEnglish));
        pug.Clock.Advance(7_000);
        pug.World.StartRound();
        Assert.Equal(Moments.Shown, Beats(pug, Ben));

        using var rush = Assigned();
        Freeze(rush, "13");
        rush.World.EndFreeze();
        Decide(rush);
        rush.Link.Command(Drop("m1"));
        Assert.Equal(1, rush.Runtime.Moments.UnboxingsWaiting);
        rush.Clock.Advance(7_000);
        rush.World.StartRound();
        Assert.Equal("", Beats(rush, Ben));
        Assert.Equal(0, rush.Runtime.Moments.UnboxingsWaiting);
        Assert.Equal(1, Read(rush, Ben, AdaWinsEnglish));
        Assert.Equal(AdaWinsEnglish, ToastOn(rush, Ben));
        Assert.True(CardUp(rush, Ada));
    }

    // ------------------------------------------------------------------ the sound

    [Fact]
    public void TheReelTicksAtEachStep_SlowingWithIt_ForEverybodyWatching()
    {
        using var host = Assigned();
        Freeze(host);
        host.Link.Command(Drop("m1"));
        host.Clock.Advance(Moments.CallMs - 1);
        Assert.Equal(0, Ticks(host, Ben));
        host.Clock.Advance(1);

        // Each instant a tick is heard, on the fake clock, from the reel's start, and the
        // step on everybody's screen in that same instant.
        var heard = new List<long>();
        var stepped = new List<int>();
        for (var ms = 0L; ms < Moments.ReelMs; ms++)
        {
            var before = Ticks(host, Ben);
            host.Clock.Advance(1);
            if (Ticks(host, Ben) > before)
            {
                heard.AddRange(Enumerable.Repeat(ms + 1, Ticks(host, Ben) - before));
                stepped.Add(StepOn(host));
                Assert.Equal(1, StepsOn(host));
            }
        }

        Assert.Equal(Moments.Steps, heard);
        Assert.Equal(Enumerable.Range(1, Moments.ReelSteps), stepped);
        Assert.Equal(Ticks(host, Ben), Ticks(host, Ada));
        Assert.All(host.World.Sounds[Ben].Where(sound => sound.Event == Moments.TickSound), sound => Assert.Equal(Moments.TickVolume, sound.Volume));

        // The reveal is no tick, and none follows it.
        Assert.Single(Reveals(host, Ben));
        var ticks = Ticks(host, Ben);
        host.Clock.Advance(Moments.PrizeMs);
        Assert.Equal(ticks, Ticks(host, Ben));
    }

    /// <summary>
    /// The schedule's shape (decision 36): a step a slot from the resting slot to the
    /// prize's, fast, then slower all the way, never closer than the least gap the server
    /// can play a tick at, and the last with most of a second to stand before the reveal.
    /// </summary>
    [Fact]
    public void TheStepsSlowAllTheWay_StartAtTheGamesOwnFastestTick_AndStandBeforeTheReveal()
    {
        var steps = Moments.Steps;
        Assert.Equal(Moments.ReelStopSlot - Moments.ReelRestSlot, steps.Count);
        Assert.Equal(Moments.ReelSteps, steps.Count);
        Assert.True(steps[0] > 0);
        var gaps = steps.Zip(steps.Skip(1), (a, b) => b - a).ToList();
        Assert.All(gaps, gap => Assert.True(gap >= Moments.TickGapMinMs));
        // The game's own case opening ticks at most 16 times a second; so does this, from the first step.
        Assert.InRange(gaps[0], Moments.TickGapMinMs, 70);
        Assert.Equal(gaps.Order(), gaps);
        // A blur at the start (ten or more steps in the first second), readable at the end
        // (the last five gaps each over a quarter of a second), and a stand before the prize.
        Assert.True(steps.Count(at => at <= 1_000) >= 10);
        Assert.All(gaps.TakeLast(5), gap => Assert.True(gap > 250));
        Assert.InRange(Moments.ReelMs - steps[^1] - Moments.StepMs, 750, 1_250);
        // A step's slide is over before the next step at the end, so the strip never lags
        // its tick: shorter than the slowest gap; and the strip is home again inside the
        // rest between two unboxings.
        Assert.True(Moments.StepMs < gaps[^1]);
        Assert.True(Moments.StripBackMs + Moments.StepMs < Moments.UnboxRestMs);
    }

    /// <summary>
    /// The schedule itself, pinned, so a change to the curve is a change somebody sees in
    /// a diff. Before the steps (PRD-09 T1) the ticks followed the stylesheet's slide,
    /// 29 of them from 32 ms to 4.4–5.2 s by landing; <c>docs/hud.md</c>, "The unboxing,
    /// played".
    /// </summary>
    [Fact]
    public void TheStepsAreTheCurvesOwn_Pinned()
    {
        Assert.Equal([0.2, 0.65, 0.55, 1], Moments.ReelCurve);
        Assert.Equal(
            [32L, 99, 168, 240, 316, 395, 478, 565, 656, 751, 851, 956, 1066, 1182, 1305, 1435, 1573, 1720, 1877, 2045, 2226, 2423, 2639, 2877, 3146, 3454, 3820, 4286, 4989],
            Moments.Steps);
    }

    [Fact]
    public void TheRevealSoundsByTier_ForEverybody_TheWinnerTheLoudest()
    {
        var events = Enum.GetValues<MomentTier>().Select(Moments.RevealSoundOf).ToList();
        Assert.Equal(events.Count, events.Distinct().Count());
        Assert.DoesNotContain(Moments.TickSound, events);

        foreach (var tier in Enum.GetValues<MomentTier>())
        {
            using var host = Assigned();
            Freeze(host);
            host.Link.Command(Drop("m1", tier: tier));
            host.Clock.Advance(Moments.RevealMs);

            Assert.Equal((Moments.RevealSoundOf(tier), 1f), Assert.Single(Reveals(host, Ada)));
            Assert.Equal((Moments.RevealSoundOf(tier), Moments.RevealVolume), Assert.Single(Reveals(host, Ben)));
        }

        Assert.True(Moments.RevealVolume < 1f);
        Assert.True(Moments.TickVolume < Moments.RevealVolume);
    }

    // ------------------------------------------------------------------ who sees it

    [Fact]
    public void SomebodyWhoConnectsMidSequenceSeesNothingOfIt_AndReadsTheLine()
    {
        using var host = Assigned();
        Freeze(host);
        host.Link.Command(Drop("m1"));
        host.Clock.Advance(1_000);

        var cleo = host.World.Connect(Cleo, "Cleo");
        var beats = new[] { Moments.Shown, Moments.Slide, Moments.Revealed }.Concat(Enumerable.Range(1, Moments.ReelLandings).Select(Moments.Landing)).ToList();
        for (var ms = 0L; ms < Moments.UnboxMs; ms += 500)
        {
            Assert.All(beats, className => Assert.False(Layout(host).Has(cleo.Slot, Moments.Unbox, className)));
            host.Clock.Advance(500);
        }

        Assert.Equal(1, Read(host, Cleo, AdaWins));
        Assert.False(host.World.Sounds.ContainsKey(Cleo));
        // Everybody who was there saw and heard all of it.
        Assert.Single(Reveals(host, Ben));
        Assert.Equal(Moments.ReelSteps, Ticks(host, Ben));
    }

    [Fact]
    public void SomebodyWhoLeavesMidSequenceTakesNothingToTheSlotsNextOccupant()
    {
        using var host = Assigned();
        Freeze(host);
        host.Link.Command(Drop("m1"));
        var slot = Player(host, Ben).Slot;
        host.World.Disconnect(Player(host, Ben));
        var cleo = host.World.Connect(Cleo, "Cleo");
        Assert.Equal(slot, cleo.Slot);

        host.Clock.Advance(Moments.RevealMs);

        Assert.False(Layout(host).Has(slot, Moments.Unbox, Moments.Shown));
        Assert.False(Layout(host).Has(slot, Moments.Unbox, Moments.Revealed));
        Assert.Equal($"{Moments.Shown} {Moments.Revealed}", Beats(host, Ada));
    }

    [Fact]
    public void TheWinnerNeedNotBeOnTheServer_EverybodyStillWatches()
    {
        using var host = Assigned();
        Freeze(host);

        // Dana is on the roster and never connected.
        host.Link.Command(Drop("m1", about: Dana));

        Assert.Equal(Moments.Shown, Beats(host, Ada));
        Assert.Equal(Moments.Shown, Beats(host, Ben));
        Assert.Equal("Dana", Layout(host).Variables[(Moments.UnboxName, Moments.Text)]);
        // Nobody's side: the whole cast.
        Assert.DoesNotContain(Layout(host).Classes, entry => entry.Key.Class is Moments.SideCt or Moments.SideT && entry.Value);
        host.Clock.Advance(Moments.RevealMs);
        // Nobody here is the person, so everybody reads everybody's line.
        Assert.Equal(AdaWins, Layout(host).Variable(Player(host, Ada).Slot, Moments.UnboxLine, Moments.Text));
        Assert.Equal(1, Read(host, Ada, AdaWins));
        Assert.Equal(0, host.Runtime.Moments.CardsWaiting);
    }

    [Fact]
    public void APuppetsDropIsWatchedByThePeople_AndABotHasNoScreen()
    {
        using var host = Assigned();
        Warmup(host);
        var puppet = host.World.Connect(Dana, "Dana", PlayerTeam.Terrorist, bot: true);

        host.Link.Command(Drop("m1", about: Dana));
        host.Clock.Advance(Moments.UnboxMs);

        Assert.Equal("Dana", Layout(host).Variables[(Moments.UnboxName, Moments.Text)]);
        Assert.True(Layout(host).Classes[(Moments.Unbox, Moments.SideT)]);
        Assert.Equal((Moments.RevealSoundOf(MomentTier.Rare), Moments.RevealVolume), Assert.Single(Reveals(host, Ada)));
        Assert.DoesNotContain(host.World.HudActions, action => action.SteamId64 == puppet.SteamId64);
        Assert.False(host.World.Sounds.ContainsKey(Dana));
        Assert.False(host.World.Said.ContainsKey(Dana));
    }

    [Fact]
    public void ASpectatorWatchesWithThePlayerTheyFollow()
    {
        // The beats are each player's own classes on an observable layout: the engine shows
        // whoever spectates a player that player's version, and a spectator of nobody their own.
        using var host = Assigned();
        Warmup(host);
        host.World.Connect(Cleo, "Cleo", PlayerTeam.Spectator);

        host.Link.Command(Drop("m1"));

        Assert.True(Layout(host).Observable);
        Assert.Equal(Moments.Shown, Beats(host, Cleo));
    }

    // ------------------------------------------------------------------ as a card does

    [Fact]
    public void APauseStandingInTheFreezeAndTheMatchBeingOverAreStretchesThatFit()
    {
        using var paused = Assigned();
        Freeze(paused, "5");
        paused.World.Rules = Rules(paused: true);
        paused.Clock.Advance(60_000);
        paused.Link.Command(Drop("m1"));
        Assert.Equal(Moments.Shown, Beats(paused, Ben));
        // The match goes on: the freeze ends and it is put away.
        paused.World.Rules = Rules();
        paused.World.EndFreeze();
        Assert.Equal("", Beats(paused, Ben));
        Assert.Equal(1, Read(paused, Ben, AdaWinsEnglish));

        using var over = Assigned();
        Freeze(over);
        over.World.EndFreeze();
        Decide(over);
        over.World.EndMap();
        over.Link.Command(Drop("m1"));
        Assert.Equal(Moments.Shown, Beats(over, Ben));
    }

    [Fact]
    public void AMapChangeTakesTheOneOnScreenAndTheOnesWaiting_AndSaysTheirLines()
    {
        using var host = Assigned();
        Warmup(host);
        host.Link.Command(Drop("m1"));
        host.Link.Command(Drop("m2", about: Ben, line: "Ben's"));
        host.Clock.Advance(Moments.CallMs);

        host.World.StartMap("de_inferno");

        Assert.False(host.Runtime.Moments.Unboxing);
        Assert.Equal(0, host.Runtime.Moments.UnboxingsWaiting);
        Assert.Equal(1, Read(host, Ada, YouWin));
        Assert.Equal(1, Read(host, Ada, "Ben's"));
        Warmup(host);
        host.Clock.Advance(Moments.UnboxMs + Moments.UnboxRestMs);
        Assert.Equal("", Beats(host, Ada));
        Assert.Equal(0, host.Runtime.Moments.CardsWaiting);
        Assert.Empty(host.World.Sounds);
        Assert.Equal(1, Read(host, Ada, YouWin));
    }

    [Fact]
    public void AReleaseTakesEveryUnboxingWithIt()
    {
        using var host = Assigned();
        Warmup(host);
        host.Link.Command(Drop("m1"));
        host.Link.Command(Drop("m2", about: Ben, line: "Ben's"));

        host.Link.Release("ended: completed");
        var actions = host.World.Actions.Count;
        host.World.Elapse(Moments.CardWaitMs);

        Assert.Equal(actions, host.World.Actions.Count);
        Assert.Equal(0, Read(host, Ada, YouWin));
        Assert.Empty(host.World.Sounds);
    }

    // ------------------------------------------------------------------ the switch, and the diagnostic

    [Fact]
    public void TheSwitchOffMakesADropItsLineToastAndCard_AndOnAgainTheReel()
    {
        using var host = Assigned();
        Freeze(host);
        Assert.True(host.Runtime.Moments.ReelOn);
        host.Runtime.Moments.SwitchReel(false);
        Assert.False(host.Runtime.Moments.ReelOn);
        Assert.StartsWith("off (ezpug_unbox_reel 0", host.Runtime.Moments.ReelReport(), StringComparison.Ordinal);

        host.Link.Command(Drop("m1"));

        // PRD-07's moment, at once, and nothing written to the reel.
        Assert.False(host.Runtime.Moments.Unboxing);
        Assert.Equal("", Beats(host, Ada));
        Assert.Equal(1, Read(host, Ada, YouWin));
        Assert.Equal(AdaWinsEnglish, ToastOn(host, Ben));
        Assert.DoesNotContain(host.World.HudActions, action => action.Detail.Contains(Moments.ReelSlot(1), StringComparison.Ordinal));
        Assert.Contains($"info: hud: the reel is off (ezpug_unbox_reel 0); the drop for {Ada} is its line, its toast and its card", host.Logged);

        host.Runtime.Moments.SwitchReel(true);
        Assert.StartsWith("steps, ", host.Runtime.Moments.ReelReport(), StringComparison.Ordinal);
        host.Link.Command(Drop("m2"));
        Assert.True(host.Runtime.Moments.Unboxing);
        Assert.Equal(Moments.Shown, Beats(host, Ada));
    }

    [Fact]
    public void TheStatusLineSaysTheModeTheScheduleAndTheStampThisBuildWasMadeBeside()
    {
        using var host = Assigned();
        var line = host.Runtime.Moments.ReelReport();
        Assert.Equal($"steps, {Moments.ReelSteps} steps over {Moments.Steps[^1]} ms of {Moments.ReelMs}, {Moments.StepMs} ms a step; stamp {HudStamp.Expected} expected on a client's card", line);
        Freeze(host);
        host.Link.Command(Drop("m1"));
        host.Clock.Advance(Moments.CallMs + Moments.Steps[2]);
        Assert.Contains(", on screens now at step 3 (steps); stamp ", host.Runtime.Moments.ReelReport(), StringComparison.Ordinal);
    }

    [Fact]
    public void TheDiagnosticPlaysTheReelNow_InAnyStretchOrNone_ForWhoeverIsHere()
    {
        using var host = Assigned();
        Freeze(host);
        host.World.EndFreeze();
        // A round is being played: no drop would be unboxed here, and the test plays anyway.
        Assert.Null(host.Runtime.Hud.Quiet);

        var answer = host.Runtime.Moments.PlayTest(ReelMode.Steps);

        Assert.StartsWith("unbox test: playing the stepped reel for Ada to 2 watching, no stretch; the prize shows in 8000 ms. This server was built beside addon stamp ", answer, StringComparison.Ordinal);
        Assert.Contains(HudStamp.Expected, answer, StringComparison.Ordinal);
        Assert.True(host.Runtime.Moments.Unboxing);
        Assert.Equal(Moments.Shown, Beats(host, Ada));
        Assert.Equal(Moments.Shown, Beats(host, Ben));
        Assert.Equal("Ada", Layout(host).Variables[(Moments.UnboxName, Moments.Text)]);
        Assert.Equal("art-big-jersey tier-legendary", Reel(host)[Moments.ReelStopSlot - 1]);
        Assert.Equal(1, Read(host, Ada, $"Ada {CallGerman}"));
        Assert.Contains($"info: hud: unboxing for {Ada} (no stretch), 2 watching; the prize shows in {Moments.RevealMs} ms (ezpug_unbox_test steps)", host.Logged);

        host.Clock.Advance(Moments.CallMs + Moments.Steps[^1]);
        Assert.Equal(Moments.ReelSteps, StepOn(host));
        Assert.Equal(Moments.ReelSteps, Ticks(host, Ben));
        host.Clock.Advance(Moments.ReelMs - Moments.Steps[^1]);
        Assert.Equal($"{Moments.Shown} {Moments.Revealed}", Beats(host, Ben));
        Assert.Equal(1, Read(host, Ada, "Du ziehst: BIG Trikot (Testlauf 1)"));
        Assert.Equal(1, Read(host, Ben, "Ada wins: BIG jersey (test run 1)"));

        // A second run is another reel (another landing may come up), told apart by its number.
        host.Clock.Advance(Moments.PrizeMs + Moments.UnboxRestMs);
        Assert.StartsWith("unbox test: playing the stepped reel", host.Runtime.Moments.PlayTest(ReelMode.Steps), StringComparison.Ordinal);
        host.Clock.Advance(Moments.RevealMs);
        Assert.Equal(1, Read(host, Ben, "Ada wins: BIG jersey (test run 2)"));
    }

    [Fact]
    public void TheDiagnosticCanPlayTheOldSlide_WhichNoMatchEverSets()
    {
        using var host = Assigned();
        Warmup(host);

        Assert.StartsWith("unbox test: playing the old slide for Ada", host.Runtime.Moments.PlayTest(ReelMode.Slide), StringComparison.Ordinal);
        host.Clock.Advance(Moments.CallMs);
        Assert.Matches($"^{Moments.Shown} {Moments.Slide} land-[1-{Moments.ReelLandings}]$", Beats(host, Ben));
        Assert.Contains($"info: hud: the unboxing for {Ada} rolls to landing {Regex.Match(Beats(host, Ben), @"land-(\d)").Groups[1].Value} (the old slide)", host.Logged);
        // The slide is the client's: no step class, and the ticks on the same schedule.
        host.Clock.Advance(Moments.ReelMs - 1);
        Assert.Equal(0, StepOn(host));
        Assert.Equal(Moments.ReelSteps, Ticks(host, Ben));
        Assert.DoesNotContain(host.World.HudActions, action => action.Detail.Contains(" +at-", StringComparison.Ordinal));
        host.Clock.Advance(1);
        // The slide stays to the end, so the prize stands under the marker; the landing settles.
        Assert.Equal($"{Moments.Shown} {Moments.Slide} {Moments.Revealed}", Beats(host, Ben));
        host.Clock.Advance(Moments.PrizeMs);
        Assert.Equal("", Beats(host, Ben));

        // A match's own drop never slides.
        host.Clock.Advance(Moments.UnboxRestMs);
        host.Link.Command(Drop("m1"));
        host.Clock.Advance(Moments.CallMs + Moments.Steps[0]);
        Assert.DoesNotContain(Moments.Slide, Beats(host, Ben), StringComparison.Ordinal);
        Assert.Equal(1, StepOn(host));
    }

    [Theory]
    [InlineData("no addon", "unbox test: the HUD is off on this server: it booted without an addon id (EZPUG_HUD_ADDON)")]
    [InlineData("not asked", "unbox test: the HUD is off on this server: the match did not ask for a HUD (branding.hud)")]
    [InlineData("no round", "unbox test: the layouts are not in the world yet: no round has started on this map")]
    [InlineData("busy", "unbox test: an unboxing is on screens now (step 0); wait for it to be put away")]
    public void TheDiagnosticSaysWhyWhenItCannot(string situation, string answer)
    {
        using var host = situation switch
        {
            "no addon" => Assigned(addon: null),
            "not asked" => Assigned(hud: false),
            _ => Assigned(),
        };
        if (situation == "busy")
        {
            Warmup(host);
            host.Link.Command(Drop("m1"));
        }

        Assert.Equal(answer, host.Runtime.Moments.PlayTest(ReelMode.Steps));
        if (situation != "busy")
        {
            Assert.False(host.Runtime.Moments.Unboxing);
            Assert.Empty(host.World.HudActions);
        }
    }

    [Fact]
    public void TheDiagnosticOnAServerOfPuppetsCallsAPuppetsSeat_AndOnAnEmptyOneTheRoster()
    {
        using var host = new GamemodeTestHost(hudAddon: Addon);
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            teamA: [GamemodeTestHost.Player(Ada, "Ada")],
            teamB: [GamemodeTestHost.Player(Ben, "Ben", Locale.En)],
            hud: true));
        Warmup(host);
        Assert.StartsWith("unbox test: playing the stepped reel for Ada to 0 watching", host.Runtime.Moments.PlayTest(ReelMode.Steps), StringComparison.Ordinal);
        host.Clock.Advance(Moments.UnboxMs + Moments.UnboxRestMs);

        host.World.Connect(Ben, "Ben", PlayerTeam.Terrorist, bot: true);
        Assert.StartsWith("unbox test: playing the stepped reel for Ben to 0 watching", host.Runtime.Moments.PlayTest(ReelMode.Steps), StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ the layout agrees

    private static string Strip(string text, string comments) => Regex.Replace(text, comments, "");

    [Fact]
    public void EveryPanelClassAndInstantTheUnboxingNamesIsInTheLayout()
    {
        var xml = Strip(File.ReadAllText(Repo.Path("hud", "layout", "ezpug_moment.xml")), @"<!--[\s\S]*?-->");
        var css = Strip(File.ReadAllText(Repo.Path("hud", "styles", "ezpug_unbox.css")), @"/\*[\s\S]*?\*/");

        Assert.Matches(new Regex($"<Panel id=\"{Moments.Unbox}\" class=\"ezpug-unbox\""), xml);
        foreach (var label in new[] { Moments.UnboxName, Moments.UnboxCall, Moments.UnboxLine })
        {
            Assert.Matches(new Regex($"<Label id=\"{label}\"[^>]* text=\"\\{{s:{Moments.Text}\\}}\""), xml);
        }

        // Exactly the slots the service fills.
        Assert.Equal(Moments.ReelSlots, Regex.Matches(xml, "<Panel id=\"unbox_slot_\\d+\" class=\"ezpug-unbox-slot\"").Count);
        for (var slot = 1; slot <= Moments.ReelSlots; slot++)
        {
            Assert.Contains($"<Panel id=\"{Moments.ReelSlot(slot)}\" class=\"ezpug-unbox-slot\"", xml, StringComparison.Ordinal);
        }

        Assert.Contains($".ezpug-unbox.{Moments.Shown}\n", css, StringComparison.Ordinal);
        Assert.Contains($".ezpug-unbox.{Moments.Revealed} .ezpug-unbox-prize\n", css, StringComparison.Ordinal);
        Assert.Contains($".ezpug-unbox.{Moments.SideCt} ", css, StringComparison.Ordinal);
        Assert.Contains($".ezpug-unbox.{Moments.SideT} ", css, StringComparison.Ordinal);
        foreach (var tier in Enum.GetValues<MomentTier>())
        {
            Assert.Contains($".ezpug-unbox-slot.{Moments.TierClassOf(tier)}\n", css, StringComparison.Ordinal);
            Assert.Contains($".ezpug-unbox.{Moments.Revealed}.{Moments.TierClassOf(tier)} .ezpug-unbox-burst\n", css, StringComparison.Ordinal);
        }

        // The strip stands with the resting slot under the marker (140 a slot, the marker
        // at 430, the stylesheet's header), and step k puts slot rest + k there, the last
        // one the prize's; a step's own slide is the strip's rule, as long as StepMs.
        var strip = Regex.Match(css, @"\.ezpug-unbox-strip\s*\{([^}]*)\}").Groups[1].Value;
        var resting = long.Parse(Regex.Match(strip, @"translate3d\( (-?\d+)px").Groups[1].Value, CultureInfo.InvariantCulture);
        Assert.Equal(430, resting + Moments.ReelPitchPx * (Moments.ReelRestSlot - 1) + Moments.ReelPitchPx / 2);
        Assert.Contains("transition-property: transform;", strip, StringComparison.Ordinal);
        var seconds = double.Parse(Regex.Match(strip, @"transition-duration: ([0-9.]+)s;").Groups[1].Value, CultureInfo.InvariantCulture);
        Assert.Equal(Moments.StepMs, (long)Math.Round(seconds * 1_000));
        Assert.Contains("transition-delay: 0s;", strip, StringComparison.Ordinal);
        for (var step = 1; step <= Moments.ReelSteps; step++)
        {
            var rule = Regex.Match(css, $@"\.ezpug-unbox\.{Moments.StepClass(step)} \.ezpug-unbox-strip\s*\{{([^}}]*)\}}").Groups[1].Value;
            var at = long.Parse(Regex.Match(rule, @"translate3d\( (-?\d+)px").Groups[1].Value, CultureInfo.InvariantCulture);
            Assert.Equal(430, at + Moments.ReelPitchPx * (Moments.ReelRestSlot + step - 1) + Moments.ReelPitchPx / 2);
            Assert.DoesNotContain("transition", rule, StringComparison.Ordinal);
        }

        Assert.Equal(Moments.ReelSteps, Regex.Matches(css, @"\.ezpug-unbox\.at-\d+ ").Count);
        var last = Regex.Match(css, $@"\.ezpug-unbox\.{Moments.StepClass(Moments.ReelSteps)} \.ezpug-unbox-strip\s*\{{([^}}]*)\}}").Groups[1].Value;
        Assert.Equal(430, long.Parse(Regex.Match(last, @"translate3d\( (-?\d+)px").Groups[1].Value, CultureInfo.InvariantCulture) + 140 * (Moments.ReelStopSlot - 1) + 70);

        // The landings: a few pixels on the second panel, and the panel's own settle.
        for (var landing = 1; landing <= Moments.ReelLandings; landing++)
        {
            var rule = Regex.Match(css, $@"\.ezpug-unbox\.{Moments.Landing(landing)} \.ezpug-unbox-land\s*\{{([^}}]*)\}}").Groups[1].Value;
            Assert.Contains($"translate3d( {Moments.LandingPx[landing - 1]}px, 0px, 0px )", rule, StringComparison.Ordinal);
            Assert.DoesNotContain("transition", rule, StringComparison.Ordinal);
        }

        Assert.Equal(Moments.ReelLandings, Regex.Matches(css, @"\.ezpug-unbox\.land-\d+ ").Count);

        // The old slide, the diagnostic's: started by `slide`, as long as the reel.
        var slide = Regex.Match(css, $@"\.ezpug-unbox\.{Moments.Slide} \.ezpug-unbox-strip\s*\{{([^}}]*)\}}").Groups[1].Value;
        Assert.Equal(Moments.ReelMs, (long)Math.Round(double.Parse(Regex.Match(slide, @"transition-duration: ([0-9.]+)s;").Groups[1].Value, CultureInfo.InvariantCulture) * 1_000));

        // Put away at once is the stylesheet's: the panel fades in an eighth of a second,
        // and the step class comes off only after that, so the strip goes home unseen.
        var panel = Regex.Match(css, @"\.ezpug-unbox\s*\{([^}]*)\}").Groups[1].Value;
        var fade = double.Parse(Regex.Match(panel, @"transition-duration: ([0-9.]+)s;").Groups[1].Value, CultureInfo.InvariantCulture) * 1_000;
        Assert.True(fade <= 150);
        Assert.True(Moments.StripBackMs > fade);
    }

    /// <summary>
    /// The stamp (PRD-09 T8): what the layouts carry is what the manifest says and what
    /// this build embeds, so a client's card and <c>ezpug_status</c> speak of the same
    /// revision. Seven hex characters, never the placeholder.
    /// </summary>
    [Fact]
    public void TheStampThisBuildEmbedsIsTheOneTheLayoutsCarry()
    {
        Assert.Matches("^[0-9a-f]{7}$", HudStamp.Expected);
        Assert.NotEqual("0000000", HudStamp.Expected);
        using var manifest = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Repo.Path("hud", "dist", "manifest.json")));
        Assert.Equal(HudStamp.Expected, manifest.RootElement.GetProperty("stamp").GetString());
        foreach (var layout in new[] { "ezpug_moment.xml", "ezpug_welcome.xml" })
        {
            var xml = File.ReadAllText(Repo.Path("hud", "layout", layout));
            var stamp = Regex.Match(xml, "<Label class=\"ezpug-[a-z-]+-stamp\" hittest=\"false\" text=\"([0-9a-f]{7})\" />");
            Assert.True(stamp.Success, $"{layout} carries no stamp label");
            Assert.Equal(HudStamp.Expected, stamp.Groups[1].Value);
        }
    }

    [Fact]
    public void TheCallIsInBothLanguages()
    {
        using var host = Assigned();
        Assert.Equal(CallGerman, host.Runtime.Localizer.For(Locale.De)[Moments.CallKey]);
        Assert.Equal(CallEnglish, host.Runtime.Localizer.For(Locale.En)[Moments.CallKey]);
    }
}
