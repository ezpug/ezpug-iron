using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>The answer a handler gives a relayed Match API command.</summary>
public sealed record CommandAnswer(LinkCommandStatus Status, MatchApiErrorCode? Code = null, string? Message = null, string? Output = null)
{
    public static readonly CommandAnswer Applied = new(LinkCommandStatus.Applied);

    public static CommandAnswer Rejected(MatchApiErrorCode code, string? message = null) =>
        new(LinkCommandStatus.Rejected, code, message);

    public static CommandAnswer WithOutput(string output) => new(LinkCommandStatus.Applied, Output: output);

    /// <summary>
    /// Not yet: the handler will call <see cref="IPlatformLink.AnswerCommand"/> when the
    /// work is done (a restore that waits for the map). The orchestrator's deadline is
    /// fifteen seconds; a command never answered is <c>provider_unavailable</c> to the client.
    /// </summary>
    public static readonly CommandAnswer Deferred = new(LinkCommandStatus.Applied, Message: "deferred");

    public bool IsDeferred => ReferenceEquals(this, Deferred);
}

/// <summary>
/// What a server does with what the orchestrator sends it. The runtime implements this
/// over a gamemode; every method runs on the thread that pumps the link (the game
/// thread in production, the test's in the harness), never on a socket thread.
/// </summary>
public interface IPlatformLinkHandler
{
    void OnWelcome(WelcomeOrchestratorFrame welcome);
    void OnAssign(AssignOrchestratorFrame assignment);
    void OnRelease(string? reason);
    void OnDrain();
    void OnProfile(RosterEntry player);
    CommandAnswer OnCommand(LinkCommand command);
    /// <summary>The console tail a <c>console</c> command asks for, newest last.</summary>
    IReadOnlyList<ConsoleLine> OnConsoleRequest(int lines);
    CommandVerdict OnPlayerCommand(PlayerCommandOrchestratorFrame command);
    /// <summary>The socket closed; the client is reconnecting (or has given up when <paramref name="fatal"/>).</summary>
    void OnLinkDown(LinkClosure closure, bool fatal);
}

/// <summary>What the heartbeat and the hello say about the server right now.</summary>
public sealed record LinkStatus(LinkServerState State, string Map, int PlayerCount, string? MatchId);

/// <summary>
/// <b>The platform seam</b>: the one relationship a server has with the world
/// (decision 5), as a gamemode and the runtime see it. Outbound verbs here; inbound
/// frames reach the <see cref="Handler"/> when <see cref="Pump"/> runs. The real one is
/// <see cref="LinkClient"/>; the harness's <c>FakePlatformLink</c> records every event
/// a mode emits and lets a test push assignments, commands and profiles in.
/// </summary>
public interface IPlatformLink
{
    /// <summary>Who this server is to the platform — known after <c>welcome</c>, stamped into every event's <c>source</c>.</summary>
    GameserverSource? Source { get; }

    /// <summary>A socket is open and welcomed.</summary>
    bool Connected { get; }

    IPlatformLinkHandler? Handler { get; set; }

    /// <summary>Emit a vocabulary event: sequenced, buffered, delivered at least once.</summary>
    void Emit(GameserverEvent gameserverEvent);

    /// <summary>The server's state changed — heartbeats carry it too, this one is not late.</summary>
    void ReportState(LinkServerState state, string? matchId = null, string? detail = null);

    /// <summary>A round backup as it was written. The newest one is kept and sent on reconnect if it never crossed.</summary>
    void SendBackup(string matchId, RoundBackup backup);

    /// <summary>A console tail, unsolicited (<paramref name="correlationId"/> null) or as the answer to a <c>console</c> command.</summary>
    void SendConsole(IReadOnlyList<ConsoleLine> lines, string? correlationId = null);

    /// <summary>
    /// <b>A picture for one phone</b> (PRD-02 T26): the mode has something this one
    /// player's widget should see right now — <c>powerup-dm</c>'s five seconds of enemy
    /// positions, say. Relayed by the orchestrator to that player's open widget sockets
    /// and to nobody else, then forgotten: a push is never sequenced, never acked, never
    /// stored and never replayed, which is what lets a mode put a position on a phone
    /// without a position ever being written down (CLAUDE.md). Dropped on the floor when
    /// the link is down or no widget of that player is open — a mode that needs the fact
    /// to survive emits an event instead.
    /// </summary>
    void PushWidget(string matchId, ulong steamId64, WidgetPushServerFramePush push);

    /// <summary>The late answer to a command the handler <see cref="CommandAnswer.Deferred"/>.</summary>
    void AnswerCommand(string correlationId, CommandAnswer answer);

    /// <summary>Deliver what arrived since the last pump to the handler, on the caller's thread.</summary>
    void Pump();
}
