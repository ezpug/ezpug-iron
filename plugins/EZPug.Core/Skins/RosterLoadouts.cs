using System.Text;
using EZPug.Sdk;
using EZPug.Sdk.Hosting;
using EZPug.Sdk.Protocol;

namespace EZPug.Core;

/// <summary>
/// <b>The loadouts a match carries, handed to the skins layer</b> (decision 20, PRD-02 T28):
/// the core plugin's <see cref="ILoadoutSource"/>, published through <see cref="LoadoutSource"/>
/// so the data-layer fork of cs2-WeaponPaints reads a player's loadout out of the
/// assignment's profiles where upstream read six MySQL tables. Nothing is copied or cached
/// here — the <see cref="Assignment"/> already holds every roster entry and every profile
/// pushed since, and a read is a lookup in it. When no match is assigned there is nothing
/// to hand out, and the answer is <c>null</c>: default items, never an error (the
/// platform's Skins.md: skins may never touch match flow).
///
/// Every hand-off is a console line, because it is the one place the hand-off can be seen
/// without a client: a bot never gets dressed (upstream applies nothing to a bot, and this
/// repo does not patch that), so on a bots run the line in the fleet console is the proof
/// that the loadout crossed the seam.
/// </summary>
public sealed class RosterLoadouts : ILoadoutSource, IDisposable
{
    private readonly GamemodeRuntime _runtime;
    private readonly ILinkLog _log;

    public RosterLoadouts(GamemodeRuntime runtime, ILinkLog log)
    {
        _runtime = runtime;
        _log = log;
        runtime.Profiled += OnProfiled;
    }

    public event Action<ulong>? LoadoutChanged;

    public Loadout? LoadoutOf(ulong steamId64)
    {
        var loadout = _runtime.Assignment?.ProfileOf(steamId64)?.Loadout;
        _log.Info(loadout is null
            ? $"skins: no loadout for {steamId64}; default items"
            : $"skins: handed {steamId64}'s loadout to the skins layer ({Describe(loadout)})");
        return loadout;
    }

    private void OnProfiled(RosterEntry player)
    {
        if (!ulong.TryParse(player.SteamId64, out var steamId64))
        {
            return;
        }

        _log.Info(player.Loadout is { } loadout
            ? $"skins: profile for {steamId64} carries a loadout ({Describe(loadout)}); the skins layer re-reads it"
            : $"skins: profile for {steamId64} carries no loadout; the skins layer re-reads it");
        LoadoutChanged?.Invoke(steamId64);
    }

    /// <summary>One line for a loadout — what each side holds, counted, never the values: <c>t: 1 weapon, knife, gloves, agent, music, pin; ct: 1 weapon</c>.</summary>
    public static string Describe(Loadout loadout)
    {
        var sides = new List<string>(2);
        if (loadout.T is { } t)
        {
            sides.Add("t: " + DescribeSide(t));
        }

        if (loadout.Ct is { } ct)
        {
            sides.Add("ct: " + DescribeSide(ct));
        }

        return sides.Count == 0 ? "empty" : string.Join("; ", sides);
    }

    private static string DescribeSide(SideLoadout side)
    {
        var parts = new StringBuilder();
        parts.Append(side.Weapons.Count).Append(side.Weapons.Count == 1 ? " weapon" : " weapons");
        if (side.Knife is { Length: > 0 })
        {
            parts.Append(", knife");
        }

        if (side.Gloves is not null)
        {
            parts.Append(", gloves");
        }

        if (side.Agent is { Length: > 0 })
        {
            parts.Append(", agent");
        }

        if (side.Music is not null)
        {
            parts.Append(", music");
        }

        if (side.Pin is not null)
        {
            parts.Append(", pin");
        }

        return parts.ToString();
    }

    public void Dispose() => _runtime.Profiled -= OnProfiled;
}
