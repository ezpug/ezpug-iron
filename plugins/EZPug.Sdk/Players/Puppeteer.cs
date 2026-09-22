using System.Globalization;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>Puppets</b> (PRD-03 T7): when the assignment carries <c>simulation</c>, every
/// roster entry is played by a bot that <i>is</i> that entry as far as anything on the
/// wire can tell — its SteamID64, its name, announced with <c>player_connected</c> like
/// a person, findable by a <c>kick</c> or a widget tap addressed to the rostered id.
/// For the modes MatchZy does not run: under a <c>matchzy</c> flow MatchZy-Enhanced's
/// simulation mode seats the bodies and keeps its own private map of who is who, so this
/// class stays out of it rather than hold a second opinion.
///
/// <para><b>A mixed roster seats exactly who is named</b> (PRD-04 T2). When
/// <c>simulation.puppets</c> lists a subset of the roster, only those entries get a seat
/// here (<see cref="Assignment.IsPuppet"/>); the rest are people, who arrive through the
/// mode's ordinary door — a drop-in mode goes live on its own clock and they join it live,
/// like anybody else — and are announced as the rostered players they are when they do.
/// A bot that turns up while such a seat is empty is <i>not</i> cast into it: the seat
/// was never a puppet's, so the body stays a plain bot and the person's SteamID is never
/// spoken for. Under <c>matchzy</c> the door refuses a partial list, because the fork
/// seats every configured entry or none.</para>
///
/// <para><b>A puppet and a bot are two things.</b> A plain bot is never rostered and never
/// announced, and is named by <see cref="BotIdentity"/>. A puppet is a roster entry made
/// flesh. The difference is decided once, when the engine adds the body
/// (<see cref="IGameWorld.Casting"/>), because a player's identity is fixed from its
/// first hook — which is why the bots a mode's cfg brought before the map was ready are
/// sent home first: they were named before anybody could cast them.</para>
///
/// <para><b>A scenario is a seating plan</b> (PRD-03 T11). The assignment may carry a
/// <see cref="PuppetScript"/> — the story the request named, resolved into knobs by the
/// orchestrator, so nothing here holds a second opinion about what <c>no-show</c> means.
/// <c>absentPlayers</c> leaves that many roster entries without a body, from the end of the
/// seating order, which takes one side then the other by turns; <c>idle</c> seats nobody at
/// all and the server waits on an empty map, which is the mode's <c>length</c> or the
/// orchestrator's join deadline to end (PRD-03 T9). Everything else a scenario can ask for
/// is refused at the door, because a knob that quietly did nothing here would be a lie
/// about a match somebody ran.</para>
///
/// <para><b>One seat at a time.</b> The engine adds a bot some frames after it is asked
/// and says nothing when it will not (a full server), so a seat is asked for, waited on
/// for <see cref="ArrivalPatienceMs"/>, and asked for again. A puppet that leaves — a
/// kick through the Match API, a map change — frees its seat and the next pass fills it:
/// it is announced leaving and announced coming back, the way a person would be.</para>
/// </summary>
public sealed class Puppeteer
{
    /// <summary>How often the room is checked for an empty seat.</summary>
    public const long SeatIntervalMs = 500;

    /// <summary>How long a bot that was asked for may take to arrive before it is asked for again.</summary>
    public const long ArrivalPatienceMs = 5_000;

    private readonly IGameWorld _world;
    private readonly MatchContext _match;
    private readonly ILinkLog _log;
    private readonly List<Seat> _seats = [];
    private Assignment? _assignment;
    private IClockTimer? _ticker;
    private Seat? _askedFor;
    private long _askedAtMs;
    private bool _scaled;

    public Puppeteer(IGameWorld world, MatchContext match, ILinkLog log)
    {
        _world = world;
        _match = match;
        _log = log;
    }

    /// <summary>Whether this match's roster is played by this class's puppets.</summary>
    public bool Active => _assignment is not null;

    /// <summary>How many roster entries have a body right now.</summary>
    public int Seated => _seats.Count(seat => seat.Slot is not null);

    /// <summary>Whether the SDK seats the puppets for <paramref name="assignment"/>: it asked for them, and MatchZy is not the one seating them.</summary>
    public static bool Seats(Assignment assignment) =>
        assignment.Simulation is not null && assignment.Gamemode.Flow != GamemodeFlow.Matchzy;

    internal void OnAssigned(Assignment assignment)
    {
        Stop();
        if (!Seats(assignment))
        {
            return;
        }

        _assignment = assignment;
        // Team A and team B by turns, so a room that is still filling is an even one.
        // Only the entries that are puppets get a seat: a person's chair stays empty.
        var teamA = assignment.Teams.TeamA.Players;
        var teamB = assignment.Teams.TeamB.Players;
        for (var index = 0; index < Math.Max(teamA.Count, teamB.Count); index++)
        {
            if (index < teamA.Count)
            {
                Add(assignment, teamA[index], MatchTeam.TeamA);
            }

            if (index < teamB.Count)
            {
                Add(assignment, teamB[index], MatchTeam.TeamB);
            }
        }

        Script(assignment.Puppets);
        _world.Casting = Cast;
    }

    /// <summary>The scenario's seating: nobody at all, or everybody but the last few of the seating order (PRD-03 T11).</summary>
    private void Script(PuppetScript? script)
    {
        if (script is null)
        {
            return;
        }

        var absent = script.Idle ? _seats.Count : (int)Math.Min(script.AbsentPlayers, _seats.Count);
        if (absent > 0)
        {
            _seats.RemoveRange(_seats.Count - absent, absent);
        }

        _log.Info($"puppets: scenario {script.Scenario} leaves {absent} roster entry(s) without a body");
    }

    private void Add(Assignment assignment, RosterEntry entry, MatchTeam team)
    {
        if (ulong.TryParse(entry.SteamId64, out var steamId64) && assignment.IsPuppet(steamId64))
        {
            _seats.Add(new Seat(steamId64, entry.Name, team));
        }
    }

    /// <summary>The map is up and configured: send home whoever was named before the casting could happen, then start seating.</summary>
    internal void OnReady()
    {
        if (_assignment is not { } assignment)
        {
            return;
        }

        if (assignment.Simulation?.TimeScale is { } scale && scale != 1)
        {
            // The engine's own clock, the way MatchZy-Enhanced's simulation mode sets it.
            _world.ExecCommand(string.Create(CultureInfo.InvariantCulture, $"sv_cheats 1; host_timescale {scale}"));
            _scaled = true;
        }

        if (_world.Players.Any(player => player.IsBot && !player.IsPuppet))
        {
            _log.Info("puppets: sending home the bots that arrived before the roster could be cast");
            _world.KickBots();
        }

        _askedFor = null;
        _ticker?.Cancel();
        // Never in the frame of the kick: the engine reconciles its bot population once
        // per frame, and an add beside a kick is no add (PRD-02 T22a).
        _ticker = _world.Clock.Every(SeatIntervalMs, Reconcile);
        var people = assignment.HumansAmongPuppets;
        _log.Info(people == 0
            ? $"puppets: seating {_seats.Count} rostered player(s)"
            : $"puppets: seating {_seats.Count} rostered player(s); {people} seat(s) are people's and stay empty until they come");
    }

    internal void OnPlayerDisconnected(IGamePlayer player)
    {
        if (player.IsPuppet && _seats.FirstOrDefault(seat => seat.SteamId64 == player.SteamId64 && seat.Slot == player.Slot) is { } seat)
        {
            seat.Slot = null;
        }
    }

    internal void OnReleased() => Stop();

    private void Stop()
    {
        _ticker?.Cancel();
        _ticker = null;
        _askedFor = null;
        if (_assignment is not null)
        {
            _world.Casting = null;
            if (_seats.Any(seat => seat.Slot is not null))
            {
                _world.KickBots();
            }

            if (_scaled)
            {
                _world.ExecCommand("host_timescale 1; sv_cheats 0");
            }
        }

        _scaled = false;
        _seats.Clear();
        _assignment = null;
    }

    private void Reconcile()
    {
        if (_seats.FirstOrDefault(seat => seat.Slot is null) is not { } empty)
        {
            _askedFor = null;
            return;
        }

        if (_askedFor is not null && _world.Clock.NowMs - _askedAtMs < ArrivalPatienceMs)
        {
            return;
        }

        if (_askedFor is not null)
        {
            _log.Warn($"puppets: the bot asked for {_askedFor.Name} never arrived; asking again");
        }

        _askedFor = empty;
        _askedAtMs = _world.Clock.NowMs;
        _world.AddBot(SideOf(empty));
    }

    /// <summary>A two-team mode puts a puppet on its team's side; a one-team mode lets the engine (or the mode's own balancer) choose.</summary>
    private PlayerTeam? SideOf(Seat seat)
    {
        if (_assignment?.Gamemode.Slots.Teams != 2)
        {
            return null;
        }

        var teamASide = _match.TeamASide == TeamSide.Ct ? PlayerTeam.CounterTerrorist : PlayerTeam.Terrorist;
        var teamBSide = _match.TeamASide == TeamSide.Ct ? PlayerTeam.Terrorist : PlayerTeam.CounterTerrorist;
        return seat.Team == MatchTeam.TeamA ? teamASide : teamBSide;
    }

    private PuppetRole? Cast(BotArrival arrival)
    {
        // Before the first pass nobody has been asked for: a body arriving now is the
        // mode's cfg filling the server, and it goes home at OnReady either way.
        if (_ticker is null)
        {
            return null;
        }

        var seat = _askedFor is { Slot: null } asked ? asked : _seats.FirstOrDefault(candidate => candidate.Slot is null);
        if (seat is null)
        {
            return null;
        }

        seat.Slot = arrival.Slot;
        _askedFor = null;
        _log.Info($"puppets: {arrival.Name} in slot {arrival.Slot} plays {seat.Name} ({seat.SteamId64})");
        return new PuppetRole(seat.SteamId64, seat.Name);
    }

    private sealed class Seat(ulong steamId64, string name, MatchTeam team)
    {
        public ulong SteamId64 { get; } = steamId64;
        public string Name { get; } = name;
        public MatchTeam Team { get; } = team;
        /// <summary>The engine slot of the body in this seat, or <c>null</c> while it is empty.</summary>
        public int? Slot { get; set; }
    }
}
