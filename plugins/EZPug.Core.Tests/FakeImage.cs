namespace EZPug.Core.Tests;

/// <summary>
/// A server image on disk, as CounterStrikeSharp lays it out: <c>game/csgo/addons/counterstrikesharp/plugins/…</c>
/// under a temp directory, with a plugin folder per name — the core at the top, the
/// rest under <c>disabled/</c>. A "dll" is the SDK's own assembly copied in under the
/// plugin's name, so the catalog reads a real assembly version off it.
/// </summary>
internal sealed class FakeImage : IDisposable
{
    public FakeImage()
    {
        Root = Path.Combine(Path.GetTempPath(), "ezpug-core-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(PluginsDirectory);
    }

    public string Root { get; }
    public string CsgoDirectory => Path.Combine(Root, "game", "csgo");
    public string CounterStrikeSharpRoot => Path.Combine(CsgoDirectory, "addons", "counterstrikesharp");
    public string PluginsDirectory => Path.Combine(CounterStrikeSharpRoot, "plugins");
    public string ModuleDirectory => Path.Combine(PluginsDirectory, "EZPug.Core");

    public FakeImage With(string name, bool disabled = true, bool dll = true)
    {
        var folder = disabled ? Path.Combine(PluginsDirectory, "disabled", name) : Path.Combine(PluginsDirectory, name);
        Directory.CreateDirectory(folder);
        if (dll)
        {
            File.Copy(typeof(EZPug.Sdk.SdkInfo).Assembly.Location, Path.Combine(folder, name + ".dll"));
        }

        return this;
    }

    public PluginCatalog Catalog() => PluginCatalog.Scan(PluginsDirectory);

    public void Dispose()
    {
        try
        {
            Directory.Delete(Root, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
