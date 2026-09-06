using System.Collections.Concurrent;
using System.Threading.Channels;
using EZPug.Sdk;

namespace EZPug.Sdk.Testing;

/// <summary>
/// A socket a test plays the orchestrator on: <see cref="Deliver"/> hands the client a
/// frame, <see cref="Close"/> ends it from the peer's side, <see cref="NextSentAsync"/>
/// awaits what the client wrote. Sessions come from a <see cref="ScriptedLinkSocketFactory"/>
/// in the order the client dials.
///
/// <para>The client writes from the thread pool while the test reads from its own thread,
/// so <see cref="Sent"/> hands out a snapshot taken under the same lock the writer takes.</para>
/// </summary>
public sealed class ScriptedLinkSocket : ILinkSocket
{
    private readonly Channel<LinkReceived> _inbound = Channel.CreateUnbounded<LinkReceived>();
    private readonly Channel<string> _outbound = Channel.CreateUnbounded<string>();
    private readonly TaskCompletionSource<LinkClosure> _closedByClient = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<string> _sent = [];

    /// <summary>Every frame the client has written so far, in order — a copy, safe to read while it writes.</summary>
    public IReadOnlyList<string> Sent
    {
        get
        {
            lock (_sent)
            {
                return _sent.ToList();
            }
        }
    }

    /// <summary>Set when the client closed this socket, with its code and reason.</summary>
    public Task<LinkClosure> ClosedByClient => _closedByClient.Task;

    public void Deliver(string frameJson) => _inbound.Writer.TryWrite(new LinkReceived.Text(frameJson));

    public void Close(int code, string reason = "") => _inbound.Writer.TryWrite(new LinkReceived.Closed(new LinkClosure(code, reason)));

    /// <summary>
    /// The next frame the client sent, in order, within <paramref name="timeoutMs"/> —
    /// the bound is <see cref="Patience"/>'s safety net, not the mechanism.
    /// </summary>
    public async Task<string> NextSentAsync(int timeoutMs = Patience.TimeoutMs)
    {
        using var timeout = new CancellationTokenSource(timeoutMs);
        try
        {
            return await _outbound.Reader.ReadAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            var sent = Sent;
            throw new TimeoutException($"the client sent nothing within {timeoutMs} ms; it had sent {sent.Count} frames");
        }
    }

    public Task SendAsync(string text, CancellationToken cancellationToken)
    {
        lock (_sent)
        {
            _sent.Add(text);
        }

        _outbound.Writer.TryWrite(text);
        return Task.CompletedTask;
    }

    public async Task<LinkReceived> ReceiveAsync(CancellationToken cancellationToken) =>
        await _inbound.Reader.ReadAsync(cancellationToken).ConfigureAwait(false);

    public Task CloseAsync(int code, string reason, CancellationToken cancellationToken)
    {
        _closedByClient.TrySetResult(new LinkClosure(code, reason));
        _inbound.Writer.TryWrite(new LinkReceived.Closed(new LinkClosure(code, reason)));
        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

public sealed class ScriptedLinkSocketFactory : ILinkSocketFactory
{
    private readonly Channel<ScriptedLinkSocket> _next = Channel.CreateUnbounded<ScriptedLinkSocket>();
    private readonly ConcurrentQueue<string> _refusals = new();
    private readonly List<ScriptedLinkSocket> _sockets = [];

    /// <summary>Every socket handed out so far — a copy, so counting them races nothing.</summary>
    public IReadOnlyList<ScriptedLinkSocket> Sockets
    {
        get
        {
            lock (_sockets)
            {
                return _sockets.ToList();
            }
        }
    }

    /// <summary>The socket the client's next dial gets. Hand out one per session, in order.</summary>
    public ScriptedLinkSocket Expect()
    {
        var socket = new ScriptedLinkSocket();
        lock (_sockets)
        {
            _sockets.Add(socket);
        }

        _next.Writer.TryWrite(socket);
        return socket;
    }

    /// <summary>Make the next dial fail with <paramref name="message"/>, as a refused connection would.</summary>
    public void Refuse(string message = "connection refused") => _refusals.Enqueue(message);

    public async Task<ILinkSocket> ConnectAsync(Uri url, CancellationToken cancellationToken)
    {
        if (_refusals.TryDequeue(out var message))
        {
            throw new IOException(message);
        }

        return await _next.Reader.ReadAsync(cancellationToken).ConfigureAwait(false);
    }
}
