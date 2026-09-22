using Xunit;

namespace EZPug.Core.Tests;

public class GameThreadClockTests
{
    [Fact]
    public void TimersFireFromTickInDueOrderAndRepeatsReArm()
    {
        var clock = new GameThreadClock();
        var fired = new List<string>();
        clock.After(0, () => fired.Add("now"));
        var every = clock.Every(1, () => fired.Add("every"));
        clock.After(1_000_000, () => fired.Add("never"));

        // Nothing fires without a tick, whatever the time.
        Assert.Empty(fired);
        Thread.Sleep(5);
        clock.Tick();
        Assert.Equal(["now", "every"], fired);

        Thread.Sleep(5);
        clock.Tick();
        Assert.Equal(["now", "every", "every"], fired);
        Assert.Equal(2, clock.Armed);

        every.Cancel();
        every.Cancel();
        Thread.Sleep(5);
        clock.Tick();
        Assert.Equal(3, fired.Count);
        Assert.Equal(1, clock.Armed);
    }

    [Fact]
    public void ACallbackThatArmsATimerIsNotReenteredOnTheSameTick()
    {
        var clock = new GameThreadClock();
        var fired = 0;
        clock.After(0, () =>
        {
            fired++;
            clock.After(0, () => fired++);
        });
        clock.Tick();
        Assert.Equal(1, fired);
        clock.Tick();
        Assert.Equal(2, fired);
    }

    [Fact]
    public void ARepeatHoldsItsPeriodWhenEveryFrameIsLate()
    {
        // The position stream's case (OPEN-POINTS §4 as it was): 100 ms beats on 7 ms
        // frames. Every beat fires a frame late, and the lateness must not add up.
        var now = 0L;
        var clock = new GameThreadClock(() => now);
        var beats = new List<long>();
        clock.Every(100, () => beats.Add(now));

        // Frames until the first one past ten seconds, 10 003 — the hundredth beat's.
        for (now = 0; now <= 10_003; now += 7)
        {
            clock.Tick();
        }

        // A hundred beats in ten seconds, not ninety-three — and each one within a frame
        // of its grid point, the hundredth as much as the first.
        Assert.Equal(100, beats.Count);
        for (var n = 1; n <= beats.Count; n++)
        {
            var lateBy = beats[n - 1] - (100 * n);
            Assert.InRange(lateBy, 0, 6);
        }
    }

    [Fact]
    public void AStalledFrameFiresOnceAndSkipsTheBeatsItSwallowed()
    {
        var now = 0L;
        var clock = new GameThreadClock(() => now);
        var beats = new List<long>();
        clock.Every(100, () => beats.Add(now));

        now = 100;
        clock.Tick();
        // A hitch: the next frame is 350 ms later, past the beats at 200, 300 and 400.
        now = 450;
        clock.Tick();
        clock.Tick();
        Assert.Equal([100L, 450L], beats);

        // The grid is kept, not the gap: the next beat is 500, fifty after the late one.
        now = 499;
        clock.Tick();
        now = 500;
        clock.Tick();
        Assert.Equal([100L, 450L, 500L], beats);
    }

    [Theory]
    [InlineData(100, 100, 100, 200)] // on time
    [InlineData(100, 100, 107, 200)] // a frame late: the late frame is not the new origin
    [InlineData(100, 100, 199, 200)] // most of a period late: still the next beat
    [InlineData(100, 100, 200, 300)] // exactly a period late: that beat is the one being fired
    [InlineData(100, 100, 451, 500)] // several periods: skip to the first one ahead
    [InlineData(1, 5, 5, 6)] // the shortest period there is
    public void TheNextBeatIsTheFirstGridPointAheadOfTheFrame(long due, long repeat, long now, long next)
    {
        Assert.Equal(next, GameThreadClock.NextBeat(due, repeat, now));
    }

    [Fact]
    public void AOneShotIsNotReArmed()
    {
        var now = 0L;
        var clock = new GameThreadClock(() => now);
        var fired = 0;
        clock.After(50, () => fired++);
        now = 500;
        clock.Tick();
        now = 1_000;
        clock.Tick();
        Assert.Equal(1, fired);
        Assert.Equal(0, clock.Armed);
    }

    [Fact]
    public void NowIsMonotonic()
    {
        var clock = new GameThreadClock();
        var first = clock.NowMs;
        Thread.Sleep(3);
        Assert.True(clock.NowMs >= first);
    }
}
