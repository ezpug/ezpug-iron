using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using EZPug.Sdk;
using EZPug.Sdk.Hosting;
using EZPug.Sdk.Protocol;
using Microsoft.Extensions.Logging;

namespace EZPug.Core;

/// <summary>
/// <b>The plugin every server runs</b> (PRD-02 T8, decision 5): boot → read the sidecar →
/// dial the link → <c>hello</c>; <c>assign</c> → the loader → <c>state: assigned</c>; the
/// engine's hooks → the vocabulary, emitted once by the SDK's runtime; <c>release</c> →
/// unload, the lobby map, <c>state: idle</c>. Three console commands for the operator
/// (<c>ezpug_status</c>, <c>ezpug_announce</c>, <c>ezpug_restore</c>). Everything with a
/// CounterStrikeSharp type in it is this file and <see cref="CounterStrikeWorld"/>; the
/// rest is the SDK, proven on the harness.
///
/// Threads: the link's socket lives on the thread pool and its heartbeat on
/// <see cref="SystemClock"/>; inbound frames wait until the runtime pumps them on the
/// engine's tick. Nothing here touches the engine off the game thread — the heartbeat
/// reads a map name and a player count the world keeps as snapshots.
/// </summary>
public sealed class CorePlugin : BasePlugin
{
    public const string LobbyMapVariable = "EZPUG_LOBBY_MAP";

    public override string ModuleName => "EZPug.Core";

    public override string ModuleVersion => HelloFactsBuilder.PluginVersion;

    public override string ModuleAuthor => "EZPug / SaarLAN";

    public override string ModuleDescription => "The EZPug core plugin: the link to the orchestrator, the gamemode loader, the event vocabulary.";

    private ServerPaths? _paths;
    private GameThreadClock? _clock;
    private CoreLog? _log;
    private CounterStrikeWorld? _world;
    private PluginCatalog? _catalog;
    private GamemodeRuntime? _runtime;
    private GamemodeLoader? _loader;
    private MatchZyFlow? _flow;
    private DemoFlow? _demos;
    private HttpDemoTransport? _demoTransport;
    private RuntimeHost? _host;
    private RosterLoadouts? _loadouts;
    private IPlatformLink? _link;
    private LinkClient? _client;
    private FileEventBuffer? _buffer;
    private Uri? _linkUrl;
    private CancellationTokenSource? _stopping;
    private Task? _linkTask;

    public override void Load(bool hotReload)
    {
        _paths = new ServerPaths(ModuleDirectory);
        _clock = new GameThreadClock();
        _log = new CoreLog(Logger, line => _runtime?.Console(line));
        _world = new CounterStrikeWorld(this, _clock, _log, Server.MapName);
        _world.Install();
        _catalog = PluginCatalog.Scan(_paths.PluginsDirectory);

        var sidecar = Sidecar.LoadFromProcess(_paths.SidecarDirectory);
        if (sidecar is null)
        {
            _link = new UnlinkedPlatformLink(_log);
            Logger.LogWarning("no sidecar: set {Url} and {Token}, or write {File} under {Dir}; running unlinked",
                Sidecar.UrlVariable, Sidecar.TokenVariable, Sidecar.FileName, _paths.SidecarDirectory);
        }
        else
        {
            _linkUrl = sidecar.LinkUrl;
            _buffer = new FileEventBuffer(sidecar.BufferDir ?? _paths.DefaultBufferDirectory);
            _client = new LinkClient(new LinkClientOptions
            {
                Url = sidecar.LinkUrl,
                Token = sidecar.Token,
                Hello = HelloFactsBuilder.Build(_catalog, ConVar.Find("hostname")?.StringValue ?? ""),
                Status = () => _runtime?.Status() ?? new LinkStatus(LinkServerState.Booting, _world.Map, 0, null),
                Clock = new SystemClock(),
                Buffer = _buffer,
                Log = _log,
            });
            _link = _client;
        }

        _runtime = new GamemodeRuntime(_world, _link, _log);
        var lobby = Environment.GetEnvironmentVariable(LobbyMapVariable);
        _loader = new GamemodeLoader(
            _world,
            _catalog,
            _paths.CsgoDirectory,
            string.IsNullOrWhiteSpace(lobby) ? _world.Map : lobby.Trim(),
            _log,
            sidecar is null ? null : MatchZyRemoteLog.From(sidecar));
        _loader.Bind(_runtime);
        _flow = new MatchZyFlow(_world, _runtime, _paths.CsgoDirectory, _log);
        _flow.Bind();
        // The demo's own upload (decision 10, T21): MatchZy records for its own flow and
        // the SDK records for every other, but the PUT is always this plugin's — a
        // presigned URL takes a body, not MatchZy's multipart form.
        _demoTransport = new HttpDemoTransport();
        _demos = new DemoFlow(_world, _runtime, _paths.CsgoDirectory, new DemoUploader(_demoTransport, _world.Clock, _log), _log);
        _demos.Bind();
        _world.MapStarted += OnMapStarted;
        _host = new RuntimeHost(_runtime, _log);
        GamemodeHost.Publish(_host);
        // The skins hand-off (decision 20, T28): the WeaponPaints fork reads a player's
        // loadout out of this match's profiles through the shared capability, and MySQL
        // is nowhere in the image.
        _loadouts = new RosterLoadouts(_runtime, _log);
        LoadoutSource.Publish(_loadouts);

        Logger.LogInformation("EZPug.Core {Version} on EZPug.Sdk {Sdk}; {Paths}; installed plugins: {Plugins}; {Sidecar}",
            HelloFactsBuilder.PluginVersion, SdkInfo.Version, _paths, string.Join(", ", _catalog.Installed), sidecar?.ToString() ?? "unlinked");

        if (_client is not null)
        {
            _stopping = new CancellationTokenSource();
            _linkTask = Task.Run(() => _client.RunAsync(_stopping.Token));
        }
    }

    public override void Unload(bool hotReload)
    {
        if (_host is not null)
        {
            GamemodeHost.Withdraw(_host);
        }

        if (_loadouts is not null)
        {
            LoadoutSource.Withdraw(_loadouts);
            _loadouts.Dispose();
            _loadouts = null;
        }

        _stopping?.Cancel();
        if (_client is not null)
        {
            // Close from this side, but never hold the game thread hostage to a socket.
            var closing = _client.CloseAsync(hotReload ? "reloading" : "unloading");
            if (!closing.Wait(TimeSpan.FromSeconds(2)))
            {
                Logger.LogWarning("the link did not close within two seconds; abandoning it");
            }
        }

        if (_world is not null)
        {
            _world.MapStarted -= OnMapStarted;
        }

        _runtime?.Dispose();
        _buffer?.Dispose();
        _demoTransport?.Dispose();
        _demoTransport = null;
        _demos = null;
        _runtime = null;
        _client = null;
        _link = null;
        _buffer = null;
        _host = null;
    }

    /// <summary>The first map the plugin sees is the server standing idle; before that it is booting.</summary>
    private void OnMapStarted(MapStart start)
    {
        if (_runtime is { State: LinkServerState.Booting } runtime)
        {
            runtime.SetState(LinkServerState.Idle, "booted");
        }
    }

    // ------------------------------------------------------------------ console commands

    [ConsoleCommand("ezpug_status", "What EZPug.Core knows: link, buffer, state, match, mode, plugins.")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnStatus(CCSPlayerController? player, CommandInfo info)
    {
        if (_runtime is null || _link is null || _catalog is null || _loader is null)
        {
            info.ReplyToCommand("EZPug.Core is not loaded");
            return;
        }

        var report = StatusReport.Render(new StatusReport.Input(_runtime, _link, _linkUrl, _client?.BufferState, _catalog, _loader));
        info.ReplyToCommand(report);
        // …and into the buffer the fleet's console route reads. A reply is only a reply
        // to whoever asked, and RCON is not one of them: CounterStrikeSharp answers a
        // `SERVER_ONLY` command on the server console, so `ezpug_status` down a node's
        // RCON socket comes back empty (measured on the dev node, PRD-02 T27). The
        // console tail is the door that works from anywhere.
        foreach (var line in report.Split('\n'))
        {
            _runtime?.Console($"[status] {line}");
        }
    }

    [ConsoleCommand("ezpug_announce", "Say a line to everybody on the server, as the announce command over the link would.")]
    [CommandHelper(minArgs: 1, usage: "<text>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnAnnounce(CCSPlayerController? player, CommandInfo info)
    {
        if (_world is null)
        {
            return;
        }

        // The same sanitizer the link's `announce` goes through (PRD-02 T30): the
        // operator's door and the client's door print the same line.
        if (SaidLine.Sanitize(info.ArgString.Trim().Trim('"')) is not { } text)
        {
            info.ReplyToCommand("nothing of that line survives being said in chat");
            return;
        }

        _world.Say(text);
        _runtime?.Console($"[announce] {text}");
    }

    [ConsoleCommand("ezpug_restore", "Load a round backup already on disk under game/csgo: ezpug_restore <file> <round>.")]
    [CommandHelper(minArgs: 2, usage: "<file> <round>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnRestore(CCSPlayerController? player, CommandInfo info)
    {
        if (_world is null || _paths is null)
        {
            return;
        }

        var outcome = BackupRestorer.Restore(_world, _paths.CsgoDirectory, info.GetArg(1), info.GetArg(2));
        info.ReplyToCommand(outcome.Message);
        _runtime?.Console($"[restore] {outcome.Message}");
    }
}
