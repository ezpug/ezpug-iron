using System.Reflection;
using CounterStrikeSharp.API.Core;
using EZPug.Sdk;
using EZPug.Sdk.Hosting;

namespace EZPug.PowerupDm;

/// <summary>
/// <b>The CounterStrikeSharp shell around <see cref="PowerupDm"/></b> — the whole of it.
/// A gamemode plugin is a folder under <c>plugins/disabled/</c> that the core plugin's
/// loader hot-loads when a match's manifest names it (decision 16), and everything a
/// plugin has to do to be one is in <see cref="GamemodePlugin"/>: find the core's
/// <see cref="IGamemodeHost"/>, attach the mode, detach on unload. Nothing here is a
/// CounterStrikeSharp type the mode ever sees.
///
/// The SDK is resolved from <c>addons/counterstrikesharp/shared/EZPug.Sdk/</c> and is
/// never copied beside this dll (<c>plugins/README.md</c>): the host capability is keyed
/// by a type in that assembly, and two copies of it would be two types and no host.
/// </summary>
public sealed class PowerupDmPlugin : GamemodePlugin
{
    public override string ModuleName => "EZPug.PowerupDm";

    /// <summary>The csproj's <c>Version</c>, read back off this assembly — the number is stated once and never repeated in source. The manifest's <c>version</c> is the mode's; this is the dll's.</summary>
    public override string ModuleVersion =>
        (typeof(PowerupDmPlugin).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? typeof(PowerupDmPlugin).Assembly.GetName().Version?.ToString(3)
            ?? "0.0.0").Split('+', 2)[0];

    public override string ModuleAuthor => "EZPug / SaarLAN";

    public override string ModuleDescription => "powerup-dm: free-for-all deathmatch where every life buys one power-up from the phone.";

    protected override Gamemode CreateMode() => new PowerupDm();
}
