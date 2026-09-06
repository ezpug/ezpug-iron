using EZPug.Sdk;

namespace EZPug.Sdk.Testing;

/// <summary>
/// <b>The storage a demo is PUT at, without a network.</b> Records every attempt (the
/// URL, the content type and the bytes it was handed — read, so a test can prove the
/// stream carried the file) and answers what <see cref="Answers"/> says: one status per
/// attempt, the last one repeating, so a test scripts "two 500s, then a 200" and the
/// uploader's retry loop is what is under test rather than a network.
/// </summary>
public sealed class FakeDemoTransport : IDemoTransport
{
    /// <summary>One PUT as the storage saw it.</summary>
    public sealed record Attempt(Uri Url, string ContentType, long Length, byte[] Body);

    public List<Attempt> Attempts { get; } = [];

    /// <summary>The statuses to answer with, in order; the last repeats. Default: 200.</summary>
    public List<int> Answers { get; } = [200];

    /// <summary>Thrown instead of answering, when set — a socket that died mid-PUT.</summary>
    public Exception? Throws { get; set; }

    public async Task<DemoPutResult> PutAsync(Uri url, Stream body, long length, string contentType, CancellationToken cancellationToken)
    {
        using var copy = new MemoryStream();
        await body.CopyToAsync(copy, cancellationToken);
        Attempts.Add(new Attempt(url, contentType, length, copy.ToArray()));
        if (Throws is { } error)
        {
            throw error;
        }

        var status = Answers.Count == 0
            ? 200
            : Answers[Math.Min(Attempts.Count - 1, Answers.Count - 1)];
        return new DemoPutResult(status, status is >= 200 and < 300 ? null : "the fake storage refused");
    }
}
