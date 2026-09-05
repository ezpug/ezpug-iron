using EZPug.Sdk;

namespace EZPug.Core;

/// <summary>
/// Where things are, derived from the one path CounterStrikeSharp hands a plugin — its
/// own folder, <c>…/game/csgo/addons/counterstrikesharp/plugins/EZPug.Core</c>. Nothing
/// here is configured: the layout is CounterStrikeSharp's, and <c>plugins/README.md</c>
/// draws it.
/// </summary>
public sealed class ServerPaths
{
    public ServerPaths(string moduleDirectory)
    {
        ModuleDirectory = Path.GetFullPath(moduleDirectory);
        CounterStrikeSharpRoot = Path.GetFullPath(Path.Combine(ModuleDirectory, "..", ".."));
        CsgoDirectory = Path.GetFullPath(Path.Combine(CounterStrikeSharpRoot, "..", ".."));
    }

    /// <summary>The core plugin's own folder.</summary>
    public string ModuleDirectory { get; }

    /// <summary><c>addons/counterstrikesharp</c> — what <c>css_plugins</c> paths are relative to.</summary>
    public string CounterStrikeSharpRoot { get; }

    /// <summary><c>addons/counterstrikesharp/plugins</c>: every plugin folder, enabled ones at the top, the rest under <c>disabled/</c>.</summary>
    public string PluginsDirectory => Path.Combine(CounterStrikeSharpRoot, "plugins");

    /// <summary><c>game/csgo</c> — where <c>cfg/</c> lives, what <c>matchzy_loadmatch</c> and the backup files are relative to.</summary>
    public string CsgoDirectory { get; }

    /// <summary>The sidecar the provider plants: <c>game/csgo/ezpug.json</c> (the environment wins over it).</summary>
    public string SidecarDirectory => CsgoDirectory;

    /// <summary>The unacked-event buffer when <c>EZPUG_LINK_BUFFER_DIR</c> does not say otherwise: a subfolder of the plugin's own, which the hot-reload watcher does not look into.</summary>
    public string DefaultBufferDirectory => Path.Combine(ModuleDirectory, "link-buffer");

    public override string ToString() => $"ServerPaths {{ CounterStrikeSharpRoot = {CounterStrikeSharpRoot}, CsgoDirectory = {CsgoDirectory} }}";
}
