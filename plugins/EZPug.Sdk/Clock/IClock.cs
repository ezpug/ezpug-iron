namespace EZPug.Sdk;

/// <summary>
/// The clock everything in the SDK reasons about time with (CLAUDE.md "Determinism"):
/// no <c>DateTime.UtcNow</c>, no <c>Stopwatch</c>, no <c>Task.Delay</c> outside the
/// implementations of this interface. <see cref="NowMs"/> is <b>monotonic</b> —
/// milliseconds since the clock started, the number the link reports as
/// <c>uptimeMs</c> — and never wall time: the orchestrator stamps arrival itself and a
/// server is not trusted with a calendar (<c>packages/protocol/src/server-link.ts</c>).
/// Timers live on the clock on purpose: a cooldown that armed a real timer would be
/// untestable, so a test's <c>FakeClock</c> fires them when it is advanced, in order.
/// </summary>
public interface IClock
{
    /// <summary>Milliseconds since the clock began. Monotonic, never wall time.</summary>
    long NowMs { get; }

    /// <summary>Run <paramref name="callback"/> once after <paramref name="delayMs"/> of clock time. Delays at or below zero fire on the next advance.</summary>
    IClockTimer After(long delayMs, Action callback);

    /// <summary>Run <paramref name="callback"/> every <paramref name="intervalMs"/> of clock time until cancelled.</summary>
    IClockTimer Every(long intervalMs, Action callback);
}

/// <summary>An armed timer. <see cref="Cancel"/> is idempotent.</summary>
public interface IClockTimer
{
    void Cancel();
}

/// <summary>
/// Real time: a <see cref="System.Diagnostics.Stopwatch"/> for <see cref="NowMs"/> and
/// thread-pool timers for the callbacks. What the link client runs on in production —
/// the game thread never waits on it. A gamemode's own timers come from the world's
/// clock instead, which the core plugin builds on CounterStrikeSharp's game-thread
/// timers (PRD-02 T8), so a mode's callback is always on the thread the game allows.
/// </summary>
public sealed class SystemClock : IClock
{
    private readonly System.Diagnostics.Stopwatch _stopwatch = System.Diagnostics.Stopwatch.StartNew();

    public long NowMs => _stopwatch.ElapsedMilliseconds;

    public IClockTimer After(long delayMs, Action callback) =>
        new ThreadingTimer(callback, Math.Max(delayMs, 0), repeat: null);

    public IClockTimer Every(long intervalMs, Action callback) =>
        new ThreadingTimer(callback, Math.Max(intervalMs, 1), repeat: Math.Max(intervalMs, 1));

    private sealed class ThreadingTimer : IClockTimer
    {
        private readonly Timer _timer;
        private int _cancelled;

        public ThreadingTimer(Action callback, long dueMs, long? repeat)
        {
            _timer = new Timer(
                _ =>
                {
                    if (Volatile.Read(ref _cancelled) == 0)
                    {
                        callback();
                    }
                },
                null,
                dueMs,
                repeat ?? Timeout.Infinite);
        }

        public void Cancel()
        {
            if (Interlocked.Exchange(ref _cancelled, 1) == 0)
            {
                _timer.Dispose();
            }
        }
    }
}
