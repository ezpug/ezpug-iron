using System.Text;

namespace EZPug.Core;

/// <summary>
/// <b>The one channel a plugin beside us speaks on</b> (PRD-03 T7a). CounterStrikeSharp
/// runs every plugin in one process, so <c>MatchZy.Log</c>'s
/// <see cref="Console.WriteLine(string)"/> and ours go through the same
/// <see cref="Console.Out"/>. This sits in front of it: every write is passed on
/// unchanged and, while somebody is <see cref="Listening"/>, split into lines and offered
/// to them as well. Nothing is swallowed, reordered or rewritten — a tee, not a filter.
///
/// <para><b>It hands a line over and does nothing with it.</b> The callback runs on
/// whichever thread wrote the line, inside <c>Console.Out</c>'s own lock, and this
/// plugin's log writes to that same console: anything that reads a line <i>here</i> and
/// answers by logging would be writing to the writer it is inside. So the one caller
/// queues the string and does its thinking on the game thread a beat later
/// (<see cref="MatchZyPuppets"/>).</para>
///
/// <para><b>Off by default.</b> A CS2 server writes a great deal, and none of it is
/// interesting except during a simulated <c>matchzy</c> match, so <see cref="Listening"/>
/// is what a match turns on: with it off this is a forwarding call and an untouched
/// buffer.</para>
/// </summary>
public sealed class ConsoleTap : TextWriter
{
    /// <summary>A line nobody ended is handed over at this length, so a writer that never breaks cannot grow the buffer for ever.</summary>
    public const int MaxLineLength = 4_096;

    private readonly TextWriter _inner;
    private readonly Action<string> _line;
    private readonly StringBuilder _buffer = new();
    private readonly System.Threading.Lock _gate = new();
    private volatile bool _listening;

    private ConsoleTap(TextWriter inner, Action<string> line)
    {
        _inner = inner;
        _line = line;
    }

    /// <summary>Whether lines are offered to the callback. Off until a match wants them.</summary>
    public bool Listening
    {
        get => _listening;
        set
        {
            if (!value)
            {
                lock (_gate)
                {
                    _buffer.Clear();
                }
            }

            _listening = value;
        }
    }

    public override Encoding Encoding => _inner.Encoding;

    /// <summary>A tap in front of <paramref name="inner"/>, standing nowhere. What <see cref="Install"/> makes, and what a test can prove without the process's one console.</summary>
    public static ConsoleTap Over(TextWriter inner, Action<string> line) => new(inner, line);

    /// <summary>Put a tap in front of whatever <see cref="Console.Out"/> is now.</summary>
    public static ConsoleTap Install(Action<string> line)
    {
        var tap = Over(Console.Out, line);
        Console.SetOut(tap);
        return tap;
    }

    /// <summary>
    /// Stand down: the console goes back to the writer this one was put in front of.
    /// Unconditional, because a writer put in front of <i>us</i> later would keep working
    /// off a tap nobody drains, and a console that has stopped forwarding is worse than
    /// one that lost a tap.
    /// </summary>
    public void Remove()
    {
        Listening = false;
        Console.SetOut(_inner);
    }

    public override void Write(char value)
    {
        _inner.Write(value);
        if (_listening)
        {
            Feed(value);
        }
    }

    public override void Write(string? value)
    {
        _inner.Write(value);
        if (_listening && value is not null)
        {
            Feed(value);
        }
    }

    public override void Write(char[] buffer, int index, int count)
    {
        _inner.Write(buffer, index, count);
        if (_listening)
        {
            Feed(new string(buffer, index, count));
        }
    }

    public override void Flush() => _inner.Flush();

    protected override void Dispose(bool disposing) => Flush();

    private void Feed(string text)
    {
        foreach (var value in text)
        {
            Feed(value);
        }
    }

    private void Feed(char value)
    {
        // A carriage return is the other half of a CRLF and never part of a line here.
        if (value == '\r')
        {
            return;
        }

        string? complete = null;
        lock (_gate)
        {
            if (value != '\n')
            {
                _buffer.Append(value);
            }

            if (value == '\n' || _buffer.Length >= MaxLineLength)
            {
                complete = _buffer.ToString();
                _buffer.Clear();
            }
        }

        if (complete is not { Length: > 0 })
        {
            return;
        }

        try
        {
            _line(complete);
        }
        catch (Exception)
        {
            // A tap that throws would take the server's console down with it. The one
            // caller only enqueues a string, so there is nothing here to report to.
        }
    }
}
