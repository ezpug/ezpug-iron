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
/// <c>team_b</c> by the roster, and <c>unrostered</c>/<c>spec</c> for a body it never named.
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

    /// <summary>
    /// The vocabulary's slot for a player. <c>team_a</c> and <c>team_b</c> are the
    /// roster's word and nobody else's: a rostered player — a puppet is one — carries
    /// their team wherever they stand. A body the request never named is
    /// <c>unrostered</c> while it plays on a side (an open-join guest, a plain bot) and
    /// <c>spec</c> while it is on none (PRD-03 T7, <c>OPEN-POINTS</c> §2): guessing a team
    /// from the side it happened to spawn on put strangers on a team's sheet.
    /// </summary>
    public ServerSlot SlotOf(IGamePlayer player)
    {
        if (_assignment()?.RosteredTeamOf(player.SteamId64) is { } team)
        {
            return team == MatchTeam.TeamA ? ServerSlot.TeamA : ServerSlot.TeamB;
        }

        return player.Team is PlayerTeam.Terrorist or PlayerTeam.CounterTerrorist ? ServerSlot.Unrostered : ServerSlot.Spec;
    }

    public ServerReadyEvent ServerReady(string map) =>
        new() { MatchId = MatchId, Source = Source, Map = map, Engine = Context.Engine };

    public PlayerConnectedEvent PlayerConnected(IGamePlayer player) =>
        new() { MatchId = MatchId, Source = Source, Player = Player(player) };

    public PlayerDisconnectedEvent PlayerDisconnected(IGamePlayer player) =>
        new() { MatchId = MatchId, Source = Source, Player = Player(player) };

    /// <summary><c>going_live</c> with the engine game this map loaded under and the format that is (PRD-05 T2d).</summary>
    public GoingLiveEvent GoingLive(string map, LiveLength? length = null) =>
        new()
        {
            MatchId = MatchId,
            Source = Source,
            MapNumber = Context.MapNumber,
            Map = map,
            Length = length,
            Engine = Context.Engine,
            Format = Context.Engine is { } engine ? FormatOf(engine) : null,
        };

    /// <summary>
    /// The format an engine game is, or <c>null</c> for one that is neither: <c>game_type 0</c>
    /// with <c>game_mode 1</c> is competitive, with <c>game_mode 2</c> wingman. The C# twin of
    /// <c>formatOfEngineGame</c> in <c>@ezpug/match-api</c>, and MatchZy's own
    /// <c>IsWingmanMode</c> test.
    /// </summary>
    public static MatchFormat? FormatOf(EngineGame engine) =>
        (engine.GameType, engine.GameMode) switch
        {
            (0, 1) => MatchFormat.Competitive,
            (0, 2) => MatchFormat.Wingman,
            _ => null,
        };

    public RoundStartEvent RoundStart(TeamScore? score = null) =>
        new() { MatchId = MatchId, Source = Source, MapNumber = Context.MapNumber, RoundNumber = Context.RoundNumber, Score = score };

    public RoundEndEvent RoundEnd(MatchTeam winner, TeamSide side, RoundWinCondition condition, TeamScore score, IReadOnlyList<PlayerRoundSummary>? players = null, long? roundTimeMs = null, RoundTower? tower = null) =>
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
            Tower = tower,
        };

    public SideSwapEvent SideSwap(TeamSide teamA) =>
        new()
        {
            MatchId = MatchId,
            Source = Source,
            MapNumber = Context.MapNumber,
            Sides = new SideSwapEventSides { TeamA = teamA, TeamB = teamA == TeamSide.Ct ? TeamSide.T : TeamSide.Ct },
        };

    public MapEndEvent MapEnd(TeamScore score, MatchTeam? winner, string? map = null, MatchEndReason? reason = null, MapTower? tower = null) =>
        new() { MatchId = MatchId, Source = Source, MapNumber = Context.MapNumber, Map = map, Score = score, Winner = winner, Reason = reason, Tower = tower };

    public SeriesEndEvent SeriesEnd(TeamScore seriesScore, MatchTeam? winner, MatchEndReason? reason = null) =>
        new() { MatchId = MatchId, Source = Source, SeriesScore = seriesScore, Winner = winner, Reason = reason };

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

    /// <summary>
    /// A position tick: every living player's position and, when the caller sampled the
    /// utility layer (ezpug/ezpug-iron#5), the grenades and the bomb beside them.
    /// <paramref name="grenades"/> travels as a list even when empty, because a missing
    /// list tells the client nothing was sampled; <paramref name="bomb"/> is simply absent
    /// while none is in play.
    /// </summary>
    public PositionTickEvent PositionTick(
        IEnumerable<IGamePlayer> players,
        IReadOnlyList<GrenadeSighting>? grenades = null,
        BombSighting? bomb = null) =>
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
            Grenades = grenades?.Select(Grenade).ToList(),
            Bomb = bomb is null ? null : Bomb(bomb),
        };

    private static PositionTickEventGrenade Grenade(GrenadeSighting grenade) =>
        new()
        {
            Id = grenade.Id,
            Kind = grenade.Kind switch
            {
                GrenadeKind.He => PositionTickEventGrenadeKind.He,
                GrenadeKind.Flash => PositionTickEventGrenadeKind.Flash,
                GrenadeKind.Smoke => PositionTickEventGrenadeKind.Smoke,
                GrenadeKind.Molotov => PositionTickEventGrenadeKind.Molotov,
                GrenadeKind.Incendiary => PositionTickEventGrenadeKind.Incendiary,
                _ => PositionTickEventGrenadeKind.Decoy,
            },
            X = grenade.Position.X,
            Y = grenade.Position.Y,
            Z = grenade.Position.Z,
            State = grenade.State == GrenadeState.Active ? PositionTickEventGrenadeState.Active : PositionTickEventGrenadeState.Flying,
            // The wire wants a positive radius or none, and only an active one has any.
            Radius = grenade.State == GrenadeState.Active && grenade.Radius is > 0 ? grenade.Radius : null,
            SteamId64 = grenade.Thrower?.SteamId64.ToString(),
        };

    private static PositionTickEventBomb Bomb(BombSighting bomb) =>
        new()
        {
            State = bomb.State switch
            {
                BombState.Carried => PositionTickEventBombState.Carried,
                BombState.Dropped => PositionTickEventBombState.Dropped,
                _ => PositionTickEventBombState.Planted,
            },
            X = bomb.Position.X,
            Y = bomb.Position.Y,
            Z = bomb.Position.Z,
            SteamId64 = bomb.State == BombState.Carried ? bomb.Carrier?.SteamId64.ToString() : null,
            Site = bomb.State == BombState.Planted ? SiteOf(bomb.Site) : null,
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
    public DemoAvailableEvent DemoAvailable(string filename, long? sizeBytes = null, string? sha256 = null, string? contentType = null, string? url = null, long? mapNumber = null) =>
        new()
        {
            MatchId = MatchId,
            Source = Source,
            // A demo is finished a GOTV delay after its map, by which time the context
            // has counted the next one — so the caller may name the map it belongs to.
            MapNumber = mapNumber ?? Context.MapNumber,
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
