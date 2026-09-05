using EZPug.Sdk.Protocol;
using Xunit;

namespace EZPug.Sdk.Tests;

public class FileEventBufferTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "ezpug-sdk-tests", Guid.NewGuid().ToString("N"));

    private static GameserverEvent Ready(string map) =>
        new ServerReadyEvent { MatchId = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b", Source = new GameserverSource { Provider = "nodes", ServerId = "devbox-1" }, Map = map };

    [Fact]
    public void SequencesPersistAcrossAReopenAndAckedEventsDoNotComeBack()
    {
        using (var buffer = new FileEventBuffer(_directory))
        {
            Assert.Equal(0, buffer.LastSeq);
            buffer.Append(Ready("a"));
            buffer.Append(Ready("b"));
            buffer.Append(Ready("c"));
            buffer.Acked(2);
        }

        using var reopened = new FileEventBuffer(_directory);
        Assert.Equal(3, reopened.LastSeq);
        Assert.Equal([1L, 3L], reopened.Pending().Select(entry => entry.Seq));
        Assert.Equal("c", ((ServerReadyEvent)reopened.Pending()[1].Event).Map);
        Assert.Equal(0, reopened.Skipped);

        var next = reopened.Append(Ready("d"));
        Assert.Equal(4, next.Seq);
    }

    [Fact]
    public void LastSeqSurvivesEvenWhenEverythingWasAckedAndCompacted()
    {
        using (var buffer = new FileEventBuffer(_directory))
        {
            for (var i = 0; i < 3; i++)
            {
                buffer.Append(Ready($"m{i}"));
            }

            buffer.AckedThrough(3);
            buffer.Compact();
            Assert.Empty(buffer.Pending());
        }

        Assert.Equal(["{\"lastSeq\":3}"], File.ReadLines(Path.Combine(_directory, "events.jsonl")).Where(line => line.Length > 0));
        using var reopened = new FileEventBuffer(_directory);
        Assert.Equal(3, reopened.LastSeq);
        Assert.Equal(4, reopened.Append(Ready("x")).Seq);
    }

    [Fact]
    public void CompactionRunsOnItsOwnPastTheThresholdAndKeepsOnlyThePending()
    {
        using var buffer = new FileEventBuffer(_directory);
        for (var i = 0; i < FileEventBuffer.CompactAfterAcks + 1; i++)
        {
            buffer.Append(Ready($"m{i}"));
        }

        for (var seq = 1; seq <= FileEventBuffer.CompactAfterAcks; seq++)
        {
            buffer.Acked(seq);
        }

        Assert.Equal("", File.ReadAllText(Path.Combine(_directory, "acked.log")));
        var lines = File.ReadAllLines(Path.Combine(_directory, "events.jsonl")).Where(line => line.Length > 0).ToList();
        Assert.Equal(2, lines.Count);
        Assert.Contains("\"lastSeq\":501", lines[0]);
        Assert.Single(buffer.Pending());
    }

    [Fact]
    public void ATornLineIsSkippedNotFatal()
    {
        using (var buffer = new FileEventBuffer(_directory))
        {
            buffer.Append(Ready("a"));
        }

        File.AppendAllText(Path.Combine(_directory, "events.jsonl"), "{\"seq\":2,\"event\":{\"matchId\":\"6f1a");
        using var reopened = new FileEventBuffer(_directory);
        Assert.Equal(1, reopened.Skipped);
        Assert.Equal(1, reopened.LastSeq);
        Assert.Single(reopened.Pending());
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }
}
