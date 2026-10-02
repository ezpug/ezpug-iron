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
        GamemodeLoader Loader,
        // The layouts of ours in the world, read back off the entities; only a server
        // that can draw a HUD is asked for them.
        IReadOnlyList<HudLayoutReading>? HudLayouts = null);

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
        // Read back off the controllers, not off what was asked for: this line is how a
        // real server proves EZ Rating reached the scoreboard (PRD-02 T27).
        lines.AppendLine($"scoreboard: {Ratings(runtime)}");
        // Only on a server that can draw one: without the addon this report is what it
        // was before the HUD existed (decision 34).
        if (runtime.Hud.Addon is { } addon)
        {
            lines.AppendLine($"hud: addon {addon}, {(runtime.Hud.On ? $"on, {runtime.Hud.Layouts.Count} layout(s) {(runtime.Hud.Spawned ? "in the world" : "waiting for a round start")}" : "off for this match")}");
            // Read back, both of them: MultiAddonManager's own list and the entities
            // (PRD-07 T9). What the line above says is what the SDK believes.
            lines.AppendLine(runtime.Hud.Handed switch
            {
                null => $"hud: {Hud.ClientAddons} does not answer, so what clients are handed is not known",
                "" => "hud: clients who connect now are handed no addon",
                var handed => $"hud: clients who connect now are handed {handed}",
            });
            foreach (var line in HudReadback.Render(input.HudLayouts ?? []))
            {
                lines.AppendLine(line);
            }
        }

        lines.AppendLine($"plugins enabled: {(input.Loader.Enabled.Count == 0 ? "none" : string.Join(", ", input.Loader.Enabled))}");
        lines.Append($"plugins installed: {string.Join(", ", input.Catalog.Installed)}");
        return lines.ToString();
    }

    /// <summary>EZ Rating as the engine holds it right now, per player, or why nothing is drawn.</summary>
    private static string Ratings(GamemodeRuntime runtime)
    {
        if (!runtime.Ratings.Active)
        {
            return runtime.Assignment is null ? "no match" : "not asked for by this gamemode";
        }

        var shown = runtime.World.Players
            .Where(player => player.ScoreboardRating is not null)
            .Select(player => $"{player.Name} {player.ScoreboardRating}")
            .ToList();
        return shown.Count == 0 ? "nobody rated yet" : $"{shown.Count} rated: {string.Join(", ", shown)}";
    }
}
