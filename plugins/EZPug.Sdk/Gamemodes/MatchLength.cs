using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>A length for a mode that has nothing to win</b> (PRD-03 T9, <c>OPEN-POINTS</c> §1).
/// A round-based mode ends when the engine has counted its rounds; a free-for-all has no
/// condition that could ever end it, and production's first seven <c>powerup-dm</c> rooms
/// each billed a rented box until a human released it. So the manifest says how long a
/// match lasts (<c>length</c>) and this class enforces it, for every flow the SDK tells
/// the story of, and never over a mode that owns its own flow (<see cref="Gamemode.OwnsFlow"/>).
/// A <c>matchzy</c> match keeps only the idle timeout (decision 26 as amended,
/// 2026-10-04): MatchZy's rounds are MatchZy's, but MatchZy has no end for a server
/// everybody left, and production's first abandoned PUG billed an empty box until an
/// admin force-ended it. Its end is the host's to say (<see cref="GamemodeRuntime.EndHook"/>),
/// and its clock runs only once the host says the match went live (<see cref="HostWentLive"/>):
/// before that, nobody having come is a no-show, and the client's own join window — fifteen
/// minutes for a cup — is the one that judges it, not an idle timeout ten minutes long:
///
/// <list type="bullet">
/// <item><b>A duration</b>, counted from <c>going_live</c>. <see cref="InForce"/> is what
/// that fact carries, so a client counts the same seconds down.</item>
/// <item><b>A frag limit</b>: the first player to that many kills while the map is live.
/// A suicide and a death to the world are nobody's frag.</item>
/// <item><b>An idle timeout</b>: nobody on the server for that long, from
/// <c>server_ready</c> if nobody ever comes and from the moment the last person leaves.
/// A person is a human or a puppet — a plain bot keeps nobody's seat warm, or a room
/// of request bots would bill for ever exactly as before. <b>Where the roster is the guest
/// list</b> (<c>slots.openJoin: false</c>) only a rostered person counts: somebody the
/// server is about to turn away is not on it, and a stranger knocking every minute must
/// not hold an abandoned match open for ever.</item>
/// </list>
///
/// Whichever comes first ends the match through <see cref="GenericFlow.End"/>: a
/// <c>map_end</c> when the map was live, a <c>series_end</c> always, both carrying the
/// reason — and the orchestrator releases the server as it does after any series. For a
/// <c>matchzy</c> match the host says it instead, and <see cref="GamemodeRuntime.LengthEnded"/>
/// follows either way, which is where a demo nobody's win panel will ever finish is
/// handed over.
///
/// <b>The clock is the server's own, so a time scale divides it.</b> The SDK's timers run
/// on real milliseconds while a simulated match may run the engine faster
/// (<c>simulation.timeScale</c>); ten minutes of deathmatch at 2× are five on this clock,
/// and five is what <see cref="InForce"/> says.
/// </summary>
public sealed class MatchLength
{
    private readonly IGameWorld _world;
    private readonly GamemodeRuntime _runtime;
    private readonly ILinkLog _log;
    private readonly Dictionary<ulong, long> _frags = [];
    private GamemodeLength? _length;
    private double _scale = 1;
    private IClockTimer? _duration;
    private IClockTimer? _idle;
    /// <summary>A <c>matchzy</c> match's idle clock waits for <see cref="HostWentLive"/>; every other flow's runs from <c>server_ready</c>.</summary>
    private bool _waitsForLive;
    private bool _wentLive;

    internal MatchLength(IGameWorld world, GamemodeRuntime runtime, ILinkLog log)
    {
        _world = world;
        _runtime = runtime;
        _log = log;
    }

    /// <summary>Whether the assigned match has a length this class enforces.</summary>
    public bool Armed => _length is not null;

    /// <summary>Whether the idle clock is running: the server is up and nobody is on it.</summary>
    public bool Idling => _idle is not null;

    /// <summary>The leader's kills so far on the live map — what a frag limit is held against.</summary>
    public long LeadingFrags => _frags.Count == 0 ? 0 : _frags.Values.Max();

    /// <summary>What <c>going_live</c> carries: the duration in seconds of this server's clock, and the frag limit. <c>null</c> when the mode declares neither.</summary>
    public LiveLength? InForce =>
        _length is { } length && (length.DurationSeconds is not null || length.FragLimit is not null)
            ? new LiveLength
            {
                DurationSeconds = length.DurationSeconds is { } seconds ? (long)Math.Ceiling(seconds / _scale) : null,
                FragLimit = length.FragLimit,
            }
            : null;

    internal void OnAssigned(Assignment assignment)
    {
        Stop();
        _waitsForLive = assignment.Gamemode.Flow == GamemodeFlow.Matchzy;
        _wentLive = false;
        _length = _waitsForLive ? IdleOnly(assignment.Gamemode.Length) : assignment.Gamemode.Length;
        _scale = assignment.Simulation?.TimeScale is { } scale && scale > 0 ? scale : 1;
    }

    /// <summary>What a <c>matchzy</c> match keeps of a length: the idle timeout, and nothing MatchZy's rounds decide.</summary>
    private static GamemodeLength? IdleOnly(GamemodeLength? length) =>
        length?.IdleTimeoutSeconds is { } seconds ? new GamemodeLength { IdleTimeoutSeconds = seconds } : null;

    /// <summary>
    /// <b>The host's word that a match whose flow it owns is past its warmup</b> — for
    /// <c>matchzy</c>, the first round MatchZy starts outside warmup (the knife round, or the
    /// first live one). From here an empty server counts; before it, nobody being there is
    /// the join window's to judge. Said once; a second call changes nothing.
    /// </summary>
    public void HostWentLive()
    {
        if (!_waitsForLive || _wentLive)
        {
            return;
        }

        _wentLive = true;
        IdleIfEmpty(leaving: null);
    }

    /// <summary>The map is up and configured (<c>server_ready</c>): an empty server starts counting.</summary>
    internal void OnReady() => IdleIfEmpty(leaving: null);

    /// <summary>The generic flow said <c>going_live</c>: the duration starts and everybody's frags are nought.</summary>
    internal void OnLive()
    {
        _frags.Clear();
        _duration?.Cancel();
        _duration = null;
        if (_length?.DurationSeconds is { } seconds)
        {
            _duration = _world.Clock.After(Scaled(seconds), () => End(MatchEndReason.TimeLimit));
        }
    }

    internal void OnPlayerConnected(IGamePlayer player)
    {
        if (Counts(player))
        {
            _idle?.Cancel();
            _idle = null;
        }
    }

    internal void OnPlayerDisconnected(IGamePlayer player)
    {
        if (Counts(player))
        {
            IdleIfEmpty(leaving: player);
        }
    }

    internal void OnPlayerDied(PlayerDeath death)
    {
        if (_length?.FragLimit is not { } limit || !_runtime.Flow.Live
            || death.Killer is not { } killer || killer.Slot == death.Victim.Slot)
        {
            return;
        }

        var frags = _frags[killer.SteamId64] = _frags.GetValueOrDefault(killer.SteamId64) + 1;
        if (frags >= limit)
        {
            End(MatchEndReason.FragLimit);
        }
    }

    internal void OnReleased() => Stop();

    private void End(MatchEndReason reason)
    {
        var matchzy = _runtime.Assignment?.Gamemode.Flow == GamemodeFlow.Matchzy;
        var ended = matchzy ? _runtime.EndHook?.Invoke(reason) == true : _runtime.Flow.End(reason);
        if (!ended)
        {
            if (matchzy && _runtime.EndHook is null)
            {
                _log.Warn($"length: the match ran out on {reason} and nothing on this server can end a matchzy match");
            }

            return;
        }

        _log.Info($"length: the match ended on {reason}");
        Stop();
        if (_runtime.Assignment is not { } assignment)
        {
            return;
        }

        foreach (var player in _world.Players.Where(player => !player.IsBot))
        {
            var lines = _runtime.Localizer.For(assignment.LocaleOf(player.SteamId64));
            _runtime.Brand.Say(player, lines[reason == MatchEndReason.FragLimit ? "length.ended.frag_limit" : "length.ended.time_limit"]);
        }

        _runtime.OnLengthEnded(reason);
    }

    private void IdleIfEmpty(IGamePlayer? leaving)
    {
        if (_length?.IdleTimeoutSeconds is not { } seconds || _idle is not null || (_waitsForLive && !_wentLive)
            || _world.Players.Any(player => Counts(player) && player.Slot != leaving?.Slot))
        {
            return;
        }

        _idle = _world.Clock.After(Scaled(seconds), () => End(MatchEndReason.Idle));
    }

    private void Stop()
    {
        _duration?.Cancel();
        _duration = null;
        _idle?.Cancel();
        _idle = null;
        _frags.Clear();
        _length = null;
        _waitsForLive = false;
        _wentLive = false;
    }

    private long Scaled(long seconds) => (long)Math.Ceiling(seconds * 1000 / _scale);

    private static bool IsPerson(IGamePlayer player) => !player.IsBot || player.IsPuppet;

    /// <summary>Whether this body keeps the server from being empty: a person, and where the roster is the guest list, a rostered one.</summary>
    private bool Counts(IGamePlayer player) =>
        IsPerson(player)
        && (_runtime.Assignment is not { } assignment
            || assignment.Gamemode.Slots.OpenJoin
            || assignment.IsRostered(player.SteamId64));
}
