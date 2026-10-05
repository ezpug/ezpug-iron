using System.Text.Json;

namespace EZPug.Sdk;

/// <summary>
/// <b>The addon's build stamp, as this build of the plugin knows it</b> (PRD-09 T8).
/// <c>pnpm hud:build</c> writes seven hex characters into the layouts' stamp labels and
/// into <c>hud/dist/manifest.json</c> (<c>hud/src/stamp.ts</c>); the SDK embeds that
/// manifest at build time (<c>EZPug.Sdk.csproj</c>, and the CS2 image's Dockerfile
/// copies it beside the sources), so a server can say which revision it was built
/// beside. A client's welcome card and reel window show the stamp of the revision the
/// client mounted. The two agree when the publish is live and the client restarted; a
/// look that reads two different stamps has found a stale client, not a wrong sheet.
/// </summary>
public static class HudStamp
{
    /// <summary>The embedded manifest's name.</summary>
    public const string Resource = "EZPug.Sdk.hud.manifest.json";

    /// <summary>What no stamped build says: the manifest without a stamp, or none embedded.</summary>
    public const string Unknown = "unstamped";

    /// <summary>The stamp of the addon this build was made beside.</summary>
    public static string Expected { get; } = Read();

    private static string Read()
    {
        try
        {
            using var stream = typeof(HudStamp).Assembly.GetManifestResourceStream(Resource);
            if (stream is null)
            {
                return Unknown;
            }

            using var manifest = JsonDocument.Parse(stream);
            return manifest.RootElement.TryGetProperty("stamp", out var stamp) && stamp.GetString() is { Length: > 0 } value
                ? value
                : Unknown;
        }
        catch (JsonException)
        {
            return Unknown;
        }
    }
}
