using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>Branding is hostname and chat this round</b> (decision 22, PRD-02 T29): what the
/// browser shows, the one voice every line the server says is spoken in, the two team
/// names in the colours of the sides they are on, and the card a player reads when they
/// arrive. Everything here comes off the assignment, so the same match branded for an
/// event is branded in all four places at once.
/// </summary>
public class BrandingTests
{
    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static RosterEntry Player(ulong steamId64, string name, Locale locale = Locale.De) =>
        new() { SteamId64 = steamId64.ToString(), Name = name, Locale = locale };

    private const ulong Ada = 76561198000000001;
    private const ulong Ben = 76561198000000002;

    /// <summary>The prefix a plain match speaks in: green EZPug between brackets.</summary>
    private static readonly string Prefix = Branding.PrefixFor(null);

    private static string Blue(string name) => ChatColor.Paint(ChatColor.Blue, name);

    private static string Gold(string name) => ChatColor.Paint(ChatColor.Gold, name);

    // ------------------------------------------------------------------ the hostname

    [Fact]
    public void TheHostnameIsOursUntilTheRequestNamesOne()
    {
        var scoutsman = Manifest("flying-scoutsman");
        var plain = new Assignment(GamemodeTestHost.AssignmentFor(scoutsman));
        Assert.Equal("EZPug · flying-scoutsman · Mirage", Branding.HostnameFor(plain, "de_mirage"));

        // An event goes between the platform and the mode, so a server browser full of
        // them sorts by the night rather than by the gamemode.
        var evening = new Assignment(GamemodeTestHost.AssignmentFor(
            scoutsman,
            branding: new MatchBranding { EventName = "SaarLAN 2026" }));
        Assert.Equal("EZPug · SaarLAN 2026 · flying-scoutsman · Inferno", Branding.HostnameFor(evening, "de_inferno"));

        // And a request that named a hostname gets exactly it, event or no event.
        var asked = new Assignment(GamemodeTestHost.AssignmentFor(
            scoutsman,
            branding: new MatchBranding { Hostname = "SaarLAN 2026 · Scoutsman", EventName = "SaarLAN 2026" }));
        Assert.Equal("SaarLAN 2026 · Scoutsman", Branding.HostnameFor(asked, "de_inferno"));
    }

    [Fact]
    public void ALongEventNameIsClampedRatherThanTruncatedByTheBrowser()
    {
        var assignment = new Assignment(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            branding: new MatchBranding { EventName = new string('a', 64) }));
        var hostname = Branding.HostnameFor(assignment, "de_mirage");
        Assert.Equal(Branding.HostnameMax, hostname.Length);
        Assert.EndsWith("…", hostname);
    }

    [Theory]
    [InlineData("de_mirage", "Mirage")]
    [InlineData("cs_office", "Office")]
    [InlineData("ar_shoots", "Shoots")]
    [InlineData("3070923343", "3070923343")]
    [InlineData("de_", "de_")]
    public void MapsArePrettiedForTheHostname(string map, string pretty) => Assert.Equal(pretty, Branding.PrettyMap(map));

    // ------------------------------------------------------------------ the voice

    [Fact]
    public void EveryLineTheServerSaysCarriesThePrefix()
    {
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("pug"), teamA: [Player(Ada, "Ada")]));

        // The rating greeting is the SDK's own line and is spoken in the same voice.
        host.World.Connect(Ada, "Ada");
        Assert.All(host.World.Said[Ada], line => Assert.StartsWith(Prefix + " ", line));
        Assert.Contains($"{Prefix} Willkommen, Ada. Noch kein EZ Rating – dieses Match zählt.", host.World.Said[Ada]);

        // The prefix is a colour and a name, not a decoration a test invented: green
        // between brackets, and the line's own colour handed back after it.
        Assert.Equal($"[{ChatColor.Green}EZPug{ChatColor.Default}]", Prefix);
    }

    [Fact]
    public void TheEventNamesTheVoiceWhereTheRequestGaveOne()
    {
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            teamA: [Player(Ada, "Ada")],
            branding: new MatchBranding { EventName = "SaarLAN 2026" }));

        host.World.Connect(Ada, "Ada");
        Assert.All(host.World.Said[Ada], line => Assert.StartsWith($"[{ChatColor.Green}SaarLAN 2026{ChatColor.Default}] ", line));

        // Released, the server speaks for EZPug again rather than for last night's event.
        host.Link.Release("ended: completed");
        Assert.Equal(Prefix, host.Runtime.Brand.Prefix);
    }

    [Fact]
    public void AnEventCannotPaintTheRestOfTheLineOrRunOffTheEndOfIt()
    {
        var loud = Branding.PrefixFor(new MatchBranding { EventName = $"{ChatColor.Red}LAN {new string('x', 40)}" });
        Assert.Equal($"[{ChatColor.Green}LAN {new string('x', Branding.PrefixNameMax - 4)}{ChatColor.Default}]", loud);

        // The same rule wherever a name from outside lands: a hostname carries no colour either.
        var assignment = new Assignment(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            branding: new MatchBranding { Hostname = $"{ChatColor.Red}Rot" }));
        Assert.Equal("Rot", Branding.HostnameFor(assignment, "de_mirage"));
    }

    // ------------------------------------------------------------------ the teams

    [Fact]
    public void ATeamIsNamedInTheColourOfTheSideItIsOn()
    {
        using var host = new GamemodeTestHost();
        var assignment = GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            teamA: [Player(Ada, "Ada")],
            teamB: [Player(Ben, "Ben")],
            maps: [new MapPlan { Map = "de_mirage", Sides = MapPlanSides.Ct }]) with
        {
            Teams = new MatchTeams
            {
                TeamA = new Roster { Name = "Saartech", Players = [Player(Ada, "Ada")] },
                TeamB = new Roster { Name = "Hüttenwerk", Players = [Player(Ben, "Ben")] },
            },
        };
        host.Start(assignment);
        var brand = host.Runtime.Brand;

        // Team A starts CT: blue for them, gold for the other side.
        Assert.Equal(Blue("Saartech"), brand.TeamName(MatchTeam.TeamA));
        Assert.Equal(Gold("Hüttenwerk"), brand.TeamName(MatchTeam.TeamB));

        // Halftime moves the colours with the players.
        host.Runtime.Emit(host.Runtime.Facts.SideSwap(TeamSide.T));
        Assert.Equal(Gold("Saartech"), brand.TeamName(MatchTeam.TeamA));
        Assert.Equal(Blue("Hüttenwerk"), brand.TeamName(MatchTeam.TeamB));

        // And a rostered player is told which of the two they are playing for.
        host.World.Connect(Ada, "Ada");
        Assert.Contains($"{Prefix} Du spielst für {Gold("Saartech")}.", host.World.Said[Ada]);

        // Somebody who is not on the roster is told nothing about a team they are not on.
        var stranger = host.World.Connect(76561198000000009, "Chris");
        Assert.Null(brand.TeamNameOf(stranger));
        Assert.DoesNotContain(host.World.Said.GetValueOrDefault(stranger.SteamId64) ?? [], line => line.Contains("spielst für"));
    }

    // ------------------------------------------------------------------ the card

    [Fact]
    public void TheCardArrivesABeatAfterTheConnect_InThePlayersOwnLanguage()
    {
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            teamA: [Player(Ada, "Ada")],
            teamB: [Player(Ben, "Ben", Locale.En)],
            branding: new MatchBranding { EventName = "SaarLAN 2026" }));

        host.World.Connect(Ada, "Ada");
        host.World.Connect(Ben, "Ben");
        // Not in the same instant as the connect: the client is still catching up with
        // its own loading chatter.
        Assert.False(host.World.Hudded.ContainsKey(Ada));

        host.Clock.Advance(Branding.CardDelayMs);
        var card = Assert.Single(host.World.Hudded[Ada]);
        Assert.Contains("SaarLAN 2026", card);
        Assert.Contains("5v5 Wettkampf", card);
        Assert.Contains("Schreib .ready in den Chat", card);
        Assert.Contains(Branding.PlatformUrl, card);

        // The other side of the roster reads the same card in English.
        var english = Assert.Single(host.World.Hudded[Ben]);
        Assert.Contains("5v5 competitive", english);
        Assert.Contains("Type .ready in chat", english);
    }

    [Fact]
    public void TheCardSaysWhatThisModeAsksOfAPlayer()
    {
        using var powerup = new GamemodeTestHost();
        powerup.Start(GamemodeTestHost.AssignmentFor(Manifest("powerup-dm"), teamA: [Player(Ada, "Ada")]));
        var card = powerup.Runtime.Brand.CardLines(Locale.De);
        Assert.Equal(Branding.PlatformName, card[0]);
        Assert.Contains("Handy", card[2]);
        Assert.Equal(Branding.PlatformUrl, card[3]);

        // A config-tier mode with nothing to tap and nobody to ready up for says so.
        using var scoutsman = new GamemodeTestHost();
        scoutsman.Start(GamemodeTestHost.AssignmentFor(Manifest("flying-scoutsman"), teamA: [Player(Ada, "Ada")]));
        Assert.Equal("Viel Spaß.", scoutsman.Runtime.Brand.CardLines(Locale.De)[2]);
        Assert.Equal("Have fun.", scoutsman.Runtime.Brand.CardLines(Locale.En)[2]);
    }

    [Fact]
    public void NobodyIsShownACardTheMatchNoLongerHas()
    {
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("pug"), teamA: [Player(Ada, "Ada")]));

        // Left before the beat was up.
        var ada = host.World.Connect(Ada, "Ada");
        host.World.Disconnect(ada);
        host.Clock.Advance(Branding.CardDelayMs * 2);
        Assert.False(host.World.Hudded.ContainsKey(Ada));

        // Still connected, but the match was released inside the same beat.
        host.World.Connect(Ben, "Ben");
        host.Link.Release("ended: completed");
        host.Clock.Advance(Branding.CardDelayMs * 2);
        Assert.False(host.World.Hudded.ContainsKey(Ben));
        Assert.Empty(host.Runtime.Brand.CardLines(Locale.De));
    }

    [Fact]
    public void APlayerAlreadyStandingHereWhenTheMatchArrivesIsWelcomedToIt()
    {
        using var host = new GamemodeTestHost();
        host.World.Connect(Ada, "Ada");
        var bot = host.World.Connect(76561198000000010, "Bot Cliffe", bot: true);

        host.Start(GamemodeTestHost.AssignmentFor(Manifest("pug"), teamA: [Player(Ada, "Ada")]));
        host.Clock.Advance(Branding.CardDelayMs);
        Assert.Single(host.World.Hudded[Ada]);
        // A bot reads neither the card nor anything else.
        Assert.False(host.World.Hudded.ContainsKey(bot.SteamId64));
        Assert.False(host.World.Said.ContainsKey(bot.SteamId64));
    }

    [Fact]
    public void TheCardsMarkupSurvivesAnEventNamedInAngleBrackets()
    {
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            teamA: [Player(Ada, "Ada")],
            branding: new MatchBranding { EventName = "<b>LAN</b> & Co" }));

        var card = host.Runtime.Brand.CardHtml(Locale.De);
        Assert.Contains("&lt;b&gt;LAN&lt;/b&gt; &amp; Co", card);
        Assert.DoesNotContain("<b>", card);
    }
}
