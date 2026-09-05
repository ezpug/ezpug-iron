using CounterStrikeSharp.API.Core.Capabilities;

namespace EZPug.Sdk.Hosting;

/// <summary>
/// <b>How a gamemode plugin finds the runtime.</b> The core plugin owns the one
/// <see cref="GamemodeRuntime"/> a server has; a gamemode ships as its own
/// CounterStrikeSharp plugin, hot-loaded by the core's loader when a manifest names it,
/// and needs a door to <c>Attach</c> its mode. This is that door, published through
/// CounterStrikeSharp's shared plugin API (<c>PluginCapability</c>). The interface lives
/// in the SDK because a capability is keyed by its type: both sides must see the same
/// <c>EZPug.Sdk</c> assembly, which is why the SDK is installed once, under
/// <c>addons/counterstrikesharp/shared/EZPug.Sdk/</c>, and never beside a plugin
/// (<c>plugins/README.md</c>).
/// </summary>
public interface IGamemodeHost
{
    /// <summary>Bind a mode to the runtime. If a match for it is already assigned, it hears <c>OnAssigned</c> at once.</summary>
    void Attach(Gamemode mode);

    /// <summary>Unbind <paramref name="mode"/> — a no-op when another mode is attached, so an old plugin unloading never evicts a new one.</summary>
    void Detach(Gamemode mode);
}

/// <summary>
/// The capability's name and the null-safe lookup. CounterStrikeSharp's
/// <c>PluginCapability.Get()</c> throws when nobody has registered the name, and
/// registers a supplier per call — so the SDK registers one supplier, once per process,
/// that answers with <see cref="Current"/>; the core plugin sets and clears it as it
/// loads and unloads (a hot reload of the core must not leave a stale host first in line).
/// </summary>
public static class GamemodeHost
{
    public const string CapabilityName = "ezpug:gamemode_host";

    public static readonly PluginCapability<IGamemodeHost> Capability = new(CapabilityName);

    private static readonly object Gate = new();
    private static bool _registered;
    private static IGamemodeHost? _current;

    /// <summary>The host a gamemode plugin attaches to, or <c>null</c> while the core plugin is not loaded.</summary>
    public static IGamemodeHost? Current
    {
        get
        {
            lock (Gate)
            {
                return _current;
            }
        }
    }

    /// <summary>The core plugin's side: make <paramref name="host"/> the one gamemode plugins find.</summary>
    public static void Publish(IGamemodeHost host)
    {
        lock (Gate)
        {
            _current = host;
            if (!_registered)
            {
                Capabilities.RegisterPluginCapability(Capability, () => Current!);
                _registered = true;
            }
        }
    }

    /// <summary>The core plugin unloading: nobody is home unless somebody else published since.</summary>
    public static void Withdraw(IGamemodeHost host)
    {
        lock (Gate)
        {
            if (ReferenceEquals(_current, host))
            {
                _current = null;
            }
        }
    }

    /// <summary>A gamemode plugin's side: the host through the capability, <c>null</c> when the core plugin is not loaded.</summary>
    public static IGamemodeHost? Find()
    {
        try
        {
            return Capability.Get();
        }
        catch (KeyNotFoundException)
        {
            return null;
        }
    }
}
