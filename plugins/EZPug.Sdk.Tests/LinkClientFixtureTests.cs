using System.Text.Json.Nodes;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>The link client against the recorded exchanges</b> (PRD-02 T6/T7): every file under
/// <c>packages/protocol/fixtures/link/</c> is what the TypeScript fake server and the real
/// <c>/link</c> said to each other. Here the C# client takes the fake's seat: the
/// orchestrator's frames are delivered to it through a scripted socket, and every frame
/// the fake sent must come out of the client byte for byte, in order.
///
/// What the client produces on its own — <c>hello</c>, the <c>state</c> answers, the flush
/// after <c>welcome</c>, <c>command_result</c>/<c>console</c>/<c>player_command_result</c> with
/// their correlation ids — is compared as it happens. What the fake's test drove by hand
/// (an event emitted, a backup written, a heartbeat, a console tail sent unsolicited, a
/// close) is driven here the same way through the client's public verbs, and the bytes
/// still have to match: the seq the client assigned, the uptime it reports, the map and
/// state it says in a hello after a reconnect. Two frames in <c>events.json</c> are the
/// fake's deliberate misbehaviour (a resend of an acked seq, a batch out of order) and go
/// through the client's raw send; the test says so where it does it.
/// </summary>
public class LinkClientFixtureTests
{
    public static IEnumerable<object[]> Exchanges() =>
        Directory.GetFiles(Repo.Path("packages", "protocol", "fixtures", "link"), "*.json")
            .Order()
            .Select(path => new object[] { Path.GetFileName(path) });

    [Theory]
    [MemberData(nameof(Exchanges))]
    public async Task TheClientReproducesTheRecordedExchange(string file)
    {
        var document = JsonNode.Parse(File.ReadAllText(Repo.Path("packages", "protocol", "fixtures", "link", file)))!.AsObject();
        var exchange = document["exchange"]!.AsArray().Select(entry => entry!.AsObject()).ToList();
        var replay = new Replay(exchange);
        await replay.RunAsync();
        Assert.True(replay.Compared > 0, $"{file}: nothing was compared");
    }

    /// <summary>One client instance: what the fake's process held.</summary>
    private sealed class Instance
    {
        public required string Token;
        public required FakeClock Clock;
        public required MemoryEventBuffer Buffer;
        public required ReplayHandler Handler;
        public required LinkClient Client;
        public int Heartbeats;
        /// <summary>The seqs the client itself resent after the last welcome; the fixture shows them as one events frame the replay must not produce twice.</summary>
        public HashSet<long> Flushed = [];
    }

    private sealed class OpenSession
    {
        public required Instance Instance;
        public required ScriptedLinkSocket Socket;
        public required Task<LinkClosure> Task;
    }

    private sealed class Replay
    {
        private readonly List<JsonObject> _exchange;
        private readonly ScriptedLinkSocketFactory _sockets = new();
        private readonly List<OpenSession> _open = [];
        private readonly Dictionary<string, JsonObject> _answers = new();
        private readonly Dictionary<string, List<JsonObject>> _eventsBeforeAnswer = new();
        private readonly HashSet<JsonObject> _producedByHandler = new(ReferenceEqualityComparer.Instance);
        private Instance? _current;
        private OpenSession? _session;

        public int Compared { get; private set; }

        public Replay(List<JsonObject> exchange)
        {
            _exchange = exchange;
            IndexAnswers();
        }

        /// <summary>Every server frame with a correlationId answers a command; the events frames between a command and its answer are what the handler emits while answering.</summary>
        private void IndexAnswers()
        {
            for (var i = 0; i < _exchange.Count; i++)
            {
                var entry = _exchange[i];
                if (From(entry) != "orchestrator" || Frame(entry) is not { } frame)
                {
                    continue;
                }

                var correlationId = frame["type"]!.GetValue<string>() switch
                {
                    "command" => frame["command"]!["correlationId"]!.GetValue<string>(),
                    "player_command" => frame["correlationId"]!.GetValue<string>(),
                    _ => null,
                };
                if (correlationId is null)
                {
                    continue;
                }

                var emitted = new List<JsonObject>();
                for (var j = i + 1; j < _exchange.Count; j++)
                {
                    var later = _exchange[j];
                    if (From(later) != "server" || Frame(later) is not { } answer)
                    {
                        continue;
                    }

                    if (answer["correlationId"]?.GetValue<string>() == correlationId)
                    {
                        _answers[correlationId] = answer;
                        _eventsBeforeAnswer[correlationId] = emitted;
                        break;
                    }

                    if (answer["type"]!.GetValue<string>() == "events")
                    {
                        emitted.Add(answer);
                    }
                }
            }
        }

        public async Task RunAsync()
        {
            for (var i = 0; i < _exchange.Count; i++)
            {
                var entry = _exchange[i];
                var from = From(entry);
                if (entry["close"] is JsonObject close)
                {
                    await HandleClose(from, close);
                    continue;
                }

                var frame = Frame(entry)!;
                if (from == "orchestrator")
                {
                    await DeliverAsync(frame);
                }
                else
                {
                    await ProduceAsync(frame, i);
                }
            }

            foreach (var session in _open.ToList())
            {
                await session.Instance.Client.CloseAsync("test over");
                await session.Task;
            }
        }

        private async Task HandleClose(string from, JsonObject close)
        {
            var code = close["code"]!.GetValue<int>();
            var reason = close["reason"]?.GetValue<string>() ?? "";
            if (from == "server")
            {
                var session = _session!;
                await session.Instance.Client.DisconnectAsync(reason);
                var closure = await session.Task;
                Assert.Equal(1000, closure.Code);
                var byClient = await session.Socket.ClosedByClient;
                Assert.Equal(code, byClient.Code);
                _open.Remove(session);
                return;
            }

            // `replaced` is told to the older socket; every other close ends the session that is talking.
            var target = code == ProtocolConstants.CloseReplaced ? _open.First() : _open.Last();
            target.Socket.Close(code, reason);
            var ended = await target.Task;
            Assert.Equal(code, ended.Code);
            Assert.Equal(reason, ended.Reason);
            _open.Remove(target);
        }

        private async Task DeliverAsync(JsonObject frame)
        {
            var session = _session!;
            var type = frame["type"]!.GetValue<string>();
            if (type == "welcome")
            {
                var ackedSeq = frame["ackedSeq"]!.GetValue<long>();
                session.Instance.Flushed = session.Instance.Buffer.Pending().Select(entry => entry.Seq).Where(seq => seq > ackedSeq).ToHashSet();
            }

            session.Socket.Deliver(Compact(frame));
            using var timeout = new CancellationTokenSource(5_000);
            await session.Instance.Client.Processed.WaitAsync(timeout.Token);
            if (type == "assign")
            {
                session.Instance.Handler.Map = frame["maps"]![0]!["map"]!.GetValue<string>();
            }

            // The pump is the game thread's frame; here it is the next line.
            session.Instance.Client.Pump();
        }

        private async Task ProduceAsync(JsonObject frame, int index)
        {
            var type = frame["type"]!.GetValue<string>();
            switch (type)
            {
                case "hello":
                    await StartSessionAsync(frame, index);
                    return;
                case "events":
                    ProduceEvents(frame);
                    break;
                case "backup":
                    _current!.Client.SendBackup(
                        frame["matchId"]!.GetValue<string>(),
                        ProtocolJson.Deserialize<RoundBackup>(frame["backup"]!.ToJsonString()));
                    break;
                case "heartbeat":
                    // The fake's uptime ticks once per heartbeat; the player count is the world's, so the test supplies it.
                    _current!.Clock.Advance(1);
                    _current.Heartbeats++;
                    _current.Handler.PlayerCount = frame["playerCount"]!.GetValue<int>();
                    _current.Client.Heartbeat();
                    break;
                case "console" when frame["correlationId"] is null:
                    _current!.Client.SendConsole(Lines(frame));
                    break;
                case "state" or "command_result" or "console" or "player_command_result":
                    // Produced by the client itself in answer to an orchestrator frame; only compared.
                    break;
                default:
                    throw new InvalidOperationException($"a server frame the replay does not drive: {type}");
            }

            await ExpectSentAsync(frame);
        }

        private void ProduceEvents(JsonObject frame)
        {
            if (_producedByHandler.Contains(frame))
            {
                // Emitted while a command was being answered; it is already on the wire, in the fixture's order.
                return;
            }

            var client = _current!.Client;
            var sequenced = frame["events"]!.AsArray().Select(node => ProtocolJson.Deserialize<SequencedEvent>(node!.ToJsonString())).ToList();
            var next = _current.Buffer.LastSeq + 1;
            var contiguous = sequenced.Select((entry, offset) => entry.Seq == next + offset).All(ok => ok);
            if (sequenced.All(entry => _current.Flushed.Contains(entry.Seq)))
            {
                // The welcome's flush already sent exactly this; nothing to produce.
                _current.Flushed.ExceptWith(sequenced.Select(entry => entry.Seq));
                return;
            }

            if (contiguous)
            {
                client.EmitBatch(sequenced.Select(entry => entry.Event).ToList());
                return;
            }

            // The fake's test resent an acked seq / sent a batch out of order to prove the orchestrator's dedup. Raw.
            client.Send(ProtocolJson.Deserialize<ServerFrame>(Compact(frame)));
        }

        private async Task StartSessionAsync(JsonObject hello, int index)
        {
            var token = hello["token"]!.GetValue<string>();
            var lastSeq = hello["lastSeq"]!.GetValue<long>();
            var fresh = _current is null || _current.Token != token || (lastSeq == 0 && _current.Buffer.LastSeq > 0);
            if (fresh)
            {
                _current = NewInstance(hello, index);
            }

            // Events the fake emitted while offline reach the hello as `lastSeq` and the session as the flush after welcome.
            var instance = _current!;
            foreach (var offline in OfflineEvents(index, instance.Buffer.LastSeq, lastSeq))
            {
                instance.Client.Emit(offline);
            }

            Assert.Equal(lastSeq, instance.Buffer.LastSeq);

            var socket = _sockets.Expect();
            var session = new OpenSession { Instance = instance, Socket = socket, Task = instance.Client.RunSessionAsync(CancellationToken.None) };
            _open.Add(session);
            _session = session;
            await ExpectSentAsync(hello);
        }

        private IEnumerable<GameserverEvent> OfflineEvents(int helloIndex, long bufferLastSeq, long helloLastSeq)
        {
            var wanted = new SortedDictionary<long, GameserverEvent>();
            for (var i = helloIndex + 1; i < _exchange.Count; i++)
            {
                var entry = _exchange[i];
                if (Frame(entry) is { } frame && frame["type"]!.GetValue<string>() == "hello")
                {
                    break;
                }

                if (From(entry) != "server" || Frame(entry) is not { } events || events["type"]!.GetValue<string>() != "events")
                {
                    continue;
                }

                foreach (var node in events["events"]!.AsArray())
                {
                    var sequenced = ProtocolJson.Deserialize<SequencedEvent>(node!.ToJsonString());
                    if (sequenced.Seq > bufferLastSeq && sequenced.Seq <= helloLastSeq)
                    {
                        wanted[sequenced.Seq] = sequenced.Event;
                    }
                }
            }

            return wanted.Values;
        }

        private Instance NewInstance(JsonObject hello, int index)
        {
            var clock = new FakeClock(UptimeAtStart(index));
            var buffer = new MemoryEventBuffer();
            var handler = new ReplayHandler(this)
            {
                LobbyMap = hello["map"]!.GetValue<string>(),
                Map = hello["map"]!.GetValue<string>(),
                State = Enum.Parse<LinkServerState>(hello["state"]!.GetValue<string>(), ignoreCase: true),
            };
            var client = new LinkClient(new LinkClientOptions
            {
                Url = new Uri("ws://orchestrator.test/link"),
                Token = hello["token"]!.GetValue<string>(),
                Hello = new HelloFacts(
                    ProtocolJson.Deserialize<ServerVersions>(hello["versions"]!.ToJsonString()),
                    hello["capabilities"]!.AsArray().Select(node => Enum.Parse<GamemodeCapability>(node!.GetValue<string>(), ignoreCase: true)).ToList(),
                    hello["plugins"]!.AsArray().Select(node => node!.GetValue<string>()).ToList(),
                    hello["hostname"]!.GetValue<string>()),
                Status = () => handler.Status(),
                Clock = clock,
                Buffer = buffer,
                Sockets = _sockets,
            });
            var instance = new Instance { Token = hello["token"]!.GetValue<string>(), Clock = clock, Buffer = buffer, Handler = handler, Client = client };
            handler.Client = client;
            client.Handler = handler;
            return instance;
        }

        /// <summary>The fake's uptime at hello: the first frame that carries one, less the heartbeats before it (each ticks the fake's uptime by one).</summary>
        private long UptimeAtStart(int helloIndex)
        {
            var heartbeats = 0;
            for (var i = helloIndex; i < _exchange.Count; i++)
            {
                if (From(_exchange[i]) != "server" || Frame(_exchange[i]) is not { } frame)
                {
                    continue;
                }

                var type = frame["type"]!.GetValue<string>();
                if (type == "heartbeat")
                {
                    heartbeats++;
                }

                if (frame["uptimeMs"] is { } uptime)
                {
                    return uptime.GetValue<long>() - heartbeats;
                }
            }

            return 0;
        }

        private async Task ExpectSentAsync(JsonObject expected)
        {
            var sent = await _session!.Socket.NextSentAsync();
            Assert.Equal(Compact(expected), sent);
            Compared++;
        }

        // ------------------------------------------------------------------ the handler

        public JsonObject AnswerFor(string correlationId) =>
            _answers.TryGetValue(correlationId, out var answer)
                ? answer
                : throw new InvalidOperationException($"the fixture holds no answer for {correlationId}");

        public IReadOnlyList<JsonObject> EmittedWhileAnswering(string correlationId) =>
            _eventsBeforeAnswer.GetValueOrDefault(correlationId) ?? [];

        public void EmitFrame(JsonObject eventsFrame)
        {
            ProduceEvents(eventsFrame);
            _producedByHandler.Add(eventsFrame);
        }

        /// <summary>The fixture's answer, or <c>null</c> where the fake's test left a command unanswered (the orchestrator's deadline was under test).</summary>
        public JsonObject? AnswerOrNull(string correlationId) => _answers.GetValueOrDefault(correlationId);

        private static string From(JsonObject entry) => entry["from"]!.GetValue<string>();

        private static JsonObject? Frame(JsonObject entry) => entry["frame"] as JsonObject;

        private static string Compact(JsonNode node) => node.ToJsonString(ProtocolJson.Options);

        private static List<ConsoleLine> Lines(JsonObject frame) =>
            frame["lines"]!.AsArray().Select(node => ProtocolJson.Deserialize<ConsoleLine>(node!.ToJsonString())).ToList();
    }

    /// <summary>What the core plugin's runtime does with the orchestrator's frames, reduced to what the fixture shows.</summary>
    private sealed class ReplayHandler : IPlatformLinkHandler
    {
        private readonly Replay _replay;

        public ReplayHandler(Replay replay)
        {
            _replay = replay;
        }

        public LinkClient? Client { get; set; }
        /// <summary>The map the server idles on; a release changes back to it, as the core plugin's unloader does.</summary>
        public string LobbyMap { get; set; } = "de_dust2";
        public string Map { get; set; } = "de_dust2";
        public LinkServerState State { get; set; } = LinkServerState.Idle;
        public string? MatchId { get; set; }
        public int PlayerCount { get; set; }

        public LinkStatus Status() => new(State, Map, PlayerCount, MatchId);

        public void OnWelcome(WelcomeOrchestratorFrame welcome) { }

        public void OnAssign(AssignOrchestratorFrame assignment)
        {
            MatchId = assignment.MatchId;
            State = LinkServerState.Assigned;
            Client!.ReportState(State, MatchId, "plugins loaded");
        }

        public void OnRelease(string? reason)
        {
            MatchId = null;
            Map = LobbyMap;
            State = LinkServerState.Idle;
            Client!.ReportState(State, null, reason);
        }

        public void OnDrain()
        {
            State = LinkServerState.Draining;
            Client!.ReportState(State, MatchId);
        }

        public void OnProfile(RosterEntry player) { }

        public CommandAnswer OnCommand(LinkCommand command)
        {
            var correlationId = LinkClient.CorrelationIdOf(command);
            foreach (var emitted in _replay.EmittedWhileAnswering(correlationId))
            {
                _replay.EmitFrame(emitted);
            }

            if (_replay.AnswerOrNull(correlationId) is not { } recorded)
            {
                return CommandAnswer.Deferred;
            }

            var answer = ProtocolJson.Deserialize<CommandResultServerFrame>(recorded.ToJsonString());
            return new CommandAnswer(answer.Status, answer.Code, answer.Message, answer.Output);
        }

        public IReadOnlyList<ConsoleLine> OnConsoleRequest(int lines)
        {
            // The tail is the server's; the fixture says what it held (link-1 is the one console command recorded).
            var answer = ProtocolJson.Deserialize<ConsoleServerFrame>(_replay.AnswerFor("link-1").ToJsonString());
            return answer.Lines;
        }

        public CommandVerdict OnPlayerCommand(PlayerCommandOrchestratorFrame command)
        {
            var answer = ProtocolJson.Deserialize<PlayerCommandResultServerFrame>(_replay.AnswerFor(command.CorrelationId).ToJsonString());
            return new CommandVerdict(answer.Status, answer.Code, answer.Message, answer.CooldownMs, answer.ChargesLeft);
        }

        public void OnLinkDown(LinkClosure closure, bool fatal) { }
    }
}
