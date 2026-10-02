using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace EZPug.Sdk;

/// <summary>
/// <b>Whether this server can draw a HUD at all</b> (PRD-07 T3, <c>docs/hud.md</c>): the
/// Workshop id of the addon that carries the layouts, and MultiAddonManager, the Metamod
/// plugin that hands an addon to a connecting client. Both are decided before the server
/// starts. The id is <c>EZPUG_HUD_ADDON</c> in the environment (a node's container, the
/// dev image) or <c>"hudAddon"</c> in <c>ezpug.json</c> (a Dathost clone), the environment
/// first, as for the <see cref="Sidecar"/>. MultiAddonManager loads at boot or not at
/// all, from its loader file in <c>addons/metamod/</c>, which the image's entrypoint or
/// the Dathost provider puts there only for a server that has the id.
///
/// So the answer is the id when both are there and <c>null</c> otherwise, and it does
/// not change while the process lives. A server without it says nothing about a HUD in
/// its <c>hello</c> and its <see cref="Hud"/> never reaches the world.
/// </summary>
public static partial class HudAddon
{
    public const string Variable = "EZPUG_HUD_ADDON";

    /// <summary>Where Metamod finds MultiAddonManager's loader file, from <c>game/csgo</c>. The orchestrator's <c>HUD_ADDON_LOADER_PATH</c>.</summary>
    public const string LoaderFile = "addons/metamod/multiaddonmanager.vdf";

    private sealed record FileShape([property: JsonPropertyName("hudAddon")] string? HudAddon);

    /// <summary>What a Workshop id looks like: the entrypoint's own test.</summary>
    [GeneratedRegex("^[1-9][0-9]{0,19}$")]
    private static partial Regex WorkshopId();

    /// <summary>
    /// The addon's id when this server has one and the loader file is in place;
    /// <c>null</c> otherwise. An id without the loader file is worth a line, because
    /// somebody meant the HUD to be on: <paramref name="log"/> hears it once.
    /// </summary>
    public static string? Find(IReadOnlyDictionary<string, string> environment, string sidecarDirectory, string csgoDirectory, ILinkLog? log = null)
    {
        if (IdOf(environment, Path.Combine(sidecarDirectory, Sidecar.FileName)) is not { } id)
        {
            return null;
        }

        if (!File.Exists(Path.Combine(csgoDirectory, LoaderFile)))
        {
            log?.Warn($"hud: this server has addon {id} but no {LoaderFile}, so MultiAddonManager is not loaded and no client can be handed the addon; the HUD stays off");
            return null;
        }

        return id;
    }

    /// <summary>The process environment and <c>ezpug.json</c> in <paramref name="sidecarDirectory"/>.</summary>
    public static string? FindFromProcess(string sidecarDirectory, string csgoDirectory, ILinkLog? log = null)
    {
        var environment = Environment.GetEnvironmentVariables()
            .Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(entry => (string)entry.Key, entry => (string?)entry.Value ?? "");
        return Find(environment, sidecarDirectory, csgoDirectory, log);
    }

    /// <summary>The id as the environment or the file names it; <c>null</c> when neither does, or when what they name is not a Workshop id.</summary>
    internal static string? IdOf(IReadOnlyDictionary<string, string> environment, string? filePath)
    {
        if (environment.TryGetValue(Variable, out var fromEnvironment) && !string.IsNullOrWhiteSpace(fromEnvironment))
        {
            return Valid(fromEnvironment);
        }

        if (filePath is null || !File.Exists(filePath))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<FileShape>(File.ReadAllText(filePath))?.HudAddon is { } fromFile ? Valid(fromFile) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? Valid(string id) => WorkshopId().IsMatch(id.Trim()) ? id.Trim() : null;
}
