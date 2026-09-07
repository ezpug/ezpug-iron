using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>A complete story for a mode that has no match plugin to tell one</b> (PRD-02 T22).
/// Match-flow events belong to the flow owner the manifest names (decision 19): for
/// <c>flow: matchzy</c> that is MatchZy's remote log, translated in the orchestrator.
/// For <c>flow: plugin</c> and <c>flow: none</c> there is nobody — a vendored community
/// plugin speaks its own language and a config-only mode speaks none at all — so this
/// class reads the flow off the engine and emits it through the runtime:
///
/// <list type="bullet">
/// <item><c>going_live</c> at the first round start outside warmup. "After warmup" is the
/// only signal a stock server gives: <c>mp_warmup_end</c> (or the warmup running out)
/// restarts the game and the round that follows is round 1.</item>
/// <item><c>round_start</c> and <c>round_end</c> from the engine's own round events, with
/// the winner and the score read off the gamerules — <see cref="RoundEnd"/> carries the
/// two team scores as CS keeps them (T first), and the sides in effect turn them into the
/// vocabulary's team order.</item>
/// <item><c>side_swap</c> when the engine flags a swap at the next round reset
/// (<c>mp_halftime</c>), and when a new map of a series starts on the ends its plan
/// named. Not asked for by name in T22 and emitted anyway, because without it the score
/// is <i>wrong</i>: CS2 swaps the team scores along with the players at halftime, so team
/// A's rounds land on team B from there on unless the runtime's sides follow. The
/// halftime flag is transient, which is why it is polled every
/// <see cref="PollIntervalMs"/> rather than read at a hook, exactly as
/// <c>MatchZyFlow</c> polls for the same fact.</item>
/// <item><c>map_end</c> on the win panel — the engine's own full stop, whether the map
/// was decided by <c>mp_maxrounds</c>, a clinch or <c>mp_timelimit</c> — and
/// <c>series_end</c> with it when the map that ended was the last one the assignment
/// planned. T22 asks for <c>series_end</c> "when the manifest's rounds/timeLimit is
/// reached"; a manifest carries neither, and the engine reaching either of them <i>is</i>
/// the win panel, so the map plan is what decides whether the series is over too.</item>
/// </list>
///
/// <b>It also starts the match, because for these flows nobody else can.</b> MatchZy holds
/// its warmup open and ends it on <c>.ready</c>; a config mode has no ready-up, no knife
/// round and no admin, and CS2's own warmup timer does not run down on a dedicated server
/// — measured on this box against 1.41.7.8 with ten bots standing, a warmup restarted on
/// <c>mp_warmuptime 20</c> was still the warmup period 72 seconds later, and the next
/// <c>mp_warmup_end</c> put the server into freeze time inside a frame. So
/// <see cref="GoLiveDelayMs"/> after the assigned map is up the emitter runs
/// <c>mp_warmup_end</c> itself, and keeps running it every
/// <see cref="WarmupEndRetryMs"/> for as long as the gamerules still say warmup — the one
/// early attempt is not enough (a <c>mp_warmup_end</c> in the cfg, one second into the
/// map, is undone by the engine re-entering warmup right after it). The delay is what the
/// roster and the request's bots connect in.
///
/// <b>What it never does.</b> It says nothing during warmup, nothing before the map it was
/// assigned is up, nothing for a <c>matchzy</c> flow, and nothing for a mode that says it
/// owns its own flow (<see cref="Gamemode.OwnsFlow"/>) — a mode that knows better is
/// always right. It emits no pause: nothing pauses a stock server but an admin, and that
/// command's answer is the mode's.
///
/// Pure over <see cref="IGameWorld"/> and the runtime that owns it, so a whole map is
/// played under xunit on the harness with no CS2 anywhere near it.
/// </summary>
public sealed class GenericFlow
{
    /// <summary>How often the gamerules are read for a swap pending at the next round reset, and for a warmup nobody is ending.</summary>
    public const long PollIntervalMs = 250;

    /// <summary>
    /// How long after the assigned map is up the emitter ends warmup itself. Long enough
    /// for the roster and the request's bots to connect after the loader set the cvars
    /// that ask for them, short enough that a drop-in server is playing before anybody
    /// wonders whether it is broken.
    /// </summary>
    public const long GoLiveDelayMs = 20_000;

    /// <summary>How long between two <c>mp_warmup_end</c>s while the gamerules still say warmup.</summary>
    public const long WarmupEndRetryMs = 10_000;

    private readonly IGameWorld _world;
    private readonly GamemodeRuntime _runtime;
    private readonly ILinkLog _log;
    private bool _armed;
    private bool _live;
    private bool _mapOver;
    private bool _pendingSwap;
    private long _teamA;
    private long _teamB;
    private long _mapsA;
    private long _mapsB;
    private bool _mapUp;
    private long _goLiveAtMs;
    private long _lastWarmupEndMs;
    private IClockTimer? _poll;

    internal GenericFlow(IGameWorld world, GamemodeRuntime runtime, ILinkLog log)
    {
        _world = world;
        _runtime = runtime;
        _log = log;
    }

    /// <summary>
    /// Whether this emitter speaks for the match assigned right now: the manifest's flow
    /// is <c>plugin</c> or <c>none</c>, and the mode attached for it (if any) has not
    /// claimed the flow for itself.
    /// </summary>
    public bool Active => _armed && !_runtime.ModeOwnsFlow;

    /// <summary>Whether the current map has gone live — between <c>going_live</c> and <c>map_end</c>.</summary>
    public bool Live => _live;

    /// <summary>This map's score so far, in team order.</summary>
    public (long TeamA, long TeamB) Score => (_teamA, _teamB);

    /// <summary>The maps each team has taken so far in the series.</summary>
    public (long TeamA, long TeamB) SeriesScore => (_mapsA, _mapsB);

    // ------------------------------------------------------------------ the runtime's calls

    internal void OnAssigned(Assignment assignment)
    {
        Disarm();
        _armed = assignment.Gamemode.Flow is GamemodeFlow.Plugin or GamemodeFlow.None;
        _mapsA = 0;
        _mapsB = 0;
        ResetMap();
        if (_armed)
        {
            _poll = _world.Clock.Every(PollIntervalMs, Poll);
        }
    }

    internal void OnReleased()
    {
        Disarm();
        _armed = false;
        _mapsA = 0;
        _mapsB = 0;
        ResetMap();
    }

    /// <summary>
    /// A map is up: this map's own story starts from nothing, and the sides start where
    /// the assignment planned them. The runtime takes team A's side from the *first*
    /// map's plan and moves it only on a <c>side_swap</c>, so the second map of a series
    /// would otherwise keep the first map's ends and put every one of its rounds on the
    /// wrong team. A plan that says <c>knife</c> decides nothing and changes nothing.
    /// </summary>
    internal void OnMapStarted()
    {
        ResetMap();
        _mapUp = true;
        _goLiveAtMs = _world.Clock.NowMs + GoLiveDelayMs;
        _lastWarmupEndMs = long.MinValue / 2;
        if (!Active || _runtime.Assignment is not { } assignment)
        {
            return;
        }

        var plan = assignment.Maps.ElementAtOrDefault((int)_runtime.Match.MapNumber - 1);
        var planned = plan?.Sides switch
        {
            MapPlanSides.Ct => TeamSide.Ct,
            MapPlanSides.T => TeamSide.T,
            _ => (TeamSide?)null,
        };
        if (planned is { } side && side != _runtime.Match.TeamASide)
        {
            _runtime.Emit(_runtime.Facts.SideSwap(side));
        }
    }

    /// <summary>
    /// A round is starting and the runtime has not numbered it yet. Everything that
    /// belongs <i>before</i> round 1 goes here, because emitting <c>going_live</c> resets
    /// the runtime's round counter by the vocabulary's rule — the first live round is
    /// round 1 — and the runtime numbers the round from the engine immediately after.
    /// </summary>
    internal void OnRoundStarting()
    {
        if (!Active)
        {
            return;
        }

        if (_world.Rules is { Warmup: true })
        {
            // A warmup round is nobody's round, and a swap flagged during one is the
            // engine tidying up rather than halftime.
            _pendingSwap = false;
            return;
        }

        if (!_live)
        {
            _live = true;
            _runtime.Emit(_runtime.Facts.GoingLive(_world.Map));
        }

        if (_pendingSwap)
        {
            _pendingSwap = false;
            _runtime.Emit(_runtime.Facts.SideSwap(_runtime.Match.TeamASide == TeamSide.Ct ? TeamSide.T : TeamSide.Ct));
        }
    }

    /// <summary>The round is numbered: say it started, with the score it starts from.</summary>
    internal void OnRoundStarted()
    {
        if (!Active || !_live)
        {
            return;
        }

        _runtime.Emit(_runtime.Facts.RoundStart(new TeamScore { TeamA = _teamA, TeamB = _teamB }));
    }

    internal void OnRoundEnded(RoundEnd roundEnd)
    {
        if (!Active || !_live)
        {
            return;
        }

        if (_runtime.Match.TeamOf(roundEnd.Winner) is not { } winner)
        {
            // The engine ends a round with no side when it is restarting one; there is no
            // winner to name and the vocabulary insists on one, so nothing is said.
            _log.Warn($"a round ended with no side to name a winner ({roundEnd.Reason}); not emitted");
            return;
        }

        (_teamA, _teamB) = _runtime.Match.TeamASide == TeamSide.Ct
            ? (roundEnd.CounterTerroristScore, roundEnd.TerroristScore)
            : (roundEnd.TerroristScore, roundEnd.CounterTerroristScore);
        _runtime.Emit(_runtime.Facts.RoundEnd(
            winner,
            winner == MatchTeam.TeamA ? _runtime.Match.TeamASide : Other(_runtime.Match.TeamASide),
            ConditionOf(roundEnd.Reason),
            new TeamScore { TeamA = _teamA, TeamB = _teamB }));
    }

    /// <summary>The win panel: this map is over, and the series with it when it was the last one planned.</summary>
    internal void OnMapEnded()
    {
        if (!Active || _mapOver || !_live || _runtime.Assignment is not { } assignment)
        {
            return;
        }

        _mapOver = true;
        var winner = Winner(_teamA, _teamB);
        // Read before the emit: `map_end` is what advances the runtime's map number.
        var last = _runtime.Match.MapNumber >= assignment.Maps.Count;
        _runtime.Emit(_runtime.Facts.MapEnd(new TeamScore { TeamA = _teamA, TeamB = _teamB }, winner, _world.Map));
        _live = false;
        if (winner == MatchTeam.TeamA)
        {
            _mapsA++;
        }
        else if (winner == MatchTeam.TeamB)
        {
            _mapsB++;
        }

        if (last)
        {
            _runtime.Emit(_runtime.Facts.SeriesEnd(
                new TeamScore { TeamA = _mapsA, TeamB = _mapsB },
                Winner(_mapsA, _mapsB)));
        }
    }

    // ------------------------------------------------------------------ the poll

    private void Poll()
    {
        if (!Active || _world.Rules is not { } rules)
        {
            return;
        }

        if (rules.SwitchingTeamsAtRoundReset)
        {
            _pendingSwap = true;
        }

        // **For as long as the gamerules say warmup, whether or not the map has already
        // gone live.** The engine re-enters warmup on its own after an early
        // `mp_warmup_end` and after a restart, and a match nobody ends it for is a
        // deathmatch that never counts a round: measured on the dev node, `going_live`
        // arrived, warmup came back underneath it, and seventy-four deaths later the
        // gamerules still said no round had been played.
        if (!rules.Warmup || _mapOver || !_mapUp)
        {
            return;
        }

        var now = _world.Clock.NowMs;
        if (now < _goLiveAtMs || now - _lastWarmupEndMs < WarmupEndRetryMs)
        {
            return;
        }

        _lastWarmupEndMs = now;
        _world.ExecCommand("mp_warmup_end");
    }

    private void Disarm()
    {
        _poll?.Cancel();
        _poll = null;
    }

    private void ResetMap()
    {
        _mapUp = false;
        _live = false;
        _mapOver = false;
        _pendingSwap = false;
        _teamA = 0;
        _teamB = 0;
    }

    private static MatchTeam? Winner(long teamA, long teamB) =>
        teamA == teamB ? null : teamA > teamB ? MatchTeam.TeamA : MatchTeam.TeamB;

    private static TeamSide Other(TeamSide side) => side == TeamSide.Ct ? TeamSide.T : TeamSide.Ct;

    private static RoundWinCondition ConditionOf(RoundEndReason reason) =>
        reason switch
        {
            RoundEndReason.Elimination => RoundWinCondition.Elimination,
            RoundEndReason.BombExploded => RoundWinCondition.BombExploded,
            RoundEndReason.BombDefused => RoundWinCondition.BombDefused,
            RoundEndReason.TimeExpired => RoundWinCondition.TimeExpired,
            _ => RoundWinCondition.Other,
        };
}
