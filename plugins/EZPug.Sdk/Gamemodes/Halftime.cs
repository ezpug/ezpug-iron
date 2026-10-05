using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>Half time is all-talk</b> (PRD-09 T4). The owner's sentence: "from the second the
/// last round of the half ends until the next freeze time begins", both sides hear each
/// other, and the HUD says so. MatchZy's <c>live.cfg</c> closes every cross-team path for
/// the whole match, and the engine's own switch
/// (<c>sv_auto_full_alltalk_during_warmup_half_end</c>) also opens warmup and the match's
/// end on a schedule of its own, which is not that sentence. So the SDK flips the cvars on
/// the phase.
///
/// <para><b>The stretch.</b> It begins when the gamerules' phase turns
/// <see cref="GamePhase.Halftime"/>, which the engine sets as the half's last round ends:
/// looked at on that <c>round_end</c> and on every <see cref="PollIntervalMs"/>. It ends the
/// instant the next <c>round_start</c> begins its freeze time. It is also ended by a pause
/// that ends, a map that changes or is over, the release and the plugin unloading, so a
/// server is never left open. A restore restarts a round, and that round's start ends it.
/// Once begun, it does not begin again until the phase has been seen to leave half time,
/// so a round start that lands a frame before the engine moves the phase on does not open
/// it twice.</para>
///
/// <para><b>The fact, always.</b> Every stretch is said as <c>halftime_started</c> with the
/// sides each team plays after the break (the side the context holds, the other one when
/// the gamerules flag a swap at the round reset) and <c>allTalk</c>, whether this server
/// opened the voice for it. A mode that tells its own flow story says its own.</para>
///
/// <para><b>The voice, where the assignment says <c>halftimeVoice</c></b> (the manifest
/// claims the capability and the request did not turn it off). The values of
/// <see cref="Cvars"/> are read as the stretch begins and put back as it ends; a cvar the
/// engine does not know is left alone. Without <c>halftimeVoice</c> not one voice cvar is
/// read or written, and nothing is said or drawn. With it, everybody reads one line in chat
/// at each edge, in their roster's language behind the match's prefix (decision 34:
/// everything the HUD shows is also a chat line), and with the HUD on a band at the top of
/// the screen stands for the whole stretch and is put away with the cvars. The band names
/// nobody: it is drawn from the state the server holds and never decides it.</para>
/// </summary>
public sealed class Halftime
{
    /// <summary>How often the gamerules are read for the phase, and for a pause that ended.</summary>
    public const long PollIntervalMs = 250;

    /// <summary>The band lives in the moment's layout, which every match with a HUD already has.</summary>
    public const string Layout = Moments.Layout;

    /// <summary>The band's panel: <see cref="Shown"/> for everybody while the stretch is open.</summary>
    public const string Band = "halftime_band";

    /// <summary>The band's words, one person's language each.</summary>
    public const string BandText = "halftime_band_text";

    /// <summary>On the band: on screen.</summary>
    public const string Shown = Moments.Shown;

    /// <summary>
    /// The cvars opened, and the value each takes for the stretch. The two the owner named
    /// (a living player hears the living and the dead of the other side), the engine's own
    /// "everybody hears everybody" pair, and <c>sv_deadtalk</c>, which with MatchZy's
    /// <c>1</c> keeps a dead player talking to the dead only.
    /// </summary>
    public static readonly IReadOnlyList<(string Name, string Open)> Cvars =
    [
        ("sv_talk_enemy_living", "1"),
        ("sv_talk_enemy_dead", "1"),
        ("sv_alltalk", "1"),
        ("sv_full_alltalk", "1"),
        ("sv_deadtalk", "0"),
    ];

    private readonly IGameWorld _world;
    private readonly GamemodeRuntime _runtime;
    private readonly ILinkLog _log;
    /// <summary>What each opened cvar said before the stretch, put back as it ends.</summary>
    private readonly Dictionary<string, string> _before = [];
    private Assignment? _assignment;
    private IClockTimer? _poll;
    private bool _voice;
    private bool _inStretch;
    private bool _seen;
    private bool _standing;
    private long _openedAtMs;

    internal Halftime(IGameWorld world, GamemodeRuntime runtime, ILinkLog log)
    {
        _world = world;
        _runtime = runtime;
        _log = log;
    }

    /// <summary>The match assigned right now opens the voice at half time.</summary>
    public bool Voice => _voice;

    /// <summary>The voice is open right now: the stretch has begun and has not ended.</summary>
    public bool Open => _inStretch && _voice;

    /// <summary>One line for <c>ezpug_status</c>: whether this match opens the voice at half time, and whether it is open now with what the cvars say.</summary>
    public string Report()
    {
        if (_assignment is null)
        {
            return "no match";
        }

        if (!_voice)
        {
            return "half time keeps the teams apart in this match";
        }

        var cvars = string.Join(", ", Cvars.Select(cvar => $"{cvar.Name} {_world.GetCvar(cvar.Name) ?? "unknown"}"));
        return Open
            ? $"half time is all-talk, open for {_world.Clock.NowMs - _openedAtMs} ms ({cvars})"
            : $"half time is all-talk, closed now ({cvars})";
    }

    // ------------------------------------------------------------------ the runtime's hooks

    internal void OnAssigned(Assignment assignment)
    {
        Stop();
        _assignment = assignment;
        _voice = assignment.HalftimeVoice;
        _poll = _world.Clock.Every(PollIntervalMs, Poll);
    }

    internal void OnReleased()
    {
        Stop();
        _assignment = null;
        _voice = false;
    }

    /// <summary>The half's last round ended: the phase may already say half time.</summary>
    internal void OnRoundEnded() => Check(_world.Rules);

    /// <summary>The next round's freeze time begins: the stretch is over.</summary>
    internal void OnRoundStarted() => End("the next round's freeze time began", say: true);

    /// <summary>A level change: whatever half time there was belonged to the map before.</summary>
    internal void OnMapStarted()
    {
        End("the map changed", say: false);
        _seen = false;
    }

    /// <summary>The win panel is up: nobody plays a next half on this map.</summary>
    internal void OnMapEnded() => End("the map is over", say: true);

    /// <summary>Somebody arrived while the band stands: their slot was just told "no" for everything, so they are told their words.</summary>
    internal void OnPlayerConnected(IGamePlayer player)
    {
        if (Open && !player.IsBot)
        {
            Tell(player);
        }
    }

    /// <summary>Everything closed and forgotten, from wherever it stands: a reassignment, the release, the plugin unloading.</summary>
    public void Stop()
    {
        End("the match was released", say: false);
        _poll?.Cancel();
        _poll = null;
        _seen = false;
        _standing = false;
    }

    // ------------------------------------------------------------------ the stretch

    private void Poll()
    {
        if (_assignment is null || _world.Rules is not { } rules)
        {
            return;
        }

        var standing = rules.Standing;
        if (_standing && !standing)
        {
            End("a pause ended", say: true);
        }

        _standing = standing;
        Check(rules);
    }

    private void Check(GameRules? rules)
    {
        if (_assignment is null || rules is null)
        {
            return;
        }

        if (rules.Phase != GamePhase.Halftime)
        {
            _seen = false;
            return;
        }

        if (_seen)
        {
            return;
        }

        _seen = true;
        Begin(rules);
    }

    private void Begin(GameRules rules)
    {
        _inStretch = true;
        var now = _runtime.Match.TeamASide;
        var after = rules.SwitchingTeamsAtRoundReset ? Other(now) : now;
        if (!_runtime.ModeOwnsFlow)
        {
            _runtime.Emit(_runtime.Facts.HalftimeStarted(after, _voice));
        }

        if (!_voice)
        {
            _log.Info($"halftime: began after round {rules.RoundsPlayed}; this match keeps the teams apart");
            return;
        }

        _openedAtMs = _world.Clock.NowMs;
        _before.Clear();
        foreach (var (name, open) in Cvars)
        {
            if (_world.GetCvar(name) is not { } value)
            {
                continue;
            }

            _before[name] = value;
            _world.SetCvar(name, open);
        }

        _log.Info($"halftime: began after round {rules.RoundsPlayed}; all-talk open ({string.Join(", ", _before.Keys.Select(name => $"{name} {_before[name]} -> {Cvars.First(cvar => cvar.Name == name).Open}"))})");
        _runtime.Hud.SetClass(Layout, Band, Shown, true);
        foreach (var player in _world.Players)
        {
            if (!player.IsBot)
            {
                Tell(player);
                _runtime.Brand.Say(player, LinesOf(player)["halftime.voice_open"]);
            }
        }
    }

    private void End(string why, bool say)
    {
        if (!_inStretch)
        {
            return;
        }

        _inStretch = false;
        if (!_voice)
        {
            return;
        }

        foreach (var (name, value) in _before)
        {
            _world.SetCvar(name, value);
        }

        _log.Info($"halftime: all-talk closed after {_world.Clock.NowMs - _openedAtMs} ms, {why} ({string.Join(", ", _before.Select(cvar => $"{cvar.Key} {cvar.Value}"))})");
        _before.Clear();
        _runtime.Hud.SetClass(Layout, Band, Shown, false);
        if (!say)
        {
            return;
        }

        foreach (var player in _world.Players)
        {
            if (!player.IsBot)
            {
                _runtime.Brand.Say(player, LinesOf(player)["halftime.voice_closed"]);
            }
        }
    }

    /// <summary>The band's words for one person, in their language.</summary>
    private void Tell(IGamePlayer player) =>
        _runtime.Hud.SetVariable(player, Layout, BandText, Moments.Text, LinesOf(player)["hud.halftime.band"]);

    private LocalizedLines LinesOf(IGamePlayer player) =>
        _runtime.Localizer.For(_assignment?.LocaleOf(player.SteamId64) ?? Localizer.DefaultLocale);

    private static TeamSide Other(TeamSide side) => side == TeamSide.Ct ? TeamSide.T : TeamSide.Ct;
}
