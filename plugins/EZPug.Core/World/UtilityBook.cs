using System.Numerics;
using EZPug.Sdk;

namespace EZPug.Core;

/// <summary>
/// <b>What is on the map right now</b> (ezpug/ezpug-iron#5): the grenades and the bomb, kept
/// from the game's own events, for <see cref="IGameWorld.SampleGrenades"/> and
/// <see cref="IGameWorld.Bomb"/>. No CounterStrikeSharp type crosses it, so the test suite
/// plays it without the game. <see cref="UtilityTracker"/> feeds it.
///
/// <para>Why events and not the entity listeners: on the dev node (CounterStrikeSharp
/// 1.0.373, 2026-09-25) <c>OnEntitySpawned</c> never fired for this plugin, through two
/// puppeted matches of thrown smokes, HEs and flashes and four plants, while the game events
/// registered beside it all arrived. Every state change here has an event with a position:
/// <c>smokegrenade_detonate</c> and <c>_expired</c>, <c>inferno_startburn</c> and
/// <c>_expire</c>, the detonates, and <c>bomb_pickup</c>, <c>_dropped</c> and
/// <c>_planted</c>. Only a grenade in the air needs its entity read, and it is found once
/// per throw, not searched for on every sample.</para>
///
/// <para>Entities are keyed by their handle (index and serial number), so an index the
/// engine reuses is a new grenade, and one that has gone off is never taken up again by a
/// later search while its entity lingers.</para>
/// </summary>
internal sealed class UtilityBook
{
    /// <summary>CS2's smoke cloud reaches about this far from its centre, in world units.</summary>
    public const float SmokeRadius = 144f;

    /// <summary>How far a fire reaches when nothing better is known yet, in world units: a molotov's first spread.</summary>
    public const float FireRadius = 120f;

    /// <summary>How soon after its projectile lands a fire still counts as that grenade's. The engine swaps the two within a frame.</summary>
    public const long FireHandoverMs = 2_000;

    /// <summary>How far from where its projectile was last seen a fire may start and still be that grenade's, in world units.</summary>
    public const float FireHandoverReach = 400f;

    /// <summary>How long a thrown molotov or incendiary waits for its fire before it is forgotten. A long throw flies about three seconds.</summary>
    public const long ThrownFireMs = 10_000;

    private readonly Func<long> _nowMs;
    private readonly Dictionary<uint, Grenade> _grenades = new();
    private readonly List<Landed> _landed = [];
    private readonly Queue<Thrown> _thrownFires = new();
    private readonly List<GrenadeSighting> _pops = [];
    /// <summary>Handles that have gone off or cleared and may still linger as entities; a search never takes them up again.</summary>
    private readonly HashSet<uint> _retired = [];
    private long _anonymous;
    private BombSighting? _bomb;

    public UtilityBook(Func<long> nowMs) => _nowMs = nowMs;

    /// <summary>A grenade is being followed.</summary>
    private sealed class Grenade(string id, GrenadeKind kind, IGamePlayer? thrower, uint index)
    {
        public string Id { get; } = id;
        public GrenadeKind Kind { get; set; } = kind;
        public IGamePlayer? Thrower { get; set; } = thrower;
        /// <summary>The entity index to read a flying grenade or a fire off.</summary>
        public uint Index { get; } = index;
        public GrenadeState State { get; set; } = GrenadeState.Flying;
        public Vector3 Position { get; set; }
        public float? Radius { get; set; }
        public bool IsFire => Kind is GrenadeKind.Molotov or GrenadeKind.Incendiary;
    }

    private sealed record Landed(string Id, GrenadeKind Kind, IGamePlayer? Thrower, Vector3 Position, long AtMs);

    private sealed record Thrown(GrenadeKind Kind, IGamePlayer? Thrower, long AtMs);

    /// <summary>Set by a throw: the next sample should look for the new projectile once.</summary>
    public bool SearchDue { get; private set; }

    /// <summary>Set at a round's start and by a pick-up nobody announced: the next bomb reading should look for it once.</summary>
    public bool BombSearchDue { get; private set; } = true;

    /// <summary>A flying grenade or a burning fire whose entity the tracker reads on every sample.</summary>
    public readonly record struct Followed(uint Key, uint Index, bool Fire);

    public IReadOnlyList<Followed> Following() =>
        _grenades
            .Where(entry => entry.Value.State == GrenadeState.Flying || entry.Value.IsFire)
            .Select(entry => new Followed(entry.Key, entry.Value.Index, entry.Value.IsFire && entry.Value.State == GrenadeState.Active))
            .ToList();

    /// <summary>Whether a search should leave this handle alone: it is followed already, or it has gone off.</summary>
    public bool Knows(uint key) => _grenades.ContainsKey(key) || _retired.Contains(key);

    // ---------------------------------------------------------------- grenades

    /// <summary><c>grenade_thrown</c>: a search is due, and a fire remembers who threw it.</summary>
    public void Threw(GrenadeKind kind, IGamePlayer? thrower)
    {
        SearchDue = true;
        if (kind is GrenadeKind.Molotov or GrenadeKind.Incendiary)
        {
            _thrownFires.Enqueue(new Thrown(kind, thrower, _nowMs()));
        }
    }

    /// <summary>The search after a throw ran.</summary>
    public void Searched() => SearchDue = false;

    /// <summary>A projectile the search found, or a flying one read again.</summary>
    public void Flying(uint key, uint index, GrenadeKind kind, IGamePlayer? thrower, Vector3 at)
    {
        if (_retired.Contains(key))
        {
            return;
        }

        if (!_grenades.TryGetValue(key, out var grenade))
        {
            grenade = new Grenade(key.ToString(), kind, thrower, index);
            _grenades[key] = grenade;
        }

        grenade.Kind = kind;
        grenade.Thrower ??= thrower;
        grenade.Position = at;
    }

    /// <summary>A followed projectile's entity is gone without an event: a molotov that landed, or one the engine freed.</summary>
    public void Vanished(uint key)
    {
        if (!_grenades.Remove(key, out var grenade))
        {
            return;
        }

        if (grenade.IsFire && grenade.State == GrenadeState.Flying)
        {
            _landed.Add(new Landed(grenade.Id, grenade.Kind, grenade.Thrower, grenade.Position, _nowMs()));
        }
    }

    /// <summary><c>smokegrenade_detonate</c>: a smoke stands here until it clears.</summary>
    public void Bloomed(uint? key, uint index, Vector3 at, IGamePlayer? thrower)
    {
        var grenade = key is { } k && _grenades.TryGetValue(k, out var known)
            ? known
            : Adopt(key, index, GrenadeKind.Smoke, thrower);
        grenade.Thrower ??= thrower;
        grenade.State = GrenadeState.Active;
        grenade.Position = at;
        grenade.Radius = SmokeRadius;
    }

    /// <summary><c>smokegrenade_expired</c> or <c>inferno_expire</c>: gone from the next tick.</summary>
    public void Cleared(uint? key)
    {
        if (key is not { } k)
        {
            return;
        }

        _grenades.Remove(k);
        _retired.Add(k);
    }

    /// <summary>
    /// <c>inferno_startburn</c>: a fire. It keeps the id, kind and thrower of the molotov or
    /// incendiary that landed nearest it just now; else the oldest one thrown and not yet
    /// burning names its kind and thrower.
    /// </summary>
    public void Burning(uint? key, uint index, Vector3 at)
    {
        var now = _nowMs();
        _landed.RemoveAll(landed => now - landed.AtMs > FireHandoverMs);
        while (_thrownFires.TryPeek(out var stale) && now - stale.AtMs > ThrownFireMs)
        {
            _thrownFires.Dequeue();
        }

        // Nearest first: a projectile noticed gone, or one still flying in the frame it lands.
        Landed? handover = _landed
            .Concat(_grenades.Values
                .Where(grenade => grenade.IsFire && grenade.State == GrenadeState.Flying)
                .Select(grenade => new Landed(grenade.Id, grenade.Kind, grenade.Thrower, grenade.Position, now)))
            .Where(landed => Vector3.Distance(landed.Position, at) <= FireHandoverReach)
            .OrderBy(landed => Vector3.Distance(landed.Position, at))
            .FirstOrDefault();

        Grenade fire;
        if (handover is not null)
        {
            _landed.RemoveAll(landed => landed.Id == handover.Id);
            foreach (var flying in _grenades.Where(entry => entry.Value.Id == handover.Id).Select(entry => entry.Key).ToList())
            {
                _grenades.Remove(flying);
                _retired.Add(flying);
            }

            DropThrown(handover.Kind, handover.Thrower);
            fire = new Grenade(handover.Id, handover.Kind, handover.Thrower, index);
            if (key is { } k)
            {
                _grenades[k] = fire;
            }
            else
            {
                _grenades[Synthetic()] = fire;
            }
        }
        else
        {
            var thrown = _thrownFires.TryDequeue(out var oldest) ? oldest : null;
            fire = Adopt(key, index, thrown?.Kind ?? GrenadeKind.Molotov, thrown?.Thrower);
        }

        fire.State = GrenadeState.Active;
        fire.Position = at;
        fire.Radius ??= FireRadius;
    }

    /// <summary>A burning fire read again: the centre of its flames and how far the furthest reaches.</summary>
    public void Spread(uint key, Vector3 centre, float radius, GrenadeKind? kind)
    {
        if (!_grenades.TryGetValue(key, out var fire) || fire.State != GrenadeState.Active)
        {
            return;
        }

        fire.Position = centre;
        fire.Radius = radius;
        if (kind is { } known && fire.Thrower is null)
        {
            fire.Kind = known;
        }
    }

    /// <summary>A flash, an HE or a decoy went off: the next sample reports it once, where it went off, and then it is gone.</summary>
    public void Popped(uint? key, GrenadeKind kind, Vector3 at, IGamePlayer? thrower)
    {
        string id;
        if (key is { } k && _grenades.Remove(k, out var grenade))
        {
            id = grenade.Id;
            thrower ??= grenade.Thrower;
        }
        else
        {
            id = key?.ToString() ?? $"n{++_anonymous}";
        }

        if (key is { } retired)
        {
            _retired.Add(retired);
        }

        _pops.Add(new GrenadeSighting(id, kind, at, GrenadeState.Active, null, thrower));
    }

    /// <summary>
    /// A new round, or a new map: the engine removes every grenade without an event, so
    /// the book forgets them, and the bomb is looked for again.
    /// </summary>
    public void Reset()
    {
        _grenades.Clear();
        _landed.Clear();
        _thrownFires.Clear();
        _pops.Clear();
        _retired.Clear();
        SearchDue = false;
        _bomb = null;
        BombSearchDue = true;
    }

    /// <summary>Everything flying or active now, and each pop since the last call once.</summary>
    public IReadOnlyList<GrenadeSighting> Sample()
    {
        var sample = _grenades.Values
            .Select(grenade => new GrenadeSighting(
                grenade.Id,
                grenade.Kind,
                grenade.Position,
                grenade.State,
                grenade.State == GrenadeState.Active ? grenade.Radius : null,
                grenade.Thrower))
            .Concat(_pops)
            .ToList();
        _pops.Clear();
        return sample;
    }

    private Grenade Adopt(uint? key, uint index, GrenadeKind kind, IGamePlayer? thrower)
    {
        var grenade = new Grenade(key?.ToString() ?? $"n{++_anonymous}", kind, thrower, index);
        _grenades[key ?? Synthetic()] = grenade;
        return grenade;
    }

    /// <summary>A key for a grenade whose entity could not be read, from the top of the range, which a handle never reaches.</summary>
    private uint Synthetic() => uint.MaxValue - (uint)(++_anonymous);

    /// <summary>The fire burning now was this thrower's oldest of that kind in the air, so it waits for no other.</summary>
    private void DropThrown(GrenadeKind kind, IGamePlayer? thrower)
    {
        var dropped = false;
        var kept = new List<Thrown>(_thrownFires.Count);
        foreach (var thrown in _thrownFires)
        {
            if (!dropped && thrown.Kind == kind && thrown.Thrower == thrower)
            {
                dropped = true;
                continue;
            }

            kept.Add(thrown);
        }

        _thrownFires.Clear();
        foreach (var thrown in kept)
        {
            _thrownFires.Enqueue(thrown);
        }
    }

    // ---------------------------------------------------------------- the bomb

    /// <summary><c>bomb_pickup</c>, or a search that found it on somebody.</summary>
    public void BombCarried(IGamePlayer carrier)
    {
        BombSearchDue = false;
        _bomb = new BombSighting(BombState.Carried, carrier.Position ?? _bomb?.Position ?? Vector3.Zero, carrier);
    }

    /// <summary><c>bomb_dropped</c>, a search that found it on the floor, or a dropped bomb read again while it falls.</summary>
    public void BombDropped(Vector3 at)
    {
        BombSearchDue = false;
        _bomb = new BombSighting(BombState.Dropped, at);
    }

    /// <summary><c>bomb_planted</c>: in its site until it goes off or is defused.</summary>
    public void BombPlanted(Vector3 at, BombSiteName site)
    {
        BombSearchDue = false;
        _bomb = new BombSighting(BombState.Planted, at, Site: site);
    }

    /// <summary><c>bomb_exploded</c> or <c>bomb_defused</c>: no bomb in play until the next round.</summary>
    public void BombGone() => _bomb = null;

    /// <summary>Freeze time is over and no event said where the bomb is: look for it once more.</summary>
    public void LookForBomb()
    {
        if (_bomb is null)
        {
            BombSearchDue = true;
        }
    }

    /// <summary>The search found no bomb: this round has none, and nothing looks again until an event says otherwise.</summary>
    public void BombSearched() => BombSearchDue = false;

    /// <summary>Where the bomb is now. A carried one stands where its carrier stands.</summary>
    public BombSighting? Bomb()
    {
        if (_bomb is { State: BombState.Carried, Carrier: { } carrier })
        {
            if (!carrier.IsAlive)
            {
                // Dead with the bomb and no bomb_dropped yet: it lies where they fell.
                return new BombSighting(BombState.Dropped, carrier.Position ?? _bomb.Position);
            }

            if (carrier.Position is { } at)
            {
                _bomb = _bomb with { Position = at };
            }
        }

        return _bomb;
    }
}
