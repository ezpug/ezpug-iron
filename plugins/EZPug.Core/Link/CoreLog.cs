using EZPug.Sdk;
using Microsoft.Extensions.Logging;

namespace EZPug.Core;

/// <summary>
/// Where the SDK writes about itself on a real server: CounterStrikeSharp's logger (the
/// server console) and the runtime's console tail, which the fleet console reads over
/// the link. The SDK never hands this a token or a frame; nothing here redacts because
/// nothing here should ever need to.
/// </summary>
public sealed class CoreLog : ILinkLog
{
    private readonly ILogger _logger;
    private readonly Action<string> _tail;

    public CoreLog(ILogger logger, Action<string> tail)
    {
        _logger = logger;
        _tail = tail;
    }

    public void Info(string message)
    {
        _logger.LogInformation("{Message}", message);
        _tail("[ezpug] " + message);
    }

    public void Warn(string message)
    {
        _logger.LogWarning("{Message}", message);
        _tail("[ezpug] warn: " + message);
    }
}
