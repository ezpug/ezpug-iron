using System.Numerics;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using EZPug.Sdk;

namespace EZPug.Core;

/// <summary>
/// <b>The utility layer's eyes</b> (ezpug/ezpug-iron#5): the game's events and a few entity
/// reads, turned into <see cref="UtilityBook"/> calls, for
/// <see cref="IGameWorld.SampleGrenades"/> and <see cref="IGameWorld.Bomb"/>. The book
/// holds the state and says why it is built on events rather than entity listeners.
///
/// <list type="bullet">
/// <item>a <b>throw</b> (<c>grenade_thrown</c>) makes the next sample look for new
/// projectiles once. Each one found is read by its index on every sample while it flies,
/// and a handle that no longer answers is gone;</item>
/// <item>a <b>smoke</b> blooms and clears on its two events, at the position they
/// carry;</item>
/// <item>a <b>fire</b> starts on <c>inferno_startburn</c>, and while it burns its entity is
/// read for the centre of its burning flames and the furthest one, until
/// <c>inferno_expire</c>;</item>
/// <item>a <b>flash</b> and an <b>HE</b> pop on their detonate, a <b>decoy</b> on
/// <c>decoy_started</c>, when it lands and starts firing;</item>
/// <item>the <b>bomb</b> follows <c>bomb_pickup</c>, <c>_dropped</c>, <c>_planted</c>,
/// <c>_exploded</c> and <c>_defused</c>. At a round's start it is looked for once, since the
/// engine hands it out without saying so.</item>
/// </list>
/// </summary>
internal sealed class UtilityTracker
{
    /// <summary>How far one flame of a fire reaches past its own point, in world units, which is added to the furthest flame.</summary>
    public const float FlameRadius = 30f;

    private static readonly Dictionary<string, GrenadeKind> Projectiles = new()
    {
        ["smokegrenade_projectile"] = GrenadeKind.Smoke,
        ["flashbang_projectile"] = GrenadeKind.Flash,
        ["hegrenade_projectile"] = GrenadeKind.He,
        ["decoy_projectile"] = GrenadeKind.Decoy,
        ["molotov_projectile"] = GrenadeKind.Molotov,
    };

    private readonly Func<CCSPlayerController?, IGamePlayer?> _known;
    private readonly ILinkLog _log;
    private readonly UtilityBook _book;
    /// <summary>What went wrong once already, so a broken read is one line in the log and not one per sample.</summary>
    private readonly HashSet<string> _said = [];
    private uint? _droppedBomb;

    public UtilityTracker(IClock clock, ILinkLog log, Func<CCSPlayerController?, IGamePlayer?> known)
    {
        _log = log;
        _known = known;
        _book = new UtilityBook(() => clock.NowMs);
    }

    public void Install(BasePlugin plugin)
    {
        plugin.RegisterListener<Listeners.OnMapStart>(_ => Reset());
        plugin.RegisterEventHandler<EventRoundPrestart>((_, _) => { Reset(); return HookResult.Continue; });
        plugin.RegisterEventHandler<EventRoundFreezeEnd>((_, _) =>
        {
            // Nobody announced a pick-up: the carrier was handed it at spawn. Look once more.
            _book.LookForBomb();
            return HookResult.Continue;
        });

        plugin.RegisterEventHandler<EventGrenadeThrown>((gameEvent, _) =>
        {
            if (KindOfWeapon(gameEvent.Weapon) is { } kind)
            {
                _book.Threw(kind, _known(gameEvent.Userid));
            }

            return HookResult.Continue;
        });
        plugin.RegisterEventHandler<EventSmokegrenadeDetonate>((gameEvent, _) =>
        {
            _book.Bloomed(Key(gameEvent.Entityid), (uint)gameEvent.Entityid, new Vector3(gameEvent.X, gameEvent.Y, gameEvent.Z), _known(gameEvent.Userid));
            return HookResult.Continue;
        });
        plugin.RegisterEventHandler<EventSmokegrenadeExpired>((gameEvent, _) => { _book.Cleared(Key(gameEvent.Entityid)); return HookResult.Continue; });
        plugin.RegisterEventHandler<EventInfernoStartburn>((gameEvent, _) =>
        {
            _book.Burning(Key(gameEvent.Entityid), (uint)gameEvent.Entityid, new Vector3(gameEvent.X, gameEvent.Y, gameEvent.Z));
            return HookResult.Continue;
        });
        plugin.RegisterEventHandler<EventInfernoExpire>((gameEvent, _) => { _book.Cleared(Key(gameEvent.Entityid)); return HookResult.Continue; });
        plugin.RegisterEventHandler<EventFlashbangDetonate>((gameEvent, _) =>
            Popped(gameEvent.Entityid, GrenadeKind.Flash, gameEvent.X, gameEvent.Y, gameEvent.Z, gameEvent.Userid));
        plugin.RegisterEventHandler<EventHegrenadeDetonate>((gameEvent, _) =>
            Popped(gameEvent.Entityid, GrenadeKind.He, gameEvent.X, gameEvent.Y, gameEvent.Z, gameEvent.Userid));
        plugin.RegisterEventHandler<EventDecoyStarted>((gameEvent, _) =>
            Popped(gameEvent.Entityid, GrenadeKind.Decoy, gameEvent.X, gameEvent.Y, gameEvent.Z, gameEvent.Userid));

        plugin.RegisterEventHandler<EventBombPickup>((gameEvent, _) =>
        {
            if (_known(gameEvent.Userid) is { } carrier)
            {
                _droppedBomb = null;
                _book.BombCarried(carrier);
            }

            return HookResult.Continue;
        });
        plugin.RegisterEventHandler<EventBombDropped>((gameEvent, _) =>
        {
            _droppedBomb = (uint)gameEvent.Entindex;
            var at = Origin((int)gameEvent.Entindex) ?? _known(gameEvent.Userid)?.Position ?? Vector3.Zero;
            _book.BombDropped(at);
            return HookResult.Continue;
        });
        plugin.RegisterEventHandler<EventBombPlanted>((gameEvent, _) =>
        {
            _droppedBomb = null;
            var planted = Planted();
            // The event's `site` is not the 0/1 the entity's `m_nBombSite` is (every
            // bomb_planted on the dev node came out without one), so the entity's word wins.
            var site = planted?.Site is { } known and not BombSiteName.Unknown ? known : CounterStrikeWorld.SiteOf(gameEvent.Site);
            _book.BombPlanted(planted?.At ?? _known(gameEvent.Userid)?.Position ?? Vector3.Zero, site);
            return HookResult.Continue;
        });
        plugin.RegisterEventHandler<EventBombExploded>((_, _) => { _book.BombGone(); return HookResult.Continue; });
        plugin.RegisterEventHandler<EventBombDefused>((_, _) => { _book.BombGone(); return HookResult.Continue; });
    }

    private void Reset()
    {
        _droppedBomb = null;
        _book.Reset();
    }

    /// <summary>Everything flying or active now, and each pop since the last call once. Game thread only.</summary>
    public IReadOnlyList<GrenadeSighting> Sample()
    {
        if (_book.SearchDue)
        {
            _book.Searched();
            Guard("the search for projectiles", Search);
        }

        foreach (var followed in _book.Following())
        {
            Guard(followed.Fire ? "inferno" : "a projectile", () => Read(followed));
        }

        return _book.Sample();
    }

    /// <summary>Where the bomb is now. Game thread only.</summary>
    public BombSighting? Bomb()
    {
        if (_book.BombSearchDue)
        {
            _book.BombSearched();
            Guard("the search for the bomb", SearchBomb);
        }
        else if (_droppedBomb is { } index && Origin((int)index) is { } lying)
        {
            // A dropped bomb falls and slides; follow it until somebody picks it up.
            _book.BombDropped(lying);
        }

        return _book.Bomb();
    }

    /// <summary>After a throw: every projectile on the map the book does not know yet.</summary>
    private void Search()
    {
        foreach (var entity in Utilities.GetAllEntities())
        {
            if (!Projectiles.TryGetValue(entity.DesignerName, out var kind) || entity.Entity is not { } identity)
            {
                continue;
            }

            var key = identity.EntityHandle.Raw;
            if (_book.Knows(key))
            {
                continue;
            }

            var projectile = new CBaseCSGrenadeProjectile(entity.Handle);
            if (kind == GrenadeKind.Molotov && new CMolotovProjectile(entity.Handle).IsIncGrenade)
            {
                kind = GrenadeKind.Incendiary;
            }

            if (Origin(projectile) is { } at)
            {
                _book.Flying(key, entity.Index, kind, Pawn(projectile.Thrower.Value), at);
            }
        }
    }

    /// <summary>A followed entity read again, or found gone.</summary>
    private void Read(UtilityBook.Followed followed)
    {
        var entity = Utilities.GetEntityFromIndex<CEntityInstance>((int)followed.Index);
        if (entity is not { IsValid: true } || entity.Entity?.EntityHandle.Raw != followed.Key)
        {
            if (!followed.Fire)
            {
                _book.Vanished(followed.Key);
            }

            return;
        }

        if (!followed.Fire)
        {
            if (Projectiles.TryGetValue(entity.DesignerName, out var kind) && Origin(new CBaseEntity(entity.Handle)) is { } at)
            {
                if (kind == GrenadeKind.Molotov && new CMolotovProjectile(entity.Handle).IsIncGrenade)
                {
                    kind = GrenadeKind.Incendiary;
                }

                _book.Flying(followed.Key, followed.Index, kind, null, at);
            }

            return;
        }

        var inferno = new CInferno(entity.Handle);
        var flames = new List<Vector3>();
        var count = Math.Min(inferno.FireCount, inferno.FirePositions.Length);
        for (var i = 0; i < count; i++)
        {
            if (inferno.FireIsBurning[i])
            {
                var flame = inferno.FirePositions[i];
                flames.Add(new Vector3(flame.X, flame.Y, flame.Z));
            }
        }

        if (flames.Count == 0)
        {
            return;
        }

        var centre = flames.Aggregate(Vector3.Zero, (sum, flame) => sum + flame) / flames.Count;
        var reach = flames.Max(flame => Vector3.Distance(flame, centre)) + FlameRadius;
        // The engine's own word on which fire this is (INFERNO_TYPE_INCGREN_FIRE = 1), for a fire nobody was seen throwing.
        _book.Spread(followed.Key, centre, reach, inferno.InfernoType == 1 ? GrenadeKind.Incendiary : GrenadeKind.Molotov);
    }

    /// <summary>At a round's start the engine hands the bomb out without an event: find it once.</summary>
    private void SearchBomb()
    {
        foreach (var c4 in Utilities.FindAllEntitiesByDesignerName<CC4>("weapon_c4"))
        {
            if (c4 is not { IsValid: true })
            {
                continue;
            }

            if (c4.OwnerEntity.Value is { IsValid: true } owner && owner.DesignerName == "player")
            {
                if (Pawn(owner) is { } carrier)
                {
                    _book.BombCarried(carrier);
                    return;
                }
            }
            else if (Origin(c4) is { } lying)
            {
                _droppedBomb = c4.Index;
                _book.BombDropped(lying);
                return;
            }
        }
    }

    /// <summary>The bomb that stands in a site now, and which site.</summary>
    private (Vector3 At, BombSiteName Site)? Planted()
    {
        try
        {
            foreach (var planted in Utilities.FindAllEntitiesByDesignerName<CPlantedC4>("planted_c4"))
            {
                if (planted is { IsValid: true } && !planted.HasExploded && !planted.BombDefused && Origin(planted) is { } at)
                {
                    return (at, CounterStrikeWorld.SiteOf(planted.BombSite));
                }
            }

            return null;
        }
        catch (Exception error)
        {
            Say("planted_c4", error);
            return null;
        }
    }

    private HookResult Popped(int entityId, GrenadeKind kind, float x, float y, float z, CCSPlayerController? thrower)
    {
        _book.Popped(Key(entityId), kind, new Vector3(x, y, z), _known(thrower));
        return HookResult.Continue;
    }

    /// <summary>The handle of the entity an event names, while it still stands; <c>null</c> when it cannot be read.</summary>
    private uint? Key(int index)
    {
        try
        {
            var entity = Utilities.GetEntityFromIndex<CEntityInstance>(index);
            return entity is { IsValid: true } ? entity.Entity?.EntityHandle.Raw : null;
        }
        catch (Exception error)
        {
            Say("an event's entity", error);
            return null;
        }
    }

    private static GrenadeKind? KindOfWeapon(string weapon) =>
        weapon.Replace("weapon_", "") switch
        {
            "smokegrenade" => GrenadeKind.Smoke,
            "flashbang" => GrenadeKind.Flash,
            "hegrenade" => GrenadeKind.He,
            "decoy" => GrenadeKind.Decoy,
            "molotov" => GrenadeKind.Molotov,
            "incgrenade" => GrenadeKind.Incendiary,
            _ => null,
        };

    private IGamePlayer? Pawn(CBaseEntity? entity)
    {
        if (entity is not { IsValid: true } || entity.DesignerName != "player")
        {
            return null;
        }

        var pawn = new CCSPlayerPawn(entity.Handle);
        return _known(pawn.OriginalController.Value);
    }

    private Vector3? Origin(int index)
    {
        try
        {
            var entity = Utilities.GetEntityFromIndex<CBaseEntity>(index);
            return entity is { IsValid: true } ? Origin(entity) : null;
        }
        catch (Exception error)
        {
            Say("the dropped bomb", error);
            return null;
        }
    }

    private static Vector3? Origin(CBaseEntity entity) =>
        entity.AbsOrigin is { } origin ? new Vector3(origin.X, origin.Y, origin.Z) : null;

    /// <summary>A read the engine refused. Swallowed so one bad entity never stops a tick, but said once, because a layer that is silently empty is a bug nobody can see.</summary>
    private void Guard(string what, Action read)
    {
        try
        {
            read();
        }
        catch (Exception error)
        {
            Say(what, error);
        }
    }

    private void Say(string what, Exception error)
    {
        if (_said.Add(what))
        {
            _log.Warn($"utility: reading {what} failed, and it is left off the tick: {error.GetType().Name}: {error.Message}");
        }
    }
}
