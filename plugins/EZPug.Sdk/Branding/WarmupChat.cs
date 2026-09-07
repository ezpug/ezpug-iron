namespace EZPug.Sdk;

/// <summary>
/// <b>What the server says while it waits</b> (PRD-02 T30): the assignment's
/// <c>warmupLines</c>, printed one every <see cref="IntervalMs"/> in warmup, in the order
/// the client wrote them, cycling for as long as the wait lasts — a player who connects
/// two minutes late reads the same lines as the one who was first in.
///
/// <list type="bullet">
/// <item><b>The platform renders them, the plugin prints them.</b> The lines arrive as
/// text, already in the roster's majority locale
/// (<see cref="Assignment.MajorityLocale"/> is what a client's renderer decides with) —
/// one line everybody reads at once cannot be four languages, and the server does not
/// own the words. Nothing here is translated and nothing here is a template.</item>
/// <item><b>They carry no prefix.</b> They are the client's words relayed, exactly like
/// a client's <c>announce</c> and unlike everything the SDK says in its own voice
/// (<see cref="Branding"/>): the platform brands its own copy, and a second
/// <c>[EZPug]</c> in front of it would be the server talking over the client.</item>
/// <item><b>Warmup is the engine's word, not ours.</b> A beat prints only while
/// <see cref="GameRules.Warmup"/> is true, so a knife round and a live round are quiet,
/// and the next map's warmup speaks again. A world with no gamerules to read (the test
/// harness) falls back to "the match has not gone live yet", which is the same window
/// with a coarser edge.</item>
/// <item><b>Every line is sanitized once</b>, at assignment, by
/// <see cref="SaidLine"/> — a line that is nothing but a semicolon is dropped there
/// rather than printed as a blank row every eight seconds.</item>
/// </list>
/// </summary>
public sealed class WarmupChat
{
    /// <summary>How long between two warmup lines. "Every few seconds": long enough that chat is still readable, short enough that a whole set is read before a match starts.</summary>
    public const long IntervalMs = 8_000;

    private readonly IGameWorld _world;
    private readonly MatchContext _match;
    private IClockTimer? _ticker;
    private string[] _lines = [];
    private int _next;

    public WarmupChat(IGameWorld world, MatchContext match)
    {
        _world = world;
        _match = match;
    }

    /// <summary>The lines this match will print, sanitized; empty when the request named none.</summary>
    public IReadOnlyList<string> Lines => _lines;

    /// <summary>How many lines have been printed for this match — what a test counts.</summary>
    public int Printed { get; private set; }

    /// <summary>Whether the printer is armed (a match with lines is assigned and its map is up).</summary>
    public bool Armed => _ticker is not null;

    /// <summary>A match is assigned: its lines are read and cleaned, and nothing is printed until the map is up.</summary>
    public void OnAssigned(Assignment assignment)
    {
        Stop();
        _lines = [.. assignment.WarmupLines.Select(SaidLine.Sanitize).OfType<string>()];
        _next = 0;
        Printed = 0;
    }

    /// <summary>The map is up and configured (<c>server_ready</c>): the wait, and the lines, begin.</summary>
    public void OnMapReady()
    {
        Stop();
        if (_lines.Length == 0)
        {
            return;
        }

        _ticker = _world.Clock.Every(IntervalMs, Beat);
    }

    /// <summary>The match is over: the server goes quiet, and the next one starts from its own first line.</summary>
    public void OnReleased()
    {
        Stop();
        _lines = [];
        _next = 0;
        Printed = 0;
    }

    /// <summary>Cancel the ticker without forgetting the lines — a level change re-arms it.</summary>
    public void Stop()
    {
        _ticker?.Cancel();
        _ticker = null;
    }

    private void Beat()
    {
        if (_lines.Length == 0 || !InWarmup)
        {
            return;
        }

        _world.Say(_lines[_next % _lines.Length]);
        _next++;
        Printed++;
    }

    /// <summary>The engine's warmup where there are gamerules to read; "not live yet" where there are none.</summary>
    private bool InWarmup => _world.Rules is { } rules ? rules.Warmup : !_match.Live;
}
