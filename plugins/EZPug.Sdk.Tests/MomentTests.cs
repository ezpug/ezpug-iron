using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>The moment</b> (PRD-07 T4 and T6): the platform says what happened to whom, and the
/// server decides how and when to show it. The line in chat always, behind the match's
/// prefix, so a server that draws nothing and a player without the addon lose nothing.
/// With the HUD on, a toast for everybody and a card for the person, and the card only
/// in a stretch of nobody playing: that rule is the table below, on the fake clock.
/// </summary>
public class MomentTests
{
    private const string Addon = "3811574606";
    private const ulong Ada = 76561198000000001;
    private const ulong Ben = 76561198000000002;
    private const ulong Cleo = 76561198000000003;

    private const string AdaWins = "Ada zieht: BIG Trikot!";
    private const string YouWin = "Du ziehst: BIG Trikot!";
    private const string AdaWinsEnglish = "Ada wins: BIG jersey!";

    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static MomentCommand Drop(
        string correlationId,
        long inMs = 0,
        ulong? about = null,
        MomentTier tier = MomentTier.Rare,
        string kind = "drop",
        string? art = "big-jersey",
        string? line = null) => new()
        {
            CorrelationId = correlationId,
            Kind = kind,
            SteamId64 = about?.ToString(),
            Tier = tier,
            Art = art,
            Text = new MomentCommandText
            {
                De = new MomentWords { Everyone = line ?? AdaWins, You = line is null ? YouWin : null },
                En = new MomentWords { Everyone = line ?? AdaWinsEnglish, You = line is null ? "You win: BIG jersey!" : null },
            },
            InMs = inMs,
        };

    private static GameRules Rules(bool warmup = false, bool paused = false, GamePhase phase = GamePhase.PlayingFirstHalf) =>
        new(warmup, RoundsPlayed: 3, paused, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: false, phase);

    /// <summary>A pug for Ada (German, team A) and Ben (English, team B), both arrived after the assignment. No round has started.</summary>
    private static GamemodeTestHost Assigned(bool hud = true, string? addon = Addon, MatchBranding? branding = null)
    {
        var host = new GamemodeTestHost(hudAddon: addon);
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            teamA: [GamemodeTestHost.Player(Ada, "Ada")],
            teamB: [GamemodeTestHost.Player(Ben, "Ben", Locale.En)],
            branding: branding,
            hud: hud));
        host.World.Connect(Ada, "Ada");
        host.World.Connect(Ben, "Ben");
        return host;
    }

    private static IGamePlayer Player(GamemodeTestHost host, ulong steamId64) => host.World.Find(steamId64)!;

    private static void Warmup(GamemodeTestHost host)
    {
        host.World.Rules = Rules(warmup: true, phase: GamePhase.WarmupRound);
        host.World.StartRound();
    }

    /// <summary>A live round starts: its freeze time begins.</summary>
    private static void Freeze(GamemodeTestHost host, string seconds = "15", string restart = "7")
    {
        host.World.SetCvar("mp_freezetime", seconds);
        host.World.SetCvar("mp_round_restart_delay", restart);
        host.World.Rules = Rules();
        host.World.StartRound();
    }

    /// <summary>A round is being played.</summary>
    private static void Live(GamemodeTestHost host, string seconds = "15", string restart = "7")
    {
        Freeze(host, seconds, restart);
        host.World.EndFreeze();
    }

    private static void Decide(GamemodeTestHost host) =>
        host.World.EndRound(PlayerTeam.Terrorist, RoundEndReason.Elimination, 1, 0);

    private static FakeHudLayout Layout(GamemodeTestHost host) => host.World.HudLayout(Moments.Layout);

    private static bool CardUp(GamemodeTestHost host, ulong steamId64) =>
        host.World.HudLayouts.Count > 0 && Layout(host).Has(Player(host, steamId64).Slot, Moments.Card, Moments.Shown);

    private static bool Turned(GamemodeTestHost host, ulong steamId64) =>
        Layout(host).Has(Player(host, steamId64).Slot, Moments.Card, Moments.Turned);

    /// <summary>What the toast in <paramref name="row"/> says on this player's screen, or <c>null</c> when it is not up.</summary>
    private static string? ToastOn(GamemodeTestHost host, ulong steamId64, int row = 1)
    {
        var slot = Player(host, steamId64).Slot;
        return host.World.HudLayouts.Count > 0 && Layout(host).Has(slot, Moments.Toast(row), Moments.Shown)
            ? Layout(host).Variable(slot, Moments.ToastText(row), Moments.Text)
            : null;
    }

    private static int Read(GamemodeTestHost host, ulong steamId64, string line) =>
        host.World.Said.GetValueOrDefault(steamId64, []).Count(said => said == host.Runtime.Brand.Line(line));

    // ------------------------------------------------------------------ the line, always

    [Theory]
    [InlineData(null, true)]
    [InlineData(Addon, false)]
    public void WithTheHudOffAMomentIsItsLineBehindThePrefix_AndNothingElse(string? addon, bool asked)
    {
        using var host = Assigned(hud: asked, addon: addon);
        Warmup(host);

        var answer = host.Link.Command(Drop("m1", about: Ada))!;
        host.World.Elapse(Moments.CardMs + Moments.ToastMs);

        Assert.Equal(LinkCommandStatus.Applied, answer.Status);
        // Each in their language, the person in their own words, in the server's one voice.
        Assert.Equal($"[{ChatColor.Green}EZPug{ChatColor.Default}] {YouWin}", host.World.Said[Ada][^1]);
        Assert.Equal(host.Runtime.Brand.Line(AdaWinsEnglish), host.World.Said[Ben][^1]);
        // And not one call to the HUD or the speakers: this match draws nothing.
        Assert.Empty(host.World.HudActions);
        Assert.Empty(host.World.Sounds);
        Assert.Equal(0, host.Runtime.Moments.CardsWaiting);
    }

    [Fact]
    public void TheLineCarriesTheEventsPrefix()
    {
        using var host = Assigned(hud: false, branding: new MatchBranding { EventName = "SaarLAN 2026" });

        host.Link.Command(Drop("m1"));

        Assert.Equal($"[{ChatColor.Green}SaarLAN 2026{ChatColor.Default}] {AdaWins}", host.World.Said[Ada][^1]);
    }

    [Fact]
    public void AMomentAboutNobodyOnTheServerIsStillRead()
    {
        using var host = Assigned(hud: false);

        host.Link.Command(Drop("m1", about: 76561198000000099));
        Assert.Equal(1, Read(host, Ada, AdaWins));
        Assert.Equal(1, Read(host, Ben, AdaWinsEnglish));

        // No person at all: the same line for everybody.
        host.Link.Command(Drop("m2"));
        Assert.Equal(2, Read(host, Ada, AdaWins));
    }

    [Fact]
    public void TheLineBehindThePrefixIsStillOneChatLine()
    {
        using var host = Assigned(hud: false, branding: new MatchBranding { EventName = "SaarLAN 2026" });

        host.Link.Command(Drop("m1", line: new string('a', 200)));

        var said = host.World.Said[Ada][^1];
        Assert.StartsWith(host.Runtime.Brand.Prefix + " aaa", said, StringComparison.Ordinal);
        Assert.Equal(SaidLine.MaxLength, said.EnumerateRunes().Count());
    }

    [Theory]
    [InlineData("abc", 5, "abc")]
    [InlineData("abcdef", 3, "abc")]
    [InlineData("ab cdef", 3, "ab")]
    // Counted in code points: an emoji is one, and never cut in half.
    [InlineData("a😀b", 2, "a😀")]
    public void ASaidLineIsCutToWhatIsLeftOfTheBudget(string said, int codePoints, string expected) =>
        Assert.Equal(expected, SaidLine.Fit(said, codePoints));

    [Fact]
    public void ALineThatCannotBeSaidIsRefusedRatherThanPrintedBlank()
    {
        using var host = Assigned(hud: false);
        var unsayable = Drop("m1") with
        {
            Text = new MomentCommandText
            {
                De = new MomentWords { Everyone = ";;\"" },
                En = new MomentWords { Everyone = "fine" },
            },
        };

        var answer = host.Link.Command(unsayable)!;

        Assert.Equal((LinkCommandStatus.Rejected, MatchApiErrorCode.ValidationFailed), (answer.Status, answer.Code));
    }

    // ------------------------------------------------------------------ the timing rule

    /// <summary>
    /// One row of the rule: where the match stands when a moment about Ada arrives, how
    /// far off it is due and what happens until then, whether her card plays at that
    /// instant, and, where it does not, what brings the next stretch it plays in.
    /// </summary>
    public sealed record Situation(
        string Name,
        Action<GamemodeTestHost> Arrange,
        bool Now,
        Action<GamemodeTestHost>? NextStretch = null,
        long InMs = 0,
        Action<GamemodeTestHost>? Until = null)
    {
        public override string ToString() => Name;
    }

    public static TheoryData<Situation> Situations() =>
        new()
        {
            new("warmup", Warmup, Now: true),
            new("a freeze with all of it left", host => Freeze(host), Now: true),
            new("a freeze with exactly the card's length left", host =>
            {
                Freeze(host);
                host.Clock.Advance(15_000 - Moments.CardMs);
            }, Now: true),
            new("the freeze is nearly over", host =>
            {
                Freeze(host);
                host.Clock.Advance(15_000 - Moments.CardMs + 1);
            }, Now: false, NextStretch: host =>
            {
                host.World.EndFreeze();
                Decide(host);
            }),
            new("a mode whose freeze is too short", host => Freeze(host, seconds: "5"), Now: false, NextStretch: host =>
            {
                host.World.EndFreeze();
                // Seven seconds of restart delay and five of the next freeze.
                Decide(host);
            }),
            new("a round is being played", host => Live(host), Now: false, NextStretch: Decide),
            new("the round is decided", host =>
            {
                Live(host);
                Decide(host);
            }, Now: true),
            new("the round is decided in a mode with no freeze and a short restart", host =>
            {
                Live(host, seconds: "0", restart: "3");
                Decide(host);
            }, Now: false, NextStretch: host =>
            {
                // The next round is played from its start; the map's end is the first stretch.
                host.World.StartRound();
                Assert.False(CardUp(host, Ada));
                host.World.EndMap();
            }),
            new("a pause, standing in the freeze", host =>
            {
                Freeze(host);
                host.World.Rules = Rules(paused: true);
                host.Clock.Advance(60_000);
            }, Now: true),
            new("halftime", host =>
            {
                Live(host);
                Decide(host);
                host.World.Rules = Rules(phase: GamePhase.Halftime);
            }, Now: true),
            new("the match is over", host =>
            {
                Live(host);
                Decide(host);
                host.World.EndMap();
            }, Now: true),
            new("no round has started on this map, so no layout is in the world", _ => { }, Now: false, NextStretch: Warmup),
            new("it arrives in a freeze and is due after the freeze ended", host =>
            {
                Freeze(host);
                host.Clock.Advance(12_000);
            }, Now: false, NextStretch: Decide, InMs: 5_000, Until: host =>
            {
                host.Clock.Advance(3_000);
                host.World.EndFreeze();
                host.Clock.Advance(2_000);
            }),
            new("it arrives while a round is played and is due once it is decided", host => Live(host), Now: true, InMs: 4_000, Until: host =>
            {
                host.Clock.Advance(1_000);
                Decide(host);
                host.Clock.Advance(3_000);
            }),
        };

    [Theory]
    [MemberData(nameof(Situations))]
    public void TheCardPlaysInAStretchOfNobodyPlaying_AndTheLineAndTheToastNeverWait(Situation situation)
    {
        using var host = Assigned();
        situation.Arrange(host);

        Assert.Equal(LinkCommandStatus.Applied, host.Link.Command(Drop("m1", inMs: situation.InMs, about: Ada))!.Status);
        if (situation.Until is { } until)
        {
            // Not before it is due: no line, no toast, no card.
            Assert.Equal(0, Read(host, Ada, YouWin));
            Assert.Null(ToastOn(host, Ben));
            Assert.False(CardUp(host, Ada));
            until(host);
        }

        // Due: the line for everybody, whatever the round is doing.
        Assert.Equal(1, Read(host, Ada, YouWin));
        Assert.Equal(1, Read(host, Ben, AdaWinsEnglish));
        Assert.Equal(situation.Now, CardUp(host, Ada));
        Assert.Equal(situation.Now ? 0 : 1, host.Runtime.Moments.CardsWaiting);
        if (host.World.HudLayouts.Count > 0)
        {
            // The toast for everybody else; for Ada too while her card has to wait.
            Assert.Equal(AdaWinsEnglish, ToastOn(host, Ben));
            Assert.Equal(situation.Now ? null : YouWin, ToastOn(host, Ada));
        }

        if (situation.NextStretch is { } next)
        {
            next(host);
            Assert.True(CardUp(host, Ada));
            Assert.Equal(0, host.Runtime.Moments.CardsWaiting);
        }

        // Said once, however long the card took.
        Assert.Equal(1, Read(host, Ada, YouWin));
    }

    [Fact]
    public void AToastSetBeforeTheLayoutsExistIsOnTheScreenWhenTheyAreMade()
    {
        using var host = Assigned();

        host.Link.Command(Drop("m1", about: Ada));
        Assert.Empty(host.World.HudActions);
        host.Clock.Advance(1_000);
        Warmup(host);

        Assert.Equal(AdaWinsEnglish, ToastOn(host, Ben));
        Assert.True(CardUp(host, Ada));
    }

    // ------------------------------------------------------------------ the card

    [Fact]
    public void TheCardSlidesInTurnsOverWithTheSoundAndGoes()
    {
        using var host = Assigned();
        Warmup(host);

        host.Link.Command(Drop("m1", about: Ada));

        var layout = Layout(host);
        var slot = Player(host, Ada).Slot;
        Assert.True(CardUp(host, Ada));
        Assert.False(Turned(host, Ada));
        Assert.Equal("Drop", layout.Variable(slot, Moments.CardKind, Moments.Text));
        Assert.Equal(YouWin, layout.Variable(slot, Moments.CardText, Moments.Text));
        Assert.True(layout.Has(slot, Moments.Card, "tier-rare"));
        Assert.False(layout.Has(slot, Moments.Card, "tier-common"));
        Assert.False(layout.Has(slot, Moments.Card, "tier-uncommon"));
        Assert.False(layout.Has(slot, Moments.Card, "tier-legendary"));
        Assert.True(layout.Has(slot, Moments.Card, "art-big-jersey"));
        Assert.Empty(host.World.Sounds);
        // Only hers: nobody else has a card.
        Assert.False(CardUp(host, Ben));

        host.Clock.Advance(Moments.TurnMs - 1);
        Assert.False(Turned(host, Ada));
        host.Clock.Advance(1);
        Assert.True(Turned(host, Ada));
        Assert.Equal((Moments.Sound, Moments.VolumeOf(MomentTier.Rare)), Assert.Single(host.World.Sounds[Ada]));
        Assert.False(host.World.Sounds.ContainsKey(Ben));

        host.Clock.Advance(Moments.CardMs - Moments.TurnMs - 1);
        Assert.True(CardUp(host, Ada));
        host.Clock.Advance(1);
        Assert.False(CardUp(host, Ada));
        Assert.False(Turned(host, Ada));
        Assert.Single(host.World.Sounds[Ada]);
    }

    [Fact]
    public void TheSoundIsTheGamesOwn_AndLouderWithTheTier()
    {
        Assert.Equal("EndMatch.ItemRevealSingleLocalPlayer", Moments.Sound);
        var volumes = Enum.GetValues<MomentTier>().Select(Moments.VolumeOf).ToList();
        Assert.Equal(volumes.Order(), volumes);
        Assert.Equal(volumes.Count, volumes.Distinct().Count());
        Assert.All(volumes, volume => Assert.InRange(volume, 0.1f, 1f));
    }

    [Fact]
    public void ACardOnScreenWhenTheFreezeEndsIsPutAwayAtOnce()
    {
        using var host = Assigned();
        Freeze(host);
        host.Link.Command(Drop("m1", about: Ada));
        host.Clock.Advance(Moments.TurnMs + 500);
        Assert.True(Turned(host, Ada));

        host.World.EndFreeze();

        Assert.False(CardUp(host, Ada));
        Assert.False(Turned(host, Ada));
        // It was read: it does not come back, at the end of its own time or of the round.
        host.Clock.Advance(Moments.CardMs);
        Decide(host);
        Assert.False(CardUp(host, Ada));
        Assert.Single(host.World.Sounds[Ada]);
    }

    [Fact]
    public void ACardPutAwayBeforeItTurnedOverWaitsForTheNextStretch()
    {
        using var host = Assigned();
        Freeze(host);
        host.Link.Command(Drop("m1", about: Ada));
        host.Clock.Advance(Moments.TurnMs - 1);

        // Somebody unpaused, or the cvar was wrong: the freeze is over early.
        host.World.EndFreeze();
        Assert.False(CardUp(host, Ada));
        Assert.Equal(1, host.Runtime.Moments.CardsWaiting);
        host.Clock.Advance(Moments.CardMs);
        Assert.Empty(host.World.Sounds);

        Decide(host);
        Assert.True(CardUp(host, Ada));
        host.Clock.Advance(Moments.TurnMs);
        Assert.Single(host.World.Sounds[Ada]);
    }

    [Fact]
    public void ARoundThatStartsWithoutAFreezePutsTheCardAway()
    {
        using var host = Assigned();
        Live(host, seconds: "0", restart: "7");
        Decide(host);
        host.Link.Command(Drop("m1", about: Ada));
        // Seven seconds of restart delay fit the card; the cvar changes under it.
        Assert.True(CardUp(host, Ada));
        host.Clock.Advance(Moments.TurnMs);

        host.World.StartRound();

        Assert.False(CardUp(host, Ada));
    }

    [Theory]
    [InlineData(0, true)]
    [InlineData(1, false)]
    public void ACardThatWaitedPastTheCapIsDropped(long past, bool plays)
    {
        using var host = Assigned();
        Live(host);
        host.Link.Command(Drop("m1", about: Ada));
        host.Clock.Advance(Moments.CardWaitMs + past);

        Decide(host);

        Assert.Equal(plays, CardUp(host, Ada));
        Assert.Equal(0, host.Runtime.Moments.CardsWaiting);
    }

    [Fact]
    public void AMapChangeDropsTheCardsThatWereWaiting_AndPutsAwayTheOneOnScreen()
    {
        using var host = Assigned();
        Live(host);
        host.Link.Command(Drop("m1", about: Ada));
        Decide(host);
        host.Link.Command(Drop("m2", about: Ada, line: "second"));
        host.Link.Command(Drop("m3", about: Ben));
        Assert.True(CardUp(host, Ada));
        Assert.Equal(1, host.Runtime.Moments.CardsWaiting);

        host.World.StartMap("de_inferno");
        Assert.Equal(0, host.Runtime.Moments.CardsWaiting);
        Warmup(host);
        host.Clock.Advance(Moments.CardMs + Moments.CardRestMs);

        Assert.False(CardUp(host, Ada));
        Assert.False(CardUp(host, Ben));
        Assert.Empty(host.World.Sounds);
    }

    [Fact]
    public void TwoMomentsForOnePersonQueue()
    {
        using var host = Assigned();
        Warmup(host);
        host.Link.Command(Drop("m1", about: Ada));
        host.Link.Command(Drop("m2", about: Ada, tier: MomentTier.Common, kind: "perk", art: "category-skin", line: "Doppelte XP"));

        var layout = Layout(host);
        var slot = Player(host, Ada).Slot;
        Assert.Equal(YouWin, layout.Variable(slot, Moments.CardText, Moments.Text));
        Assert.Equal(1, host.Runtime.Moments.CardsWaiting);
        // The second one's card has to wait, so its toast is hers too; the first one's was not.
        Assert.Equal("Doppelte XP", ToastOn(host, Ada, row: 2));
        Assert.Null(ToastOn(host, Ada, row: 1));

        // The first card runs its time, the screen is empty for a beat, then the second comes in.
        host.Clock.Advance(Moments.CardMs);
        Assert.False(CardUp(host, Ada));
        Assert.Equal(YouWin, layout.Variable(slot, Moments.CardText, Moments.Text));
        host.Clock.Advance(Moments.CardRestMs - 1);
        Assert.False(CardUp(host, Ada));
        host.Clock.Advance(1);
        Assert.True(CardUp(host, Ada));
        Assert.False(Turned(host, Ada));
        Assert.Equal("Perk", layout.Variable(slot, Moments.CardKind, Moments.Text));
        Assert.Equal("Doppelte XP", layout.Variable(slot, Moments.CardText, Moments.Text));
        Assert.True(layout.Has(slot, Moments.Card, "tier-common"));
        Assert.False(layout.Has(slot, Moments.Card, "tier-rare"));
        Assert.True(layout.Has(slot, Moments.Card, "art-category-skin"));
        Assert.False(layout.Has(slot, Moments.Card, "art-big-jersey"));

        host.Clock.Advance(Moments.CardMs);
        Assert.False(CardUp(host, Ada));
        Assert.Equal(2, host.World.Sounds[Ada].Count);
        Assert.Equal(Moments.VolumeOf(MomentTier.Common), host.World.Sounds[Ada][1].Volume);
    }

    [Fact]
    public void TheSecondCardWaitsForAStretchOfItsOwnWhenTheFirstUsedThisOneUp()
    {
        using var host = Assigned();
        Freeze(host);
        host.Link.Command(Drop("m1", about: Ada));
        host.Link.Command(Drop("m2", about: Ada, line: "second"));

        // Fifteen seconds of freeze: the first card and the rest leave eight and a half, enough.
        host.Clock.Advance(Moments.CardMs + Moments.CardRestMs);
        Assert.True(CardUp(host, Ada));
        host.Clock.Advance(Moments.CardMs + Moments.CardRestMs);

        // A third would have two seconds: it waits for the round to be decided.
        host.Link.Command(Drop("m3", about: Ada, line: "third"));
        Assert.False(CardUp(host, Ada));
        Assert.Equal(1, host.Runtime.Moments.CardsWaiting);
        host.World.EndFreeze();
        Decide(host);
        Assert.True(CardUp(host, Ada));
    }

    [Fact]
    public void NoMoreThanAFewCardsWaitForOnePerson()
    {
        using var host = Assigned();
        Live(host);
        for (var n = 0; n < Moments.CardsWaitingMax + 3; n++)
        {
            host.Link.Command(Drop($"m{n}", about: Ada, line: $"line {n}"));
        }

        Assert.Equal(Moments.CardsWaitingMax, host.Runtime.Moments.CardsWaiting);
        // Every one of them was still said.
        Assert.Equal(1, Read(host, Ada, $"line {Moments.CardsWaitingMax + 2}"));
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("empty", null)]
    [InlineData("big-jersey", "art-big-jersey")]
    // A key the addon does not hold is a class no rule draws: the default picture, never a refusal.
    [InlineData("golden-chicken", "art-golden-chicken")]
    // Outside the contract's grammar: no class at all.
    [InlineData("Big Jersey", null)]
    [InlineData("x\" .y", null)]
    public void ThePictureIsAClassForAKeyAndNothingForTheDefault(string? key, string? expected) =>
        Assert.Equal(expected, Moments.ArtClassOf(key));

    [Fact]
    public void AMatchThatNamesTooManyPicturesGetsTheDefaultForTheRest()
    {
        using var host = Assigned();
        Warmup(host);
        for (var n = 0; n <= Moments.ArtClassesMax; n++)
        {
            host.Link.Command(Drop($"m{n}", about: Ada, art: $"key-{n}"));
            host.Clock.Advance(Moments.CardMs + Moments.CardRestMs);
        }

        var classes = Layout(host).SlotClasses[Player(host, Ada).Slot].Keys
            .Where(key => key.Class.StartsWith(Moments.ArtClassPrefix, StringComparison.Ordinal))
            .ToList();
        Assert.Equal(Moments.ArtClassesMax, classes.Count);
        Assert.DoesNotContain(classes, key => key.Class == $"art-key-{Moments.ArtClassesMax}");
    }

    [Fact]
    public void AKindThisServerHasNoWordForIsHeadedByTheEvent_AndTheRaffleByItsOwn()
    {
        using var host = Assigned(branding: new MatchBranding { EventName = "SaarLAN 2026" });
        Warmup(host);
        var layout = Layout(host);

        host.Link.Command(Drop("m1", about: Ada, kind: "tournament-win"));
        Assert.Equal("SaarLAN 2026", layout.Variable(Player(host, Ada).Slot, Moments.CardKind, Moments.Text));

        host.Link.Command(Drop("m2", about: Ben, kind: "raffle"));
        Assert.Equal("Raffle", layout.Variable(Player(host, Ben).Slot, Moments.CardKind, Moments.Text));
        host.Clock.Advance(Moments.CardMs + Moments.CardRestMs);
        host.Link.Command(Drop("m3", about: Ada, kind: "raffle"));
        Assert.Equal("Verlosung", layout.Variable(Player(host, Ada).Slot, Moments.CardKind, Moments.Text));
    }

    // ------------------------------------------------------------------ the toasts

    [Fact]
    public void ToastsStackToThree_AndTheNextWaitsForARow()
    {
        using var host = Assigned();
        Warmup(host);
        host.Link.Command(Drop("m1", tier: MomentTier.Legendary, line: "one"));
        host.Clock.Advance(1_000);
        host.Link.Command(Drop("m2", tier: MomentTier.Common, line: "two"));
        host.Link.Command(Drop("m3", line: "three"));
        host.Link.Command(Drop("m4", tier: MomentTier.Uncommon, line: "four"));

        Assert.Equal("one", ToastOn(host, Ben, row: 1));
        Assert.Equal("two", ToastOn(host, Ben, row: 2));
        Assert.Equal("three", ToastOn(host, Ada, row: 3));
        // The tint is the row's, for everybody.
        Assert.True(Layout(host).Classes[(Moments.Toast(1), "tier-legendary")]);
        Assert.True(Layout(host).Classes[(Moments.Toast(2), "tier-common")]);
        Assert.False(Layout(host).Classes[(Moments.Toast(2), "tier-legendary")]);
        // The fourth was said, and is drawn when the first row comes free and has rested.
        Assert.Equal(1, Read(host, Ben, "four"));

        host.Clock.Advance(Moments.ToastMs - 1_000);
        Assert.Null(ToastOn(host, Ben, row: 1));
        Assert.Equal("two", ToastOn(host, Ben, row: 2));
        host.Clock.Advance(Moments.ToastRestMs - 1);
        Assert.Null(ToastOn(host, Ben, row: 1));
        host.Clock.Advance(1);
        Assert.Equal("four", ToastOn(host, Ben, row: 1));
        Assert.True(Layout(host).Classes[(Moments.Toast(1), "tier-uncommon")]);
        Assert.False(Layout(host).Classes[(Moments.Toast(1), "tier-legendary")]);

        host.Clock.Advance(Moments.ToastMs);
        Assert.Null(ToastOn(host, Ben, row: 1));
        Assert.Null(ToastOn(host, Ben, row: 2));
        Assert.Null(ToastOn(host, Ben, row: 3));
    }

    [Fact]
    public void ABurstLongerThanTheWaitingLineIsSaidAndNotAllDrawn()
    {
        using var host = Assigned();
        Warmup(host);
        var burst = Moments.ToastRows + Moments.ToastsWaitingMax + 1;
        for (var n = 1; n <= burst; n++)
        {
            host.Link.Command(Drop($"m{n}", line: $"line {n}"));
        }

        var drawn = new HashSet<string>();
        for (var beat = 0; beat < 200; beat++)
        {
            for (var row = 1; row <= Moments.ToastRows; row++)
            {
                if (ToastOn(host, Ben, row) is { } line)
                {
                    drawn.Add(line);
                }
            }

            host.Clock.Advance(250);
        }

        Assert.Equal(burst - 1, drawn.Count);
        Assert.DoesNotContain($"line {burst}", drawn);
        Assert.Equal(1, Read(host, Ben, $"line {burst}"));
    }

    [Fact]
    public void SomebodyWhoConnectsWhileAToastIsUpSeesNoEmptyToast()
    {
        using var host = Assigned();
        Warmup(host);
        host.Link.Command(Drop("m1"));

        var cleo = host.World.Connect(Cleo, "Cleo");
        host.Clock.Advance(Hud.ResendDelayMs);

        Assert.False(Layout(host).Has(cleo.Slot, Moments.Toast(1), Moments.Shown));
        Assert.Equal(AdaWins, ToastOn(host, Ada));
    }

    // ------------------------------------------------------------------ who gets what

    [Fact]
    public void SomebodyWhoLeftBeforeItWasDueGetsNothing_AndNothingWaitsForThem()
    {
        using var host = Assigned();
        Live(host);
        host.Link.Command(Drop("m1", inMs: 2_000, about: Ada));
        var slot = Player(host, Ada).Slot;
        host.World.Disconnect(Player(host, Ada));
        host.Clock.Advance(2_000);

        // Everybody else still reads it.
        Assert.Equal(1, Read(host, Ben, AdaWinsEnglish));
        Assert.Equal(0, host.Runtime.Moments.CardsWaiting);

        // Whoever takes the slot, and Ada herself if she comes back, gets no card.
        var cleo = host.World.Connect(Cleo, "Cleo");
        Assert.Equal(slot, cleo.Slot);
        Decide(host);
        Assert.False(CardUp(host, Cleo));
        Assert.Empty(host.World.Sounds);
    }

    [Fact]
    public void SomebodyWhoLeavesTakesTheirWaitingCardsAndTheOneOnScreenWithThem()
    {
        using var host = Assigned();
        Live(host);
        host.Link.Command(Drop("m1", about: Ada));
        host.Link.Command(Drop("m2", about: Ben));
        Assert.Equal(2, host.Runtime.Moments.CardsWaiting);

        host.World.Disconnect(Player(host, Ada));
        Assert.Equal(1, host.Runtime.Moments.CardsWaiting);
        host.World.Connect(Ada, "Ada");
        Decide(host);
        Assert.False(CardUp(host, Ada));
        Assert.True(CardUp(host, Ben));

        // Ben leaves with his card up: its turn never plays for whoever takes the slot.
        var slot = Player(host, Ben).Slot;
        host.World.Disconnect(Player(host, Ben));
        var cleo = host.World.Connect(Cleo, "Cleo");
        Assert.Equal(slot, cleo.Slot);
        host.Clock.Advance(Moments.CardMs);
        Assert.False(CardUp(host, Cleo));
        Assert.False(Turned(host, Cleo));
        Assert.Empty(host.World.Sounds);
    }

    [Fact]
    public void ABotAndAPuppetHaveNoScreenAndNoEars()
    {
        using var host = Assigned();
        Warmup(host);
        var bot = host.World.Connect(76561198000000099, "BOT Kai", bot: true);

        host.Link.Command(Drop("m1", about: bot.SteamId64));
        // The people in the room read about it like any other.
        Assert.Equal(AdaWinsEnglish, ToastOn(host, Ben));
        host.Clock.Advance(Moments.CardMs);

        Assert.Equal(0, host.Runtime.Moments.CardsWaiting);
        Assert.DoesNotContain(host.World.HudActions, action => action.SteamId64 == bot.SteamId64);
        Assert.False(host.World.Sounds.ContainsKey(bot.SteamId64));
    }

    [Fact]
    public void AReleaseTakesEveryMomentWithIt()
    {
        using var host = Assigned();
        Live(host);
        host.Link.Command(Drop("m1", about: Ada));
        host.Link.Command(Drop("m2", inMs: 4_000, line: "later"));
        Decide(host);
        Assert.True(CardUp(host, Ada));

        host.Link.Release("ended: completed");
        var actions = host.World.Actions.Count;
        host.World.Elapse(Moments.CardWaitMs);

        Assert.Equal(actions, host.World.Actions.Count);
        Assert.Equal(0, Read(host, Ada, "later"));
        Assert.Empty(host.World.HudLayouts);
        Assert.Empty(host.World.Sounds);
    }

    [Fact]
    public void TheLayoutIsOneOfTheHuds()
    {
        using var host = Assigned();
        Assert.Contains(Moments.Layout, host.Runtime.Hud.Layouts);
        Assert.Equal(3, Moments.ToastRows);
        Assert.Equal("moment_toast_1", Moments.Toast(1));
        Assert.Equal("moment_toast_1_text", Moments.ToastText(1));
    }
}
