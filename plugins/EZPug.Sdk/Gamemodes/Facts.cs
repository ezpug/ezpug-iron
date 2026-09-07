using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>The event model a mode speaks</b>: the vocabulary's events with the parts every
/// one carries — <c>matchId</c>, <c>source</c>, the map and round numbers — filled from
/// the runtime's <see cref="MatchContext"/>, so a mode writes
/// <c>Emit(Facts.RoundEnd(…))</c> and never a match id. The generated records are the
/// wire truth; this only saves the typing. Players are described through
/// <see cref="Player(IGamePlayer)"/>, which turns an engine team into <c>team_a</c>/
/// <c>team_b</c>/<c>spec</c> by the roster first and the sides in effect second.
/// </summary>
public sealed class Facts
{
    private readonly Func<MatchContext> _context;
    private readonly Func<GameserverSource> _source;
    private readonly Func<Assignment?> _assignment;

    internal Facts(Func<MatchContext> context, Func<GameserverSource> source, Func<Assignment?> assignment)
    {
        _context = context;
        _source = source;
        _assignment = assignment;
    }

    private MatchContext Context => _context();
    private string MatchId => Context.MatchId ?? throw new InvalidOperationException("no match is assigned");
    private GameserverSource Source => _source();

    /// <summary>A player as the vocabulary names one: SteamID64, name, and the slot they hold.</summary>
    public GameserverPlayer Player(IGamePlayer player) =>
        new() { SteamId64 = player.SteamId64.ToString(), Name = player.Name, Team = SlotOf(player) };

    /// <summary>The vocabulary's slot for a player: the roster's team when rostered, else by the sides in effect, <c>spec</c> off a team.</summary>
    public ServerSlot SlotOf(IGamePlayer player)
    {
        var rostered = _assignment()?.RosteredTeamOf(player.SteamId64);
        if (rostered is { } team)
        {
            return team == MatchTeam.TeamA ? ServerSlot.TeamA : ServerSlot.TeamB;
        }

        if (_assignment()?.Gamemode.Slots.Teams == 1 && player.Team is PlayerTeam.Terrorist or PlayerTeam.CounterTerrorist)
        {
            return ServerSlot.TeamA;
        }

        return Context.TeamOf(player.Team) switch
        {
            MatchTeam.TeamA => ServerSlot.TeamA,
            MatchTeam.TeamB => ServerSlot.TeamB,
            _ => ServerSlot.Spec,
        };
    }

    public ServerReadyEvent ServerReady(string map) =>
        new() { MatchId = MatchId, Source = Source, Map = map };

    public PlayerConnectedEvent PlayerConnected(IGamePlayer player) =>
        new() { MatchId = MatchId, Source = Source, Player = Player(player) };

    public PlayerDisconnectedEvent PlayerDisconnected(IGamePlayer player) =>
        new() { MatchId = MatchId, Source = Source, Player = Player(player) };

    public GoingLiveEvent GoingLive(string map) =>
        new() { MatchId = MatchId, Source = Source, MapNumber = Context.MapNumber, Map = map };

    public RoundStartEvent RoundStart(TeamScore? score = null) =>
        new() { MatchId = MatchId, Source = Source, MapNumber = Context.MapNumber, RoundNumber = Context.RoundNumber, Score = score };

    public RoundEndEvent RoundEnd(MatchTeam winner, TeamSide side, RoundWinCondition condition, TeamScore score, IReadOnlyList<PlayerRoundSummary>? players = null, long? roundTimeMs = null) =>
        new()
        {
            MatchId = MatchId,
            Source = Source,
            MapNumber = Context.MapNumber,
            RoundNumber = Context.RoundNumber,
            Winner = new RoundWinner { Team = winner, Side = side },
            WinCondition = condition,
            Score = score,
            Players = players,
            RoundTimeMs = roundTimeMs,
        };

    public SideSwapEvent SideSwap(TeamSide teamA) =>
        new()
        {
            MatchId = MatchId,
            Source = Source,
            MapNumber = Context.MapNumber,
            Sides = new SideSwapEventSides { TeamA = teamA, TeamB = teamA == TeamSide.Ct ? TeamSide.T : TeamSide.Ct },
        };

    public MapEndEvent MapEnd(TeamScore score, MatchTeam? winner, string? map = null) =>
        new() { MatchId = MatchId, Source = Source, MapNumber = Context.MapNumber, Map = map, Score = score, Winner = winner };

    public SeriesEndEvent SeriesEnd(TeamScore seriesScore, MatchTeam? winner) =>
        new() { MatchId = MatchId, Source = Source, SeriesScore = seriesScore, Winner = winner };

    public MatchPausedEvent MatchPaused(PauseKind? kind = null, PauseSource? pausedBy = null) =>
        new() { MatchId = MatchId, Source = Source, MapNumber = Context.MapNumber, Kind = kind, PausedBy = pausedBy };

    public MatchUnpausedEvent MatchUnpaused() =>
        new() { MatchId = MatchId, Source = Source, MapNumber = Context.MapNumber };

    public PlayerDeathEvent PlayerDeath(PlayerDeath death, long? roundTimeMs = null) =>
        new()
        {
            MatchId = MatchId,
            Source = Source,
            MapNumber = Context.MapNumber,
            RoundNumber = Math.Max(Context.RoundNumber, 1),
            Victim = Player(death.Victim),
            Killer = death.Killer is null ? null : Player(death.Killer),
            Assists = death.Assists.Select(assist => new PlayerDeathEventAssist { Player = Player(assist.Player), Flash = assist.Flash }).ToList(),
            Weapon = death.Weapon,
            Headshot = death.Headshot,
            Penetrated = death.Penetrated ? true : null,
            Noscope = death.Noscope ? true : null,
            ThroughSmoke = death.ThroughSmoke ? true : null,
            AttackerBlind = death.AttackerBlind ? true : null,
            RoundTimeMs = roundTimeMs,
        };

    public BombPlantedEvent BombPlanted(IGamePlayer player, BombSiteName site, long? roundTimeMs = null) =>
        new() { MatchId = MatchId, Source = Source, MapNumber = Context.MapNumber, RoundNumber = Math.Max(Context.RoundNumber, 1), Player = Player(player), Site = SiteOf(site), RoundTimeMs = roundTimeMs };

    public BombDefusedEvent BombDefused(IGamePlayer player, BombSiteName site, long? roundTimeMs = null) =>
        new() { MatchId = MatchId, Source = Source, MapNumber = Context.MapNumber, RoundNumber = Math.Max(Context.RoundNumber, 1), Player = Player(player), Site = SiteOf(site), RoundTimeMs = roundTimeMs };

    public BombExplodedEvent BombExploded(BombSiteName site, long? roundTimeMs = null) =>
        new() { MatchId = MatchId, Source = Source, MapNumber = Context.MapNumber, RoundNumber = Math.Max(Context.RoundNumber, 1), Site = SiteOf(site), RoundTimeMs = roundTimeMs };

    public PositionTickEvent PositionTick(IEnumerable<IGamePlayer> players) =>
        new()
        {
            MatchId = MatchId,
            Source = Source,
            MapNumber = Context.MapNumber,
            RoundNumber = Context.RoundNumber > 0 ? Context.RoundNumber : null,
            Positions = players
                .Where(player => player.IsAlive && player.Position is not null)
                .Select(player => new PositionTickEventPosition
                {
                    SteamId64 = player.SteamId64.ToString(),
                    X = player.Position!.Value.X,
                    Y = player.Position!.Value.Y,
                    Z = player.Position!.Value.Z,
                })
                .ToList(),
        };

    public BackupWrittenEvent BackupWritten(long roundNumber, string filename) =>
        new() { MatchId = MatchId, Source = Source, MapNumber = Context.MapNumber, RoundNumber = roundNumber, Filename = filename };

    /// <summary>
    /// A map's demo is finished. <paramref name="sha256"/> and
    /// <paramref name="contentType"/> travel together and only once the server has
    /// already PUT the file where the assignment's <c>demoUploadUrl</c> said — that pair
    /// is what the orchestrator relays as <c>demo.uploaded</c> (decision 10, PRD-02 T21).
    /// A demo announced without them exists on this box and nowhere else.
    /// </summary>
    public DemoAvailableEvent DemoAvailable(string filename, long? sizeBytes = null, string? sha256 = null, string? contentType = null, string? url = null) =>
        new()
        {
            MatchId = MatchId,
            Source = Source,
            MapNumber = Context.MapNumber,
            Filename = filename,
            Url = url,
            SizeBytes = sizeBytes,
            Sha256 = sha256,
            ContentType = contentType,
        };

    public ChatMessageEvent ChatMessage(IGamePlayer player, string text, bool teamOnly) =>
        new() { MatchId = MatchId, Source = Source, Player = Player(player), Text = text, Scope = teamOnly ? ServerChatScope.Team : ServerChatScope.All };

    public ChatCommandEvent ChatCommand(IGamePlayer player, string command, string? args) =>
        new() { MatchId = MatchId, Source = Source, Player = Player(player), Command = command, Args = args };

    /// <summary>The escape hatch: a snake_case name and any JSON-shaped data.</summary>
    public PluginEvent Plugin(string name, object data) =>
        new() { MatchId = MatchId, Source = Source, Name = name, Data = ToObject(data) };

    private static BombSite? SiteOf(BombSiteName site) =>
        site switch
        {
            BombSiteName.A => BombSite.A,
            BombSiteName.B => BombSite.B,
            _ => null,
        };

    private static JsonObject ToObject(object data) => ToJsonObject(data);

    /// <summary>An anonymous object, a record or a <see cref="JsonObject"/> as the wire's JSON object — what a <c>plugin_event</c>'s <c>data</c> and a widget push's payload are both built from.</summary>
    public static JsonObject ToJsonObject(object data) =>
        data as JsonObject
        ?? JsonSerializer.SerializeToNode(data, ProtocolJson.Options) as JsonObject
        ?? throw new ArgumentException("data must serialize to a JSON object", nameof(data));
}

/// <summary>
/// Stamps the per-match sequence hint onto an event on its way out. Records are
/// immutable, so the copy is the record's own clone method and the hint is set on the
/// copy; the caller's instance is untouched.
/// </summary>
public static class EventStamper
{
    private static readonly Dictionary<Type, (MethodInfo Clone, PropertyInfo Seq)> Cache = new();

    /// <summary>The per-match sequence hint an event carries, whichever branch it is.</summary>
    public static long? SeqOf(GameserverEvent gameserverEvent) => (long?)Members(gameserverEvent.GetType()).Seq.GetValue(gameserverEvent);

    public static GameserverEvent WithSeq(GameserverEvent gameserverEvent, long seq)
    {
        var members = Members(gameserverEvent.GetType());
        var copy = (GameserverEvent)members.Clone.Invoke(gameserverEvent, null)!;
        members.Seq.SetValue(copy, seq);
        return copy;
    }

    private static (MethodInfo Clone, PropertyInfo Seq) Members(Type type)
    {
        lock (Cache)
        {
            if (!Cache.TryGetValue(type, out var members))
            {
                members = (
                    type.GetMethod("<Clone>$") ?? throw new InvalidOperationException($"{type.Name} is not a record"),
                    type.GetProperty("Seq") ?? throw new InvalidOperationException($"{type.Name} has no Seq"));
                Cache[type] = members;
            }

            return members;
        }
    }
}
