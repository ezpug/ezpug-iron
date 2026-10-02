using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>A moment on a server that draws nothing</b> (PRD-07 T4): the platform says what
/// happened to whom, and a server without a HUD answers by printing the line, exactly as
/// an <c>announce</c> does — so a caller needs no knowledge of what a server can draw.
/// Each person reads their own language, the person it is about reads their own words,
/// and the line waits for the instant the client asked for.
/// </summary>
public class MomentTests
{
    private const ulong Ada = 76561198000000001;
    private const ulong Ben = 76561198000000002;

    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static RosterEntry Player(ulong steamId64, string name, Locale locale) =>
        new() { SteamId64 = steamId64.ToString(), Name = name, Locale = locale };

    private static MomentCommand Drop(string correlationId, long inMs = 0, string? about = null) => new()
    {
        CorrelationId = correlationId,
        Kind = "drop",
        SteamId64 = about,
        Tier = MomentTier.Rare,
        Art = "big-jersey",
        Text = new MomentCommandText
        {
            De = new MomentWords { Everyone = "Ada zieht: BIG Trikot!", You = "Du ziehst: BIG Trikot!" },
            En = new MomentWords { Everyone = "Ada wins: BIG jersey!", You = "You win: BIG jersey!" },
        },
        InMs = inMs,
    };

    private static GamemodeTestHost Playing()
    {
        var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            teamA: [Player(Ada, "Ada", Locale.De)],
            teamB: [Player(Ben, "Ben", Locale.En)]));
        host.World.Connect(Ada, "Ada");
        host.World.Connect(Ben, "Ben");
        return host;
    }

    [Fact]
    public void EverybodyReadsTheLineInTheirLanguageAndThePersonReadsTheirOwn()
    {
        using var host = Playing();

        var answer = host.Link.Command(Drop("m1", about: Ada.ToString()))!;

        Assert.Equal(LinkCommandStatus.Applied, answer.Status);
        // The client's words as they were written, like an announce: no prefix of ours.
        Assert.Equal("Du ziehst: BIG Trikot!", host.World.Said[Ada][^1]);
        Assert.Equal("Ada wins: BIG jersey!", host.World.Said[Ben][^1]);
        // And not one call to the HUD: this server has no addon id.
        Assert.Empty(host.World.HudActions);
    }

    [Fact]
    public void AMomentAboutNobodyOnTheServerIsStillRead()
    {
        using var host = Playing();

        host.Link.Command(Drop("m1", about: "76561198000000099"));
        Assert.Equal("Ada zieht: BIG Trikot!", host.World.Said[Ada][^1]);
        Assert.Equal("Ada wins: BIG jersey!", host.World.Said[Ben][^1]);

        // No person at all: the same line for everybody.
        host.Link.Command(Drop("m2"));
        Assert.Equal("Ada zieht: BIG Trikot!", host.World.Said[Ada][^1]);
    }

    [Fact]
    public void TheLineWaitsUntilTheMomentIsDue()
    {
        using var host = Playing();
        var before = host.World.Said[Ada].Count;

        Assert.Equal(LinkCommandStatus.Applied, host.Link.Command(Drop("m1", inMs: 4_000, about: Ada.ToString()))!.Status);
        host.World.Elapse(3_999);
        Assert.Equal(before, host.World.Said[Ada].Count);
        host.World.Elapse(1);
        Assert.Equal("Du ziehst: BIG Trikot!", host.World.Said[Ada][^1]);
    }

    [Fact]
    public void AReleaseBeforeItIsDueTakesTheMomentWithIt()
    {
        using var host = Playing();

        host.Link.Command(Drop("m1", inMs: 4_000));
        host.Link.Release("ended: completed");
        host.World.Elapse(10_000);

        Assert.DoesNotContain("Ada zieht: BIG Trikot!", host.World.Said[Ada]);
    }

    [Fact]
    public void ALineThatCannotBeSaidIsRefusedRatherThanPrintedBlank()
    {
        using var host = Playing();
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
}
