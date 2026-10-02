using System.Globalization;

namespace EZPug.Sdk;

/// <summary>Why nobody is playing right now.</summary>
public enum QuietReason
{
    /// <summary>No round has started on this map yet: it is still loading, or the server is empty.</summary>
    NoRound,
    Warmup,
    /// <summary>A round has started and its freeze time is still running.</summary>
    FreezeTime,
    /// <summary>The round is decided and the next one has not started.</summary>
    RoundOver,
    /// <summary>The match is standing in its freeze time: a pause or a timeout.</summary>
    Paused,
    Halftime,
    /// <summary>The map is over and the scoreboard is up.</summary>
    MatchOver,
}

/// <summary>
/// A stretch of nobody playing: why, and how much of it is left where the engine's own
/// clock says so. <see cref="LeftMs"/> is <c>null</c> for a stretch that ends when
/// somebody decides it does (a warmup, a pause, the scoreboard), which is as long as
/// anything the HUD shows.
/// </summary>
public readonly record struct Quiet(QuietReason Reason, long? LeftMs)
{
    /// <summary>Whether something that takes <paramref name="ms"/> to show is over before anybody plays again, as far as anybody can know now.</summary>
    public bool Fits(long ms) => LeftMs is not { } left || left >= ms;
}

/// <summary>
/// <b>The HUD</b> (decision 34, PRD-07 T3): Panorama layouts the server shows through
/// CS2's <c>custom_hud_layout</c>, on top of the world seam's six verbs. A layout's
/// file is on the player's machine (the Workshop addon, <c>docs/hud.md</c>) and only its
/// state travels: a class on a panel, a string a label binds. This class owns everything
/// about that state that costs people days when it is got wrong, so the welcome, the
/// moment and a mode's own toast only ever say what should be on whose screen.
///
/// <para><b>Decoration, never structure.</b> Nothing waits for the HUD, nothing reads it
/// back, and everything it shows is also a chat line. It has no way to take a player's
/// mouse: the seam has no verb for it.</para>
///
/// <para><b>Off is untouched.</b> The HUD is on for a match when the server booted with
/// the addon's Workshop id (<see cref="HudAddon"/>) <i>and</i> the assignment asks for it.
/// Otherwise every method here returns before it reaches the world: no console line, no
/// entity, no read.</para>
///
/// <para>The rules, each with a test in <c>HudTests</c>:</para>
/// <list type="bullet">
/// <item><b>Nothing before a round starts.</b> A layout is an entity, and
/// CounterStrikeSharp remembers a failed look at the entity list for the life of the
/// process. So the layouts are created on the first <c>round_start</c> of a map, and what
/// was asked for before that is kept and applied then.</item>
/// <item><b>Orphans go first.</b> The entity outlives a plugin reload. Whatever of ours
/// is in the world is removed by name before anything is created.</item>
/// <item><b>The map takes the layouts with it</b>, and the next round start makes them
/// again with everything that should be on them.</item>
/// <item><b>A slot is reset when a person takes it, at every spawn, and again
/// <see cref="ResendDelayMs"/> after each.</b> The engine keeps a player's state by slot
/// and slots are reused; a client still loading drops what it is told. A reset tells the
/// slot everything it could be holding: what this player should see, and "no" for the
/// rest.</item>
/// <item><b>No memo.</b> Every call goes out. Nothing here skips one because it believes
/// the client already has it, and a player who leaves takes their state with them.</item>
/// <item><b>Bots have no screen.</b> A plain bot and a puppet are skipped.</item>
/// <item><b>Somebody who left gets nothing.</b> A call that names a player who is no
/// longer here is dropped, so a timer that outlived its player cannot write on the slot's
/// next occupant.</item>
/// <item><b>Everything goes at release</b> and when the plugin unloads: the layouts, and
/// the addon's id off the list clients are handed.</item>
/// </list>
///
/// <para>A panel's class, or a label's string, is either everybody's or one player's.
/// The engine lets a slot's own value win over everybody's and CounterStrikeSharp cannot
/// take a slot's value back, so a name that was once told to a slot stays the slot's.</para>
/// </summary>
public sealed class Hud
{
    /// <summary>How long after a connect or a spawn the slot is told everything a second time.</summary>
    public const long ResendDelayMs = 2_000;

    /// <summary>MultiAddonManager's console verb that adds an addon to what every connecting client is told to mount.</summary>
    public const string AddClientAddon = "mm_add_client_addon";

    /// <summary>And the one that takes it off again, for the clients who connect after it.</summary>
    public const string RemoveClientAddon = "mm_remove_client_addon";

    /// <summary>MultiAddonManager's own record of that list: the ids, separated by commas, that a client who connects now is told to mount.</summary>
    public const string ClientAddons = "mm_client_extra_addons";

    private readonly record struct ClassKey(string Layout, string Panel, string Class);

    private readonly record struct VariableKey(string Layout, string Panel, string Variable);

    /// <summary>What one person should see, and the second telling still owed to them.</summary>
    private sealed class Screen
    {
        public Dictionary<ClassKey, bool> Classes { get; } = [];
        public Dictionary<VariableKey, string> Variables { get; } = [];
        public IClockTimer? Resend { get; set; }
    }

    private enum RoundPhase
    {
        None,
        Freeze,
        Live,
        Over,
    }

    private readonly IGameWorld _world;
    private readonly ILinkLog _log;
    private readonly List<string> _layouts = [];
    /// <summary>The layouts a spectator sees the watched player's version of.</summary>
    private readonly HashSet<string> _observable = [];
    private readonly Dictionary<ClassKey, bool> _classes = [];
    private readonly Dictionary<VariableKey, string> _variables = [];
    private readonly Dictionary<ulong, Screen> _screens = [];
    /// <summary>Every class and string any slot was told since the match was assigned: what a reset has to say "no" to.</summary>
    private readonly HashSet<ClassKey> _slotClasses = [];
    private readonly HashSet<VariableKey> _slotVariables = [];
    /// <summary>What was already warned about, so a mixed name is one line in the log.</summary>
    private readonly HashSet<string> _warned = [];
    private bool _on;
    private bool _spawned;
    private double _scale = 1;
    private RoundPhase _phase;
    private long _phaseAtMs;
    private bool _mapOver;
    /// <summary>When the layouts in the world were made: before a map's start means they went with the map before.</summary>
    private long _spawnedAtMs;

    public Hud(IGameWorld world, string? addon = null, ILinkLog? log = null)
    {
        _world = world;
        _log = log ?? NullLinkLog.Instance;
        Addon = addon;
    }

    /// <summary>The Workshop id of the addon this server can hand to clients, or <c>null</c> on a server that cannot draw a HUD at all.</summary>
    public string? Addon { get; }

    /// <summary>The match being played draws the HUD: the server has the addon and the assignment asked.</summary>
    public bool On => _on;

    /// <summary>The layouts are in the world: the HUD is on and a round has started on this map.</summary>
    public bool Spawned => _on && _spawned;

    /// <summary>
    /// What a client who connects now is handed, as MultiAddonManager holds it: read
    /// back, not remembered. Empty for no addon, and <c>null</c> on a server that cannot
    /// draw a HUD (nothing is read there) or whose MultiAddonManager does not answer.
    /// </summary>
    public string? Handed => Addon is null ? null : _world.GetCvar(ClientAddons);

    /// <summary>The layouts this server shows while the HUD is on, by source path.</summary>
    public IReadOnlyList<string> Layouts => _layouts;

    /// <summary>
    /// A layout the HUD shows: its <b>source</b> path with the extension, as the addon
    /// ships it (<c>panorama/layout/custom_game/ezpug_welcome.xml</c>). Declared once by
    /// whoever drives it, for the life of the runtime; it exists in the world while the
    /// HUD is on and a round has started. <paramref name="observable"/> shows somebody
    /// who is spectating a player that player's version of it: for a layout about what
    /// happens to a player (a moment), not for one that speaks to them (the welcome).
    /// </summary>
    public void Register(string layout, bool observable = false)
    {
        if (_layouts.Contains(layout))
        {
            return;
        }

        _layouts.Add(layout);
        if (observable)
        {
            _observable.Add(layout);
        }

        if (Spawned)
        {
            _world.CreateHudLayout(layout, observable);
        }
    }

    // ------------------------------------------------------------------ what is on a screen

    /// <summary>Set or clear a class on a panel for everybody.</summary>
    public void SetClass(string layout, string panel, string className, bool has)
    {
        if (!_on)
        {
            return;
        }

        var key = new ClassKey(layout, panel, className);
        WarnIfSlots(_slotClasses.Contains(key), $"{panel}.{className}");
        _classes[key] = has;
        if (_spawned)
        {
            _world.SetHudClass(layout, panel, className, has);
        }
    }

    /// <summary>Set or clear a class on a panel for one person. A bot has no screen and is skipped, and so is somebody who has left.</summary>
    public void SetClass(IGamePlayer player, string layout, string panel, string className, bool has)
    {
        if (!_on || Present(player) is not { } present)
        {
            return;
        }

        var key = new ClassKey(layout, panel, className);
        _slotClasses.Add(key);
        ScreenOf(present).Classes[key] = has;
        if (_spawned)
        {
            _world.SetHudClass(present, layout, panel, className, has);
        }
    }

    /// <summary>Set the string a label binds as <c>{s:variable}</c>, for everybody.</summary>
    public void SetVariable(string layout, string panel, string variable, string value)
    {
        if (!_on)
        {
            return;
        }

        var key = new VariableKey(layout, panel, variable);
        WarnIfSlots(_slotVariables.Contains(key), $"{panel} {{s:{variable}}}");
        _variables[key] = value;
        if (_spawned)
        {
            _world.SetHudVariable(layout, panel, variable, value);
        }
    }

    /// <summary>Set the string a label binds as <c>{s:variable}</c>, for one person. A bot has no screen and is skipped, and so is somebody who has left.</summary>
    public void SetVariable(IGamePlayer player, string layout, string panel, string variable, string value)
    {
        if (!_on || Present(player) is not { } present)
        {
            return;
        }

        var key = new VariableKey(layout, panel, variable);
        _slotVariables.Add(key);
        ScreenOf(present).Variables[key] = value;
        if (_spawned)
        {
            _world.SetHudVariable(present, layout, panel, variable, value);
        }
    }

    /// <summary>
    /// The person as the world holds them now, or <c>null</c> for a bot and for somebody
    /// who is gone. A caller may still hold the player of a connection that has ended,
    /// and that one's slot belongs to whoever took it since.
    /// </summary>
    private IGamePlayer? Present(IGamePlayer player) =>
        !player.IsBot && _world.Find(player.SteamId64) is { IsBot: false } present ? present : null;

    private Screen ScreenOf(IGamePlayer player)
    {
        if (!_screens.TryGetValue(player.SteamId64, out var screen))
        {
            screen = new Screen();
            _screens[player.SteamId64] = screen;
        }

        return screen;
    }

    private void WarnIfSlots(bool told, string what)
    {
        if (told && _warned.Add(what))
        {
            _log.Warn($"hud: {what} was set for everybody after it was set for one player; a slot's own value wins, so not everybody will see it");
        }
    }

    // ------------------------------------------------------------------ is anybody playing

    /// <summary>
    /// <b>Is anybody playing, and for how long not.</b> <c>null</c> while a round is being
    /// played, and otherwise why it is not and what is left of that. A card that needs
    /// five seconds asks <c>Quiet?.Fits(5_000)</c>.
    ///
    /// <para>What is left is read off the mode's own cvars when it is asked: the rest of
    /// <c>mp_freezetime</c> in a freeze, and after a round the rest of
    /// <c>mp_round_restart_delay</c> plus the freeze that follows it. Under a simulated
    /// match's time scale those are that much shorter on this clock. A mode that respawns
    /// people for ever is being played from its first freeze end to the end of its map.</para>
    ///
    /// <para>A pause counts only while the match is standing in a freeze: one asked for in
    /// the middle of a round waits for that round to end, and so does this. <c>null</c>
    /// as well while the HUD is off, where nothing asks: there is no stretch for a card
    /// that will not be shown.</para>
    /// </summary>
    public Quiet? Quiet
    {
        get
        {
            if (!_on)
            {
                return null;
            }

            // Before a round has started on this map there is nothing to read: the rules
            // are an entity too.
            if (_phase == RoundPhase.None)
            {
                return new Quiet(QuietReason.NoRound, null);
            }

            var rules = _world.Rules;
            if (_mapOver || rules is { Phase: GamePhase.MatchEnded })
            {
                return new Quiet(QuietReason.MatchOver, null);
            }

            if (rules is { Warmup: true })
            {
                return new Quiet(QuietReason.Warmup, null);
            }

            if (rules is { Phase: GamePhase.Halftime })
            {
                return new Quiet(QuietReason.Halftime, null);
            }

            var elapsed = _world.Clock.NowMs - _phaseAtMs;
            switch (_phase)
            {
                case RoundPhase.Freeze:
                    if (rules is { Standing: true })
                    {
                        return new Quiet(QuietReason.Paused, null);
                    }

                    // A mode with no freeze time is being played from the round's start,
                    // whether or not the engine says the freeze ended.
                    var left = Scaled("mp_freezetime") - elapsed;
                    return left > 0 ? new Quiet(QuietReason.FreezeTime, left) : null;
                case RoundPhase.Over:
                    return new Quiet(QuietReason.RoundOver, Math.Max(0, Scaled("mp_round_restart_delay") - elapsed) + Scaled("mp_freezetime"));
                default:
                    return null;
            }
        }
    }

    /// <summary>A cvar of engine seconds as milliseconds of this clock; nothing when it cannot be read.</summary>
    private long Scaled(string cvar) =>
        double.TryParse(_world.GetCvar(cvar), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds) && seconds > 0
            ? (long)(seconds * 1_000 / _scale)
            : 0;

    // ------------------------------------------------------------------ the runtime's hooks

    /// <summary>A match is assigned: when it asks for the HUD and the server has the addon, every client who connects from now on is handed it.</summary>
    internal void OnAssigned(Assignment assignment)
    {
        Stop();
        if (Addon is not { } addon || !assignment.Hud)
        {
            return;
        }

        _on = true;
        _scale = assignment.Simulation?.TimeScale is { } scale && scale > 0 ? scale : 1;
        _world.ExecCommand($"{AddClientAddon} {addon}");
        _log.Info($"hud: on for {assignment.MatchId}; clients are handed addon {addon}, {_layouts.Count} layout(s) at the next round start");
    }

    /// <summary>The match is over: nothing of the HUD stays, in the world or on the list clients are handed.</summary>
    internal void OnReleased() => Stop();

    /// <summary>
    /// Everything gone, from wherever it stands: the release, a reassignment, the plugin
    /// unloading. The layouts are only reached for when a round start made them; the id
    /// comes off the list either way.
    /// </summary>
    public void Stop()
    {
        if (_on)
        {
            if (_spawned)
            {
                _world.RemoveHudLayouts();
            }

            _world.ExecCommand($"{RemoveClientAddon} {Addon}");
        }

        foreach (var screen in _screens.Values)
        {
            screen.Resend?.Cancel();
        }

        _screens.Clear();
        _classes.Clear();
        _variables.Clear();
        _slotClasses.Clear();
        _slotVariables.Clear();
        _on = false;
        _spawned = false;
        _scale = 1;
        _phase = RoundPhase.None;
        _mapOver = false;
    }

    /// <summary>
    /// A map is up. Its entities are new, so the layouts of the map before are gone —
    /// unless a round has already started on this one, which the world may tell us before
    /// it gets round to announcing the map (<see cref="MapStart"/>).
    ///
    /// <para>That round start is then the map's first, and it could not know it. If the
    /// layouts were made before this map came up, it found them "in the world" and made
    /// none, and they went with the map before: they are made now. The dev node showed
    /// it on every MatchZy match (PRD-07 T9): the lobby map's round start makes the
    /// layouts, the match's level change takes them, and the new map's warmup round
    /// starts inside the beat before the map is announced.</para>
    /// </summary>
    internal void OnMapStarted(MapStart start)
    {
        if (_phase != RoundPhase.None && _phaseAtMs >= start.StartedAtMs)
        {
            if (_on && _spawned && _spawnedAtMs < start.StartedAtMs)
            {
                Spawn();
            }

            return;
        }

        _phase = RoundPhase.None;
        _mapOver = false;
        _spawned = false;
    }

    /// <summary>A round started: the first one of a map is when the layouts are made.</summary>
    internal void OnRoundStarted()
    {
        _phase = RoundPhase.Freeze;
        _phaseAtMs = _world.Clock.NowMs;
        _mapOver = false;
        if (_on && !_spawned)
        {
            Spawn();
        }
    }

    internal void OnFreezeEnded()
    {
        if (_phase == RoundPhase.Freeze)
        {
            _phase = RoundPhase.Live;
        }
    }

    internal void OnRoundEnded()
    {
        _phase = RoundPhase.Over;
        _phaseAtMs = _world.Clock.NowMs;
    }

    /// <summary>The win panel is up: nobody plays again on this map.</summary>
    internal void OnMapEnded() => _mapOver = true;

    /// <summary>Somebody took a slot. Whatever its last occupant was shown is taken off it before this one sees anything.</summary>
    internal void OnPlayerConnected(IGamePlayer player)
    {
        if (!_on || player.IsBot)
        {
            return;
        }

        Forget(player.SteamId64);
        Reset(player);
    }

    /// <summary>A spawn: the slot is told everything again, now and a beat later.</summary>
    internal void OnPlayerSpawned(IGamePlayer player)
    {
        if (!_on || player.IsBot)
        {
            return;
        }

        Reset(player);
    }

    /// <summary>They left, and what they were shown leaves with them. The slot itself is cleaned when the next person takes it: there is nobody to tell now.</summary>
    internal void OnPlayerDisconnected(IGamePlayer player) => Forget(player.SteamId64);

    private void Forget(ulong steamId64)
    {
        if (_screens.Remove(steamId64, out var screen))
        {
            screen.Resend?.Cancel();
        }
    }

    // ------------------------------------------------------------------ the layouts and the slots

    private void Spawn()
    {
        // By name, not by memory: a load of the plugin that never got to its Unload left
        // its layouts standing, and a second one beside it is a panel nobody can reach.
        _world.RemoveHudLayouts();
        foreach (var layout in _layouts)
        {
            _world.CreateHudLayout(layout, _observable.Contains(layout));
        }

        _spawned = true;
        _spawnedAtMs = _world.Clock.NowMs;
        _log.Info($"hud: {_layouts.Count} layout(s) made on {_world.Map}");
        foreach (var (key, has) in _classes)
        {
            _world.SetHudClass(key.Layout, key.Panel, key.Class, has);
        }

        foreach (var (key, value) in _variables)
        {
            _world.SetHudVariable(key.Layout, key.Panel, key.Variable, value);
        }

        foreach (var player in _world.Players)
        {
            if (!player.IsBot)
            {
                Tell(player);
            }
        }
    }

    /// <summary>Tell the slot everything now, and once more <see cref="ResendDelayMs"/> later: a client that was still loading dropped the first.</summary>
    private void Reset(IGamePlayer player)
    {
        Tell(player);
        var screen = ScreenOf(player);
        screen.Resend?.Cancel();
        var steamId64 = player.SteamId64;
        screen.Resend = _world.Clock.After(ResendDelayMs, () =>
        {
            screen.Resend = null;
            if (_on && _world.Find(steamId64) is { IsBot: false } still)
            {
                Tell(still);
            }
        });
    }

    /// <summary>Everything a slot could be holding, said as it should be for whoever is in it now: what they should see, and "no" for the rest.</summary>
    private void Tell(IGamePlayer player)
    {
        if (!_spawned)
        {
            return;
        }

        _screens.TryGetValue(player.SteamId64, out var screen);
        foreach (var key in _slotClasses)
        {
            _world.SetHudClass(player, key.Layout, key.Panel, key.Class, screen?.Classes.GetValueOrDefault(key) ?? false);
        }

        foreach (var key in _slotVariables)
        {
            _world.SetHudVariable(player, key.Layout, key.Panel, key.Variable, screen?.Variables.GetValueOrDefault(key) ?? "");
        }
    }
}
