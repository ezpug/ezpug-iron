using CounterStrikeSharp.API.Core.Capabilities;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk.Hosting;

/// <summary>
/// <b>Skins over the link, no database in the open</b> (decision 20, PRD-02 T28). The
/// platform owns loadouts: a match request's roster entries carry them and a
/// <c>profile</c> push refreshes one, so the core plugin holds every loadout a match
/// knows about in its <see cref="Assignment"/>. The data-layer fork of cs2-WeaponPaints
/// (<c>plugins/vendor/WeaponPaints/</c>) reads them through this interface where upstream
/// queried MySQL — which is why the image has no database, the internet sees none, and a
/// LAN with no uplink still has skins.
///
/// Published the way <see cref="IGamemodeHost"/> is, through CounterStrikeSharp's shared
/// plugin API, and for the same reason it lives in the SDK: a capability is keyed by its
/// type, so the fork and the core must see the one <c>EZPug.Sdk</c> assembly installed
/// under <c>addons/counterstrikesharp/shared/</c> (<c>plugins/README.md</c>).
///
/// Everything here happens on the game thread: the runtime pumps a <c>profile</c> frame on
/// the engine's tick before <see cref="LoadoutChanged"/> is raised, and a caller asks
/// <see cref="LoadoutOf"/> from a connect hook or a chat command. A loadout is a value the
/// skins layer copies into its own tables; nothing is shared afterwards.
/// </summary>
public interface ILoadoutSource
{
    /// <summary>
    /// The loadout the roster or the latest <c>profile</c> push carries for a player, or
    /// <c>null</c> when nobody knows them, their profile has none, or no match is assigned.
    /// Absence means default items, exactly as an absent row did in the fork's database
    /// (the platform's Skins.md: "defaults are absence").
    /// </summary>
    Loadout? LoadoutOf(ulong steamId64);

    /// <summary>
    /// A <c>profile</c> arrived for a player — somebody who joined open, or a refresh of a
    /// rostered player's. Whoever applies skins re-reads theirs through <see cref="LoadoutOf"/>;
    /// the profile may or may not carry a loadout, and the read is what says which.
    /// </summary>
    event Action<ulong>? LoadoutChanged;
}

/// <summary>
/// The capability's name and the null-safe lookup, the same shape as <see cref="GamemodeHost"/>:
/// one supplier registered once per process that answers with <see cref="Current"/>, which
/// the core plugin sets as it loads and clears as it unloads.
/// </summary>
public static class LoadoutSource
{
    public const string CapabilityName = "ezpug:loadouts";

    public static readonly PluginCapability<ILoadoutSource> Capability = new(CapabilityName);

    private static readonly object Gate = new();
    private static bool _registered;
    private static ILoadoutSource? _current;

    /// <summary>The source the skins layer reads, or <c>null</c> while the core plugin is not loaded.</summary>
    public static ILoadoutSource? Current
    {
        get
        {
            lock (Gate)
            {
                return _current;
            }
        }
    }

    /// <summary>The core plugin's side: make <paramref name="source"/> the one the skins layer finds.</summary>
    public static void Publish(ILoadoutSource source)
    {
        lock (Gate)
        {
            _current = source;
            if (!_registered)
            {
                Capabilities.RegisterPluginCapability(Capability, () => Current!);
                _registered = true;
            }
        }
    }

    /// <summary>The core plugin unloading: nobody is home unless somebody else published since.</summary>
    public static void Withdraw(ILoadoutSource source)
    {
        lock (Gate)
        {
            if (ReferenceEquals(_current, source))
            {
                _current = null;
            }
        }
    }

    /// <summary>The skins layer's side: the source through the capability, <c>null</c> when the core plugin is not loaded.</summary>
    public static ILoadoutSource? Find()
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
