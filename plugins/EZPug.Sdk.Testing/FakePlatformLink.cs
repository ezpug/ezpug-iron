using System.Text.Json.Nodes;
using EZPug.Sdk;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk.Testing;

/// <summary>
/// <b>The link without a socket.</b> Records every event a mode emitted (stamped, as the
/// wire would carry it) in <see cref="Events"/> — position ticks apart, which are
/// ephemeral on the wire and land in <see cref="Ticks"/> so a story's event list stays
/// exact — and every state, backup, console and widget-push frame; a test pushes the
/// orchestrator's side in — <see cref="Assign"/>, <see cref="Release"/>, <see cref="Command"/>,
/// <see cref="PlayerCommand"/>, <see cref="PushProfile"/> — and reads the answer back.
/// Delivery is synchronous: a pushed frame reaches the handler before the call returns,
/// so a test asserts on the next line.
/// </summary>
public sealed class FakePlatformLink : IPlatformLink
{
    public FakePlatformLink(string provider = "sim", string serverId = "sim-1")
    {
        Source = new GameserverSource { Provider = provider, ServerId = serverId };
    }

    public GameserverSource? Source { get; }
    public bool Connected => true;
    public IPlatformLinkHandler? Handler { get; set; }

    public List<GameserverEvent> Events { get; } = [];
    /// <summary>The position ticks the runtime streamed, apart from the durable events.</summary>
    public List<PositionTickEvent> Ticks { get; } = [];
    public List<StateServerFrame> States { get; } = [];
    public List<BackupServerFrame> Backups { get; } = [];
    public List<ConsoleServerFrame> Consoles { get; } = [];
    public List<CommandResultServerFrame> CommandResults { get; } = [];
    public List<PlayerCommandResultServerFrame> PlayerCommandResults { get; } = [];
    /// <summary>The pushes a mode aimed at one phone, in order (PRD-02 T26). Ephemeral on the wire; here so a test can look at them.</summary>
    public List<WidgetPushServerFrame> Pushes { get; } = [];

    /// <summary>The events of one type, in order.</summary>
    public IReadOnlyList<T> EventsOf<T>() where T : GameserverEvent => Events.OfType<T>().ToList();

    /// <summary>The event types emitted, in order — the shape of a story.</summary>
    public IReadOnlyList<string> EventTypes => Events.Select(gameserverEvent => gameserverEvent.Discriminator).ToList();

    public void Emit(GameserverEvent gameserverEvent)
    {
        if (gameserverEvent is PositionTickEvent tick)
        {
            Ticks.Add(tick);
        }
        else
        {
            Events.Add(gameserverEvent);
        }
    }

    public void ReportState(LinkServerState state, string? matchId = null, string? detail = null) =>
        States.Add(new StateServerFrame { State = state, MatchId = matchId, Detail = detail });

    public void SendBackup(string matchId, RoundBackup backup) =>
        Backups.Add(new BackupServerFrame { MatchId = matchId, Backup = backup });

    public void SendConsole(IReadOnlyList<ConsoleLine> lines, string? correlationId = null) =>
        Consoles.Add(new ConsoleServerFrame { CorrelationId = correlationId, UptimeMs = 0, Lines = lines });

    public void PushWidget(string matchId, ulong steamId64, WidgetPushServerFramePush push) =>
        Pushes.Add(new WidgetPushServerFrame { MatchId = matchId, SteamId64 = steamId64.ToString(), Push = push });

    public void AnswerCommand(string correlationId, CommandAnswer answer) =>
        CommandResults.Add(new CommandResultServerFrame
        {
            CorrelationId = correlationId,
            Status = answer.Status,
            Code = answer.Code,
            Message = answer.Message,
            Output = answer.Output,
        });

    public void Pump() { }

    // ------------------------------------------------------------------ the orchestrator's side

    private IPlatformLinkHandler Target => Handler ?? throw new InvalidOperationException("no handler is attached to the fake link");

    public void Welcome(long heartbeatIntervalMs = ProtocolConstants.HeartbeatIntervalMsDefault) =>
        Target.OnWelcome(new WelcomeOrchestratorFrame
        {
            Provider = Source!.Provider,
            ServerId = Source.ServerId,
            HeartbeatIntervalMs = heartbeatIntervalMs,
            AckedSeq = 0,
        });

    public void Assign(AssignOrchestratorFrame assignment) => Target.OnAssign(assignment);

    public void Release(string? reason = "ended: completed") => Target.OnRelease(reason);

    public void Drain() => Target.OnDrain();

    public void PushProfile(RosterEntry player) => Target.OnProfile(player);

    /// <summary>Relay a command and record its result, as the orchestrator would see it; <c>null</c> when the handler deferred it (the answer lands in <see cref="CommandResults"/> later).</summary>
    public CommandResultServerFrame? Command(LinkCommand command)
    {
        var answer = Target.OnCommand(command);
        if (answer.IsDeferred)
        {
            return null;
        }

        AnswerCommand(LinkClient.CorrelationIdOf(command), answer);
        return CommandResults[^1];
    }

    /// <summary>A tap from the phone, answered as the widget would see it.</summary>
    public PlayerCommandResultServerFrame PlayerCommand(ulong steamId64, string command, JsonObject? args = null, string correlationId = "pc-1")
    {
        var verdict = Target.OnPlayerCommand(new PlayerCommandOrchestratorFrame
        {
            CorrelationId = correlationId,
            SteamId64 = steamId64.ToString(),
            Command = command,
            Args = args,
        });
        var result = new PlayerCommandResultServerFrame
        {
            CorrelationId = correlationId,
            SteamId64 = steamId64.ToString(),
            Command = command,
            Status = verdict.Status,
            Code = verdict.Code,
            Message = verdict.Message,
            CooldownMs = verdict.CooldownMs,
            ChargesLeft = verdict.ChargesLeft,
        };
        PlayerCommandResults.Add(result);
        return result;
    }

    public IReadOnlyList<ConsoleLine> ConsoleTail(int lines = ProtocolConstants.ConsoleTailDefault) => Target.OnConsoleRequest(lines);
}
