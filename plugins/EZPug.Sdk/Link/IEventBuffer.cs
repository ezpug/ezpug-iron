using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>The unacked-event buffer</b>: every vocabulary event the server emits gets the
/// next link <c>seq</c> and stays here until the orchestrator's <c>ack</c> names it,
/// whatever the ack said (<c>packages/protocol/src/server-link.ts</c>). At-least-once
/// delivery is this buffer plus the resend on reconnect; the orchestrator's per-server
/// dedup makes the duplicates harmless. <see cref="LastSeq"/> survives a restart when
/// the implementation is on disk, so a fresh process continues the count rather than
/// starting a second one.
/// </summary>
public interface IEventBuffer
{
    /// <summary>The last link seq handed out; <c>0</c> on a fresh install.</summary>
    long LastSeq { get; }

    /// <summary>Everything not yet acked, in seq order.</summary>
    IReadOnlyList<SequencedEvent> Pending();

    /// <summary>Assign the next seq and keep the event until it is acked.</summary>
    SequencedEvent Append(GameserverEvent gameserverEvent);

    /// <summary>The orchestrator answered for <paramref name="seq"/>.</summary>
    void Acked(long seq);

    /// <summary><c>welcome.ackedSeq</c>: everything at or below is known to the orchestrator.</summary>
    void AckedThrough(long seq);
}

/// <summary>In memory: the harness and the tests. Lost with the process, exactly as a test wants.</summary>
public sealed class MemoryEventBuffer : IEventBuffer
{
    private readonly List<SequencedEvent> _pending = [];
    private long _lastSeq;

    public MemoryEventBuffer(long lastSeq = 0)
    {
        _lastSeq = lastSeq;
    }

    public long LastSeq => _lastSeq;

    public IReadOnlyList<SequencedEvent> Pending() => _pending.ToList();

    public SequencedEvent Append(GameserverEvent gameserverEvent)
    {
        var sequenced = new SequencedEvent { Seq = ++_lastSeq, Event = gameserverEvent };
        _pending.Add(sequenced);
        return sequenced;
    }

    public void Acked(long seq) => _pending.RemoveAll(entry => entry.Seq == seq);

    public void AckedThrough(long seq) => _pending.RemoveAll(entry => entry.Seq <= seq);
}
