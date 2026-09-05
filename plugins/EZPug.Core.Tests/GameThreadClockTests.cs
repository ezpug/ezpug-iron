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
    public void NowIsMonotonic()
    {
        var clock = new GameThreadClock();
        var first = clock.NowMs;
        Thread.Sleep(3);
        Assert.True(clock.NowMs >= first);
    }
}
