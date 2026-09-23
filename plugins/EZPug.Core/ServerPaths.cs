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
        EngineWriteDirectory = WriteDirectoryOf(CsgoDirectory);
    }

    /// <summary>The core plugin's own folder.</summary>
    public string ModuleDirectory { get; }

    /// <summary><c>addons/counterstrikesharp</c> — what <c>css_plugins</c> paths are relative to.</summary>
    public string CounterStrikeSharpRoot { get; }

    /// <summary><c>addons/counterstrikesharp/plugins</c>: every plugin folder, enabled ones at the top, the rest under <c>disabled/</c>.</summary>
    public string PluginsDirectory => Path.Combine(CounterStrikeSharpRoot, "plugins");

    /// <summary><c>game/csgo</c> — where <c>cfg/</c> lives, what <c>matchzy_loadmatch</c> and the backup files are relative to.</summary>
    public string CsgoDirectory { get; }

    /// <summary>
    /// <b>Where the engine writes a relative path</b> — its <c>DEFAULT_WRITE_PATH</c>, which
    /// is the first <c>Game</c> search path in <c>gameinfo.gi</c>. With Metamod installed
    /// that is <c>csgo/addons/metamod</c>, because its loader line goes first, and CS2 builds
    /// newer than 1.41.7.8 (Dathost's, 2026-09-23) resolve <c>tv_record</c> against it
    /// rather than against <c>game/csgo</c>. A <c>tv_record MatchZy/…</c> then needs a <c>MatchZy/</c> folder
    /// here, and the engine never creates one (PRD-04 T11, measured on Dathost). Falls back
    /// to <see cref="CsgoDirectory"/> when <c>gameinfo.gi</c> cannot be read or names no
    /// <c>Game</c> path.
    /// </summary>
    public string EngineWriteDirectory { get; }

    /// <summary>The sidecar the provider plants: <c>game/csgo/ezpug.json</c> (the environment wins over it).</summary>
    public string SidecarDirectory => CsgoDirectory;

    /// <summary>The unacked-event buffer when <c>EZPUG_LINK_BUFFER_DIR</c> does not say otherwise: a subfolder of the plugin's own, which the hot-reload watcher does not look into.</summary>
    public string DefaultBufferDirectory => Path.Combine(ModuleDirectory, "link-buffer");

    public override string ToString() => $"ServerPaths {{ CounterStrikeSharpRoot = {CounterStrikeSharpRoot}, CsgoDirectory = {CsgoDirectory}, EngineWriteDirectory = {EngineWriteDirectory} }}";

    /// <summary>
    /// The first <c>Game</c> entry of <c>gameinfo.gi</c>'s search paths, as a path relative
    /// to the game root (<c>csgo/addons/metamod</c>), or <c>null</c>. Only the key
    /// <c>Game</c> counts — <c>Game_LowViolence</c> and <c>Mod</c> are other lists — and a
    /// <c>//</c> comment or quotes around the value are not part of it.
    /// </summary>
    public static string? FirstGamePath(string gameInfo)
    {
        var inSearchPaths = false;
        foreach (var raw in gameInfo.Split('\n'))
        {
            var comment = raw.IndexOf("//", StringComparison.Ordinal);
            var line = (comment >= 0 ? raw[..comment] : raw).Trim();
            if (!inSearchPaths)
            {
                inSearchPaths = line.Equals("SearchPaths", StringComparison.OrdinalIgnoreCase);
                continue;
            }

            if (line == "}")
            {
                return null;
            }

            var parts = line.Split((char[])[' ', '\t'], 2, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 2 && parts[0].Trim('"').Equals("Game", StringComparison.OrdinalIgnoreCase))
            {
                return parts[1].Trim().Trim('"');
            }
        }

        return null;
    }

    private static string WriteDirectoryOf(string csgoDirectory)
    {
        try
        {
            var gameInfo = Path.Combine(csgoDirectory, "gameinfo.gi");
            if (File.Exists(gameInfo) && FirstGamePath(File.ReadAllText(gameInfo)) is { Length: > 0 } relative)
            {
                return Path.GetFullPath(Path.Combine(csgoDirectory, "..", relative));
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }

        return csgoDirectory;
    }
}
