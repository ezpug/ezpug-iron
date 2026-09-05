using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

public class FakeClockTests
{
    [Fact]
    public void TimersFireInDueOrderIncludingOnesArmedWhileFiring()
    {
        var clock = new FakeClock(100);
        var fired = new List<string>();
        clock.After(30, () => fired.Add("b"));
        clock.After(10, () =>
        {
            fired.Add("a");
            clock.After(5, () => fired.Add("a+5"));
        });
        var every = clock.Every(20, () => fired.Add($"tick@{clock.NowMs}"));
        clock.Advance(40);
        Assert.Equal(["a", "a+5", "tick@120", "b", "tick@140"], fired);
        Assert.Equal(140, clock.NowMs);
        every.Cancel();
        clock.Advance(100);
        Assert.Equal(5, fired.Count);
        Assert.Equal(0, clock.Pending);
    }

    [Fact]
    public void ACancelledTimerNeverFiresAndNowNeverMovesBack()
    {
        var clock = new FakeClock();
        var fired = false;
        var timer = clock.After(10, () => fired = true);
        timer.Cancel();
        timer.Cancel();
        clock.Advance(10);
        Assert.False(fired);
        clock.AdvanceTo(5);
        Assert.Equal(10, clock.NowMs);
    }

    [Fact]
    public void TheSystemClockCountsUpAndFiresOnTheThreadPool()
    {
        var clock = new SystemClock();
        var before = clock.NowMs;
        using var fired = new ManualResetEventSlim();
        clock.After(1, fired.Set);
        Assert.True(fired.Wait(5_000));
        Assert.True(clock.NowMs >= before);
    }
}
