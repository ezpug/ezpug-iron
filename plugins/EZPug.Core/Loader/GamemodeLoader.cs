using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using EZPug.Sdk;
using EZPug.Sdk.Protocol;

namespace EZPug.Core;

/// <summary>
/// <b>The gamemode loader</b> (decision 16): on <c>assign</c>, write each vendored
/// plugin's own config where CounterStrikeSharp will read it (<see cref="PluginConfigsDirectory"/>),
/// enable exactly the plugin folders the assignment names, set the hostname the SDK's
/// <see cref="Branding.HostnameFor(Assignment, string)"/> decided and go to the first map;
/// when that map is up (the runtime's <c>MapLoaded</c>, before <c>server_ready</c>), exec the mode's cfg,
/// and then — a beat later, in a console frame of its own, because the engine reconciles a
/// cvar once per frame and two writes in one net out (<see cref="CvarSettleMs"/>) — set the
/// flat cvars, and for a <c>matchzy</c> flow write the match config (the
/// hostname format added, so MatchZy keeps the hostname the loader set), <c>matchzy_loadmatch</c>
/// it, once per assignment — MatchZy carries a series across its own map changes — and
/// point its remote log at the orchestrator (<see cref="MatchZyRemoteLog"/>); on
/// <c>release</c>, unload what was enabled, in reverse, and go back to the lobby map.
/// Pure over <see cref="IGameWorld"/> and the <see cref="PluginCatalog"/>, so the harness
/// proves every line it issues.
///
/// <b>A restore</b> (PRD-02 T14, <c>assign.restore</c>): the match resumes here after its
/// server was lost. The map loaded is the backup's, not the plan's first; after
/// <c>matchzy_loadmatch</c> the backup is written where MatchZy keeps its own
/// (<c>MatchZyDataBackup/</c>, the remote log put back inside it — <see cref="MatchZyBackups.WithRemoteLog"/>)
/// and <c>matchzy_loadbackup</c> loads it. MatchZy in warmup marks the restore pending and
/// applies it the moment the match starts (<c>HandleMatchStart</c> → <c>RestoreRoundBackup</c>:
/// the engine's <c>mp_backup_restore_load_file</c>, then a pause both teams lift with
/// <c>.unpause</c>, MatchZy's <c>matchzy_pause_after_restore</c> default), so players reconnect
/// into warmup, ready up, and find the round they were in. <c>backup_restored</c> is emitted
/// as a <c>plugin_event</c> — the same one the simulator speaks — and <c>going_live</c> is
/// still MatchZy's to say, which is what the orchestrator closes the recovery window on.
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

    /// <summary>Where CounterStrikeSharp reads a plugin's own config, relative to <c>game/csgo</c>: <c>&lt;this&gt;/&lt;folder&gt;/&lt;folder&gt;.json</c> (its <c>ConfigManager.Load</c>, keyed on the plugin's folder name).</summary>
    public const string PluginConfigsDirectory = "addons/counterstrikesharp/configs/plugins";

    /// <summary>
    /// <b>The beat between the mode's cfg and everything the assignment asks for.</b> The
    /// engine reconciles a cvar's <i>effects</i> once at the end of the console frame it
    /// was set in, against the value it held before that frame — so a value the cfg sets
    /// and the request then sets back is not two changes but none. Measured on the dev
    /// node with <c>flying-scoutsman</c> (CS2 1.41.7.8): the cfg's <c>bot_kick; bot_quota
    /// 0</c> and the request's <c>bot_quota 10</c> in one frame produced an empty server
    /// for a whole match, and the same <c>bot_quota 10</c> a frame later filled it inside
    /// a second (PRD-02 T22a). A second is what the map already waits for once over
    /// (<c>CounterStrikeWorld.MapReadyDelayMs</c>, MatchZy's own settle) and is many frames
    /// at any tickrate, so the cfg's own eviction pass is long done when this one lands.
    /// </summary>
    public const long CvarSettleMs = 1_000;

    private static readonly Regex WorkshopId = new("^[0-9]{6,20}$", RegexOptions.CultureInvariant);

    private readonly IGameWorld _world;
    private readonly PluginCatalog _catalog;
    private readonly string _csgoDirectory;
    private readonly ILinkLog _log;
    private readonly MatchZyRemoteLog? _remoteLog;
    private readonly List<InstalledPlugin> _enabled = [];
    private readonly List<string> _writtenConfigs = [];
    private GamemodeRuntime? _runtime;
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
        _runtime = runtime;
        runtime.Assigned += OnAssigned;
        runtime.MapLoaded += OnMapLoaded;
        runtime.Released += OnReleased;
    }

    private void OnAssigned(Assignment assignment)
    {
        var map = MapFor(assignment);
        _matchLoaded = false;
        _world.SetCvar("hostname", Branding.HostnameFor(assignment, map));

        // Before the first `css_plugins load`, never after: CounterStrikeSharp reads a
        // plugin's config once, while it loads it, and a file that lands a frame later is
        // a file nobody opens.
        WritePluginConfigs(assignment);

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

        if (assignment.Restore is { } restore && assignment.Gamemode.Flow != GamemodeFlow.Matchzy)
        {
            _log.Warn($"the assignment carries a backup for round {restore.RoundNumber}, but a {assignment.Gamemode.Flow} flow has no round backups to restore; the match starts over");
        }

        // The runtime hears about a map a beat after the engine starts it
        // (CounterStrikeWorld.MapReadyDelayMs), and on a freshly booted container the
        // assign lands inside that beat — so say the change is coming before asking for
        // it, or the boot map arrives holding this assignment and the match reports a
        // server_ready for a map that was never its own (PRD-02 T22c).
        _runtime?.ExpectMapChange(map);
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

        // Everything else in a console frame of its own — see CvarSettleMs. The runtime
        // holds server_ready (and the mode's OnStart) until Configure has run, so "the map
        // is up" still means "and configured" for anybody downstream.
        _runtime?.SettleThen(CvarSettleMs, () => Configure(assignment, map));
    }

    /// <summary>
    /// The second console frame: the assignment's flat cvars, then — for a <c>matchzy</c>
    /// flow — the match config, <c>matchzy_loadmatch</c>, the remote log and any backup.
    /// The order inside it is the one the pug lane proved and is not what T22a moved; what
    /// moved is that none of it shares a frame with the mode's cfg any more.
    /// </summary>
    private void Configure(Assignment assignment, string map)
    {
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
        File.WriteAllText(path, WithHostnameFormat(config, Branding.HostnameFor(assignment, map)).ToJsonString(ProtocolJson.Options));
        _world.ExecCommand($"matchzy_loadmatch {MatchConfigFile}");
        _matchLoaded = true;

        // After loadmatch, never before: loading replaces MatchZy's config object, and never
        // in the file: the file is serialised into every round backup.
        PointRemoteLog();

        if (assignment.Restore is { } restore)
        {
            RestoreBackup(assignment, restore);
        }
    }

    private void PointRemoteLog()
    {
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
    /// Write the backup the assignment carries where MatchZy looks for its own and load it.
    /// The file name is MatchZy's, checked to be a name and nothing else; the content is
    /// what crossed the link with the remote log put back (the header value was scrubbed
    /// on the way up). MatchZy answers a load in warmup with a pending restore it applies at
    /// match start, which is why <c>backup_restored</c> is said here and <c>going_live</c> later.
    /// </summary>
    private void RestoreBackup(Assignment assignment, RoundBackup restore)
    {
        if (!MatchZyBackups.IsSafeFileName(restore.Filename))
        {
            _log.Warn($"the backup for round {restore.RoundNumber} is named {restore.Filename}, which is not a MatchZy backup file name; not restored");
            return;
        }

        var folder = Path.Combine(_csgoDirectory, MatchZyBackups.Folder);
        Directory.CreateDirectory(folder);
        var content = _remoteLog is { } remoteLog ? MatchZyBackups.WithRemoteLog(restore.Content, remoteLog) : restore.Content;
        File.WriteAllText(Path.Combine(folder, restore.Filename), content);
        _world.ExecCommand($"matchzy_loadbackup {restore.Filename}");
        // Loading deserialised the config from the file; the remote log is said once more so
        // the console's own value and the file's agree whichever MatchZy reads last.
        PointRemoteLog();
        _log.Info($"restoring map {restore.MapNumber} round {restore.RoundNumber} from {restore.Filename}; MatchZy applies it when the match starts");
        _runtime?.Emit(_runtime.Facts.Plugin(BackupRestoredEvent, new JsonObject
        {
            ["mapNumber"] = restore.MapNumber,
            ["roundNumber"] = restore.RoundNumber,
            ["filename"] = restore.Filename,
        }));
    }

    /// <summary>
    /// The <c>plugin_event</c> name a restored server says, the protocol's own word for it
    /// (its <c>data</c> too: <c>mapNumber</c>, <c>roundNumber</c>, <c>filename</c>). The
    /// orchestrator closes its recovery window on this event, because a <c>matchzy</c> flow
    /// never says <c>going_live</c> a second time (PRD-02 T37a).
    /// </summary>
    public const string BackupRestoredEvent = ProtocolConstants.BackupRestoredEvent;

    /// <summary>The map to load: the backup's when the match resumes here, the plan's first otherwise.</summary>
    public static string MapFor(Assignment assignment)
    {
        if (assignment.Restore is { } restore && restore.MapNumber >= 1 && restore.MapNumber <= assignment.Maps.Count)
        {
            return assignment.Maps[(int)restore.MapNumber - 1].Map;
        }

        return assignment.Maps[0].Map;
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

    /// <summary>
    /// <b>A vendored plugin's own config file</b> (PRD-02 T23): one document per plugin
    /// folder, written where that folder's plugin will read it —
    /// <c>addons/counterstrikesharp/configs/plugins/&lt;folder&gt;/&lt;folder&gt;.json</c>.
    /// The door for a community plugin whose settings are not cvars: cs2-retakes keeps
    /// <c>MaxPlayers</c> and <c>ShouldAutoJoinGame</c> in one, and the orchestrator builds
    /// it from the manifest (<c>apps/orchestrator/src/match-config/retakes.ts</c>).
    ///
    /// A folder name that is not a plain folder name is refused rather than written: this
    /// is the one place a frame's key becomes a path.
    ///
    /// CounterStrikeSharp prefers a <c>&lt;folder&gt;.toml</c> beside the json when one
    /// exists. Nothing in the image ships one, and one that appeared would silently win
    /// over what the orchestrator sent — so it is warned about rather than deleted, because
    /// a file this loader did not write is not this loader's to remove.
    /// </summary>
    private void WritePluginConfigs(Assignment assignment)
    {
        if (assignment.PluginConfigs is not { Count: > 0 } configs)
        {
            return;
        }

        foreach (var (name, config) in configs)
        {
            if (!IsSafePluginFolderName(name))
            {
                _log.Warn($"the assignment carries a config for {name}, which is not a plugin folder name; not written");
                continue;
            }

            var folder = Path.Combine(_csgoDirectory, PluginConfigsDirectory, name);
            Directory.CreateDirectory(folder);
            if (File.Exists(Path.Combine(folder, name + ".toml")))
            {
                _log.Warn($"{name} has a {name}.toml beside its config; CounterStrikeSharp reads that first and the assignment's settings will not apply");
            }

            File.WriteAllText(Path.Combine(folder, name + ".json"), config.ToJsonString(ProtocolJson.Options));
            _writtenConfigs.Add(name);
        }
    }

    /// <summary>A CounterStrikeSharp plugin folder: letters, digits, <c>.</c>, <c>_</c> and <c>-</c>, and nothing that could leave the configs directory.</summary>
    public static bool IsSafePluginFolderName(string name) =>
        name.Length is > 0 and <= 64
        && name != "."
        && name != ".."
        && name.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-');

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

        // The match's plugin configs go with it, so a server started by hand between
        // matches never runs a vendored plugin on the last match's settings. The plugin
        // writes its own defaults back the next time it loads without one.
        foreach (var name in _writtenConfigs)
        {
            var path = Path.Combine(_csgoDirectory, PluginConfigsDirectory, name, name + ".json");
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }

        _writtenConfigs.Clear();
        _world.ChangeLevel(LobbyMap);
    }
}
