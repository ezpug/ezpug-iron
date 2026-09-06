using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>What the recorded exchanges cannot show: the reconnect loop on the clock, the fatal codes, the buffer across sessions, the heartbeat timer, a backup kept for the next socket.</summary>
public class LinkClientTests
{
    private static readonly GameserverSource Source = new() { Provider = "nodes", ServerId = "devbox-1" };
    private const string MatchId = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";

    private sealed class Rig : IPlatformLinkHandler
    {
        public FakeClock Clock { get; } = new();
        public ScriptedLinkSocketFactory Sockets { get; } = new();
        public MemoryEventBuffer Buffer { get; } = new();
        public LinkClient Client { get; }
        public List<(LinkClosure Closure, bool Fatal)> Downs { get; } = [];
        private readonly List<string> _log = [];
        private readonly SemaphoreSlim _logged = new(0);

        /// <summary>Every line logged so far — a copy, because the client logs from the thread pool.</summary>
        public IReadOnlyList<string> Log
        {
            get
            {
                lock (_log)
                {
                    return _log.ToList();
                }
            }
        }

        public Rig(long backoffInitialMs = 1_000, long backoffMaxMs = 30_000)
        {
            Client = new LinkClient(new LinkClientOptions
            {
                Url = new Uri("ws://orchestrator.test/link"),
                Token = "ezs_not-a-secret_server_token_0001",
                Hello = new HelloFacts(new ServerVersions { Plugin = "0.1.0", Sdk = "0.1.0", CounterStrikeSharp = "1.0.373" }, [GamemodeCapability.Chat], ["EZPug.Core"], "rig"),
                Status = () => new LinkStatus(LinkServerState.Idle, "de_dust2", 0, null),
                Clock = Clock,
                Buffer = Buffer,
                Sockets = Sockets,
                BackoffInitialMs = backoffInitialMs,
                BackoffMaxMs = backoffMaxMs,
                Log = new SignallingLog(this),
            });
            Client.Handler = this;
        }

        /// <summary>Every line the client logs releases the semaphore, so a test waits for a line rather than polling for it.</summary>
        private sealed class SignallingLog(Rig rig) : ILinkLog
        {
            public void Info(string message) => rig.Logged("info: " + message);

            public void Warn(string message) => rig.Logged("warn: " + message);
        }

        private void Logged(string line)
        {
            lock (_log)
            {
                _log.Add(line);
            }

            _logged.Release();
        }

        /// <summary>Resolves once a logged line satisfies <paramref name="condition"/>; the bounded wait is <see cref="Patience"/>'s safety net, not the mechanism.</summary>
        public async Task LoggedAsync(Func<string, bool> condition, int timeoutMs = Patience.TimeoutMs)
        {
            using var timeout = new CancellationTokenSource(timeoutMs);
            var seen = 0;
            while (true)
            {
                List<string> snapshot;
                lock (_log)
                {
                    snapshot = _log.Skip(seen).ToList();
                    seen = _log.Count;
                }

                if (snapshot.Any(condition))
                {
                    return;
                }

                try
                {
                    await _logged.WaitAsync(timeout.Token);
                }
                catch (OperationCanceledException)
                {
                    throw new TimeoutException($"no log line matched within {timeoutMs} ms; the log holds: {string.Join(" | ", Log)}");
                }
            }
        }

        public int LogCount(Func<string, bool> condition)
        {
            lock (_log)
            {
                return _log.Count(condition);
            }
        }

        public static string Welcome(long ackedSeq = 0, long heartbeatIntervalMs = 10_000) =>
            ProtocolJson.Serialize<OrchestratorFrame>(new WelcomeOrchestratorFrame { Provider = "nodes", ServerId = "devbox-1", HeartbeatIntervalMs = heartbeatIntervalMs, AckedSeq = ackedSeq });

        public static string Ack(params long[] seqs) =>
            ProtocolJson.Serialize<OrchestratorFrame>(new AckOrchestratorFrame
            {
                Results = seqs.Select(seq => new AckOrchestratorFrameResult { Seq = seq, Status = LinkAckStatus.Accepted }).ToList(),
            });

        public static GameserverEvent Ready(string map) => new ServerReadyEvent { MatchId = MatchId, Source = Source, Map = map };

        public async Task<ScriptedLinkSocket> ExpectHelloAsync()
        {
            var socket = Sockets.Expect();
            var hello = ProtocolJson.Deserialize<ServerFrame>(await socket.NextSentAsync());
            Assert.IsType<HelloServerFrame>(hello);
            return socket;
        }

        /// <summary>One inbound frame applied on the socket thread; the bound is <see cref="Patience"/>'s, not a latency claim.</summary>
        public async Task WaitProcessedAsync()
        {
            using var timeout = new CancellationTokenSource(Patience.TimeoutMs);
            await Client.Processed.WaitAsync(timeout.Token);
        }

        public void OnWelcome(WelcomeOrchestratorFrame welcome) { }
        public void OnAssign(AssignOrchestratorFrame assignment) { }
        public void OnRelease(string? reason) { }
        public void OnDrain() { }
        public void OnProfile(RosterEntry player) { }
        public CommandAnswer OnCommand(LinkCommand command) => CommandAnswer.Applied;
        public IReadOnlyList<ConsoleLine> OnConsoleRequest(int lines) => [];
        public CommandVerdict OnPlayerCommand(PlayerCommandOrchestratorFrame command) => CommandVerdict.Ok(null, null);
        public void OnLinkDown(LinkClosure closure, bool fatal) => Downs.Add((closure, fatal));
    }

    [Fact]
    public async Task NothingButHelloIsSentBeforeWelcomeAndTheBufferFlushesAfterIt()
    {
        var rig = new Rig();
        rig.Client.Emit(Rig.Ready("de_mirage"));
        rig.Client.ReportState(LinkServerState.Idle);
        var run = rig.Client.RunSessionAsync(CancellationToken.None);
        var socket = await rig.ExpectHelloAsync();
        Assert.Single(socket.Sent);
        Assert.Contains("\"lastSeq\":1", socket.Sent[0]);

        socket.Deliver(Rig.Welcome());
        var flushed = ProtocolJson.Deserialize<ServerFrame>(await socket.NextSentAsync());
        var events = Assert.IsType<EventsServerFrame>(flushed);
        Assert.Equal([1L], events.Events.Select(entry => entry.Seq));
        Assert.True(rig.Client.Connected);

        socket.Close(1000, "done");
        Assert.Equal(1000, (await run).Code);
        Assert.False(rig.Client.Connected);
    }

    [Fact]
    public async Task TheLoopReconnectsWithDoublingBackoffOnTheClockAndResetsItOnWelcome()
    {
        var rig = new Rig(backoffInitialMs: 1_000, backoffMaxMs: 4_000);
        using var stop = new CancellationTokenSource();
        var run = rig.Client.RunAsync(stop.Token);

        var first = await rig.ExpectHelloAsync();
        first.Close(1006, "network");
        await rig.LoggedAsync(line => line.Contains("reconnecting in 1000 ms"));
        rig.Client.Pump();
        Assert.Equal((1006, false), (rig.Downs[^1].Closure.Code, rig.Downs[^1].Fatal));

        // Not before the wait: no dial. The clock moves 999 ms, still nothing; the last ms dials.
        rig.Clock.Advance(999);
        Assert.Single(rig.Sockets.Sockets);
        rig.Clock.Advance(1);
        var second = await rig.ExpectHelloAsync();
        second.Close(ProtocolConstants.CloseShuttingDown, "restart");
        await rig.LoggedAsync(line => line.Contains("reconnecting in 2000 ms"));
        rig.Clock.Advance(2_000);
        var third = await rig.ExpectHelloAsync();
        third.Close(ProtocolConstants.CloseReplaced, "newer socket");
        await rig.LoggedAsync(line => line.Contains("reconnecting in 4000 ms"));
        rig.Clock.Advance(4_000);
        var fourth = await rig.ExpectHelloAsync();
        fourth.Close(1011, "again");
        // Capped at the maximum.
        await rig.LoggedAsync(_ => rig.LogCount(line => line.Contains("reconnecting in 4000 ms")) == 2);
        rig.Clock.Advance(4_000);
        var fifth = await rig.ExpectHelloAsync();
        fifth.Deliver(Rig.Welcome());
        await rig.WaitProcessedAsync();
        fifth.Close(1006, "");
        // A welcome reset the backoff to the initial value.
        await rig.LoggedAsync(_ => rig.LogCount(line => line.Contains("reconnecting in 1000 ms")) == 2);

        stop.Cancel();
        await run;
    }

    [Theory]
    [InlineData(ProtocolConstants.CloseUnauthorized)]
    [InlineData(ProtocolConstants.CloseProtocolMismatch)]
    [InlineData(ProtocolConstants.CloseMalformed)]
    [InlineData(ProtocolConstants.CloseRevoked)]
    public async Task ADecisionCloseStopsTheLoopAndIsReportedFatal(int code)
    {
        var rig = new Rig();
        var run = rig.Client.RunAsync(CancellationToken.None);
        var socket = await rig.ExpectHelloAsync();
        socket.Close(code, "no");
        await run;
        rig.Client.Pump();
        var down = Assert.Single(rig.Downs);
        Assert.True(down.Fatal);
        Assert.Equal(code, down.Closure.Code);
        Assert.Single(rig.Sockets.Sockets);
        Assert.Contains(rig.Log, line => line.Contains("not reconnecting"));
    }

    [Fact]
    public async Task ARefusedDialIsAHiccupToo()
    {
        var rig = new Rig(backoffInitialMs: 500);
        using var stop = new CancellationTokenSource();
        rig.Sockets.Refuse("connection refused");
        var run = rig.Client.RunAsync(stop.Token);
        await rig.LoggedAsync(line => line.Contains("1006 (connection refused); reconnecting in 500 ms"));
        rig.Clock.Advance(500);
        await rig.ExpectHelloAsync();
        stop.Cancel();
        await run;
    }

    [Fact]
    public async Task UnackedEventsSurviveASessionAndOnlyThePartAboveAckedSeqIsResent()
    {
        var rig = new Rig();
        var run = rig.Client.RunSessionAsync(CancellationToken.None);
        var socket = await rig.ExpectHelloAsync();
        socket.Deliver(Rig.Welcome());
        await rig.WaitProcessedAsync();
        rig.Client.EmitBatch([Rig.Ready("a"), Rig.Ready("b"), Rig.Ready("c")]);
        await socket.NextSentAsync();
        socket.Deliver(Rig.Ack(1));
        await rig.WaitProcessedAsync();
        Assert.Equal([2L, 3L], rig.Buffer.Pending().Select(entry => entry.Seq));
        socket.Close(1006, "");
        await run;

        // The orchestrator persisted through 2 on its side; only 3 is owed.
        rig.Client.Emit(Rig.Ready("d"));
        var again = rig.Client.RunSessionAsync(CancellationToken.None);
        var next = await rig.ExpectHelloAsync();
        Assert.Contains("\"lastSeq\":4", next.Sent[0]);
        next.Deliver(Rig.Welcome(ackedSeq: 2));
        var flushed = Assert.IsType<EventsServerFrame>(ProtocolJson.Deserialize<ServerFrame>(await next.NextSentAsync()));
        Assert.Equal([3L, 4L], flushed.Events.Select(entry => entry.Seq));
        Assert.Equal([3L, 4L], rig.Buffer.Pending().Select(entry => entry.Seq));
        await rig.Client.CloseAsync();
        await again;
    }

    [Fact]
    public async Task ALargeBacklogIsResentInBatchesOfTheProtocolsMaximum()
    {
        var rig = new Rig();
        for (var i = 0; i < ProtocolConstants.EventsBatchMax + 5; i++)
        {
            rig.Client.Emit(Rig.Ready($"map{i}"));
        }

        var run = rig.Client.RunSessionAsync(CancellationToken.None);
        var socket = await rig.ExpectHelloAsync();
        socket.Deliver(Rig.Welcome());
        var first = Assert.IsType<EventsServerFrame>(ProtocolJson.Deserialize<ServerFrame>(await socket.NextSentAsync()));
        var second = Assert.IsType<EventsServerFrame>(ProtocolJson.Deserialize<ServerFrame>(await socket.NextSentAsync()));
        Assert.Equal(ProtocolConstants.EventsBatchMax, first.Events.Count);
        Assert.Equal(5, second.Events.Count);
        Assert.Equal(ProtocolConstants.EventsBatchMax + 1, second.Events[0].Seq);
        await rig.Client.CloseAsync();
        await run;
    }

    [Fact]
    public async Task HeartbeatsFollowTheWelcomesIntervalOnTheClockAndStopWithTheSession()
    {
        var rig = new Rig();
        var run = rig.Client.RunSessionAsync(CancellationToken.None);
        var socket = await rig.ExpectHelloAsync();
        socket.Deliver(Rig.Welcome(heartbeatIntervalMs: 5_000));
        await rig.WaitProcessedAsync();
        rig.Clock.Advance(4_999);
        Assert.Single(socket.Sent);
        rig.Clock.Advance(1);
        var beat = Assert.IsType<HeartbeatServerFrame>(ProtocolJson.Deserialize<ServerFrame>(await socket.NextSentAsync()));
        Assert.Equal(5_000, beat.UptimeMs);
        rig.Clock.Advance(5_000);
        await socket.NextSentAsync();
        socket.Close(1006, "");
        await run;
        rig.Clock.Advance(50_000);
        Assert.Equal(3, socket.Sent.Count);
        Assert.Equal(0, rig.Clock.Pending);
    }

    [Fact]
    public async Task ABackupWrittenWhileOfflineCrossesOnTheNextSocket()
    {
        var rig = new Rig();
        rig.Client.SendBackup(MatchId, new RoundBackup { MapNumber = 1, RoundNumber = 3, Filename = "r3.cfg", Content = "\"round\" {}\n" });
        var run = rig.Client.RunSessionAsync(CancellationToken.None);
        var socket = await rig.ExpectHelloAsync();
        socket.Deliver(Rig.Welcome());
        var backup = Assert.IsType<BackupServerFrame>(ProtocolJson.Deserialize<ServerFrame>(await socket.NextSentAsync()));
        Assert.Equal(3, backup.Backup.RoundNumber);
        await rig.Client.CloseAsync();
        await run;
    }

    [Fact]
    public async Task AnUnreadableFrameIsLoggedAndTheLinkStaysUp()
    {
        var rig = new Rig();
        var run = rig.Client.RunSessionAsync(CancellationToken.None);
        var socket = await rig.ExpectHelloAsync();
        socket.Deliver(Rig.Welcome());
        await rig.WaitProcessedAsync();
        socket.Deliver("{\"type\":\"teleport\"}");
        await rig.LoggedAsync(line => line.Contains("unreadable frame"));
        Assert.True(rig.Client.Connected);
        await rig.Client.CloseAsync();
        await run;
    }
}
