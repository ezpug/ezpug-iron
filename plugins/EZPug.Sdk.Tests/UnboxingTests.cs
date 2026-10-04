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
        string.Join(' ', new[] { Moments.Shown, Moments.Rolling, Moments.Revealed }
            .Concat(Enumerable.Range(1, Moments.ReelLandings).Select(Moments.Landing))
            .Where(className => On(host, steamId64, className)));

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

        // The reel, with one landing.
        host.Clock.Advance(Moments.CallMs - 1);
        Assert.Equal(Moments.Shown, Beats(host, Ben));
        host.Clock.Advance(1);
        var rolling = Beats(host, Ben);
        Assert.Matches($"^{Moments.Shown} {Moments.Rolling} land-[1-{Moments.ReelLandings}]$", rolling);
        Assert.Equal(rolling, Beats(host, Ada));

        // The reveal, at the contract's instant: the landing settles, the sound, the line.
        host.Clock.Advance(Moments.ReelMs - 1);
        Assert.Equal(rolling, Beats(host, Ada));
        Assert.Equal(0, Read(host, Ben, AdaWinsEnglish));
        host.Clock.Advance(1);
        Assert.Equal(ProtocolConstants.MomentUnboxingRevealMs, Moments.RevealMs);
        Assert.Equal($"{Moments.Shown} {Moments.Rolling} {Moments.Revealed}", Beats(host, Ada));
        Assert.Equal($"{Moments.Shown} {Moments.Rolling} {Moments.Revealed}", Beats(host, Ben));
        Assert.Equal(YouWin, layout.Variable(Player(host, Ada).Slot, Moments.UnboxLine, Moments.Text));
        Assert.Equal(AdaWinsEnglish, layout.Variable(Player(host, Ben).Slot, Moments.UnboxLine, Moments.Text));
        Assert.Equal(1, Read(host, Ada, YouWin));
        Assert.Equal(1, Read(host, Ben, AdaWinsEnglish));
        Assert.Equal((Moments.Sound, Moments.VolumeOf(MomentTier.Rare)), Assert.Single(host.World.Sounds[Ada]));
        Assert.Single(host.World.Sounds[Ben]);
        Assert.True(layout.Classes[(Moments.Unbox, "tier-rare")]);
        Assert.True(layout.Classes[(Moments.Unbox, "art-big-jersey")]);

        // Gone, with the freeze still running: it never needed the freeze to end.
        host.Clock.Advance(Moments.PrizeMs - 1);
        Assert.Equal($"{Moments.Shown} {Moments.Rolling} {Moments.Revealed}", Beats(host, Ben));
        host.Clock.Advance(1);
        Assert.Equal("", Beats(host, Ada));
        Assert.Equal("", Beats(host, Ben));
        Assert.False(host.Runtime.Moments.Unboxing);
        Assert.True(host.Runtime.Hud.Quiet is { Reason: QuietReason.FreezeTime, LeftMs: >= Moments.UnboxSpareMs });

        // In place of the toast and the card, to the end: said once, drawn once.
        host.World.EndFreeze();
        Decide(host);
        Assert.Null(ToastOn(host, Ben));
        Assert.False(CardUp(host, Ada));
        Assert.Equal(0, host.Runtime.Moments.CardsWaiting);
        Assert.Equal(1, Read(host, Ada, YouWin));
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
        Assert.StartsWith($"{Moments.Shown} {Moments.Rolling}", Beats(host, Ben), StringComparison.Ordinal);

        // Somebody unpaused, or the cvar was wrong: the freeze is over early.
        host.World.EndFreeze();

        Assert.Equal("", Beats(host, Ada));
        Assert.Equal("", Beats(host, Ben));
        Assert.False(host.Runtime.Moments.Unboxing);
        // Nobody saw the prize: the line and the toast now, the card at the next stretch.
        Assert.Equal(1, Read(host, Ada, YouWin));
        Assert.Equal(AdaWinsEnglish, ToastOn(host, Ben));
        Assert.Equal(YouWin, ToastOn(host, Ada));
        Assert.Equal(1, host.Runtime.Moments.CardsWaiting);

        // No beat of it comes back, no sound of it plays, and the line is not said again.
        host.Clock.Advance(Moments.UnboxMs);
        Assert.Equal("", Beats(host, Ben));
        Assert.Empty(host.World.Sounds);
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

    // ------------------------------------------------------------------ who sees it

    [Fact]
    public void SomebodyWhoConnectsMidSequenceSeesNothingOfIt_AndReadsTheLine()
    {
        using var host = Assigned();
        Freeze(host);
        host.Link.Command(Drop("m1"));
        host.Clock.Advance(1_000);

        var cleo = host.World.Connect(Cleo, "Cleo");
        var beats = new[] { Moments.Shown, Moments.Rolling, Moments.Revealed }.Concat(Enumerable.Range(1, Moments.ReelLandings).Select(Moments.Landing)).ToList();
        for (var ms = 0L; ms < Moments.UnboxMs; ms += 500)
        {
            Assert.All(beats, className => Assert.False(Layout(host).Has(cleo.Slot, Moments.Unbox, className)));
            host.Clock.Advance(500);
        }

        Assert.Equal(1, Read(host, Cleo, AdaWins));
        Assert.False(host.World.Sounds.ContainsKey(Cleo));
        // Everybody who was there saw all of it.
        Assert.Single(host.World.Sounds[Ben]);
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
        Assert.Equal($"{Moments.Shown} {Moments.Rolling} {Moments.Revealed}", Beats(host, Ada));
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
        Assert.Single(host.World.Sounds[Ada]);
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
        Assert.Contains($".ezpug-unbox.{Moments.Rolling} .ezpug-unbox-strip\n", css, StringComparison.Ordinal);
        Assert.Contains($".ezpug-unbox.{Moments.Revealed} .ezpug-unbox-prize\n", css, StringComparison.Ordinal);
        Assert.Contains($".ezpug-unbox.{Moments.SideCt} ", css, StringComparison.Ordinal);
        Assert.Contains($".ezpug-unbox.{Moments.SideT} ", css, StringComparison.Ordinal);
        for (var landing = 1; landing <= Moments.ReelLandings; landing++)
        {
            Assert.Contains($".ezpug-unbox.{Moments.Rolling}.{Moments.Landing(landing)} .ezpug-unbox-land\n", css, StringComparison.Ordinal);
        }

        Assert.Equal(Moments.ReelLandings, Regex.Matches(css, @"\.land-\d+ ").Count);
        foreach (var tier in Enum.GetValues<MomentTier>())
        {
            Assert.Contains($".ezpug-unbox-slot.{Moments.TierClassOf(tier)}\n", css, StringComparison.Ordinal);
            Assert.Contains($".ezpug-unbox.{Moments.Revealed}.{Moments.TierClassOf(tier)} .ezpug-unbox-burst\n", css, StringComparison.Ordinal);
        }

        // The reel slides for as long as the server waits before it reveals, and stops on
        // the slot the prize is put in: 140 a slot, the marker at 430 (the stylesheet's header).
        var strip = Regex.Match(css, @"\.ezpug-unbox\.rolling \.ezpug-unbox-strip\s*\{([^}]*)\}").Groups[1].Value;
        var seconds = double.Parse(Regex.Match(strip, @"transition-duration: ([0-9.]+)s;").Groups[1].Value, CultureInfo.InvariantCulture);
        Assert.Equal(Moments.ReelMs, (long)Math.Round(seconds * 1_000));
        var rolled = long.Parse(Regex.Match(strip, @"translate3d\( (-?\d+)px").Groups[1].Value, CultureInfo.InvariantCulture);
        Assert.Equal(430, rolled + 140 * (Moments.ReelStopSlot - 1) + 70);

        // Put away at once is the stylesheet's: the panel fades in an eighth of a second,
        // and the strip is back at its start before the next unboxing may begin.
        var panel = Regex.Match(css, @"\.ezpug-unbox\s*\{([^}]*)\}").Groups[1].Value;
        Assert.Contains("transition-duration: 0.12s;", panel, StringComparison.Ordinal);
        var back = Regex.Match(css, @"\.ezpug-unbox-strip\s*\{([^}]*)\}").Groups[1].Value;
        var delay = double.Parse(Regex.Match(back, @"transition-delay: ([0-9.]+)s;").Groups[1].Value, CultureInfo.InvariantCulture);
        Assert.True(delay * 1_000 <= Moments.UnboxRestMs);
    }

    [Fact]
    public void TheCallIsInBothLanguages()
    {
        using var host = Assigned();
        Assert.Equal(CallGerman, host.Runtime.Localizer.For(Locale.De)[Moments.CallKey]);
        Assert.Equal(CallEnglish, host.Runtime.Localizer.For(Locale.En)[Moments.CallKey]);
    }
}
