using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>EZ Rating on the scoreboard, and the connect line</b> (PRD-02 T27, decision 21):
/// the number the runtime writes where Premier writes its own, read back through the
/// world exactly as <c>ezpug_status</c> reads it off a real controller, and the one
/// bilingual line a player gets when they arrive. Both hang off the manifest's
/// <c>scoreboardRating</c>, so <c>pug</c> (true) and <c>flying-scoutsman</c> (false) are
/// the two halves of every test here.
/// </summary>
public class RatingBoardTests
{
    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static RosterEntry Player(ulong steamId64, string name, Locale locale = Locale.De, long? rating = null, string? rankName = null) =>
        new() { SteamId64 = steamId64.ToString(), Name = name, Locale = locale, Rating = rating, RankName = rankName };

    private const ulong Ada = 76561198000000001;
    private const ulong Ben = 76561198000000002;

    /// <summary>A line as it reaches a player: behind the match's chat prefix, like every line the server says (PRD-02 T29).</summary>
    private static string Said(string line) => Branding.Prefixed(line);

    /// <summary>The other line a rostered player gets when they arrive — the branding's, in the colour of the side they are on.</summary>
    private static string TeamLine(string said, string team, char color) => Said($"{said} {ChatColor.Paint(color, team)}.");

    [Fact]
    public void ARosteredPlayerArrivesToTheirRatingAndOneLine()
    {
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            teamA: [Player(Ada, "Ada", Locale.De, rating: 1820, rankName: "Silber III")],
            teamB: [Player(Ben, "Ben", Locale.En, rating: 2410)]));

        var ada = host.World.Connect(Ada, "Ada");
        Assert.Equal(1820, ada.ScoreboardRating);
        // The number is written the way the scoreboard cell writes it — plain, no
        // grouping — so the line and the cell never disagree about the same rating.
        Assert.Equal(
            [Said("Willkommen, Ada. Dein EZ Rating: 1820 · Silber III."), TeamLine("Du spielst für", "Team A", ChatColor.Blue)],
            host.World.Said[Ada]);

        // The other side, in the other language, with no rank to name.
        var ben = host.World.Connect(Ben, "Ben");
        Assert.Equal(2410, ben.ScoreboardRating);
        Assert.Equal(
            [Said("Welcome, Ben. Your EZ Rating: 2410."), TeamLine("You play for", "Team B", ChatColor.Gold)],
            host.World.Said[Ben]);

        // One greeting per connection, however many times the numbers are drawn again.
        host.World.StartRound();
        Assert.Equal(2, host.World.Said[Ada].Count);
        Assert.Equal(1820, ada.ScoreboardRating);
    }

    [Fact]
    public void AGamemodeThatDidNotAskForItGetsNeitherTheNumberNorTheLine()
    {
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("flying-scoutsman"),
            map: "de_dust2",
            teamA: [Player(Ada, "Ada", rating: 1820)]));
        Assert.False(host.Runtime.Ratings.Active);

        var ada = host.World.Connect(Ada, "Ada");
        Assert.Null(ada.ScoreboardRating);
        // The branding still welcomes them to their team; the rating is what this
        // manifest did not ask for.
        Assert.DoesNotContain(host.World.Said[Ada], line => line.Contains("EZ Rating"));
        Assert.DoesNotContain(host.World.Actions, action => action.Verb == "rating");
    }

    [Fact]
    public void SomebodyWhoJoinedOpenIsGreetedByTheirProfile()
    {
        // retakes: nobody is rostered, people arrive and the platform answers with a
        // `profile` — which is the first moment the server knows who anybody is.
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("retakes")));

        var ada = host.World.Connect(Ada, "Ada");
        Assert.Null(ada.ScoreboardRating);
        Assert.False(host.World.Said.ContainsKey(Ada));

        host.Link.PushProfile(Player(Ada, "Ada", Locale.En, rating: 1500, rankName: "Silver III"));
        Assert.Equal(1500, ada.ScoreboardRating);
        Assert.Equal([Said("Welcome, Ada. Your EZ Rating: 1500 · Silver III.")], host.World.Said[Ada]);

        // A refreshed rating moves the number and says nothing a second time.
        host.Link.PushProfile(Player(Ada, "Ada", Locale.En, rating: 1560, rankName: "Silver III"));
        Assert.Equal(1560, ada.ScoreboardRating);
        Assert.Single(host.World.Said[Ada]);
    }

    [Fact]
    public void AProfileWithNoRatingSaysSoAndDrawsNothing()
    {
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            teamA: [Player(Ada, "Ada", Locale.En)]));

        var ada = host.World.Connect(Ada, "Ada");
        Assert.Null(ada.ScoreboardRating);
        Assert.Equal(
            [Said("Welcome, Ada. No EZ Rating yet – this match counts."), TeamLine("You play for", "Team A", ChatColor.Blue)],
            host.World.Said[Ada]);
    }

    [Fact]
    public void AStrangerIsLeftAlone()
    {
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("retakes")));

        var ada = host.World.Connect(Ada, "Ada");
        Assert.Null(ada.ScoreboardRating);
        Assert.DoesNotContain(host.World.Actions, action => action.Verb == "rating");
        Assert.False(host.World.Said.ContainsKey(Ada));
    }

    [Fact]
    public void ThePlayersAlreadyStandingAreDrawnWhenTheMatchArrives()
    {
        // A server that was already up (a warm instance, a retakes box people are on)
        // gets its assignment after the people: the numbers go on then, and nobody is
        // greeted twice when the map comes up.
        using var host = new GamemodeTestHost();
        var ada = host.World.Connect(Ada, "Ada");
        Assert.Null(ada.ScoreboardRating);

        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            teamA: [Player(Ada, "Ada", rating: 999)]));
        Assert.Equal(999, ada.ScoreboardRating);
        // Assign is not an arrival: the greeting belongs to a connect or a profile. The
        // one line an assignment does say is the branding's, which is what it is for.
        Assert.Equal([TeamLine("Du spielst für", "Team A", ChatColor.Blue)], host.World.Said[Ada]);
    }

    [Fact]
    public void TheScoreboardIsClearedWhenTheMatchIsReleased()
    {
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            teamA: [Player(Ada, "Ada", rating: 1820)]));
        var ada = host.World.Connect(Ada, "Ada");
        Assert.Equal(1820, ada.ScoreboardRating);

        host.Link.Release();
        Assert.Null(ada.ScoreboardRating);
        Assert.False(host.Runtime.Ratings.Active);

        // And the next match greets the same connection again: it is a new match.
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            matchId: "7f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b",
            teamA: [Player(Ada, "Ada", rating: 1900)]));
        Assert.Equal(1900, ada.ScoreboardRating);
        host.Link.PushProfile(Player(Ada, "Ada", rating: 1900));
        var team = TeamLine("Du spielst für", "Team A", ChatColor.Blue);
        Assert.Equal(
            [Said("Willkommen, Ada. Dein EZ Rating: 1820."), team, team, Said("Willkommen, Ada. Dein EZ Rating: 1900.")],
            host.World.Said[Ada]);
    }

    [Fact]
    public void ABotIsDrawnAndNotTalkedTo()
    {
        // How the dev node proves this without a human: a bot has a synthetic SteamID64
        // (BotIdentity), the platform pushes a profile for it, the number lands on the
        // controller — and nobody wastes a chat line on a bot.
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("retakes")));
        var bot = host.World.Connect(BotIdentity.SteamId64Of(3), "BOT Ada", bot: true);

        host.Link.PushProfile(Player(BotIdentity.SteamId64Of(3), "BOT Ada", rating: 1234));
        Assert.Equal(1234, bot.ScoreboardRating);
        Assert.False(host.World.Said.ContainsKey(bot.SteamId64));
    }
}
