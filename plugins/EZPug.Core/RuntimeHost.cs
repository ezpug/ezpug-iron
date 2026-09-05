using EZPug.Sdk;
using EZPug.Sdk.Hosting;

namespace EZPug.Core;

/// <summary>The door a hot-loaded gamemode plugin uses to reach the one runtime (see <see cref="GamemodeHost"/>).</summary>
public sealed class RuntimeHost : IGamemodeHost
{
    private readonly GamemodeRuntime _runtime;
    private readonly ILinkLog _log;

    public RuntimeHost(GamemodeRuntime runtime, ILinkLog log)
    {
        _runtime = runtime;
        _log = log;
    }

    public void Attach(Gamemode mode)
    {
        _runtime.Attach(mode);
        _log.Info($"gamemode {mode.Id} attached");
    }

    public void Detach(Gamemode mode)
    {
        if (ReferenceEquals(_runtime.Mode, mode))
        {
            _runtime.Detach();
            _log.Info($"gamemode {mode.Id} detached");
        }
    }
}
