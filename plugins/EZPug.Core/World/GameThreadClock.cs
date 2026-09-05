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
/// </summary>
public sealed class GameThreadClock : IClock
{
    private readonly Stopwatch _stopwatch = Stopwatch.StartNew();
    private readonly List<Entry> _entries = [];

    public long NowMs => _stopwatch.ElapsedMilliseconds;

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
                    entry.DueMs = now + repeat;
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
