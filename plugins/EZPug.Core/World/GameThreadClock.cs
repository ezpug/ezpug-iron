using System.Diagnostics;
using EZPug.Sdk;

namespace EZPug.Core;

/// <summary>
/// <b>The game-thread clock.</b> Monotonic milliseconds from a <see cref="Stopwatch"/>;
/// timers fire from <see cref="Tick"/>, which the world calls once per engine frame on
/// the game thread — so a mode's callback always runs where the engine allows, and a
/// due callback that arms another timer is fired on the next frame, never re-entered.
/// The link client runs on <see cref="SystemClock"/> instead; the two share nothing but
/// the interface.
///
/// <para><b>A repeating timer holds its period</b> (PRD-04 T5). A due timer fires on the
/// first frame at or after its due time, so it is always up to a frame late — and it is
/// re-armed from the <i>due time</i>, not from the frame that fired it, so the lateness
/// never accumulates: the <c>n</c>th beat of an <c>Every(100)</c> is due at
/// <c>armed + 100·n</c> however long the frames are. Re-arming from the frame instead was
/// the old rule, and it made every repeat a frame long (the position stream ran at 108 ms
/// at 128 fps, OPEN-POINTS §4 as it was).</para>
///
/// <para><b>A stalled frame skips, never bursts.</b> A frame that arrives a whole period
/// or more past a timer's due time — a map change, a hitch — fires it <i>once</i> and
/// re-arms it at the next beat still ahead of that frame; the beats the stall swallowed
/// are gone, not owed. A position stream after a hitch is one late tick, not a volley of
/// identical ones, and a heartbeat is never sent twice in a frame. The beat that follows
/// a late fire can therefore come less than a period after it: the grid is kept, not the
/// gap.</para>
/// </summary>
public sealed class GameThreadClock : IClock
{
    private readonly Func<long> _now;
    private readonly List<Entry> _entries = [];

    public GameThreadClock()
    {
        var stopwatch = Stopwatch.StartNew();
        _now = () => stopwatch.ElapsedMilliseconds;
    }

    /// <summary>A clock on a time source the caller moves — the tests', so a frame's lateness is a number and not a sleep.</summary>
    internal GameThreadClock(Func<long> now)
    {
        _now = now;
    }

    public long NowMs => _now();

    public IClockTimer After(long delayMs, Action callback) => Arm(callback, NowMs + Math.Max(delayMs, 0), repeat: null);

    public IClockTimer Every(long intervalMs, Action callback)
    {
        var interval = Math.Max(intervalMs, 1);
        return Arm(callback, NowMs + interval, interval);
    }

    /// <summary>Fire every timer that is due, in due order. Called by the world on each engine frame.</summary>
    public void Tick()
    {
        var now = NowMs;
        List<Entry> due;
        lock (_entries)
        {
            due = _entries.Where(entry => entry.DueMs <= now).OrderBy(entry => entry.DueMs).ThenBy(entry => entry.Order).ToList();
            foreach (var entry in due)
            {
                if (entry.RepeatMs is { } repeat)
                {
                    entry.DueMs = NextBeat(entry.DueMs, repeat, now);
                }
                else
                {
                    _entries.Remove(entry);
                }
            }
        }

        foreach (var entry in due)
        {
            if (!entry.Cancelled)
            {
                entry.Callback();
            }
        }
    }

    /// <summary>
    /// The first beat of the grid <c>due + repeat·k</c> strictly after <paramref name="now"/>:
    /// <c>due + repeat</c> on an ordinary frame, further on when the frame was a whole period
    /// late or more, so the beats in between are skipped rather than fired back to back.
    /// </summary>
    internal static long NextBeat(long due, long repeat, long now) =>
        due + (repeat * (((now - due) / repeat) + 1));

    /// <summary>How many timers are armed — for a status line.</summary>
    public int Armed
    {
        get
        {
            lock (_entries)
            {
                return _entries.Count;
            }
        }
    }

    private long _order;

    private Entry Arm(Action callback, long dueMs, long? repeat)
    {
        lock (_entries)
        {
            var entry = new Entry(this, callback, dueMs, repeat, _order++);
            _entries.Add(entry);
            return entry;
        }
    }

    private sealed class Entry(GameThreadClock clock, Action callback, long dueMs, long? repeatMs, long order) : IClockTimer
    {
        public Action Callback { get; } = callback;
        public long DueMs { get; set; } = dueMs;
        public long? RepeatMs { get; } = repeatMs;
        public long Order { get; } = order;
        public bool Cancelled { get; private set; }

        public void Cancel()
        {
            lock (clock._entries)
            {
                Cancelled = true;
                clock._entries.Remove(this);
            }
        }
    }
}
