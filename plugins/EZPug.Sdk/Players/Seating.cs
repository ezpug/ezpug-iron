using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>People sit where the roster says</b> (PRD-09 T2, decision 35). The playtest of
/// 2026-10-04 found Rush seating nobody: a puppet is added on its side
/// (<see cref="Puppeteer"/>), and a person was placed by nothing, so a roster that all
/// clicked CT stood on CT and the warmup hold counted them present. MatchZy seats its own
/// match (decision 19) and does not run Rush (decision 33), so for a mode the SDK tells the
/// story of, the SDK seats.
///
/// <para><b>Who is seated.</b> A <c>flow: none</c> mode with <c>slots.teams: 2</c>, unless
/// the mode attached for it owns its flow (a mode that knows better is always right): every
/// rostered body, a person or a puppet, is put on its team's side by the rule the puppeteer
/// adds a puppet by (<see cref="MatchContext.SideOf"/>), which follows every
/// <c>side_swap</c>. It is checked every <see cref="SeatIntervalMs"/>, so somebody who
/// connects is placed before the team menu matters and somebody who picks the other side or
/// spectators is put back within a beat. A person is told so once in chat, in their language
/// and the match's voice; a body the engine would not move is tried again every
/// <see cref="RetryMs"/>, with a line in the log and none in chat. A plain bot is nobody's
/// and stays where the engine put it; a one-team mode and a community plugin's flow
/// (<c>retakes</c> splits its group afresh every round) are left alone.</para>
///
/// <para><b>Never while the engine swaps.</b> At halftime CS2 moves every player to the
/// other side at the round reset, and the runtime's sides follow at the round start that
/// comes with it (<see cref="GenericFlow"/>'s <c>side_swap</c>). From the moment the
/// gamerules flag a swap until that <c>side_swap</c> is said, the roster's sides and the
/// engine's disagree for a reason, and seating holds still rather than undo the swap.</para>
///
/// <para><b>The door</b> (<c>openJoin: false</c>, <c>docs/gamemodes.md</c> → Slots). For
/// every flow but <c>matchzy</c>, whose plugin keeps its own door, a person whose SteamID is
/// not on the roster is kicked with the reason, in both languages because nobody knows
/// theirs. One turned away as they arrive was never announced, so nothing says they left
/// either. A plain bot is never a stranger, and neither is a SteamID the engine has not
/// told yet (<c>0</c>): the next beat asks again.</para>
/// </summary>
public sealed class Seating
{
    /// <summary>How often the room is checked for a person off their side, or a stranger.</summary>
    public const long SeatIntervalMs = 250;

    /// <summary>How long a body that was moved, or a stranger who was kicked, is given before it is tried again.</summary>
    public const long RetryMs = 2_000;

    private readonly IGameWorld _world;
    private readonly GamemodeRuntime _runtime;
    private readonly ILinkLog _log;
    private readonly Dictionary<ulong, long> _movedAtMs = [];
    private readonly Dictionary<ulong, (long AtMs, bool Announced)> _turnedAway = [];
    private Assignment? _assignment;
    private bool _seats;
    private bool _door;
    private IClockTimer? _poll;

    internal Seating(IGameWorld world, GamemodeRuntime runtime, ILinkLog log)
    {
        _world = world;
        _runtime = runtime;
        _log = log;
    }

    /// <summary>Whether the SDK puts the rostered on their sides for the match assigned right now.</summary>
    public bool Seats => _seats && !_runtime.ModeOwnsFlow;

    /// <summary>Whether the SDK keeps strangers out of the match assigned right now: the roster is the guest list and no match plugin keeps the door.</summary>
    public bool KeepsTheDoor => _door;

    internal void OnAssigned(Assignment assignment)
    {
        Stop();
        _assignment = assignment;
        var flow = assignment.Gamemode.Flow;
        _seats = flow == GamemodeFlow.None && assignment.Gamemode.Slots.Teams == 2;
        _door = flow != GamemodeFlow.Matchzy && !assignment.Gamemode.Slots.OpenJoin;
        if (_seats || _door)
        {
            _poll = _world.Clock.Every(SeatIntervalMs, Poll);
        }
    }

    internal void OnReleased()
    {
        Stop();
        _assignment = null;
        _seats = false;
        _door = false;
    }

    /// <summary>
    /// Somebody arrived: <c>false</c> when they were turned away at the door, and nothing
    /// else on the server should hear of them.
    /// </summary>
    internal bool Admit(IGamePlayer player)
    {
        if (!Stranger(player))
        {
            return true;
        }

        TurnAway(player, announced: false);
        return false;
    }

    /// <summary>
    /// Somebody left: <c>true</c> when it was a stranger turned away before anything
    /// announced them, whose leaving is nobody's news either.
    /// </summary>
    internal bool OnPlayerDisconnected(IGamePlayer player)
    {
        _movedAtMs.Remove(player.SteamId64);
        return _turnedAway.Remove(player.SteamId64, out var turned) && !turned.Announced;
    }

    /// <summary>The side a rostered body belongs on right now; <c>null</c> for anybody the SDK does not seat.</summary>
    public PlayerTeam? SideOf(ulong steamId64) =>
        Seats && _assignment?.RosteredTeamOf(steamId64) is { } team ? _runtime.Match.SideOf(team) : null;

    /// <summary>One line for <c>ezpug_status</c>: who stands where, read off the engine, and whether the door is shut.</summary>
    public string Report()
    {
        if (_assignment is not { } assignment)
        {
            return "no match";
        }

        var door = _door ? "; the roster is the guest list" : "";
        if (!Seats)
        {
            return $"not the SDK's for this mode{door}";
        }

        var rostered = _world.Players.Where(player => (!player.IsBot || player.IsPuppet) && assignment.IsRostered(player.SteamId64)).ToList();
        var off = rostered.Where(player => player.Team != SideOf(player.SteamId64)).ToList();
        var ct = rostered.Count(player => player.Team == PlayerTeam.CounterTerrorist);
        var t = rostered.Count(player => player.Team == PlayerTeam.Terrorist);
        var report = $"{ct} on CT, {t} on T; {rostered.Count - off.Count} of {rostered.Count} rostered on their side";
        if (off.Count > 0)
        {
            report += $", off it: {string.Join(", ", off.Select(player => $"{player.Name} on {Short(player.Team)} for {Short(SideOf(player.SteamId64))}"))}";
        }

        return report + door;
    }

    // ------------------------------------------------------------------ the poll

    private void Poll()
    {
        if (_assignment is null || _world.Rules is not { } rules)
        {
            return;
        }

        var now = _world.Clock.NowMs;
        foreach (var player in _world.Players.ToList())
        {
            if (Stranger(player))
            {
                // Here before the assignment was, or before the engine told their SteamID.
                TurnAway(player, announced: true);
            }
        }

        if (!Seats || rules.SwitchingTeamsAtRoundReset || _runtime.Flow.SwapPending)
        {
            return;
        }

        foreach (var player in _world.Players.ToList())
        {
            if ((player.IsBot && !player.IsPuppet) || SideOf(player.SteamId64) is not { } side)
            {
                continue;
            }

            if (player.Team == side)
            {
                _movedAtMs.Remove(player.SteamId64);
                continue;
            }

            Seat(player, side, now);
        }
    }

    private void Seat(IGamePlayer player, PlayerTeam side, long now)
    {
        var again = _movedAtMs.TryGetValue(player.SteamId64, out var at);
        if (again && now - at < RetryMs)
        {
            return;
        }

        _movedAtMs[player.SteamId64] = now;
        if (again)
        {
            _log.Warn($"seating: {player.Name} ({player.SteamId64}) is still on {Short(player.Team)}; moving them to {Short(side)} again");
        }
        else
        {
            _log.Info($"seating: {player.Name} ({player.SteamId64}) was on {Short(player.Team)}; their side is {Short(side)}");
        }

        _world.SetTeam(player, side);
        if (player.Team == side)
        {
            // The engine moves a body inside the call: only one it would not move waits for a retry.
            _movedAtMs.Remove(player.SteamId64);
        }

        if (!again && !player.IsBot && _assignment?.RosteredTeamOf(player.SteamId64) is { } team)
        {
            var lines = _runtime.Localizer.For(_assignment.LocaleOf(player.SteamId64));
            _runtime.Brand.Say(player, lines["seating.placed", _runtime.Brand.TeamName(team), Short(side)]);
        }
    }

    // ------------------------------------------------------------------ the door

    private bool Stranger(IGamePlayer player) =>
        _door && _assignment is { } assignment && !player.IsBot && player.SteamId64 != 0 && !assignment.IsRostered(player.SteamId64);

    private void TurnAway(IGamePlayer player, bool announced)
    {
        var now = _world.Clock.NowMs;
        var known = _turnedAway.TryGetValue(player.SteamId64, out var turned);
        if (known && now - turned.AtMs < RetryMs)
        {
            return;
        }

        // Before the kick: a world that drops them inside it asks who they were.
        _turnedAway[player.SteamId64] = (now, known ? turned.Announced : announced);
        _log.Info($"door: {player.Name} ({player.SteamId64}) is not on the roster of {_assignment?.MatchId}; turned away");
        var de = _runtime.Localizer.For(Locale.De)["door.not_rostered"];
        var en = _runtime.Localizer.For(Locale.En)["door.not_rostered"];
        _world.Kick(player, $"{de} / {en}");
    }

    private void Stop()
    {
        _poll?.Cancel();
        _poll = null;
        _movedAtMs.Clear();
        _turnedAway.Clear();
    }

    private static string Short(PlayerTeam? team) =>
        team switch
        {
            PlayerTeam.CounterTerrorist => "CT",
            PlayerTeam.Terrorist => "T",
            PlayerTeam.Spectator => "spectators",
            _ => "no team",
        };
}
