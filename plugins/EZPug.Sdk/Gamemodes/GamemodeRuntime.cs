using System.Text.Json.Nodes;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>The runtime</b>: one per server, owned by the host (the core plugin in production,
/// <c>GamemodeTestHost</c> in a test). It is the link's handler and the world's listener,
/// and routes both to whichever <see cref="Gamemode"/> is attached:
///
/// <list type="bullet">
/// <item><c>assign</c> → the host's <see cref="Assigned"/> (the loader: plugins, cfg, cvars,
/// map) → the mode's <c>OnAssigned</c> → <c>state: assigned</c>. A mode attached later
/// (a plugin hot-loaded by the loader) gets <c>OnAssigned</c> the moment it attaches.</item>
/// <item>the world's hooks → the vocabulary (<c>player_connected</c>, <c>player_death</c>,
/// <c>bomb_*</c>, <c>chat_*</c>, <c>server_ready</c>) emitted once here, and the mode's
/// hooks; match-flow events are the flow owner's and never emitted here. The map coming
/// up runs the host's <see cref="MapLoaded"/> (cfg, cvars, the match config) <i>before</i>
/// <c>server_ready</c> is emitted, so a mode's <c>OnStart</c> sees the server configured.</item>
/// <item>position ticks every <see cref="PositionTickIntervalMs"/> while a match is assigned,
/// the manifest asks for <c>positions</c> and the link is up — ephemeral, unsequenced,
/// never buffered for a link that is down.</item>
/// <item><c>player_command</c> and <c>!verb</c> in chat → the <see cref="CommandTable"/> →
/// the mode → the verdict back.</item>
/// <item><c>release</c> → the mode's <c>OnEnd</c>, its timers and player state cleared, the
/// host's <see cref="Released"/> (unload, lobby map), <c>state: idle</c>.</item>
/// </list>
///
/// Every event a mode emits is stamped with the per-match <c>seq</c> hint and advances
/// the <see cref="MatchContext"/> where it says something about the flow.
/// </summary>
public sealed class GamemodeRuntime : IPlatformLinkHandler, IDisposable
{
    private readonly List<Action> _stateClearers = [];
    private readonly List<IClockTimer> _timers = [];
    private readonly List<ConsoleLine> _console = [];
    private readonly ILinkLog _log;
    private Gamemode? _mode;
    private LinkServerState _state = LinkServerState.Booting;
    private bool _mapReady;
    private IClockTimer? _positionTicker;

    /// <summary>How often positions are streamed while a match is assigned and the mode asks for them.</summary>
    public const long PositionTickIntervalMs = 100;

    public GamemodeRuntime(IGameWorld world, IPlatformLink link, ILinkLog? log = null)
    {
        World = world;
        Link = link;
        _log = log ?? NullLinkLog.Instance;
        Localizer = new Localizer();
        Facts = new Facts(() => Match, () => Link.Source ?? new GameserverSource { Provider = "unknown", ServerId = "unknown" }, () => Assignment);
        Flow = new GenericFlow(world, this, _log);
        link.Handler = this;
        world.MapStarted += OnMapStarted;
        world.PlayerConnected += OnPlayerConnected;
        world.PlayerDisconnected += OnPlayerDisconnected;
        world.PlayerSpawned += OnPlayerSpawned;
        world.PlayerDied += OnPlayerDied;
        world.RoundStarted += OnRoundStarted;
        world.RoundEnded += OnRoundEnded;
        world.MapEnded += OnMapEnded;
        world.BombPlanted += OnBombPlanted;
        world.BombDefused += OnBombDefused;
        world.BombExploded += OnBombExploded;
        world.ChatSaid += OnChatSaid;
        world.Tick += OnTick;
    }

    public IGameWorld World { get; }
    public IPlatformLink Link { get; }
    public Localizer Localizer { get; private set; }
    public Facts Facts { get; }
    public MatchContext Match { get; } = new();

    /// <summary>The SDK's own flow emitter, speaking for a <c>plugin</c> or <c>none</c> flow (PRD-02 T22).</summary>
    public GenericFlow Flow { get; }

    public Assignment? Assignment { get; private set; }
    public CommandTable? Commands { get; private set; }
    public Gamemode? Mode => _mode;

    /// <summary>The attached mode when the assignment is for it; a mode assigned another manifest hears nothing.</summary>
    private Gamemode? Active =>
        _mode is { } mode && Assignment is { } assignment && mode.Id == assignment.Gamemode.Id ? mode : null;

    /// <summary>Whether the mode attached for this assignment says it tells its own flow story.</summary>
    internal bool ModeOwnsFlow => Active?.OwnsFlow == true;

    /// <summary>The server's state as the link reports it.</summary>
    public LinkServerState State => _state;

    /// <summary>The host's loader: enable the plugins, change the map, set the hostname. Runs before the mode's <c>OnAssigned</c>.</summary>
    public event Action<Assignment>? Assigned;

    /// <summary>The host's map hook: the assigned match's map is up — exec the cfg, set the cvars, load the match config. Runs before <c>server_ready</c> is emitted and before the mode's <c>OnStart</c>.</summary>
    public event Action<Assignment, string>? MapLoaded;

    /// <summary>The host's unloader, after the mode's <c>OnEnd</c>.</summary>
    public event Action<string?>? Released;

    public event Action? Drained;

    /// <summary>The host answers a Match API command first; <c>null</c> lets the runtime and the mode try.</summary>
    public Func<LinkCommand, CommandAnswer?>? CommandHook { get; set; }

    /// <summary>What the link says in <c>hello</c> and every heartbeat.</summary>
    public LinkStatus Status() =>
        new(_state, World.Map, World.Players.Count, Assignment?.MatchId);

    // ------------------------------------------------------------------ modes

    /// <summary>Bind a mode. If a match is already assigned (the plugin was hot-loaded by the loader), it hears <c>OnAssigned</c> now, and <c>OnStart</c> if the map is already up.</summary>
    public void Attach(Gamemode mode)
    {
        if (_mode is not null)
        {
            Detach();
        }

        _mode = mode;
        mode.Bind(this);
        Localizer = mode.BuildLocalizer();
        if (Assignment is { } assignment && mode.Id == assignment.Gamemode.Id)
        {
            mode.OnAssigned(assignment);
            if (_mapReady)
            {
                mode.OnStart();
            }
        }
    }

    public void Detach()
    {
        if (_mode is null)
        {
            return;
        }

        ClearModeState();
        _mode.Unbind();
        _mode = null;
        Localizer = new Localizer();
    }

    /// <summary>Report a state to the orchestrator and remember it for the heartbeat.</summary>
    public void SetState(LinkServerState state, string? detail = null)
    {
        _state = state;
        Link.ReportState(state, Assignment?.MatchId, detail);
    }

    /// <summary>The host feeds the server console here; the fleet console route reads the tail.</summary>
    public void Console(string line)
    {
        _console.Add(new ConsoleLine { UptimeMs = World.Clock.NowMs, Line = line.Length > ProtocolConstants.ConsoleLineMax ? line[..ProtocolConstants.ConsoleLineMax] : line });
        if (_console.Count > ProtocolConstants.ConsoleTailMax)
        {
            _console.RemoveRange(0, _console.Count - ProtocolConstants.ConsoleTailMax);
        }
    }

    // ------------------------------------------------------------------ emitting

    /// <summary>Stamp the per-match seq, advance the context for flow events, hand it to the link.</summary>
    public void Emit(GameserverEvent gameserverEvent)
    {
        if (Match.MatchId is null)
        {
            _log.Warn($"{gameserverEvent.Discriminator} emitted with no match assigned; dropped");
            return;
        }

        switch (gameserverEvent)
        {
            case GoingLiveEvent:
                Match.Live = true;
                Match.RoundNumber = 0;
                break;
            case SideSwapEvent swap:
                Match.TeamASide = swap.Sides.TeamA;
                break;
            case MapEndEvent:
                Match.Live = false;
                Match.MapNumber++;
                Match.RoundNumber = 0;
                Commands?.Reset(PlayerCommandChargePeriod.Map);
                break;
            case SeriesEndEvent:
                Match.Live = false;
                break;
            default:
                break;
        }

        var stamped = gameserverEvent is PositionTickEvent ? gameserverEvent : EventStamper.WithSeq(gameserverEvent, ++Match.LastSeq);
        Link.Emit(stamped);
    }

    internal PlayerState<T> RegisterState<T>(PlayerState<T> state)
    {
        _stateClearers.Add(state.Clear);
        _playerLeavers.Add(steamId64 => state.Remove(steamId64));
        return state;
    }

    private readonly List<Action<ulong>> _playerLeavers = [];

    internal IClockTimer Track(IClockTimer timer)
    {
        _timers.Add(timer);
        return timer;
    }

    // ------------------------------------------------------------------ IPlatformLinkHandler

    public void OnWelcome(WelcomeOrchestratorFrame welcome)
    {
        _log.Info($"linked as {welcome.Provider}/{welcome.ServerId}");
    }

    public void OnAssign(AssignOrchestratorFrame frame)
    {
        if (Assignment is not null && Assignment.MatchId != frame.MatchId)
        {
            _log.Warn($"assigned {frame.MatchId} while holding {Assignment.MatchId}; releasing the old one first");
            OnRelease("reassigned");
        }

        var assignment = new Assignment(frame);
        Assignment = assignment;
        Match.Reset(frame.MatchId, frame.Maps[0].Sides == MapPlanSides.T ? TeamSide.T : TeamSide.Ct);
        if (frame.Restore is { } restore)
        {
            // The match resumes here from a backup (PRD-02 T14): the context starts where
            // the dead server left off, so the map number a backup frame or a round event
            // carries is the series' and not this box's.
            Match.MapNumber = restore.MapNumber;
            Match.RoundNumber = Math.Max(0, restore.RoundNumber - 1);
        }

        Commands = new CommandTable(frame.Gamemode.Commands, World.Clock, Localizer);
        _mapReady = false;
        Flow.OnAssigned(assignment);
        Assigned?.Invoke(assignment);
        if (_mode is { } mode)
        {
            if (mode.Id != frame.Gamemode.Id)
            {
                _log.Warn($"the attached mode is {mode.Id}, the assignment is {frame.Gamemode.Id}; the mode stays out of it");
            }
            else
            {
                mode.OnAssigned(assignment);
            }
        }

        ArmPositionTicker(assignment);
        SetState(LinkServerState.Assigned, "plugins loaded");
    }

    private void ArmPositionTicker(Assignment assignment)
    {
        _positionTicker?.Cancel();
        _positionTicker = null;
        if (!assignment.Gamemode.Capabilities.Positions)
        {
            return;
        }

        _positionTicker = World.Clock.Every(PositionTickIntervalMs, () =>
        {
            if (Assignment is null || !Link.Connected)
            {
                return;
            }

            var tick = Facts.PositionTick(World.Players);
            if (tick.Positions.Count > 0)
            {
                Emit(tick);
            }
        });
    }

    public void OnRelease(string? reason)
    {
        if (Assignment is null)
        {
            SetState(LinkServerState.Idle, reason);
            return;
        }

        try
        {
            Active?.OnEnd(reason);
        }
        finally
        {
            ClearModeState();
            _positionTicker?.Cancel();
            _positionTicker = null;
            Commands = null;
            var released = reason;
            Flow.OnReleased();
            Assignment = null;
            Match.Clear();
            _mapReady = false;
            Released?.Invoke(released);
            SetState(LinkServerState.Idle, reason);
        }
    }

    public void OnDrain()
    {
        Active?.OnDrain();
        Drained?.Invoke();
        SetState(LinkServerState.Draining);
    }

    public void OnProfile(RosterEntry player)
    {
        Assignment?.Push(player);
        Active?.OnProfile(player);
    }

    public CommandAnswer OnCommand(LinkCommand command)
    {
        if (CommandHook?.Invoke(command) is { } fromHost)
        {
            return fromHost;
        }

        switch (command)
        {
            case AnnounceCommand announce:
                World.Say(announce.Text);
                return CommandAnswer.Applied;
            case KickCommand kick:
                if (!ulong.TryParse(kick.SteamId64, out var steamId64) || World.Find(steamId64) is not { } player)
                {
                    return CommandAnswer.Rejected(MatchApiErrorCode.PlayerNotInMatch, $"{kick.SteamId64} is not on this server");
                }

                World.Kick(player, kick.Reason ?? "kicked");
                return CommandAnswer.Applied;
            case RconCommand rcon:
                World.ExecCommand(rcon.Command);
                return CommandAnswer.WithOutput("");
            case ProfileCommand profile:
                OnProfile(profile.Player);
                return CommandAnswer.Applied;
            default:
                return Active?.OnCommand(command) ?? CommandAnswer.Rejected(MatchApiErrorCode.CommandUnsupported, "no gamemode is attached for this assignment");
        }
    }

    public IReadOnlyList<ConsoleLine> OnConsoleRequest(int lines) =>
        _console.Skip(Math.Max(0, _console.Count - lines)).ToList();

    public CommandVerdict OnPlayerCommand(PlayerCommandOrchestratorFrame command)
    {
        if (!ulong.TryParse(command.SteamId64, out var steamId64) || World.Find(steamId64) is not { } player)
        {
            var locale = Assignment?.LocaleOf(ulong.TryParse(command.SteamId64, out var id) ? id : 0) ?? Localizer.DefaultLocale;
            return CommandVerdict.Refuse(PlayerCommandRefusal.NotInMatch, Localizer.For(locale)["command.not_in_match"]);
        }

        return RunPlayerCommand(player, command.Command, command.Args);
    }

    public void OnLinkDown(LinkClosure closure, bool fatal)
    {
        _log.Warn(fatal ? $"the link is closed for good: {closure}" : $"the link dropped: {closure}");
    }

    /// <summary>The whole pipeline for one tap, from the phone or from chat.</summary>
    public CommandVerdict RunPlayerCommand(IGamePlayer player, string command, JsonObject? args)
    {
        var locale = Assignment?.LocaleOf(player.SteamId64) ?? Localizer.DefaultLocale;
        if (Commands is null || Active is not { } mode)
        {
            return CommandVerdict.Refuse(PlayerCommandRefusal.UnknownCommand, Localizer.For(locale)["command.unknown_command"]);
        }

        if (Commands.Precheck(player.SteamId64, locale, command, args) is { } refused)
        {
            return refused;
        }

        var outcome = mode.OnPlayerCommand(player, command, args);
        return outcome is PlayerCommandOutcome.Applied
            ? Commands.Spend(player.SteamId64, command)
            : Commands.Refused(player.SteamId64, locale, command, outcome);
    }

    // ------------------------------------------------------------------ world hooks

    private void OnMapStarted(string map)
    {
        if (Assignment is null)
        {
            return;
        }

        if (_mapReady && Assignment.Gamemode.Flow == GamemodeFlow.Matchzy)
        {
            // A second map while assigned: MatchZy changed level for the next map of its
            // series (its map_end reached the orchestrator over its own log, never this
            // runtime), so the context follows it here. A mode that emits map_end itself
            // already advanced it.
            Match.MapNumber++;
            Match.RoundNumber = 0;
        }

        _mapReady = true;
        Commands?.Reset(PlayerCommandChargePeriod.Map);
        Flow.OnMapStarted();
        MapLoaded?.Invoke(Assignment, map);
        Emit(Facts.ServerReady(map));
        Active?.OnStart();
    }

    private void OnPlayerConnected(IGamePlayer player)
    {
        if (Assignment is null)
        {
            return;
        }

        if (!player.IsBot)
        {
            Emit(Facts.PlayerConnected(player));
        }

        Active?.OnPlayerJoined(player);
    }

    private void OnPlayerDisconnected(IGamePlayer player)
    {
        if (Assignment is null)
        {
            return;
        }

        if (!player.IsBot)
        {
            Emit(Facts.PlayerDisconnected(player));
        }

        Active?.OnPlayerLeft(player);
        Commands?.Forget(player.SteamId64);
        foreach (var leave in _playerLeavers)
        {
            leave(player.SteamId64);
        }
    }

    private void OnPlayerSpawned(IGamePlayer player)
    {
        if (Assignment is null)
        {
            return;
        }

        Commands?.Reset(PlayerCommandChargePeriod.Life, player.SteamId64);
        Active?.OnPlayerSpawned(player);
    }

    private void OnPlayerDied(PlayerDeath death)
    {
        if (Assignment is null)
        {
            return;
        }

        Emit(Facts.PlayerDeath(death));
        Active?.OnPlayerDied(death);
    }

    private void OnRoundStarted()
    {
        if (Assignment is null)
        {
            return;
        }

        // `going_live` and a `side_swap` belong before round 1 exists, and emitting
        // `going_live` resets the counter — so the generic flow speaks on either side of
        // the numbering, never in the middle of it.
        Flow.OnRoundStarting();
        // The engine's own count when the world has one (warmup and a knife round never
        // count, mp_restartgame resets it); a plain count when it does not (the harness).
        Match.RoundNumber = World.Rules is { } rules ? rules.RoundsPlayed + 1 : Match.RoundNumber + 1;
        Commands?.Reset(PlayerCommandChargePeriod.Round);
        Flow.OnRoundStarted();
        Active?.OnRoundStart(Match.RoundNumber);
    }

    private void OnRoundEnded(RoundEnd roundEnd)
    {
        if (Assignment is null)
        {
            return;
        }

        Flow.OnRoundEnded(roundEnd);
        Active?.OnRoundEnd(roundEnd);
    }

    private void OnMapEnded()
    {
        if (Assignment is not null)
        {
            Flow.OnMapEnded();
        }
    }

    private void OnBombPlanted(IGamePlayer player, BombSiteName site)
    {
        if (Assignment is not null)
        {
            Emit(Facts.BombPlanted(player, site));
        }
    }

    private void OnBombDefused(IGamePlayer player, BombSiteName site)
    {
        if (Assignment is not null)
        {
            Emit(Facts.BombDefused(player, site));
        }
    }

    private void OnBombExploded(BombSiteName site)
    {
        if (Assignment is not null)
        {
            Emit(Facts.BombExploded(site));
        }
    }

    private void OnChatSaid(ChatLine line)
    {
        if (Assignment is null)
        {
            return;
        }

        var parsed = ChatParser.Parse(line.Text);
        var chat = Assignment.Gamemode.Capabilities.Chat;
        switch (parsed)
        {
            case ChatParser.Parsed.Command command:
                if (chat)
                {
                    Emit(Facts.ChatCommand(line.Player, command.Name, command.Args));
                }

                if (Commands?.Declares(command.Name) == true)
                {
                    var verdict = RunPlayerCommand(line.Player, command.Name, null);
                    if (verdict.Message is { } message)
                    {
                        World.Say(line.Player, message);
                    }
                }

                break;
            case ChatParser.Parsed.Message message:
                if (chat && message.Text.Length > 0)
                {
                    Emit(Facts.ChatMessage(line.Player, message.Text, line.TeamOnly));
                }

                Active?.OnChat(line);
                break;
            default:
                break;
        }
    }

    private void OnTick()
    {
        Link.Pump();
        if (Assignment is not null)
        {
            Active?.OnTick();
        }
    }

    private void ClearModeState()
    {
        foreach (var timer in _timers)
        {
            timer.Cancel();
        }

        _timers.Clear();
        foreach (var clear in _stateClearers)
        {
            clear();
        }

        Commands?.Clear();
    }

    public void Dispose()
    {
        Detach();
        _positionTicker?.Cancel();
        _positionTicker = null;
        _stateClearers.Clear();
        _playerLeavers.Clear();
        World.MapStarted -= OnMapStarted;
        World.PlayerConnected -= OnPlayerConnected;
        World.PlayerDisconnected -= OnPlayerDisconnected;
        World.PlayerSpawned -= OnPlayerSpawned;
        World.PlayerDied -= OnPlayerDied;
        World.RoundStarted -= OnRoundStarted;
        World.RoundEnded -= OnRoundEnded;
        World.BombPlanted -= OnBombPlanted;
        World.BombDefused -= OnBombDefused;
        World.BombExploded -= OnBombExploded;
        World.ChatSaid -= OnChatSaid;
        World.Tick -= OnTick;
        if (ReferenceEquals(Link.Handler, this))
        {
            Link.Handler = null;
        }
    }
}
