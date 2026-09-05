using System.Reflection;

namespace EZPug.Core;

/// <summary>One plugin folder in the image, whether or not it is enabled.</summary>
/// <param name="Name">The folder name — what a manifest's <c>plugins</c> lists.</param>
/// <param name="RelativeDllPath">The dll relative to <c>addons/counterstrikesharp</c> with forward slashes (<c>plugins/disabled/MatchZy/MatchZy.dll</c>): the one form both <c>css_plugins load</c> and <c>unload</c> accept.</param>
/// <param name="DllPath">The dll on disk.</param>
public sealed record InstalledPlugin(string Name, string RelativeDllPath, string DllPath);

/// <summary>
/// <b>What the image holds.</b> CounterStrikeSharp auto-loads every folder under
/// <c>plugins/</c> at boot and skips <c>plugins/disabled/</c> — so the core plugin sits
/// at the top and every gamemode plugin (MatchZy, retakes, the SDK modes, the skins
/// layer) sits under <c>disabled/</c>, enabled by the loader exactly when a manifest
/// names it (decision 16). The catalog is the scan of both levels: what <c>hello</c>
/// reports as installed, and the path the loader hands <c>css_plugins</c>.
/// </summary>
public sealed class PluginCatalog
{
    public const string DisabledFolder = "disabled";

    private readonly Dictionary<string, InstalledPlugin> _byName;

    private PluginCatalog(IReadOnlyList<InstalledPlugin> plugins)
    {
        Plugins = plugins;
        _byName = plugins.ToDictionary(plugin => plugin.Name, StringComparer.Ordinal);
    }

    /// <summary>Every plugin folder that holds a <c>&lt;Name&gt;/&lt;Name&gt;.dll</c>, enabled ones first, then <c>disabled/</c>, each level in name order.</summary>
    public IReadOnlyList<InstalledPlugin> Plugins { get; }

    /// <summary>The folder names, what <c>hello.plugins</c> carries.</summary>
    public IReadOnlyList<string> Installed => Plugins.Select(plugin => plugin.Name).ToList();

    public InstalledPlugin? Find(string name) => _byName.GetValueOrDefault(name);

    /// <summary>The assembly version a plugin's dll declares, three parts, or <c>null</c> when it is not installed or not readable. Read from the file's manifest without loading it.</summary>
    public string? VersionOf(string name)
    {
        if (Find(name) is not { } plugin)
        {
            return null;
        }

        try
        {
            var version = AssemblyName.GetAssemblyName(plugin.DllPath).Version;
            return version is null ? null : $"{version.Major}.{version.Minor}.{version.Build}";
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Scan <paramref name="pluginsDirectory"/> (<c>addons/counterstrikesharp/plugins</c>). A missing directory is an empty catalog, not an error.</summary>
    public static PluginCatalog Scan(string pluginsDirectory)
    {
        var plugins = new List<InstalledPlugin>();
        if (!Directory.Exists(pluginsDirectory))
        {
            return new PluginCatalog(plugins);
        }

        var root = Path.GetFullPath(Path.Combine(pluginsDirectory, ".."));
        var top = Directory.GetDirectories(pluginsDirectory).OrderBy(Path.GetFileName, StringComparer.Ordinal).ToList();
        foreach (var directory in top.Where(directory => !IsDisabledFolder(directory)))
        {
            Add(plugins, root, directory);
        }

        var disabled = top.FirstOrDefault(IsDisabledFolder);
        if (disabled is not null)
        {
            foreach (var directory in Directory.GetDirectories(disabled).OrderBy(Path.GetFileName, StringComparer.Ordinal))
            {
                Add(plugins, root, directory);
            }
        }

        return new PluginCatalog(plugins);
    }

    private static bool IsDisabledFolder(string directory) =>
        string.Equals(Path.GetFileName(directory), DisabledFolder, StringComparison.OrdinalIgnoreCase);

    private static void Add(List<InstalledPlugin> plugins, string root, string directory)
    {
        var name = Path.GetFileName(directory);
        var dll = Path.Combine(directory, name + ".dll");
        if (!File.Exists(dll) || plugins.Any(plugin => plugin.Name == name))
        {
            return;
        }

        var relative = Path.GetRelativePath(root, dll).Replace(Path.DirectorySeparatorChar, '/');
        plugins.Add(new InstalledPlugin(name, relative, dll));
    }
}
