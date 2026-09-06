using EZPug.Sdk;

namespace EZPug.Sdk.Testing;

/// <summary>
/// A virtual timeline a test advances by hand; timers fire in due order, on the
/// advancing thread, including ones armed while firing. <see cref="NowMs"/> starts
/// where the test says (the link reports it as uptime, so a fixture with
/// <c>uptimeMs: 421000</c> starts the clock there) and never moves on its own.
///
/// <para>Thread-safe by design, not by luck: the test advances from its own thread while
/// the code under test arms timers from the socket thread and the reconnect loop
/// (<c>LinkClient</c> does exactly that). The book of timers is therefore kept under a
/// lock — but a callback is invoked <i>outside</i> it, because callbacks reach back into
/// the code that armed them and would otherwise close a lock cycle with that code's own
/// gate.</para>
/// </summary>
public sealed class FakeClock : IClock
{
    private readonly List<Entry> _timers = [];
    private readonly object _gate = new();
    private long _now;
    private long _order;

    private sealed class Entry : IClockTimer
    {
        public long Due;
        public long Order;
        public long? Interval;
        public required Action Callback;
        public volatile bool Cancelled;

        public void Cancel() => Cancelled = true;
    }

    public FakeClock(long startMs = 0)
    {
        _now = startMs;
    }

    public long NowMs
    {
        get
        {
            lock (_gate)
            {
                return _now;
            }
        }
    }

    public int Pending
    {
        get
        {
            lock (_gate)
            {
                return _timers.Count(timer => !timer.Cancelled);
            }
        }
    }

    public IClockTimer After(long delayMs, Action callback) => Arm(Math.Max(delayMs, 0), null, callback);

    public IClockTimer Every(long intervalMs, Action callback) => Arm(Math.Max(intervalMs, 1), Math.Max(intervalMs, 1), callback);

    private IClockTimer Arm(long delayMs, long? interval, Action callback)
    {
        lock (_gate)
        {
            var entry = new Entry { Due = _now + delayMs, Order = _order++, Interval = interval, Callback = callback };
            _timers.Add(entry);
            return entry;
        }
    }

    /// <summary>Move forward by <paramref name="byMs"/>, firing every timer that comes due, in order.</summary>
    public void Advance(long byMs) => AdvanceTo(NowMs + byMs);

    public void AdvanceTo(long timestampMs)
    {
        while (true)
        {
            Entry next;
            lock (_gate)
            {
                var due = _timers
                    .Where(timer => !timer.Cancelled && timer.Due <= timestampMs)
                    .OrderBy(timer => timer.Due)
                    .ThenBy(timer => timer.Order)
                    .FirstOrDefault();
                if (due is null)
                {
                    _timers.RemoveAll(timer => timer.Cancelled);
                    _now = Math.Max(_now, timestampMs);
                    return;
                }

                _now = Math.Max(_now, due.Due);
                if (due.Interval is { } interval)
                {
                    due.Due += interval;
                    due.Order = _order++;
                }
                else
                {
                    _timers.Remove(due);
                }

                next = due;
            }

            // Cancelled between the pick and here — a session ending on the socket thread
            // disarms its heartbeat while the test advances. Cancel means cancel.
            if (next.Cancelled)
            {
                continue;
            }

            // Outside the lock: the callback may arm a timer (which takes this lock) and
            // may take the lock of whatever armed it, which is holding its own gate while
            // it arms here. Only one of the two may be held at a time.
            next.Callback();
        }
    }
}
