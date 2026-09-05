using System.Text;
using EZPug.Sdk;

namespace EZPug.Core;

/// <summary>
/// <c>ezpug_status</c>: what an operator at the console wants to know, and nothing a
/// stranger should — the link's URL host, never the token; the buffer's counters; the
/// state, match and mode; the plugins the loader enabled. One line per fact, so a
/// Dathost console or an RCON reply reads the same.
/// </summary>
public static class StatusReport
{
    public sealed record Input(
        GamemodeRuntime Runtime,
        IPlatformLink Link,
        Uri? LinkUrl,
        (long LastSeq, int Pending)? Buffer,
        PluginCatalog Catalog,
        GamemodeLoader Loader);

    public static string Render(Input input)
    {
        var runtime = input.Runtime;
        var lines = new StringBuilder();
        lines.AppendLine($"EZPug.Core {HelloFactsBuilder.PluginVersion} / EZPug.Sdk {SdkInfo.Version} / CounterStrikeSharp {HelloFactsBuilder.CounterStrikeSharpVersion}");
        lines.AppendLine(input.LinkUrl is null
            ? $"link: unlinked (set {Sidecar.UrlVariable} + {Sidecar.TokenVariable}, or write {Sidecar.FileName})"
            : $"link: {(input.Link.Connected ? "connected" : "connecting")} to {input.LinkUrl.Host}{(input.LinkUrl.IsDefaultPort ? "" : ":" + input.LinkUrl.Port)} as {(input.Link.Source is { } source ? $"{source.Provider}/{source.ServerId}" : "(not welcomed yet)")}");
        if (input.Buffer is { } buffer)
        {
            lines.AppendLine($"buffer: lastSeq {buffer.LastSeq}, {buffer.Pending} unacked");
        }

        var status = runtime.Status();
        lines.AppendLine($"state: {status.State.ToString().ToLowerInvariant()}, map {status.Map}, {status.PlayerCount} player(s)");
        lines.AppendLine(runtime.Assignment is { } assignment
            ? $"match: {assignment.MatchId} ({assignment.Gamemode.Id}, flow {assignment.Gamemode.Flow.ToString().ToLowerInvariant()}), map {runtime.Match.MapNumber} round {runtime.Match.RoundNumber}{(runtime.Match.Live ? ", live" : "")}"
            : "match: none");
        lines.AppendLine($"mode: {runtime.Mode?.Id ?? "none attached"}");
        lines.AppendLine($"plugins enabled: {(input.Loader.Enabled.Count == 0 ? "none" : string.Join(", ", input.Loader.Enabled))}");
        lines.Append($"plugins installed: {string.Join(", ", input.Catalog.Installed)}");
        return lines.ToString();
    }
}
