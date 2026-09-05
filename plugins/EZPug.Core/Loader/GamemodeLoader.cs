using System.Text.RegularExpressions;
using EZPug.Sdk;
using EZPug.Sdk.Protocol;

namespace EZPug.Core;

/// <summary>
/// <b>The gamemode loader</b> (decision 16): on <c>assign</c>, enable exactly the plugin
/// folders the assignment names, set the hostname and go to the first map; when that map
/// is up (the runtime's <c>MapLoaded</c>, before <c>server_ready</c>), exec the mode's cfg,
/// set the flat cvars, and for a <c>matchzy</c> flow write the match config and
/// <c>matchzy_loadmatch</c> it; on <c>release</c>, unload what was enabled, in reverse,
/// and go back to the lobby map. Pure over <see cref="IGameWorld"/> and the
/// <see cref="PluginCatalog"/>, so the harness proves every line it issues.
///
/// <c>css_plugins</c> is spoken in one form only — the dll path relative to
/// <c>addons/counterstrikesharp</c> — because CounterStrikeSharp composes the path
/// differently for <c>load</c> and <c>unload</c> when given a bare name, and only the
/// <c>.dll</c> form lands on the same file both ways.
/// </summary>
public sealed class GamemodeLoader
{
    /// <summary>Where the MatchZy config is written, relative to <c>game/csgo</c> — what <c>matchzy_loadmatch</c> reads.</summary>
    public const string MatchConfigFile = "cfg/ezpug/match.json";

    private static readonly Regex WorkshopId = new("^[0-9]{6,20}$", RegexOptions.CultureInvariant);

    private readonly IGameWorld _world;
    private readonly PluginCatalog _catalog;
    private readonly string _csgoDirectory;
    private readonly ILinkLog _log;
    private readonly List<InstalledPlugin> _enabled = [];

    public GamemodeLoader(IGameWorld world, PluginCatalog catalog, string csgoDirectory, string lobbyMap, ILinkLog? log = null)
    {
        _world = world;
        _catalog = catalog;
        _csgoDirectory = csgoDirectory;
        LobbyMap = lobbyMap;
        _log = log ?? NullLinkLog.Instance;
    }

    /// <summary>Where the server goes between matches: the map it booted with, or <c>EZPUG_LOBBY_MAP</c>.</summary>
    public string LobbyMap { get; }

    /// <summary>The plugin folders enabled for the current match, in load order.</summary>
    public IReadOnlyList<string> Enabled => _enabled.Select(plugin => plugin.Name).ToList();

    /// <summary>Hook the runtime's host events.</summary>
    public void Bind(GamemodeRuntime runtime)
    {
        runtime.Assigned += OnAssigned;
        runtime.MapLoaded += OnMapLoaded;
        runtime.Released += OnReleased;
    }

    private void OnAssigned(Assignment assignment)
    {
        var map = assignment.Maps[0].Map;
        _world.SetCvar("hostname", HostnameFor(assignment, map));

        foreach (var name in assignment.Plugins)
        {
            if (_catalog.Find(name) is not { } plugin)
            {
                _log.Warn($"the assignment names plugin {name}, which is not installed; skipped");
                continue;
            }

            if (_enabled.Any(enabled => enabled.Name == name))
            {
                continue;
            }

            _world.ExecCommand($"css_plugins load {plugin.RelativeDllPath}");
            _enabled.Add(plugin);
        }

        if (assignment.Restore is { } restore)
        {
            _log.Warn($"the assignment carries a backup for round {restore.RoundNumber}; restoring on assign is PRD-02 T14 and is not done here");
        }

        if (WorkshopId.IsMatch(map))
        {
            _world.HostWorkshopMap(map);
        }
        else
        {
            _world.ChangeLevel(map);
        }
    }

    private void OnMapLoaded(Assignment assignment, string map)
    {
        foreach (var cfg in assignment.Cfg)
        {
            _world.ExecCfg(cfg);
        }

        foreach (var (name, value) in assignment.Cvars)
        {
            _world.SetCvar(name, value);
        }

        if (assignment.Gamemode.Flow != GamemodeFlow.Matchzy)
        {
            return;
        }

        if (assignment.MatchzyConfig is not { } config)
        {
            _log.Warn("a matchzy flow with no matchzyConfig: MatchZy runs as its cfg left it (the config builder is PRD-02 T9)");
            return;
        }

        var path = Path.Combine(_csgoDirectory, MatchConfigFile);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, config.ToJsonString(ProtocolJson.Options));
        _world.ExecCommand($"matchzy_loadmatch {MatchConfigFile}");
    }

    private void OnReleased(string? reason)
    {
        for (var at = _enabled.Count - 1; at >= 0; at--)
        {
            _world.ExecCommand($"css_plugins unload {_enabled[at].RelativeDllPath}");
        }

        _enabled.Clear();
        var config = Path.Combine(_csgoDirectory, MatchConfigFile);
        if (File.Exists(config))
        {
            File.Delete(config);
        }

        _world.ChangeLevel(LobbyMap);
    }

    /// <summary>The request's hostname, or <c>EZPug · &lt;mode&gt; · &lt;Map&gt;</c> (branding proper — event name, chat, the card — is PRD-02 T29).</summary>
    public static string HostnameFor(Assignment assignment, string map) =>
        assignment.Branding.Hostname is { Length: > 0 } hostname ? hostname : $"EZPug · {assignment.Gamemode.Id} · {PrettyMap(map)}";

    /// <summary><c>de_mirage</c> → <c>Mirage</c>; a workshop id stays as it is.</summary>
    public static string PrettyMap(string map)
    {
        var name = map.Contains('_') ? map[(map.IndexOf('_') + 1)..] : map;
        return name.Length == 0 ? map : char.ToUpperInvariant(name[0]) + name[1..];
    }
}
