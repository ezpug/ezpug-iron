using System.Text.RegularExpressions;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>The welcome</b> (PRD-07 T5): the connect card drawn by the HUD, read off a world that
/// keeps each slot's state the way the engine does. What it says, in whose language, when
/// it comes and goes, and the one rule that matters most: a player gets one card, the HUD's
/// or the centre panel's, and with the HUD off the centre card is what it always was.
/// </summary>
public class WelcomeTests
{
    private const string Addon = "3811574606";
    private const ulong Ada = 76561198000000001;
    private const ulong Ben = 76561198000000002;
    private const ulong Cleo = 76561198000000003;

    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static GameRules Rules(bool warmup) =>
        new(warmup, RoundsPlayed: warmup ? 0 : 1, Paused: false, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: false,
            warmup ? GamePhase.WarmupRound : GamePhase.PlayingFirstHalf);

    /// <summary>A pug for Ada (German, team A) and Ben (English, team B) at an event, on a server that can draw, the match asking for the HUD.</summary>
    private static GamemodeTestHost Assigned(
        string mode = "pug",
        bool hud = true,
        string? addon = Addon,
        MatchBranding? branding = null)
    {
        var host = new GamemodeTestHost(hudAddon: addon);
        host.World.SetCvar("mp_freezetime", "15");
        host.World.SetCvar("mp_round_restart_delay", "7");
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest(mode),
            teamA: [GamemodeTestHost.Player(Ada, "Ada")],
            teamB: mode == "pug" ? [GamemodeTestHost.Player(Ben, "Ben", Locale.En)] : null,
            branding: branding ?? new MatchBranding { EventName = "SaarLAN 2026" },
            hud: hud));
        return host;
    }

    /// <summary>The server is in warmup: a round has started, so the layouts are in the world.</summary>
    private static void InWarmup(GamemodeTestHost host)
    {
        host.World.Rules = Rules(warmup: true);
        host.World.StartRound();
    }

    private static FakeHudLayout Layout(GamemodeTestHost host) => host.World.HudLayout(Welcome.Layout);

    private static bool CardUp(GamemodeTestHost host, IGamePlayer player) => Layout(host).Has(player.Slot, Welcome.Card, Welcome.Shown);

    private static bool MarkUp(GamemodeTestHost host, IGamePlayer player) => Layout(host).Has(player.Slot, Welcome.Mark, Welcome.Shown);

    // ------------------------------------------------------------------ off

    [Theory]
    [InlineData(null, true)]
    [InlineData(Addon, false)]
    public void WithTheHudOffTheCentreCardIsWhatItAlwaysWas(string? addon, bool asked)
    {
        using var host = Assigned(hud: asked, addon: addon);
        InWarmup(host);
        host.World.Connect(Ada, "Ada");
        host.Clock.Advance(Branding.CardDelayMs);

        Assert.Equal(host.Runtime.Brand.CardHtml(Locale.De), Assert.Single(host.World.Hudded[Ada]));
        Assert.Empty(host.World.HudActions);
    }

    // ------------------------------------------------------------------ the card

    [Fact]
    public void SomebodyWhoJoinsInWarmupGetsTheCardInTheirOwnLanguage_AndNoCentreCard()
    {
        using var host = Assigned();
        InWarmup(host);
        var ada = host.World.Connect(Ada, "Ada");
        var ben = host.World.Connect(Ben, "Ben");
        host.Clock.Advance(Branding.CardDelayMs);

        Assert.False(host.World.Hudded.ContainsKey(Ada));
        Assert.False(host.World.Hudded.ContainsKey(Ben));
        Assert.True(CardUp(host, ada));
        Assert.False(MarkUp(host, ada));

        var layout = Layout(host);
        Assert.Equal("Willkommen bei", layout.Variable(ada.Slot, Welcome.Eyebrow, Welcome.Text));
        Assert.Equal("SaarLAN 2026", layout.Variable(ada.Slot, Welcome.Title, Welcome.Text));
        Assert.Equal("PUGs für die SaarLAN-Community", layout.Variable(ada.Slot, Welcome.Tagline, Welcome.Text));
        Assert.Equal("Du spielst für Team A.", layout.Variable(ada.Slot, Welcome.Team, Welcome.Text));
        Assert.False(layout.Has(ada.Slot, Welcome.Card, Welcome.Teamless));
        Assert.Equal("Schreib .ready in den Chat, wenn du bereit bist.", layout.Variable(ada.Slot, Welcome.ToDo, Welcome.Text));
        Assert.Equal(Branding.PlatformUrl, layout.Variable(ada.Slot, Welcome.Url, Welcome.Text));
        Assert.Equal("SaarLAN 2026", layout.Variable(ada.Slot, Welcome.MarkTitle, Welcome.Text));

        Assert.Equal("Welcome to", layout.Variable(ben.Slot, Welcome.Eyebrow, Welcome.Text));
        Assert.Equal("PUGs for the SaarLAN community", layout.Variable(ben.Slot, Welcome.Tagline, Welcome.Text));
        Assert.Equal("You play for Team B.", layout.Variable(ben.Slot, Welcome.Team, Welcome.Text));
        Assert.Equal("Type .ready in chat when you are ready.", layout.Variable(ben.Slot, Welcome.ToDo, Welcome.Text));
    }

    [Fact]
    public void TheCardShrinksIntoTheMarkForTheRestOfWarmup_AndEverythingGoesWhenTheMatchGoesLive()
    {
        using var host = Assigned();
        InWarmup(host);
        var ada = host.World.Connect(Ada, "Ada");
        host.Clock.Advance(Branding.CardDelayMs + Welcome.CardMs - 1);
        Assert.True(CardUp(host, ada));

        host.Clock.Advance(1);
        Assert.False(CardUp(host, ada));
        Assert.True(Layout(host).Has(ada.Slot, Welcome.Card, Welcome.Shrunk));
        Assert.True(MarkUp(host, ada));

        // Warmup goes on, round after round, and so does the mark; a spawn tells the slot again.
        host.World.StartRound();
        host.World.Spawn(ada);
        host.Clock.Advance(Hud.ResendDelayMs);
        Assert.True(MarkUp(host, ada));

        // Live.
        host.World.Rules = Rules(warmup: false);
        host.World.StartRound();
        Assert.False(MarkUp(host, ada));
        Assert.False(CardUp(host, ada));
        Assert.False(Layout(host).Has(ada.Slot, Welcome.Card, Welcome.Shrunk));
    }

    [Fact]
    public void SomebodyWhoJoinsBeforeAnyRoundGetsTheCardWhenTheLayoutsAreMade()
    {
        using var host = Assigned();
        var ada = host.World.Connect(Ada, "Ada");
        host.Clock.Advance(Branding.CardDelayMs);

        // Nothing touched the world, and no centre card either: the HUD has it.
        Assert.Empty(host.World.HudActions);
        Assert.False(host.World.Hudded.ContainsKey(Ada));

        InWarmup(host);
        Assert.True(CardUp(host, ada));
    }

    // ------------------------------------------------------------------ never over a fight

    [Fact]
    public void SomebodyWhoJoinsWhileARoundIsPlayedGetsTheCentreCard()
    {
        using var host = Assigned();
        host.World.Rules = Rules(warmup: false);
        host.World.StartRound();
        host.World.EndFreeze();
        var ada = host.World.Connect(Ada, "Ada");
        host.Clock.Advance(Branding.CardDelayMs);

        Assert.Single(host.World.Hudded[Ada]);
        Assert.False(CardUp(host, ada));
    }

    [Fact]
    public void ACardInTheFreezeTimeIsPutAwayTheInstantTheFreezeEnds()
    {
        using var host = Assigned();
        host.World.Rules = Rules(warmup: false);
        host.World.StartRound();
        var ada = host.World.Connect(Ada, "Ada");
        // Fifteen seconds of freeze, two of them gone: thirteen left, the card needs eight.
        host.Clock.Advance(Branding.CardDelayMs);
        Assert.True(CardUp(host, ada));
        Assert.False(host.World.Hudded.ContainsKey(Ada));

        host.Clock.Advance(1_000);
        host.World.EndFreeze();
        Assert.False(CardUp(host, ada));
        Assert.False(MarkUp(host, ada));

        // And it does not come back as a mark when its time would have run out.
        host.Clock.Advance(Welcome.CardMs);
        Assert.False(MarkUp(host, ada));
        Assert.False(CardUp(host, ada));
    }

    [Fact]
    public void AFreezeShorterThanTheCardGetsTheCentreCard()
    {
        using var host = Assigned();
        host.World.SetCvar("mp_freezetime", "5");
        host.World.Rules = Rules(warmup: false);
        host.World.StartRound();
        var ada = host.World.Connect(Ada, "Ada");
        host.Clock.Advance(Branding.CardDelayMs);

        Assert.Single(host.World.Hudded[Ada]);
        Assert.False(CardUp(host, ada));
    }

    [Fact]
    public void ACardStillUpWhenTheMatchGoesLiveFinishesInTheFreezeAndLeavesNoMark()
    {
        using var host = Assigned();
        InWarmup(host);
        var ada = host.World.Connect(Ada, "Ada");
        host.Clock.Advance(Branding.CardDelayMs);

        // Everybody readied: the first live round, fifteen seconds of freeze.
        host.World.Rules = Rules(warmup: false);
        host.World.StartRound();
        Assert.True(CardUp(host, ada));

        host.Clock.Advance(Welcome.CardMs);
        Assert.False(CardUp(host, ada));
        Assert.False(MarkUp(host, ada));
    }

    // ------------------------------------------------------------------ who gets what

    [Fact]
    public void SomebodyAlreadyHereWhenTheMatchIsAssignedGetsTheCentreCard()
    {
        // They connected before the addon was handed out, so the HUD has nothing on their screen.
        using var host = new GamemodeTestHost(hudAddon: Addon);
        var ada = host.World.Connect(Ada, "Ada");
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("pug"), teamA: [GamemodeTestHost.Player(Ada, "Ada")], hud: true));
        InWarmup(host);
        host.Clock.Advance(Branding.CardDelayMs);

        Assert.Single(host.World.Hudded[Ada]);
        Assert.False(CardUp(host, ada));
    }

    [Fact]
    public void AFreeForAllHasNoTeamLine_AndTheEventsOwnTaglineAndBanner()
    {
        using var host = Assigned(mode: "powerup-dm", branding: new MatchBranding
        {
            EventName = "SaarLAN 2026",
            Tagline = "Die LAN im Saarland",
            Banner = "saarlan-2026",
        });
        InWarmup(host);
        var ada = host.World.Connect(Ada, "Ada");
        host.Clock.Advance(Branding.CardDelayMs);

        var layout = Layout(host);
        Assert.True(layout.Has(ada.Slot, Welcome.Card, Welcome.Teamless));
        Assert.Equal("", layout.Variable(ada.Slot, Welcome.Team, Welcome.Text));
        Assert.Equal("Die LAN im Saarland", layout.Variable(ada.Slot, Welcome.Tagline, Welcome.Text));
        Assert.Equal("Öffne dein Match auf ezpug.com – deine Aktionen laufen über das Handy.", layout.Variable(ada.Slot, Welcome.ToDo, Welcome.Text));
        // The banner is everybody's: a slot nobody is in has it too.
        Assert.True(layout.Has(9, Welcome.Root, "banner-saarlan-2026"));
    }

    [Fact]
    public void EZPugsOwnWordsWhenTheRequestNamesNoEvent()
    {
        using var host = Assigned(branding: new MatchBranding());
        InWarmup(host);
        var ada = host.World.Connect(Ada, "Ada");
        host.Clock.Advance(Branding.CardDelayMs);

        Assert.Equal("EZPug", Layout(host).Variable(ada.Slot, Welcome.Title, Welcome.Text));
        Assert.Equal("PUGs für die SaarLAN-Community", Layout(host).Variable(ada.Slot, Welcome.Tagline, Welcome.Text));
        Assert.DoesNotContain(Layout(host).Classes.Keys, key => key.Class.StartsWith(Welcome.BannerClassPrefix, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("default", null)]
    [InlineData("saarlan-2026", "banner-saarlan-2026")]
    // A key the addon does not hold is a class no rule draws: the house banner, never a refusal.
    [InlineData("summer-cup", "banner-summer-cup")]
    // Outside the contract's grammar: no class at all.
    [InlineData("Saarlan 2026", null)]
    [InlineData("x\" .y", null)]
    public void TheBannerIsAClassForAKeyAndNothingForTheHouseOne(string? key, string? expected) =>
        Assert.Equal(expected, Welcome.BannerClassOf(new MatchBranding { Banner = key }));

    [Fact]
    public void SomebodyWhoLeavesTakesTheirCardWithThem_AndTheNextInTheSlotGetsTheirOwn()
    {
        using var host = Assigned();
        InWarmup(host);
        var ada = host.World.Connect(Ada, "Ada");
        host.Clock.Advance(Branding.CardDelayMs + 1_000);
        host.World.Disconnect(ada);

        // Cleo takes the slot and is not rostered: her own card, no team line, and
        // nothing of Ada's timer lands on her.
        var cleo = host.World.Connect(Cleo, "Cleo");
        Assert.Equal(ada.Slot, cleo.Slot);
        Assert.False(MarkUp(host, cleo));
        Assert.False(CardUp(host, cleo));
        host.Clock.Advance(Welcome.CardMs - 1_000);
        Assert.False(MarkUp(host, cleo));
        Assert.True(CardUp(host, cleo));
        Assert.True(Layout(host).Has(cleo.Slot, Welcome.Card, Welcome.Teamless));
    }

    [Fact]
    public void BotsAndPuppetsGetNothing()
    {
        using var host = Assigned();
        InWarmup(host);
        var bot = host.World.Connect(76561198000000099, "BOT Kai", bot: true);
        host.Clock.Advance(Branding.CardDelayMs + Welcome.CardMs);

        Assert.DoesNotContain(host.World.HudActions, action => action.SteamId64 == bot.SteamId64);
        Assert.False(host.World.Hudded.ContainsKey(bot.SteamId64));
    }

    [Fact]
    public void NothingOfAReleasedMatchIsStillComing()
    {
        using var host = Assigned();
        InWarmup(host);
        host.World.Connect(Ada, "Ada");
        host.Clock.Advance(Branding.CardDelayMs);
        host.Link.Release();
        var before = host.World.HudActions.Count;

        host.Clock.Advance(Welcome.CardMs * 2);
        Assert.Equal(before, host.World.HudActions.Count);
        Assert.Empty(host.World.HudLayouts);
    }

    // ------------------------------------------------------------------ the layout agrees

    [Fact]
    public void EveryPanelAndClassTheWelcomeNamesIsInTheLayout()
    {
        // The client ignores a name it does not know without a word, so the layout is read
        // here: an id renamed on one side and not the other is a red test, not a blank card.
        var xml = File.ReadAllText(Repo.Path("hud", "layout", "ezpug_welcome.xml"));
        var css = File.ReadAllText(Repo.Path("hud", "styles", "ezpug_welcome.css"));
        Assert.EndsWith(Path.GetFileName(Repo.Path("hud", "layout", "ezpug_welcome.xml")), Welcome.Layout, StringComparison.Ordinal);
        foreach (var panel in new[] { Welcome.Root, Welcome.Card, Welcome.Mark })
        {
            Assert.Matches(new Regex($"<Panel id=\"{panel}\""), xml);
        }

        foreach (var label in new[] { Welcome.Eyebrow, Welcome.Title, Welcome.Tagline, Welcome.Team, Welcome.ToDo, Welcome.Url, Welcome.MarkTitle, Welcome.MarkUrl })
        {
            Assert.Matches(new Regex($"<Label id=\"{label}\"[^>]* text=\"\\{{s:{Welcome.Text}\\}}\""), xml);
        }

        Assert.Contains(".ezpug-welcome-card.shown", css, StringComparison.Ordinal);
        Assert.Contains(".ezpug-welcome-card.shrunk", css, StringComparison.Ordinal);
        Assert.Contains(".ezpug-welcome-card.teamless", css, StringComparison.Ordinal);
        Assert.Contains(".ezpug-welcome-mark.shown", css, StringComparison.Ordinal);
        // The banner's stylesheet is written by hud/src/banners.ts, one rule per key under this prefix.
        Assert.Contains($".ezpug-welcome.{Welcome.BannerClassPrefix}${{key}}", File.ReadAllText(Repo.Path("hud", "src", "banners.ts")), StringComparison.Ordinal);
        Assert.Contains("class=\"ezpug-welcome\"", xml, StringComparison.Ordinal);
        Assert.Contains("class=\"ezpug-welcome-card\"", xml, StringComparison.Ordinal);
        Assert.Contains("class=\"ezpug-welcome-mark\"", xml, StringComparison.Ordinal);
    }
}
