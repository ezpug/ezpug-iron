using System.Security.Cryptography;

namespace EZPug.Sdk;

/// <summary>What one PUT answered. <c>Status 0</c> is "the request never got an answer".</summary>
public readonly record struct DemoPutResult(int Status, string? Message)
{
    public bool Ok => Status is >= 200 and < 300;

    /// <summary>Worth trying again: no answer at all, a timeout, a rate limit, a server error.</summary>
    public bool Retryable => Status is 0 or 408 or 429 or >= 500;
}

/// <summary>
/// The one HTTP verb a demo needs, behind a seam so the retry loop above it is proven on
/// a fake and the game is never in a test (PRD-02 T21). The body is a stream: a demo is
/// tens or hundreds of megabytes and never becomes a byte array on the way out.
/// </summary>
public interface IDemoTransport
{
    Task<DemoPutResult> PutAsync(Uri url, Stream body, long length, string contentType, CancellationToken cancellationToken);
}

/// <summary>What became of one demo: the file, its size and hash, and where it went (or did not).</summary>
public sealed record DemoUploadOutcome(
    bool Uploaded,
    string FileName,
    long SizeBytes,
    string? Sha256,
    string ContentType,
    /// <summary>Why it did not land, for a log line and never for a wire field.</summary>
    string? Detail);

/// <summary>
/// <b>The server owns the upload</b> (decision 10): MatchZy's own uploader POSTs a
/// multipart form, which a presigned S3 PUT cannot take, so the demo goes up from here
/// instead — streamed, checksummed, and retried on the injected clock.
///
/// The hash is taken first, over the whole file, and the file is opened again for each
/// attempt: a retry must send the same bytes the hash promises, and a stream that has
/// already been read once cannot. Both passes are sequential reads of a file the kernel
/// just wrote, which is the cheap half of this operation; the network is the other.
/// </summary>
public sealed class DemoUploader
{
    /// <summary>How many times one demo is offered to the storage before it is given up on.</summary>
    public const int Attempts = 4;

    /// <summary>The waits between attempts, in order; the last one repeats. On the clock, never <c>Task.Delay</c>.</summary>
    public static readonly long[] BackoffMs = [2_000, 6_000, 18_000];

    private readonly IDemoTransport _transport;
    private readonly IClock _clock;
    private readonly ILinkLog _log;

    public DemoUploader(IDemoTransport transport, IClock clock, ILinkLog? log = null)
    {
        _transport = transport;
        _clock = clock;
        _log = log ?? NullLinkLog.Instance;
    }

    /// <summary>
    /// Hash <paramref name="path"/>, then PUT it at <paramref name="url"/> until it lands
    /// or the attempts run out. Never throws: a demo that could not be uploaded is an
    /// outcome the match reports, not an exception the plugin dies of.
    /// </summary>
    public async Task<DemoUploadOutcome> UploadAsync(Uri url, string path, string contentType = DemoFiles.ContentType, CancellationToken cancellationToken = default)
    {
        var fileName = Path.GetFileName(path);
        long length;
        string hash;
        try
        {
            await using var reading = File.OpenRead(path);
            length = reading.Length;
            hash = Convert.ToHexStringLower(await SHA256.HashDataAsync(reading, cancellationToken));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            _log.Warn($"could not read the demo {fileName}: {error.Message}");
            return new DemoUploadOutcome(false, fileName, 0, null, contentType, error.Message);
        }

        string? detail = null;
        for (var attempt = 1; attempt <= Attempts; attempt++)
        {
            DemoPutResult result;
            try
            {
                await using var body = File.OpenRead(path);
                result = await _transport.PutAsync(url, body, length, contentType, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception error)
            {
                result = new DemoPutResult(0, error.Message);
            }

            if (result.Ok)
            {
                _log.Info($"the demo {fileName} ({length} bytes) landed on attempt {attempt}");
                return new DemoUploadOutcome(true, fileName, length, hash, contentType, null);
            }

            detail = result.Message is { Length: > 0 } message
                ? $"{result.Status}: {message}"
                : $"the storage answered {result.Status}";
            if (!result.Retryable || attempt == Attempts)
            {
                break;
            }

            _log.Warn($"the demo {fileName} did not land ({detail}); attempt {attempt + 1} of {Attempts} follows");
            await DelayAsync(BackoffMs[Math.Min(attempt - 1, BackoffMs.Length - 1)], cancellationToken);
        }

        _log.Warn($"the demo {fileName} stayed on this server ({detail})");
        return new DemoUploadOutcome(false, fileName, length, hash, contentType, detail);
    }

    /// <summary>A wait on the injected clock — <c>Task.Delay</c> would be a second timeline (CLAUDE.md).</summary>
    private Task DelayAsync(long delayMs, CancellationToken cancellationToken)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var timer = _clock.After(delayMs, () => completion.TrySetResult());
        var registration = cancellationToken.Register(() =>
        {
            timer.Cancel();
            completion.TrySetCanceled(cancellationToken);
        });
        return completion.Task.ContinueWith(
            task =>
            {
                registration.Dispose();
                return task;
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default).Unwrap();
    }
}

/// <summary>
/// The real transport: one <see cref="HttpClient"/> and one streamed PUT. The URL is a
/// presigned one — its signature <i>is</i> the credential — so it is never logged and
/// never carried anywhere but into this call.
/// </summary>
public sealed class HttpDemoTransport : IDemoTransport, IDisposable
{
    private readonly HttpClient _http;
    private readonly bool _owned;

    public HttpDemoTransport(HttpClient? http = null, TimeSpan? timeout = null)
    {
        _owned = http is null;
        _http = http ?? new HttpClient { Timeout = timeout ?? TimeSpan.FromMinutes(10) };
    }

    public async Task<DemoPutResult> PutAsync(Uri url, Stream body, long length, string contentType, CancellationToken cancellationToken)
    {
        using var content = new StreamContent(body);
        content.Headers.ContentLength = length;
        content.Headers.TryAddWithoutValidation("Content-Type", contentType);
        using var request = new HttpRequestMessage(HttpMethod.Put, url) { Content = content };
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.IsSuccessStatusCode)
        {
            return new DemoPutResult((int)response.StatusCode, null);
        }

        // The body of a storage's refusal is an XML error document, not a secret; the
        // first line of it is what makes a 403 readable.
        var said = await response.Content.ReadAsStringAsync(cancellationToken);
        return new DemoPutResult((int)response.StatusCode, said.Length > 200 ? said[..200] : said);
    }

    public void Dispose()
    {
        if (_owned)
        {
            _http.Dispose();
        }
    }
}
