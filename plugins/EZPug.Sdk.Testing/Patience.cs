namespace EZPug.Sdk.Testing;

/// <summary>
/// How long a harness wait gives the thread pool before it calls a hang a hang.
///
/// <para>Every wait in this assembly is a <i>behavioural</i> assertion — "the client
/// sends a hello", "the frame was applied", "the line was logged" — over a timeline the
/// test owns (the injected <see cref="FakeClock"/>). The wall-clock bound on such a wait
/// exists only so a genuine hang fails with a message instead of stalling the run
/// forever: the safety net, never the mechanism. Five seconds is a <i>latency</i>
/// assumption, not a behavioural one, and it is wrong under <c>pnpm verify:extended</c>,
/// where this suite runs beside the whole TypeScript matrix and a saturated scheduler can
/// leave a continuation queued for seconds. A slow box then reads as broken backoff
/// (PRD-02 T20a).</para>
///
/// <para>So: the same assertions, more patience. The TypeScript side reached the same
/// posture for the same reason in <c>eventually()</c> (<c>@ezpug/core/testing</c>,
/// <c>EVENTUALLY_TIMEOUT_MS</c>); this is that number doubled, which xunit allows because
/// no per-test timeout is configured above it to stay under.</para>
///
/// <para>Two rules ride along with the number:</para>
/// <list type="bullet">
/// <item><b>Never for a negative.</b> These waits prove something <i>happens</i>. To
/// prove something does not, settle the world (advance the clock, await the session) and
/// assert once — waiting half a minute for nothing is half a minute wasted.</item>
/// <item><b>A budget is not an ordering.</b> No amount of patience saves a test that
/// advances the fake clock before the code under test armed its timer; that wants a
/// signal that happens after the arming, not a longer wait.</item>
/// </list>
/// </summary>
public static class Patience
{
    /// <summary>The bound every harness wait defaults to, in milliseconds.</summary>
    public const int TimeoutMs = 30_000;
}
