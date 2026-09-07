using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>The lines a server says while it waits, and the ones a client tells it to say</b>
/// (PRD-02 T30): the assignment's warmup lines on a timer in warmup and nowhere else, an
/// <c>announce</c> printed as the client wrote it, and one sanitizer between chat and
/// everything a line from outside could otherwise reach.
/// </summary>
public class WarmupChatTests
{
    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static readonly string[] Lines = ["Willkommen bei EZPug.", "Auf ezpug.com steht dein Match.", "Ready-up mit !ready."];

    /// <summary>A host in warmup, its map up, with <paramref name="lines"/> to print.</summary>
    private static GamemodeTestHost Warming(IReadOnlyList<string> lines, out Assignment assignment)
    {
        var host = new GamemodeTestHost();
        host.World.Rules = new GameRules(Warmup: true, RoundsPlayed: 0, Paused: false, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: false);
        assignment = host.Start(GamemodeTestHost.AssignmentFor(Manifest("pug"), warmupLines: lines));
        return host;
    }

    [Fact]
    public void TheWarmupLinesArePrintedOneEveryFewSecondsInOrderAndThenAgain()
    {
        using var host = Warming(Lines, out _);

        // Nothing at the moment the map comes up: the first line is one interval in, so
        // it does not land inside the client's own connect chatter.
        Assert.Empty(host.World.Broadcasts);

        host.World.Elapse(WarmupChat.IntervalMs);
        host.World.Elapse(WarmupChat.IntervalMs);
        host.World.Elapse(WarmupChat.IntervalMs);
        Assert.Equal(Lines, host.World.Broadcasts);

        // The set cycles: somebody who connects late still reads all three.
        host.World.Elapse(WarmupChat.IntervalMs);
        Assert.Equal([.. Lines, Lines[0]], host.World.Broadcasts);
        Assert.Equal(4, host.Runtime.Warmup.Printed);
    }

    [Fact]
    public void TheLinesAreTheClientsWordsWithNoPrefixOfOurs()
    {
        using var host = Warming(["Willkommen bei EZPug."], out _);
        host.World.Elapse(WarmupChat.IntervalMs);

        // Unlike everything the SDK says in its own voice (T29), a line the platform
        // rendered is relayed exactly as it was written.
        Assert.Equal("Willkommen bei EZPug.", Assert.Single(host.World.Broadcasts));
        Assert.DoesNotContain(Branding.PrefixFor(null), host.World.Broadcasts[0]);
    }

    [Fact]
    public void WarmupEndingEndsTheLinesAndTheNextWarmupStartsThemAgain()
    {
        using var host = Warming(Lines, out _);
        host.World.Elapse(WarmupChat.IntervalMs);
        Assert.Single(host.World.Broadcasts);

        // The engine says the match is running: the server has nothing to fill.
        host.World.Rules = new GameRules(Warmup: false, RoundsPlayed: 3, Paused: false, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: false);
        host.World.Elapse(WarmupChat.IntervalMs * 4);
        Assert.Single(host.World.Broadcasts);

        // Map two: warmup again, and the lines pick up where they were.
        host.World.Rules = new GameRules(Warmup: true, RoundsPlayed: 0, Paused: false, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, SwitchingTeamsAtRoundReset: false);
        host.World.Elapse(WarmupChat.IntervalMs);
        Assert.Equal([Lines[0], Lines[1]], host.World.Broadcasts);
    }

    [Fact]
    public void AWorldWithNoGamerulesFallsBackToTheMatchNotBeingLiveYet()
    {
        // A world that reports no gamerules — the harness, and a mode whose own flow is
        // the only thing that knows the wait is over: `going_live` is the edge instead.
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("powerup-dm"), warmupLines: Lines));
        Assert.Null(host.World.Rules);

        host.World.Elapse(WarmupChat.IntervalMs);
        Assert.Single(host.World.Broadcasts);

        host.Runtime.Emit(host.Runtime.Facts.GoingLive(host.World.Map));
        Assert.True(host.Runtime.Match.Live);
        host.World.Elapse(WarmupChat.IntervalMs * 3);
        Assert.Single(host.World.Broadcasts);
    }

    [Fact]
    public void AMatchWithNoLinesArmsNothingAndAReleaseSilencesTheOnesThereWere()
    {
        using var quiet = new GamemodeTestHost();
        quiet.Start(GamemodeTestHost.AssignmentFor(Manifest("pug")));
        Assert.False(quiet.Runtime.Warmup.Armed);
        quiet.World.Elapse(WarmupChat.IntervalMs * 3);
        Assert.Empty(quiet.World.Broadcasts);

        using var host = Warming(Lines, out _);
        Assert.True(host.Runtime.Warmup.Armed);
        host.Link.Release("ended");
        Assert.False(host.Runtime.Warmup.Armed);
        Assert.Empty(host.Runtime.Warmup.Lines);
        host.World.Elapse(WarmupChat.IntervalMs * 3);
        Assert.Empty(host.World.Broadcasts);
    }

    [Fact]
    public void ALineThatIsNothingButConsoleIsDroppedAtAssignment()
    {
        using var host = Warming(["; ;", "  Gleich geht es los.  "], out var assignment);

        // The frame keeps what the client sent; what is printed is what survived.
        Assert.Equal(2, assignment.WarmupLines.Count);
        Assert.Equal(["Gleich geht es los."], host.Runtime.Warmup.Lines);
        host.World.Elapse(WarmupChat.IntervalMs * 2);
        Assert.Equal(["Gleich geht es los.", "Gleich geht es los."], host.World.Broadcasts);
    }

    // ------------------------------------------------------------------ announce

    [Fact]
    public void AnAnnounceIsPrintedAsTheClientWroteIt()
    {
        using var host = Warming([], out _);
        var answer = host.Link.Command(new AnnounceCommand { CorrelationId = "c1", Text = "Map 2 startet in 5 Minuten" });

        Assert.Equal(LinkCommandStatus.Applied, answer!.Status);
        Assert.Equal("Map 2 startet in 5 Minuten", Assert.Single(host.World.Broadcasts));
    }

    [Fact]
    public void AnAnnounceIsSanitizedAndAnEmptyOneIsRefused()
    {
        using var host = Warming([], out _);

        var applied = host.Link.Command(new AnnounceCommand
        {
            CorrelationId = "c1",
            Text = "gleich\ngeht es \"los\"; say hi",
        });
        Assert.Equal(LinkCommandStatus.Applied, applied!.Status);
        Assert.Equal("gleich geht es los say hi", Assert.Single(host.World.Broadcasts));

        // The contract forbids an empty line, so what arrives is a line that is
        // nothing once it is safe to say: a colour code and a console separator.
        var refused = host.Link.Command(new AnnounceCommand { CorrelationId = "c2", Text = "\u0004;\u0001" });
        Assert.Equal(LinkCommandStatus.Rejected, refused!.Status);
        Assert.Equal(MatchApiErrorCode.ValidationFailed, refused.Code);
        Assert.Single(host.World.Broadcasts);
    }

    // ------------------------------------------------------------------ the sanitizer

    [Theory]
    // The simulator's own vectors (`packages/sim/src/chat.ts`), so both boxes print the same line.
    [InlineData("gg wp", "gg wp")]
    [InlineData("  spaced   out  ", "spaced out")]
    [InlineData("line\nbreak", "line break")]
    [InlineData("say \"hi\"; quit", "say hi quit")]
    [InlineData("back\\slash", "back slash")]
    [InlineData("\u0004green\u0001", "green")]
    public void ALineFromOutsideIsCleanedTheSameWayTheSimulatorCleansIt(string raw, string expected) =>
        Assert.Equal(expected, SaidLine.Sanitize(raw));

    [Fact]
    public void ALineIsClampedToWhatChatShowsAndOneWithNothingLeftIsNull()
    {
        Assert.Equal(SaidLine.MaxLength, SaidLine.Sanitize(new string('a', 400))!.Length);
        Assert.Null(SaidLine.Sanitize("   "));
        Assert.Null(SaidLine.Sanitize(";;;"));

        // Counted in code points: an emoji at the edge is dropped, never halved.
        var emoji = SaidLine.Sanitize(new string('a', 126) + "🎯🎯")!;
        Assert.Equal("🎯", emoji[126..]);
    }
}
