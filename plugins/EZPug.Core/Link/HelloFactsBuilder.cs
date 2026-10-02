using System.Reflection;
using CounterStrikeSharp.API;
using EZPug.Sdk;
using EZPug.Sdk.Protocol;

namespace EZPug.Core;

/// <summary>
/// What this server says about itself in <c>hello</c>: the versions as observed (the
/// plugin's own, the SDK's, CounterStrikeSharp's as its assembly declares it, MatchZy's
/// from its dll when installed), the manifest capabilities this build honours, the
/// plugin folders in the image, and the hostname the server booted with. A server that
/// can draw the HUD says <c>hud</c> as well (PRD-07 T3); one that cannot says exactly
/// what it said before there was one.
/// </summary>
public static class HelloFactsBuilder
{
    /// <summary>
    /// The capabilities this build of the plugin can honour. <c>backups</c> since PRD-02 T9
    /// (MatchZy's round backups cross the link; the restore is T14); <c>scoreboardRating</c>
    /// since T27, where the SDK's <see cref="RatingBoard"/> made it true — claiming one
    /// before it exists would be a lie the fleet console repeats.
    /// </summary>
    public static readonly IReadOnlyList<HelloCapability> Capabilities =
    [
        HelloCapability.Positions,
        HelloCapability.Chat,
        HelloCapability.PlayerCommands,
        HelloCapability.Widget,
        HelloCapability.Backups,
        HelloCapability.ScoreboardRating,
    ];

    public const string MatchZyPlugin = "MatchZy";

    /// <param name="hud">The server booted with the HUD's addon id and MultiAddonManager's loader file (<see cref="HudAddon"/>).</param>
    public static HelloFacts Build(PluginCatalog catalog, string hostname, bool hud = false) =>
        new(
            new ServerVersions
            {
                Plugin = PluginVersion,
                Sdk = SdkInfo.Version,
                CounterStrikeSharp = CounterStrikeSharpVersion,
                Matchzy = catalog.VersionOf(MatchZyPlugin),
            },
            hud ? [.. Capabilities, HelloCapability.Hud] : Capabilities,
            catalog.Installed.Take(64).ToList(),
            string.IsNullOrWhiteSpace(hostname) ? "ezpug" : hostname.Trim());

    /// <summary>The core plugin's own version, from the assembly.</summary>
    public static string PluginVersion =>
        (typeof(HelloFactsBuilder).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? typeof(HelloFactsBuilder).Assembly.GetName().Version?.ToString(3)
            ?? "0.0.0").Split('+', 2)[0];

    /// <summary>CounterStrikeSharp as the loaded assembly declares itself (<c>1.0.373</c>), the pin the SDK compiled against when the runtime does not say.</summary>
    public static string CounterStrikeSharpVersion
    {
        get
        {
            try
            {
                var declared = Api.GetVersionString().Split('+', 2)[0];
                return string.IsNullOrWhiteSpace(declared) ? SdkInfo.CounterStrikeSharpApiVersion : declared;
            }
            catch (Exception)
            {
                return SdkInfo.CounterStrikeSharpApiVersion;
            }
        }
    }
}
