namespace EZPug.Sdk;

/// <summary>
/// Per-player state keyed by SteamID64, created on first touch by the factory a mode
/// hands in, dropped when the player leaves (the runtime calls <see cref="Remove"/>)
/// and cleared when the match ends. A mode declares one through
/// <c>Gamemode.PlayerState&lt;T&gt;()</c> so the cleanup is wired; constructing one
/// directly works too and then the cleanup is the caller's.
/// </summary>
public sealed class PlayerState<T>
{
    private readonly Func<IGamePlayer, T> _create;
    private readonly Dictionary<ulong, T> _entries = new();

    public PlayerState(Func<IGamePlayer, T> create)
    {
        _create = create;
    }

    /// <summary>The player's entry, created now if this is the first touch.</summary>
    public T this[IGamePlayer player]
    {
        get
        {
            if (!_entries.TryGetValue(player.SteamId64, out var entry))
            {
                entry = _create(player);
                _entries[player.SteamId64] = entry;
            }

            return entry;
        }
        set => _entries[player.SteamId64] = value;
    }

    public bool TryGet(ulong steamId64, out T entry) => _entries.TryGetValue(steamId64, out entry!);

    public bool Remove(ulong steamId64) => _entries.Remove(steamId64);

    public void Clear() => _entries.Clear();

    public int Count => _entries.Count;

    public IEnumerable<KeyValuePair<ulong, T>> All => _entries;
}
