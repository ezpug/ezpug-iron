using System.Text.Json;
using System.Text.Json.Serialization;

namespace EZPug.Sdk;

/// <summary>
/// <b>How a server learns where home is.</b> The provider plants two facts before the
/// server starts — the orchestrator's URL and this server's token — either as
/// environment (<c>EZPUG_IRON_URL</c>, <c>EZPUG_SERVER_TOKEN</c>: a node's container, the
/// dev image) or as a file, <c>ezpug.json</c> (<c>{ "url", "token" }</c>: what the Dathost
/// provider uploads, PRD-02 T16). Environment wins when both are present, because a
/// container's env is set per start and a file may be a template's leftover.
/// <c>EZPUG_LINK_BUFFER_DIR</c> / <c>"bufferDir"</c> is where the unacked-event buffer
/// lives; absent, the caller picks a directory beside the plugin.
/// The token is a secret: <see cref="ToString"/> redacts it and nothing here logs.
/// </summary>
public sealed record Sidecar(Uri LinkUrl, string Token, string? BufferDir)
{
    public const string UrlVariable = "EZPUG_IRON_URL";
    public const string TokenVariable = "EZPUG_SERVER_TOKEN";
    public const string BufferDirVariable = "EZPUG_LINK_BUFFER_DIR";
    public const string FileName = "ezpug.json";

    private sealed record FileShape(
        [property: JsonPropertyName("url")] string? Url,
        [property: JsonPropertyName("token")] string? Token,
        [property: JsonPropertyName("bufferDir")] string? BufferDir);

    /// <summary>
    /// Read the environment, then the file. <c>null</c> when neither says enough — the
    /// plugin then runs unlinked and says so on the console, rather than guessing.
    /// </summary>
    public static Sidecar? Load(IReadOnlyDictionary<string, string> environment, string? filePath)
    {
        if (environment.TryGetValue(UrlVariable, out var url) && environment.TryGetValue(TokenVariable, out var token)
            && !string.IsNullOrWhiteSpace(url) && !string.IsNullOrWhiteSpace(token))
        {
            environment.TryGetValue(BufferDirVariable, out var bufferDir);
            return new Sidecar(LinkUrlOf(url), token.Trim(), NullIfBlank(bufferDir));
        }

        if (filePath is not null && File.Exists(filePath))
        {
            var shape = JsonSerializer.Deserialize<FileShape>(File.ReadAllText(filePath));
            if (shape is { Url: { } fileUrl, Token: { } fileToken }
                && !string.IsNullOrWhiteSpace(fileUrl) && !string.IsNullOrWhiteSpace(fileToken))
            {
                return new Sidecar(LinkUrlOf(fileUrl), fileToken.Trim(), NullIfBlank(shape.BufferDir));
            }
        }

        return null;
    }

    /// <summary>The process environment and <c>ezpug.json</c> in <paramref name="directory"/>.</summary>
    public static Sidecar? LoadFromProcess(string directory)
    {
        var environment = Environment.GetEnvironmentVariables()
            .Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(entry => (string)entry.Key, entry => (string?)entry.Value ?? "");
        return Load(environment, Path.Combine(directory, FileName));
    }

    /// <summary>
    /// The orchestrator's base URL as a client is given it (<c>https://gs.ezpug.com</c>,
    /// <c>http://127.0.0.1:3430</c>, or already <c>wss://…/link</c>) turned into the link's
    /// upgrade URL: <c>http</c> → <c>ws</c>, <c>https</c> → <c>wss</c>, the protocol's path
    /// appended when none is given.
    /// </summary>
    public static Uri LinkUrlOf(string url)
    {
        var uri = new Uri(url.Trim(), UriKind.Absolute);
        var scheme = uri.Scheme switch
        {
            "http" => "ws",
            "https" => "wss",
            "ws" or "wss" => uri.Scheme,
            _ => throw new ArgumentException($"{uri.Scheme} is not a scheme the link can dial", nameof(url)),
        };
        var builder = new UriBuilder(uri) { Scheme = scheme };
        if (string.IsNullOrEmpty(builder.Path) || builder.Path == "/")
        {
            builder.Path = Protocol.ProtocolConstants.ServerLinkPath;
        }

        return builder.Uri;
    }

    /// <summary>
    /// The orchestrator's HTTP origin the link URL implies (<c>wss://gs.ezpug.com/link</c> →
    /// <c>https://gs.ezpug.com</c>) with <paramref name="path"/> — where MatchZy's remote log
    /// is pointed (<c>ProtocolConstants.MatchzyLogPath</c>).
    /// </summary>
    public Uri HttpUrl(string path)
    {
        var builder = new UriBuilder(LinkUrl)
        {
            Scheme = LinkUrl.Scheme == "wss" ? "https" : "http",
            Path = path,
            Query = "",
            Fragment = "",
        };
        if (builder.Port == (LinkUrl.Scheme == "wss" ? 443 : 80))
        {
            builder.Port = -1;
        }

        return builder.Uri;
    }

    private static string? NullIfBlank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>For a log line: the URL and where the buffer goes, never the token.</summary>
    public override string ToString() => $"Sidecar {{ LinkUrl = {LinkUrl}, Token = [redacted], BufferDir = {BufferDir ?? "(default)"} }}";
}
