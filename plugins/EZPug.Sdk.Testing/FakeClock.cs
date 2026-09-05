using EZPug.Sdk;

namespace EZPug.Sdk.Testing;

/// <summary>
/// A virtual timeline a test advances by hand; timers fire in due order, on the
/// advancing thread, including ones armed while firing. <see cref="NowMs"/> starts
/// where the test says (the link reports it as uptime, so a fixture with
/// <c>uptimeMs: 421000</c> starts the clock there) and never moves on its own.
/// </summary>
public sealed class FakeClock : IClock
{
    private readonly List<Entry> _timers = [];
    private long _now;
    private long _order;

    private sealed class Entry : IClockTimer
    {
        public long Due;
        public long Order;
        public long? Interval;
        public required Action Callback;
        public bool Cancelled;

        public void Cancel() => Cancelled = true;
    }

    public FakeClock(long startMs = 0)
    {
        _now = startMs;
    }

    public long NowMs => _now;

    public int Pending => _timers.Count(timer => !timer.Cancelled);

    public IClockTimer After(long delayMs, Action callback) => Arm(Math.Max(delayMs, 0), null, callback);

    public IClockTimer Every(long intervalMs, Action callback) => Arm(Math.Max(intervalMs, 1), Math.Max(intervalMs, 1), callback);

    private IClockTimer Arm(long delayMs, long? interval, Action callback)
    {
        var entry = new Entry { Due = _now + delayMs, Order = _order++, Interval = interval, Callback = callback };
        _timers.Add(entry);
        return entry;
    }

    /// <summary>Move forward by <paramref name="byMs"/>, firing every timer that comes due, in order.</summary>
    public void Advance(long byMs) => AdvanceTo(_now + byMs);

    public void AdvanceTo(long timestampMs)
    {
        while (true)
        {
            var next = _timers
                .Where(timer => !timer.Cancelled && timer.Due <= timestampMs)
                .OrderBy(timer => timer.Due)
                .ThenBy(timer => timer.Order)
                .FirstOrDefault();
            if (next is null)
            {
                break;
            }

            _now = Math.Max(_now, next.Due);
            if (next.Interval is { } interval)
            {
                next.Due += interval;
                next.Order = _order++;
            }
            else
            {
                _timers.Remove(next);
            }

            next.Callback();
        }

        _timers.RemoveAll(timer => timer.Cancelled);
        _now = Math.Max(_now, timestampMs);
    }
}
