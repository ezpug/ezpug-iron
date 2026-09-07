using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>What the hello reports about this build and this box.</summary>
public sealed record HelloFacts(
    ServerVersions Versions,
    IReadOnlyList<GamemodeCapability> Capabilities,
    /// <summary>Plugin folders present in the image, whether or not enabled.</summary>
    IReadOnlyList<string> Plugins,
    string Hostname);

/// <summary>Where the link client writes about itself. Never a frame, never a token.</summary>
public interface ILinkLog
{
    void Info(string message);
    void Warn(string message);
}

public sealed class NullLinkLog : ILinkLog
{
    public static readonly NullLinkLog Instance = new();

    public void Info(string message) { }

    public void Warn(string message) { }
}

public sealed class LinkClientOptions
{
    public required Uri Url { get; init; }
    public required string Token { get; init; }
    public required HelloFacts Hello { get; init; }
    /// <summary>What the hello and every heartbeat report: state, map, players, the match held.</summary>
    public required Func<LinkStatus> Status { get; init; }
    public required IClock Clock { get; init; }
    public required IEventBuffer Buffer { get; init; }
    public ILinkSocketFactory Sockets { get; init; } = new ClientWebSocketFactory();
    public ILinkLog Log { get; init; } = NullLinkLog.Instance;
    /// <summary>The first wait after a lost socket; doubles per failure up to <see cref="BackoffMaxMs"/>, resets on <c>welcome</c>.</summary>
    public long BackoffInitialMs { get; init; } = 1_000;
    public long BackoffMaxMs { get; init; } = 30_000;
}

/// <summary>
/// <b>The link client</b> (decision 5, PRD-02 T7): one outbound WebSocket to the
/// orchestrator's <c>/link</c>, and the behaviour the TypeScript fake server pins in
/// <c>packages/protocol/fixtures/link/*.json</c> — <c>EZPug.Sdk.Tests</c> replays those
/// files against this class frame for frame.
///
/// <list type="bullet">
/// <item>The first frame is <c>hello</c>; nothing else is sent before <c>welcome</c>.</item>
/// <item>Every event gets the buffer's next <c>seq</c> and stays there until an <c>ack</c>
/// names it. On <c>welcome</c>, everything at or below <c>ackedSeq</c> is dropped and the
/// rest resent in order in batches of <see cref="ProtocolConstants.EventsBatchMax"/>.</item>
/// <item><c>command</c> → <c>command_result</c> (a <c>console</c> command → a <c>console</c>
/// frame), <c>player_command</c> → <c>player_command_result</c>, each with the
/// <c>correlationId</c> it came with; <c>assign</c>, <c>release</c> and <c>drain</c> are the
/// handler's to answer with a <c>state</c>.</item>
/// <item>A heartbeat every <c>welcome.heartbeatIntervalMs</c>, on the clock.</item>
/// <item>Reconnect with capped exponential backoff on the clock after a lost socket or a
/// close the protocol calls a hiccup (1000, 1001, 1005, 1006, 1011, <c>replaced</c>,
/// <c>shuttingDown</c>); stop, and tell the handler it is fatal, after a close that is a
/// decision (<c>unauthorized</c>, <c>protocolMismatch</c>, <c>malformed</c>, <c>revoked</c>).</item>
/// </list>
///
/// Threads: the socket is read and written on the thread pool; <see cref="Emit"/> and the
/// other outbound verbs may be called from any thread; inbound frames queue until
/// <see cref="Pump"/> delivers them to the handler on the caller's thread — the game
/// thread in production, so a handler never locks. Acks and the welcome's buffer
/// bookkeeping happen on the socket thread under one lock, so an event emitted while a
/// welcome is being applied is neither lost nor sent twice in one session.
/// </summary>
public sealed class LinkClient : IPlatformLink, IAsyncDisposable
{
    private static readonly HashSet<int> FatalCloseCodes =
    [
        ProtocolConstants.CloseUnauthorized,
        ProtocolConstants.CloseProtocolMismatch,
        ProtocolConstants.CloseMalformed,
        ProtocolConstants.CloseRevoked,
    ];

    private readonly LinkClientOptions _options;
    private readonly IClock _clock;
    private readonly IEventBuffer _buffer;
    private readonly ConcurrentQueue<Action<IPlatformLinkHandler>> _inbox = new();
    private readonly object _gate = new();

    private Session? _session;
    private GameserverSource? _source;

    /// <summary>Released once per inbound frame after it was applied — how a test waits for the socket thread without polling.</summary>
    internal SemaphoreSlim Processed { get; } = new(0);
    private BackupServerFrame? _pendingBackup;
    private long _backoffMs;
    private bool _stopped;

    public LinkClient(LinkClientOptions options)
    {
        _options = options;
        _clock = options.Clock;
        _buffer = options.Buffer;
        _backoffMs = options.BackoffInitialMs;
    }

    public GameserverSource? Source => _source;

    public bool Connected
    {
        get
        {
            lock (_gate)
            {
                return _session is { Welcomed: true };
            }
        }
    }

    public IPlatformLinkHandler? Handler { get; set; }

    /// <summary>The clock.s monotonic count — milliseconds since the plugin loaded, the server.s own clock on the wire.</summary>
    public long UptimeMs => _clock.NowMs;

    /// <summary>The last seq handed out and the events still unacked — for a status line.</summary>
    public (long LastSeq, int Pending) BufferState => (_buffer.LastSeq, _buffer.Pending().Count);

    // ------------------------------------------------------------------ outbound

    public void Emit(GameserverEvent gameserverEvent) => EmitBatch([gameserverEvent]);

    /// <summary>Several events that belong together (a round's end and its backup): consecutive seqs, one frame per <see cref="ProtocolConstants.EventsBatchMax"/>.</summary>
    public void EmitBatch(IReadOnlyList<GameserverEvent> events)
    {
        if (events.Count == 0)
        {
            return;
        }

        lock (_gate)
        {
            var sequenced = events.Select(_buffer.Append).ToList();
            if (_session is { Welcomed: true } session)
            {
                for (var at = 0; at < sequenced.Count; at += ProtocolConstants.EventsBatchMax)
                {
                    session.Enqueue(new EventsServerFrame { Events = sequenced.Skip(at).Take(ProtocolConstants.EventsBatchMax).ToList() });
                }
            }
        }
    }

    public void ReportState(LinkServerState state, string? matchId = null, string? detail = null) =>
        Send(new StateServerFrame { State = state, MatchId = matchId, Detail = detail });

    public void SendBackup(string matchId, RoundBackup backup)
    {
        var frame = new BackupServerFrame { MatchId = matchId, Backup = backup };
        lock (_gate)
        {
            if (_session is { Welcomed: true } session)
            {
                _pendingBackup = null;
                session.Enqueue(frame);
            }
            else
            {
                _pendingBackup = frame;
            }
        }
    }

    public void SendConsole(IReadOnlyList<ConsoleLine> lines, string? correlationId = null) =>
        Send(new ConsoleServerFrame { CorrelationId = correlationId, UptimeMs = UptimeMs, Lines = lines });

    /// <summary>
    /// A push for one player's widget. Sent on the open session or dropped —
    /// deliberately not buffered like an event, because the point of a push is that it
    /// was true a moment ago; one that arrives after a reconnect would be a lie drawn on
    /// a phone.
    /// </summary>
    public void PushWidget(string matchId, ulong steamId64, WidgetPushServerFramePush push) =>
        Send(new WidgetPushServerFrame
        {
            MatchId = matchId,
            SteamId64 = steamId64.ToString(),
            Push = push,
        });

    public void AnswerCommand(string correlationId, CommandAnswer answer) =>
        Send(new CommandResultServerFrame
        {
            CorrelationId = correlationId,
            Status = answer.Status,
            Code = answer.Code,
            Message = answer.Message,
            Output = answer.Output,
        });

    /// <summary>One heartbeat now, from <see cref="LinkClientOptions.Status"/>. The interval timer calls this.</summary>
    public void Heartbeat()
    {
        var status = _options.Status();
        Send(new HeartbeatServerFrame
        {
            State = status.State,
            Map = status.Map,
            PlayerCount = status.PlayerCount,
            MatchId = status.MatchId,
            UptimeMs = UptimeMs,
        });
    }

    /// <summary>Send any frame on the open, welcomed session; dropped otherwise (events go through <see cref="Emit"/>, which buffers).</summary>
    internal bool Send(ServerFrame frame)
    {
        lock (_gate)
        {
            if (_session is { Welcomed: true } session)
            {
                session.Enqueue(frame);
                return true;
            }

            return false;
        }
    }

    // ------------------------------------------------------------------ inbound

    public void Pump()
    {
        var handler = Handler;
        while (_inbox.TryDequeue(out var deliver))
        {
            if (handler is not null)
            {
                deliver(handler);
            }
        }
    }

    // ------------------------------------------------------------------ sessions

    /// <summary>
    /// Connect, say hello, serve until the socket closes, reconnect after a wait on the
    /// clock, until <paramref name="cancellationToken"/> or a fatal close. The plugin's
    /// whole life on the link is one call.
    /// </summary>
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var closure = await RunSessionAsync(cancellationToken).ConfigureAwait(false);
            lock (_gate)
            {
                if (_stopped || cancellationToken.IsCancellationRequested)
                {
                    return;
                }
            }

            var fatal = FatalCloseCodes.Contains(closure.Code);
            _inbox.Enqueue(handler => handler.OnLinkDown(closure, fatal));
            if (fatal)
            {
                _options.Log.Warn($"link closed {closure}; not reconnecting");
                return;
            }

            long wait;
            lock (_gate)
            {
                wait = _backoffMs;
                _backoffMs = Math.Min(_backoffMs * 2, _options.BackoffMaxMs);
            }

            // Arm first, say so second. The line is what tells the outside world the wait
            // exists — a test whose timeline is an injected clock reads it and then
            // advances, and a timer armed after that advance would sleep straight through
            // it. Logging after the arming makes the line a promise, not a prediction.
            var waited = WaitAsync(wait, cancellationToken);
            _options.Log.Info($"link closed {closure}; reconnecting in {wait} ms");
            await waited.ConfigureAwait(false);
        }
    }

    /// <summary>One session: connect, hello, serve until closed. Resolves with how it ended. A test drives these one at a time.</summary>
    public async Task<LinkClosure> RunSessionAsync(CancellationToken cancellationToken)
    {
        ILinkSocket socket;
        try
        {
            socket = await _options.Sockets.ConnectAsync(_options.Url, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return new LinkClosure(1000, "stopped");
        }
        catch (Exception error)
        {
            return new LinkClosure(1006, error.Message);
        }

        var session = new Session(socket, this);
        lock (_gate)
        {
            _session = session;
        }

        try
        {
            return await session.ServeAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            lock (_gate)
            {
                if (ReferenceEquals(_session, session))
                {
                    _session = null;
                }
            }

            await socket.DisposeAsync().ConfigureAwait(false);
        }
    }

    /// <summary>Close the current socket from this side (1000) and stop <see cref="RunAsync"/>'s loop.</summary>
    public async Task CloseAsync(string reason = "")
    {
        Session? session;
        lock (_gate)
        {
            _stopped = true;
            session = _session;
        }

        if (session is not null)
        {
            await session.CloseAsync(1000, reason).ConfigureAwait(false);
        }
    }

    /// <summary>Close the current socket without stopping the loop — a test of the reconnect.</summary>
    public async Task DisconnectAsync(string reason = "")
    {
        Session? session;
        lock (_gate)
        {
            session = _session;
        }

        if (session is not null)
        {
            await session.CloseAsync(1000, reason).ConfigureAwait(false);
        }
    }

    public ValueTask DisposeAsync() => new(CloseAsync("disposed"));

    private Task WaitAsync(long delayMs, CancellationToken cancellationToken)
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var timer = _clock.After(delayMs, () => done.TrySetResult());
        cancellationToken.Register(() =>
        {
            timer.Cancel();
            done.TrySetResult();
        });
        return done.Task;
    }

    private HelloServerFrame BuildHello()
    {
        var status = _options.Status();
        var hello = _options.Hello;
        return new HelloServerFrame
        {
            Token = _options.Token,
            Versions = hello.Versions,
            Capabilities = hello.Capabilities,
            Plugins = hello.Plugins,
            Hostname = hello.Hostname,
            Map = status.Map,
            State = status.State,
            MatchId = status.MatchId,
            LastSeq = _buffer.LastSeq,
        };
    }

    /// <summary>The welcome, on the socket thread: settle the buffer, flush what is owed, arm the heartbeat.</summary>
    private void OnWelcome(Session session, WelcomeOrchestratorFrame welcome)
    {
        lock (_gate)
        {
            _source = new GameserverSource { Provider = welcome.Provider, ServerId = welcome.ServerId };
            _buffer.AckedThrough(welcome.AckedSeq);
            session.Welcomed = true;
            _backoffMs = _options.BackoffInitialMs;
            var pending = _buffer.Pending();
            for (var at = 0; at < pending.Count; at += ProtocolConstants.EventsBatchMax)
            {
                var batch = pending.Skip(at).Take(ProtocolConstants.EventsBatchMax).ToList();
                session.Enqueue(new EventsServerFrame { Events = batch });
            }

            if (_pendingBackup is { } backup)
            {
                _pendingBackup = null;
                session.Enqueue(backup);
            }

            session.HeartbeatTimer = _clock.Every(welcome.HeartbeatIntervalMs, Heartbeat);
        }

        _inbox.Enqueue(handler => handler.OnWelcome(welcome));
    }

    private void OnAck(AckOrchestratorFrame ack)
    {
        lock (_gate)
        {
            foreach (var result in ack.Results)
            {
                _buffer.Acked(result.Seq);
                if (result.Status == LinkAckStatus.Rejected)
                {
                    _options.Log.Warn($"event {result.Seq} rejected: {result.Message}");
                }
            }
        }
    }

    /// <summary>Everything the handler answers, queued for the pump; the answer is sent from there.</summary>
    private void Dispatch(OrchestratorFrame frame)
    {
        switch (frame)
        {
            case AssignOrchestratorFrame assign:
                _inbox.Enqueue(handler => handler.OnAssign(assign));
                break;
            case ReleaseOrchestratorFrame release:
                _inbox.Enqueue(handler => handler.OnRelease(release.Reason));
                break;
            case DrainOrchestratorFrame:
                _inbox.Enqueue(handler => handler.OnDrain());
                break;
            case ProfileOrchestratorFrame profile:
                _inbox.Enqueue(handler => handler.OnProfile(profile.Player));
                break;
            case CommandOrchestratorFrame { Command: ConsoleCommand console }:
                _inbox.Enqueue(handler =>
                {
                    var lines = handler.OnConsoleRequest((int)Math.Min(console.Lines, ProtocolConstants.ConsoleTailMax));
                    SendConsole(lines, console.CorrelationId);
                });
                break;
            case CommandOrchestratorFrame command:
                _inbox.Enqueue(handler =>
                {
                    var answer = handler.OnCommand(command.Command);
                    if (!answer.IsDeferred)
                    {
                        AnswerCommand(CorrelationIdOf(command.Command), answer);
                    }
                });
                break;
            case PlayerCommandOrchestratorFrame playerCommand:
                _inbox.Enqueue(handler =>
                {
                    var verdict = handler.OnPlayerCommand(playerCommand);
                    Send(new PlayerCommandResultServerFrame
                    {
                        CorrelationId = playerCommand.CorrelationId,
                        SteamId64 = playerCommand.SteamId64,
                        Command = playerCommand.Command,
                        Status = verdict.Status,
                        Code = verdict.Code,
                        Message = verdict.Message,
                        CooldownMs = verdict.CooldownMs,
                        ChargesLeft = verdict.ChargesLeft,
                    });
                });
                break;
            default:
                break;
        }
    }

    /// <summary>Every command carries one; the generated branches spell it the same way, the base does not.</summary>
    internal static string CorrelationIdOf(LinkCommand command) =>
        command switch
        {
            ConsoleCommand c => c.CorrelationId,
            PauseCommand c => c.CorrelationId,
            UnpauseCommand c => c.CorrelationId,
            RestartRoundCommand c => c.CorrelationId,
            ForceEndCommand c => c.CorrelationId,
            KickCommand c => c.CorrelationId,
            AnnounceCommand c => c.CorrelationId,
            RconCommand c => c.CorrelationId,
            RestoreCommand c => c.CorrelationId,
            RerollCommand c => c.CorrelationId,
            ProfileCommand c => c.CorrelationId,
            _ => throw new ArgumentException($"{command.GetType().Name} carries no correlationId", nameof(command)),
        };

    /// <summary>One socket's life: the hello, the writer loop, the reader loop.</summary>
    private sealed class Session
    {
        private readonly ILinkSocket _socket;
        private readonly LinkClient _client;
        private readonly Channel<string> _outbound = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
        private readonly CancellationTokenSource _lifetime = new();
        private LinkClosure? _closure;

        public Session(ILinkSocket socket, LinkClient client)
        {
            _socket = socket;
            _client = client;
        }

        public bool Welcomed { get; set; }

        public IClockTimer? HeartbeatTimer { get; set; }

        public void Enqueue(ServerFrame frame) => _outbound.Writer.TryWrite(ProtocolJson.Serialize(frame));

        public async Task<LinkClosure> ServeAsync(CancellationToken cancellationToken)
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token);
            var writer = WriteAsync(linked.Token);
            _outbound.Writer.TryWrite(ProtocolJson.Serialize<ServerFrame>(_client.BuildHello()));
            try
            {
                while (true)
                {
                    LinkReceived received;
                    try
                    {
                        received = await _socket.ReceiveAsync(linked.Token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        break;
                    }

                    if (received is LinkReceived.Closed closed)
                    {
                        _closure ??= closed.Closure;
                        break;
                    }

                    var text = ((LinkReceived.Text)received).Payload;
                    OrchestratorFrame frame;
                    try
                    {
                        frame = ProtocolJson.Deserialize<OrchestratorFrame>(text);
                    }
                    catch (JsonException error)
                    {
                        // A frame this build cannot read: an orchestrator ahead of us. Say so, keep the link.
                        _client._options.Log.Warn($"unreadable frame from the orchestrator: {error.Message}");
                        continue;
                    }

                    switch (frame)
                    {
                        case WelcomeOrchestratorFrame welcome:
                            _client.OnWelcome(this, welcome);
                            break;
                        case AckOrchestratorFrame ack:
                            _client.OnAck(ack);
                            break;
                        default:
                            _client.Dispatch(frame);
                            break;
                    }

                    _client.Processed.Release();
                }
            }
            finally
            {
                HeartbeatTimer?.Cancel();
                lock (_client._gate)
                {
                    Welcomed = false;
                }

                _outbound.Writer.TryComplete();
                _lifetime.Cancel();
                await writer.ConfigureAwait(false);
            }

            return _closure ?? new LinkClosure(cancellationToken.IsCancellationRequested ? 1000 : 1006, cancellationToken.IsCancellationRequested ? "stopped" : "");
        }

        public async Task CloseAsync(int code, string reason)
        {
            _closure ??= new LinkClosure(code, reason);
            try
            {
                await _socket.CloseAsync(code, reason, CancellationToken.None).ConfigureAwait(false);
            }
            finally
            {
                _lifetime.Cancel();
            }
        }

        private async Task WriteAsync(CancellationToken cancellationToken)
        {
            try
            {
                await foreach (var text in _outbound.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
                {
                    await _socket.SendAsync(text, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // The session ended; whatever is still queued is either in the buffer (events) or stale (a heartbeat).
            }
            catch (Exception error)
            {
                _closure ??= new LinkClosure(1006, error.Message);
                _lifetime.Cancel();
            }
        }
    }
}
