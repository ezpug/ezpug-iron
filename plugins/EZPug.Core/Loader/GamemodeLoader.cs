using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using EZPug.Sdk;
using EZPug.Sdk.Protocol;

namespace EZPug.Core;

/// <summary>
/// <b>The gamemode loader</b> (decision 16): on <c>assign</c>, enable exactly the plugin
/// folders the assignment names, set the hostname and go to the first map; when that map
/// is up (the runtime's <c>MapLoaded</c>, before <c>server_ready</c>), exec the mode's cfg,
/// set the flat cvars, and for a <c>matchzy</c> flow write the match config (the
/// hostname format added, so MatchZy keeps the hostname the loader set), <c>matchzy_loadmatch</c>
/// it, once per assignment — MatchZy carries a series across its own map changes — and
/// point its remote log at the orchestrator (<see cref="MatchZyRemoteLog"/>); on
/// <c>release</c>, unload what was enabled, in reverse, and go back to the lobby map.
/// Pure over <see cref="IGameWorld"/> and the <see cref="PluginCatalog"/>, so the harness
/// proves every line it issues.
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
    private readonly MatchZyRemoteLog? _remoteLog;
    private readonly List<InstalledPlugin> _enabled = [];
    private bool _matchLoaded;

    public GamemodeLoader(IGameWorld world, PluginCatalog catalog, string csgoDirectory, string lobbyMap, ILinkLog? log = null, MatchZyRemoteLog? remoteLog = null)
    {
        _world = world;
        _catalog = catalog;
        _csgoDirectory = csgoDirectory;
        LobbyMap = lobbyMap;
        _log = log ?? NullLinkLog.Instance;
        _remoteLog = remoteLog;
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
        _matchLoaded = false;
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
            _log.Warn("a matchzy flow with no matchzyConfig: MatchZy runs as its cfg left it");
            return;
        }

        if (_matchLoaded)
        {
            _log.Info($"map {map} is up mid-series; MatchZy carries the match across its own map changes and the config is not reloaded");
            return;
        }

        var path = Path.Combine(_csgoDirectory, MatchConfigFile);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, WithHostnameFormat(config, HostnameFor(assignment, map)).ToJsonString(ProtocolJson.Options));
        _world.ExecCommand($"matchzy_loadmatch {MatchConfigFile}");
        _matchLoaded = true;

        // After loadmatch, never before: loading replaces MatchZy's config object, and never
        // in the file: the file is serialised into every round backup.
        if (_remoteLog is { } remoteLog)
        {
            foreach (var line in remoteLog.Commands())
            {
                _world.ExecCommand(line);
            }
        }
        else
        {
            _log.Warn("no sidecar, so MatchZy's remote log points nowhere: its match-flow events reach nobody");
        }
    }

    /// <summary>
    /// The config with <c>matchzy_hostname_format</c> set to the hostname the loader decided:
    /// MatchZy rewrites <c>hostname</c> from that cvar on every round (its default is
    /// <c>MatchZy | {TEAM1} vs {TEAM2}</c>), so setting <c>hostname</c> alone loses. The
    /// original is not touched.
    /// </summary>
    public static JsonObject WithHostnameFormat(JsonObject config, string hostname)
    {
        var copy = (JsonObject)config.DeepClone();
        if (copy["cvars"] is not JsonObject cvars)
        {
            cvars = new JsonObject();
            copy["cvars"] = cvars;
        }

        cvars["matchzy_hostname_format"] = hostname;
        return copy;
    }

    private void OnReleased(string? reason)
    {
        for (var at = _enabled.Count - 1; at >= 0; at--)
        {
            _world.ExecCommand($"css_plugins unload {_enabled[at].RelativeDllPath}");
        }

        _enabled.Clear();
        _matchLoaded = false;
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
