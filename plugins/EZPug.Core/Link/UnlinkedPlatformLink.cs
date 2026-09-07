using EZPug.Sdk;
using EZPug.Sdk.Protocol;

namespace EZPug.Core;

/// <summary>
/// The link when there is nothing to dial: no <c>EZPUG_IRON_URL</c> + <c>EZPUG_SERVER_TOKEN</c>
/// in the environment and no <c>ezpug.json</c> beside the game. The plugin still loads —
/// a server an operator is poking at by hand should not lose its console commands — but
/// every event is dropped and <c>ezpug_status</c> says so. Nothing is buffered: with no
/// home to send to, a buffer would only grow.
/// </summary>
public sealed class UnlinkedPlatformLink : IPlatformLink
{
    private readonly ILinkLog _log;
    private bool _said;

    public UnlinkedPlatformLink(ILinkLog log)
    {
        _log = log;
    }

    public GameserverSource? Source => null;

    public bool Connected => false;

    public IPlatformLinkHandler? Handler { get; set; }

    public void Emit(GameserverEvent gameserverEvent) => Drop();

    public void ReportState(LinkServerState state, string? matchId = null, string? detail = null) { }

    public void SendBackup(string matchId, RoundBackup backup) => Drop();

    public void SendConsole(IReadOnlyList<ConsoleLine> lines, string? correlationId = null) { }

    public void PushWidget(string matchId, ulong steamId64, WidgetPushServerFramePush push) { }

    public void AnswerCommand(string correlationId, CommandAnswer answer) { }

    public void Pump() { }

    private void Drop()
    {
        if (!_said)
        {
            _said = true;
            _log.Warn($"unlinked: no {Sidecar.UrlVariable}/{Sidecar.TokenVariable} and no {Sidecar.FileName}; events are dropped");
        }
    }
}
