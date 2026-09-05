using CounterStrikeSharp.API.Core;
using Microsoft.Extensions.Logging;

namespace EZPug.Sdk.Hosting;

/// <summary>
/// <b>A gamemode's CounterStrikeSharp shell, written once.</b> A mode is a
/// <see cref="Gamemode"/> and a manifest; to reach a server it also needs to be a
/// CounterStrikeSharp plugin in its own folder, and this base is that plugin: it finds the
/// core's <see cref="IGamemodeHost"/> when it loads (or when every plugin has loaded, if
/// the core came later) and attaches the mode; it detaches on unload. The mode itself
/// never sees a CounterStrikeSharp type. <c>docs/sdk.md</c> shows the five lines.
/// </summary>
public abstract class GamemodePlugin : BasePlugin
{
    private Gamemode? _mode;

    /// <summary>The mode this plugin carries. Built once, on load.</summary>
    protected abstract Gamemode CreateMode();

    /// <summary>The mode, after <see cref="Load"/>.</summary>
    protected Gamemode Mode => _mode ?? throw new InvalidOperationException("the plugin has not loaded");

    public override void Load(bool hotReload)
    {
        _mode = CreateMode();
        TryAttach();
    }

    public override void OnAllPluginsLoaded(bool hotReload)
    {
        if (!Attached)
        {
            TryAttach();
        }
    }

    public override void Unload(bool hotReload)
    {
        if (_mode is { } mode)
        {
            GamemodeHost.Current?.Detach(mode);
        }

        Attached = false;
    }

    /// <summary>Whether the mode is bound to a runtime.</summary>
    public bool Attached { get; private set; }

    private void TryAttach()
    {
        if (_mode is null)
        {
            return;
        }

        var host = GamemodeHost.Find();
        if (host is null)
        {
            Logger.LogWarning("{Mode}: EZPug.Core is not loaded; the mode waits for it", _mode.Id);
            return;
        }

        host.Attach(_mode);
        Attached = true;
        Logger.LogInformation("{Mode}: attached to the EZPug runtime", _mode.Id);
    }
}
