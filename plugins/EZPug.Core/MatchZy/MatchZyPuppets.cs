using System.Collections.Concurrent;
using EZPug.Sdk;
using EZPug.Sdk.Protocol;

namespace EZPug.Core;

/// <summary>
/// <b>A puppet in a pug is announced too</b> (PRD-03 T7a, decision 25).
///
/// <para>For the modes MatchZy does not run, the SDK's <see cref="Puppeteer"/> asks for
/// each body and knows who it asked for, so a puppet is a rostered player from its first
/// hook (T7). Under a <c>matchzy</c> flow MatchZy-Enhanced's simulation mode seats them
/// instead — it walks <c>bot_quota</c> up one at a time, maps each bot to a roster entry
/// and readies it — and tells nobody which bot is which. Left alone, the core plugin sees
/// ten plain bots: nothing is announced, the orchestrator's presence map is empty, a
/// <c>kick</c> or a widget tap for a rostered SteamID is refused <c>player_not_in_match</c>,
/// and every death crosses the link under a synthetic id while MatchZy's own stats carry
/// the rostered one. One match, two opinions about who is on the server.</para>
///
/// <para>So this reads the fork's mapping rather than forming one: its decisions go to
/// the server console word for word (<see cref="SimulationLog"/>), the two plugins share
/// a process and therefore a <see cref="Console.Out"/> (<see cref="ConsoleTap"/>), and
/// each line is turned into <see cref="IGameWorld.Recast"/> on the body it names. From
/// then on that bot <i>is</i> the roster entry to everything downstream, and the
/// announcement the world raises is the first word anybody said about it.</para>
///
/// <para><b>Threads.</b> A console line arrives on whichever thread wrote it, inside the
/// console's own lock; it is queued there and nowhere else. Every read of the engine and
/// every touch of the world happens on the game thread, one drain per
/// <see cref="DrainIntervalMs"/>, the way <see cref="MatchZyFlow"/> polls.</para>
/// </summary>
public sealed class MatchZyPuppets
{
    /// <summary>How often the queued console lines are read. A mapping is worth a quarter of a second's wait; a warmup is a minute wide.</summary>
    public const long DrainIntervalMs = 250;

    /// <summary>How many lines may wait to be read. A room of ten maps in a few dozen; anything past this is a console nobody is draining.</summary>
    public const int MaxQueued = 1_000;

    private readonly IGameWorld _world;
    private readonly GamemodeRuntime _runtime;
    private readonly Func<int, int?> _slotOfUserId;
    private readonly Action<bool>? _listen;
    private readonly ILinkLog _log;
    private readonly ConcurrentQueue<string> _lines = new();
    private Assignment? _assignment;
    private IClockTimer? _drain;
    private int _dropped;

    /// <param name="slotOfUserId">The engine slot the fork's <c>UserId</c> names, or <c>null</c> when that body has gone. The one CounterStrikeSharp lookup this class needs, held at arm's length so it is provable without the game.</param>
    /// <param name="listen">Told when a simulated match wants the console read, so nothing is buffered for the rest of a server's life.</param>
    public MatchZyPuppets(
        IGameWorld world,
        GamemodeRuntime runtime,
        Func<int, int?> slotOfUserId,
        Action<bool>? listen = null,
        ILinkLog? log = null)
    {
        _world = world;
        _runtime = runtime;
        _slotOfUserId = slotOfUserId;
        _listen = listen;
        _log = log ?? NullLinkLog.Instance;
    }

    /// <summary>Whether a simulated <c>matchzy</c> match is assigned right now — the only time the console is read.</summary>
    public bool Active => _assignment is not null;

    /// <summary>How many bodies on the server this plugin knows a roster entry for.</summary>
    public int Seated => _world.Players.Count(player => player.IsPuppet);

    /// <summary>Whether this class seats nobody and only listens: MatchZy owns the bodies, the SDK's <see cref="Puppeteer"/> owns every other flow.</summary>
    public static bool Reads(Assignment assignment) =>
        assignment.Simulation is not null && assignment.Gamemode.Flow == GamemodeFlow.Matchzy;

    /// <summary>Hook the runtime's host events.</summary>
    public void Bind()
    {
        _runtime.Assigned += OnAssigned;
        _runtime.Released += OnReleased;
    }

    /// <summary>
    /// One line off the server console, from whatever thread wrote it. Queued and nothing
    /// else — see the class's note on threads.
    /// </summary>
    public void Heard(string line)
    {
        if (_lines.Count >= MaxQueued || !SimulationLog.Ours(line))
        {
            return;
        }

        _lines.Enqueue(line);
    }

    /// <summary>Read whatever is queued and cast the bodies it names. The game thread, every <see cref="DrainIntervalMs"/>.</summary>
    public void Drain()
    {
        while (_lines.TryDequeue(out var line))
        {
            Apply(line);
        }
    }

    private void OnAssigned(Assignment assignment)
    {
        Disarm();
        if (!Reads(assignment))
        {
            return;
        }

        _assignment = assignment;
        _dropped = 0;
        _listen?.Invoke(true);
        _drain = _world.Clock.Every(DrainIntervalMs, Drain);
        _log.Info("matchzy puppets: reading simulation mode's own console lines for who each bot plays");
    }

    private void OnReleased(string? reason) => Disarm();

    private void Disarm()
    {
        _drain?.Cancel();
        _drain = null;
        if (_assignment is not null)
        {
            _listen?.Invoke(false);
        }

        _assignment = null;
        _lines.Clear();
    }

    private void Apply(string line)
    {
        if (_assignment is not { } assignment)
        {
            return;
        }

        if (SimulationLog.Mapped(line) is { } mapping)
        {
            Seat(assignment, mapping);
            return;
        }

        if (SimulationLog.Released(line) is { } userId)
        {
            // Nothing to do to the world: the body's own disconnect is what took it off,
            // and that is announced where every other leaving is. Said out loud because a
            // room that goes one short in a durable log deserves a reason beside it.
            _log.Info($"matchzy puppets: simulation mode freed the roster slot bot {userId} held");
        }
    }

    private void Seat(Assignment assignment, SimulationMapping mapping)
    {
        // The identities are the ones this repo wrote into the match file, so a SteamID
        // the request never named would mean the fork is playing a match nobody asked
        // for. Refused rather than invented: an unrostered id in the durable log is worse
        // than a bot nobody named.
        if (!assignment.IsRostered(mapping.SteamId64))
        {
            _log.Warn($"matchzy puppets: simulation mode mapped a bot to {mapping.SteamId64}, who is not on this match's roster; leaving it a bot");
            return;
        }

        if (_slotOfUserId(mapping.UserId) is not { } slot)
        {
            _dropped++;
            _log.Warn($"matchzy puppets: bot {mapping.UserId} plays {mapping.Name} and is already gone; {_dropped} mapping(s) missed so far");
            return;
        }

        if (_world.Recast(slot, new PuppetRole(mapping.SteamId64, mapping.Name)))
        {
            return;
        }

        _dropped++;
        _log.Warn($"matchzy puppets: slot {slot} cannot play {mapping.Name} ({mapping.SteamId64}); {_dropped} mapping(s) missed so far");
    }
}
