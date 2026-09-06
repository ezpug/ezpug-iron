using System.Diagnostics;
using System.Security.Cryptography;
using EZPug.Sdk;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>The upload the server owns</b> (decision 10, PRD-02 T21): the file is hashed once,
/// streamed at the presigned URL, and offered again on the injected clock when the
/// storage says something retryable. Nothing here throws at the caller — a demo that
/// could not be uploaded is an outcome the match reports.
/// </summary>
public class DemoUploaderTests : IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "ezpug-demo-" + Guid.NewGuid().ToString("N"));
    private static readonly Uri Target = new("https://bucket.invalid/demos/one.dem?signed=1");

    public DemoUploaderTests() => Directory.CreateDirectory(_folder);

    private string WriteDemo(string name, int bytes)
    {
        var path = Path.Combine(_folder, name);
        var content = new byte[bytes];
        for (var i = 0; i < bytes; i++)
        {
            content[i] = (byte)(i % 251);
        }

        File.WriteAllBytes(path, content);
        return path;
    }

    [Fact]
    public async Task ThePutCarriesTheWholeFileAndTheOutcomeCarriesItsHash()
    {
        var path = WriteDemo("match.dem", 5_000);
        var transport = new FakeDemoTransport();
        var uploader = new DemoUploader(transport, new FakeClock());

        var outcome = await uploader.UploadAsync(Target, path);

        Assert.True(outcome.Uploaded);
        Assert.Equal("match.dem", outcome.FileName);
        Assert.Equal(5_000, outcome.SizeBytes);
        Assert.Equal(DemoFiles.ContentType, outcome.ContentType);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path))), outcome.Sha256);
        var attempt = Assert.Single(transport.Attempts);
        Assert.Equal(Target, attempt.Url);
        Assert.Equal(5_000, attempt.Length);
        Assert.Equal(File.ReadAllBytes(path), attempt.Body);
        Assert.Equal(DemoFiles.ContentType, attempt.ContentType);
    }

    [Fact]
    public async Task ARetryableRefusalIsTriedAgainOnTheClockWithTheSameBytes()
    {
        var path = WriteDemo("match.dem", 512);
        var clock = new FakeClock();
        var transport = new FakeDemoTransport();
        transport.Answers.Clear();
        transport.Answers.AddRange([500, 429, 200]);
        var uploader = new DemoUploader(transport, clock);

        var uploading = uploader.UploadAsync(Target, path);
        // The waits are the clock's: nothing moves until it does.
        Assert.False(uploading.IsCompleted);
        await AdvanceUntil(clock, uploading);

        var outcome = await uploading;
        Assert.True(outcome.Uploaded);
        Assert.Equal(3, transport.Attempts.Count);
        Assert.All(transport.Attempts, attempt => Assert.Equal(File.ReadAllBytes(path), attempt.Body));
    }

    [Fact]
    public async Task ARefusalThatWillNotChangeIsNotRetriedAndTheDemoStaysHere()
    {
        var path = WriteDemo("match.dem", 128);
        var transport = new FakeDemoTransport();
        transport.Answers.Clear();
        transport.Answers.Add(403);
        var uploader = new DemoUploader(transport, new FakeClock());

        var outcome = await uploader.UploadAsync(Target, path);

        Assert.False(outcome.Uploaded);
        Assert.Single(transport.Attempts);
        Assert.Contains("403", outcome.Detail);
        // The hash is still known: the bytes exist, they are just not where they were asked for.
        Assert.NotNull(outcome.Sha256);
    }

    [Fact]
    public async Task ASocketThatDiesIsRetriedAndGivenUpOnAfterTheLastAttempt()
    {
        var path = WriteDemo("match.dem", 64);
        var clock = new FakeClock();
        var transport = new FakeDemoTransport { Throws = new IOException("the connection went away") };
        var uploader = new DemoUploader(transport, clock);

        var uploading = uploader.UploadAsync(Target, path);
        await AdvanceUntil(clock, uploading);

        var outcome = await uploading;
        Assert.False(outcome.Uploaded);
        Assert.Equal(DemoUploader.Attempts, transport.Attempts.Count);
        Assert.Contains("the connection went away", outcome.Detail);
    }

    [Fact]
    public async Task AFileThatIsNotThereIsAnOutcomeAndNotAThrow()
    {
        var transport = new FakeDemoTransport();
        var uploader = new DemoUploader(transport, new FakeClock());

        var outcome = await uploader.UploadAsync(Target, Path.Combine(_folder, "nothing.dem"));

        Assert.False(outcome.Uploaded);
        Assert.Empty(transport.Attempts);
        Assert.Null(outcome.Sha256);
    }

    /// <summary>
    /// Move the fake clock until the upload settles — the backoff's timers are on it, and
    /// the continuations between them are the thread pool's. The wall-clock bound is the
    /// safety net, never the mechanism (<see cref="Patience"/>, PRD-02 T20a): a loaded box
    /// takes longer to schedule a continuation and must not read as a stuck upload.
    /// </summary>
    private static async Task AdvanceUntil(FakeClock clock, Task task)
    {
        var watch = Stopwatch.StartNew();
        while (!task.IsCompleted && watch.ElapsedMilliseconds < Patience.TimeoutMs)
        {
            clock.Advance(1_000);
            await Task.Delay(1);
        }
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_folder, recursive: true);
        }
        catch (IOException)
        {
            // A temp folder that will not go is not a failing test.
        }
    }
}
