using System.Numerics;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Extensions;
using CounterStrikeSharp.API.Modules.Memory;
using CounterStrikeSharp.API.Modules.Utils;
using EZPug.Sdk;
using EngineRoundEndReason = CounterStrikeSharp.API.Modules.Entities.Constants.RoundEndReason;

namespace EZPug.Core;

/// <summary>
/// A player as the SDK sees one, over a CounterStrikeSharp controller. Identity (SteamID64,
/// slot) is fixed at connect; everything else is read from the controller on the game
/// thread when asked, and answers safely when the controller has gone. A bot has no
/// SteamID, so it is named by <see cref="BotIdentity"/> — unless it was cast as a
/// rostered player (<see cref="IGameWorld.Casting"/>, PRD-03 T7), in which case it is
/// that player: the roster's SteamID64 and the roster's name, whatever the engine calls
/// the body. A cast that arrives after the body did (<see cref="IGameWorld.Recast"/>,
/// PRD-03 T7a) builds another of these over the same controller rather than moving this
/// one's identity, so nothing that already holds a player sees it become someone else.
/// </summary>
public sealed class CounterStrikePlayer : IGamePlayer
{
    private readonly CCSPlayerController _controller;
    private string _name;

    public CounterStrikePlayer(CCSPlayerController controller, PuppetRole? role = null)
    {
        _controller = controller;
        Slot = controller.Slot;
        IsBot = controller.IsBot;
        IsPuppet = IsBot && role is not null;
        SteamId64 = IsPuppet ? role!.SteamId64 : IsBot ? BotIdentity.SteamId64Of(Slot) : controller.SteamID;
        _name = IsPuppet ? role!.Name : controller.PlayerName;
    }

    internal CCSPlayerController Controller => _controller;

    internal bool Valid => _controller.IsValid;

    /// <summary>Whether <paramref name="controller"/> is the body this player was made for: the same live entity, the same kind of client and, for a person, the same account.</summary>
    internal bool Holds(CCSPlayerController controller) =>
        Valid
        && _controller.Handle == controller.Handle
        && IsBot == controller.IsBot
        && (IsBot || SteamId64 == controller.SteamID);

    public ulong SteamId64 { get; }

    public int Slot { get; }

    public bool IsBot { get; }

    public bool IsPuppet { get; }

    public string Name
    {
        get
        {
            // A puppet goes by the roster's name even where the engine would not take it.
            if (!IsPuppet && Valid && _controller.PlayerName is { Length: > 0 } name)
            {
                _name = name;
            }

            return _name;
        }
    }

    public PlayerTeam Team => Valid ? TeamOf(_controller.Team) : PlayerTeam.None;

    public bool IsAlive => Valid && _controller.PawnIsAlive;

    public Vector3? Position
    {
        get
        {
            if (!Valid || !IsAlive || _controller.PlayerPawn.Value?.AbsOrigin is not { } origin)
            {
                return null;
            }

            return new Vector3(origin.X, origin.Y, origin.Z);
        }
    }

    public int Health => Valid ? (int)_controller.PawnHealth : 0;

    public int Armor => Valid ? _controller.PawnArmor : 0;

    /// <summary>
    /// <c>m_iCompetitiveRanking</c>, but only while <c>m_iCompetitiveRankType</c> says the
    /// scoreboard is drawing it Premier-style — the engine leaves the number behind when
    /// the type is cleared, so the type is what "something is shown" means here.
    /// <c>null</c> when the fields cannot be read at all: CounterStrikeSharp refuses both
    /// while <c>FollowCS2ServerGuidelines</c> is on (the image turns it off, PRD-02 T27),
    /// and a status line an operator asks for may not take the console down over it.
    /// </summary>
    public int? ScoreboardRating
    {
        get
        {
            if (!Valid)
            {
                return null;
            }

            try
            {
                return _controller.CompetitiveRankType == PremierRankType ? _controller.CompetitiveRanking : null;
            }
            catch (Exception)
            {
                return null;
            }
        }
    }

    /// <summary>
    /// <c>m_iCompetitiveRankType</c> for Premier: the one rank type whose scoreboard cell
    /// is a plain number, which is why EZ Rating borrows it (decision 21). Every other
    /// type draws a CS:GO skill-group icon instead.
    /// </summary>
    public const sbyte PremierRankType = 11;

    internal CCSPlayerPawn? Pawn => Valid ? _controller.PlayerPawn.Value : null;

    public static PlayerTeam TeamOf(CsTeam team) =>
        team switch
        {
            CsTeam.Terrorist => PlayerTeam.Terrorist,
            CsTeam.CounterTerrorist => PlayerTeam.CounterTerrorist,
            CsTeam.Spectator => PlayerTeam.Spectator,
            _ => PlayerTeam.None,
        };

    public static CsTeam CsTeamOf(PlayerTeam team) =>
        team switch
        {
            PlayerTeam.Terrorist => CsTeam.Terrorist,
            PlayerTeam.CounterTerrorist => CsTeam.CounterTerrorist,
            PlayerTeam.Spectator => CsTeam.Spectator,
            _ => CsTeam.None,
        };
}

/// <summary>
/// <b><see cref="IGameWorld"/> over CounterStrikeSharp</b> — the only place in the tree a
/// game event, a listener or a controller is touched. Every hook the SDK raises is a
/// CounterStrikeSharp event or listener registered on the plugin (deregistered by the
/// framework on unload); every verb is a controller call or a server command. The
/// clock's timers fire from <c>OnTick</c>, so a mode's callback is on the game thread.
///
/// Two things are decided here and worth knowing: the map is announced to the SDK
/// <see cref="MapReadyDelayMs"/> after the engine's <c>OnMapStart</c>, because the
/// engine execs its own gamemode cfgs right after that listener and a cfg exec'd before
/// them is undone (MatchZy waits the same second); and players are tracked from the
/// engine's <c>player_connect_full</c> for humans and <c>OnClientPutInServer</c> for
/// bots, which is when a controller with a name and a SteamID exists for each.
/// </summary>
public sealed class CounterStrikeWorld : IGameWorld
{
    /// <summary>How long after <c>OnMapStart</c> the map counts as up. The <see cref="MapStart"/> raised then still carries the engine's own instant.</summary>
    public const long MapReadyDelayMs = 1_000;

    private readonly BasePlugin _plugin;
    private readonly GameThreadClock _clock;
    private readonly ILinkLog _log;
    private readonly Dictionary<int, CounterStrikePlayer> _bySlot = new();
    private IReadOnlyList<IGamePlayer> _players = [];
    private string _map;
    /// <summary>One warning is enough: a refused rating is refused for every player, every round.</summary>
    private bool _ratingRefused;
    private readonly UtilityTracker _utility;
    /// <summary>The layout entities this load of the plugin created, by layout. Emptied with the map; never what <see cref="RemoveHudLayouts"/> trusts.</summary>
    private readonly Dictionary<string, CCSCustomHudLayout> _hudLayouts = new(StringComparer.Ordinal);
    /// <summary>A round has started on the map that is up, so its entities may be touched. See <see cref="HudReady"/>.</summary>
    private bool _roundStartedOnMap;
    /// <summary>What went wrong with the HUD once already, so a broken call is one line in the log and not one per player per round.</summary>
    private readonly HashSet<string> _hudSaid = [];

    public CounterStrikeWorld(BasePlugin plugin, GameThreadClock clock, ILinkLog log, string initialMap)
    {
        _plugin = plugin;
        _clock = clock;
        _log = log;
        _utility = new UtilityTracker(clock, log, controller => Known(controller));
        _map = string.IsNullOrEmpty(initialMap) ? "unknown" : initialMap;
    }

    /// <summary>The map as last announced by the engine. Read from any thread (the heartbeat's).</summary>
    public string Map => Volatile.Read(ref _map);

    public IClock Clock => _clock;

    /// <summary>An immutable snapshot rebuilt on connect and disconnect; its count is safe off the game thread.</summary>
    public IReadOnlyList<IGamePlayer> Players => Volatile.Read(ref _players);

    public Func<BotArrival, PuppetRole?>? Casting { get; set; }

    public IGamePlayer? Find(ulong steamId64) => Players.FirstOrDefault(player => player.SteamId64 == steamId64);

    /// <summary>The <c>cs_gamerules</c> entity's state, read on the game thread; <c>null</c> when there is none (between maps) or the read fails.</summary>
    public GameRules? Rules
    {
        get
        {
            try
            {
                var rules = Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules").FirstOrDefault()?.GameRules;
                return rules is null
                    ? null
                    : new GameRules(
                        rules.WarmupPeriod,
                        rules.TotalRoundsPlayed,
                        rules.MatchWaitingForResume,
                        rules.TerroristTimeOutActive,
                        rules.CTTimeOutActive,
                        rules.TechnicalTimeOut,
                        rules.SwitchingTeamsAtRoundReset,
                        PhaseOf(rules.GamePhase));
            }
            catch (Exception)
            {
                return null;
            }
        }
    }

    /// <summary>The grenades on the map, followed by <see cref="UtilityTracker"/>. Game thread only.</summary>
    public IReadOnlyList<GrenadeSighting> SampleGrenades() => _utility.Sample();

    /// <summary>The bomb, followed by <see cref="UtilityTracker"/>. Game thread only.</summary>
    public BombSighting? Bomb => _utility.Bomb();

    /// <summary>
    /// The engine's <c>m_gamePhase</c> as the SDK names it. An unknown number is
    /// <see cref="GamePhase.Unknown"/> rather than a guess: the one caller that acts on
    /// this (the MatchZy flow's pause answer) names a reason only for a phase it knows.
    /// </summary>
    internal static GamePhase PhaseOf(int phase) =>
        Enum.IsDefined(typeof(GamePhase), phase) && phase >= 0 ? (GamePhase)phase : GamePhase.Unknown;

    // ------------------------------------------------------------------ hooks

    public event Action<MapStart>? MapStarted;
    public event Action<IGamePlayer>? PlayerConnected;
    public event Action<IGamePlayer>? PlayerDisconnected;
    public event Action<IGamePlayer>? PlayerSpawned;
    public event Action<PlayerDeath>? PlayerDied;
    public event Action? RoundStarted;
    public event Action? FreezeEnded;
    public event Action<RoundEnd>? RoundEnded;
    public event Action? MapEnded;
    public event Action<IGamePlayer, BombSiteName>? BombPlanted;
    public event Action<IGamePlayer, BombSiteName>? BombDefused;
    public event Action<BombSiteName>? BombExploded;
    public event Action<ChatLine>? ChatSaid;
    public event Action? Tick;

    /// <summary>Register every listener and event on the plugin. Once, from <c>Load</c>.</summary>
    public void Install()
    {
        _plugin.RegisterListener<Listeners.OnTick>(() =>
        {
            _clock.Tick();
            Tick?.Invoke();
        });

        _plugin.RegisterListener<Listeners.OnMapStart>(map =>
        {
            Volatile.Write(ref _map, map);
            ForgetHudLayouts();
            // The instant is stamped here, not in the callback: a listener that asked for
            // a level change during this second has to know the map it hears about was
            // already standing before it asked (PRD-02 T22c).
            var startedAt = _clock.NowMs;
            _clock.After(MapReadyDelayMs, () => MapStarted?.Invoke(new MapStart(map, startedAt)));
        });

        // The level is going: every entity with it, and nothing may reach for one until
        // a round has started on the next.
        _plugin.RegisterListener<Listeners.OnMapEnd>(ForgetHudLayouts);

        _plugin.RegisterEventHandler<EventPlayerConnectFull>((gameEvent, _) =>
        {
            if (gameEvent.Userid is { IsValid: true, IsBot: false } controller)
            {
                Track(controller);
            }

            return HookResult.Continue;
        });

        _plugin.RegisterListener<Listeners.OnClientPutInServer>(slot =>
        {
            if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true, IsBot: true } controller)
            {
                Track(controller);
            }
        });

        _plugin.RegisterEventHandler<EventPlayerDisconnect>((gameEvent, _) =>
        {
            if (gameEvent.Userid is { IsValid: true } controller)
            {
                Drop(controller.Slot);
            }

            return HookResult.Continue;
        });

        // The event above names a controller, and a kicked bot's is often gone by the
        // time it fires — the slot then kept a player nobody was (PRD-03 T7, see Track).
        // The listener names the slot, which is all a drop needs; whichever comes first
        // does it and the other finds nothing.
        _plugin.RegisterListener<Listeners.OnClientDisconnect>(Drop);

        _plugin.RegisterEventHandler<EventPlayerSpawn>((gameEvent, _) =>
        {
            if (Known(gameEvent.Userid) is { } player)
            {
                PlayerSpawned?.Invoke(player);
            }

            return HookResult.Continue;
        });

        _plugin.RegisterEventHandler<EventPlayerDeath>((gameEvent, _) =>
        {
            if (Known(gameEvent.Userid) is not { } victim)
            {
                return HookResult.Continue;
            }

            var killer = Known(gameEvent.Attacker);
            if (killer is not null && killer.SteamId64 == victim.SteamId64)
            {
                killer = null;
            }

            var assists = new List<PlayerAssist>();
            if (Known(gameEvent.Assister) is { } assister && assister.SteamId64 != victim.SteamId64)
            {
                assists.Add(new PlayerAssist(assister, gameEvent.Assistedflash));
            }

            PlayerDied?.Invoke(new PlayerDeath(
                victim,
                killer,
                assists,
                gameEvent.Weapon,
                gameEvent.Headshot,
                Penetrated: gameEvent.Penetrated > 0,
                Noscope: gameEvent.Noscope,
                ThroughSmoke: gameEvent.Thrusmoke,
                AttackerBlind: gameEvent.Attackerblind));
            return HookResult.Continue;
        });

        _plugin.RegisterEventHandler<EventRoundStart>((_, _) =>
        {
            _roundStartedOnMap = true;
            RoundStarted?.Invoke();
            return HookResult.Continue;
        });

        _plugin.RegisterEventHandler<EventRoundFreezeEnd>((_, _) =>
        {
            FreezeEnded?.Invoke();
            return HookResult.Continue;
        });

        _plugin.RegisterEventHandler<EventRoundEnd>((gameEvent, _) =>
        {
            var (tScore, ctScore) = Scores();
            RoundEnded?.Invoke(new RoundEnd(
                CounterStrikePlayer.TeamOf((CsTeam)gameEvent.Winner),
                ReasonOf((EngineRoundEndReason)gameEvent.Reason),
                tScore,
                ctScore));
            return HookResult.Continue;
        });

        // The win panel is the map's own full stop: MatchZy's series ends on it and so
        // does a mode that counts its own rounds, which is why the demo flow and the
        // generic flow emitter both hang off this one event (T21, T22).
        _plugin.RegisterEventHandler<EventCsWinPanelMatch>((_, _) =>
        {
            MapEnded?.Invoke();
            return HookResult.Continue;
        });

        _plugin.RegisterEventHandler<EventBombPlanted>((gameEvent, _) =>
        {
            if (Known(gameEvent.Userid) is { } player)
            {
                BombPlanted?.Invoke(player, _utility.PlantedSite());
            }

            return HookResult.Continue;
        });

        _plugin.RegisterEventHandler<EventBombDefused>((gameEvent, _) =>
        {
            if (Known(gameEvent.Userid) is { } player)
            {
                BombDefused?.Invoke(player, _utility.PlantedSite());
            }

            return HookResult.Continue;
        });

        _plugin.RegisterEventHandler<EventBombExploded>((_, _) =>
        {
            BombExploded?.Invoke(_utility.PlantedSite());
            return HookResult.Continue;
        });

        _utility.Install(_plugin);

        _plugin.AddCommandListener("say", (controller, info) => OnSay(controller, info, teamOnly: false), HookMode.Post);
        _plugin.AddCommandListener("say_team", (controller, info) => OnSay(controller, info, teamOnly: true), HookMode.Post);
    }

    private HookResult OnSay(CCSPlayerController? controller, CommandInfo info, bool teamOnly)
    {
        if (Known(controller) is { } player && info.ArgCount >= 2)
        {
            var text = info.GetArg(1);
            if (text.Length > 0)
            {
                ChatSaid?.Invoke(new ChatLine(player, text, teamOnly));
            }
        }

        return HookResult.Continue;
    }

    /// <summary>
    /// A slot is held by whoever is standing in it <i>now</i>. It used to be held by
    /// whoever got there first: a bot kicked without a disconnect this world heard left
    /// its player behind, and the next body in that slot played the whole match under the
    /// dead one's name with no team to read — <c>real-powerup-dm-bo1.json</c> has one bot
    /// that is <c>spec</c> in all of its 219 appearances and shares a name with another,
    /// and production's <c>OPEN-POINTS</c> §2 was the same body. So a newcomer to a held
    /// slot first sees the stale player out, announced, and then moves in.
    /// </summary>
    private void Track(CCSPlayerController controller)
    {
        if (_bySlot.TryGetValue(controller.Slot, out var held))
        {
            if (held.Holds(controller))
            {
                return;
            }

            _log.Warn($"slot {controller.Slot} still held {held.Name}, who is gone; seeing them out before {controller.PlayerName} moves in");
            Drop(controller.Slot);
        }

        var role = controller.IsBot ? Casting?.Invoke(new BotArrival(controller.Slot, controller.PlayerName)) : null;
        var player = new CounterStrikePlayer(controller, role);
        if (role is not null)
        {
            Rename(controller, role.Name);
        }

        _bySlot[controller.Slot] = player;
        Snapshot();
        PlayerConnected?.Invoke(player);
    }

    /// <summary>
    /// <b>The cast that arrives late</b> (PRD-03 T7a). MatchZy-Enhanced's simulation mode
    /// spawns its bots first and decides which roster entry each one plays seconds
    /// afterwards, so there is nothing to ask at the door: the body is already a plain bot
    /// by the time the fork says who it is. Handing it over here rebuilds the player over
    /// the same controller and announces it, which is the first word anything has said
    /// about that body — a plain bot is never announced, so no disconnect is owed for the
    /// bot it stops being. A body handed a <i>different</i> roster entry is a remap, and
    /// the person it was is seen out before the new one moves in, the way
    /// <see cref="Track"/> does it for a slot.
    /// </summary>
    public bool Recast(int slot, PuppetRole role)
    {
        if (!_bySlot.TryGetValue(slot, out var held) || !held.IsBot || !held.Valid)
        {
            return false;
        }

        if (held.IsPuppet && held.SteamId64 == role.SteamId64)
        {
            return true;
        }

        var controller = held.Controller;
        if (held.IsPuppet)
        {
            _log.Warn($"slot {slot} played {held.Name}, and now plays {role.Name}: seeing the first out");
            Drop(slot);
        }

        var player = new CounterStrikePlayer(controller, role);
        Rename(controller, role.Name);
        _bySlot[slot] = player;
        Snapshot();
        PlayerConnected?.Invoke(player);
        return true;
    }

    private void Drop(int slot)
    {
        if (_bySlot.Remove(slot, out var player))
        {
            Snapshot();
            PlayerDisconnected?.Invoke(player);
        }
    }

    /// <summary>The scoreboard's name for a puppet. Cosmetic, so a refusal is a line in the log and not a fault: the wire says the roster's name either way.</summary>
    private void Rename(CCSPlayerController controller, string name)
    {
        try
        {
            controller.PlayerName = name;
            Utilities.SetStateChanged(controller, "CBasePlayerController", "m_iszPlayerName");
        }
        catch (Exception error)
        {
            _log.Warn($"renaming the bot in slot {controller.Slot} to {name} failed: {error.Message}");
        }
    }

    private void Snapshot() =>
        Volatile.Write(ref _players, _bySlot.Values.OrderBy(player => player.Slot).ToList<IGamePlayer>());

    private CounterStrikePlayer? Known(CCSPlayerController? controller) =>
        controller is { IsValid: true } && _bySlot.TryGetValue(controller.Slot, out var player) ? player : null;

    private static CounterStrikePlayer Real(IGamePlayer player) =>
        player as CounterStrikePlayer ?? throw new ArgumentException("not one of this world's players", nameof(player));

    private static (int T, int Ct) Scores()
    {
        int t = 0, ct = 0;
        foreach (var team in Utilities.FindAllEntitiesByDesignerName<CCSTeam>("cs_team_manager"))
        {
            switch ((CsTeam)team.TeamNum)
            {
                case CsTeam.Terrorist:
                    t = team.Score;
                    break;
                case CsTeam.CounterTerrorist:
                    ct = team.Score;
                    break;
                default:
                    break;
            }
        }

        return (t, ct);
    }

    /// <summary>The engine's reason for a round's end, folded to the SDK's four that mean something to a mode.</summary>
    public static RoundEndReason ReasonOf(EngineRoundEndReason reason) =>
        reason switch
        {
            EngineRoundEndReason.TargetBombed => RoundEndReason.BombExploded,
            EngineRoundEndReason.BombDefused => RoundEndReason.BombDefused,
            EngineRoundEndReason.TargetSaved => RoundEndReason.TimeExpired,
            EngineRoundEndReason.CTsWin or EngineRoundEndReason.TerroristsWin => RoundEndReason.Elimination,
            _ => RoundEndReason.Other,
        };

    /// <summary><c>planted_c4</c>'s <c>m_nBombSite</c> numbers the sites 0 and 1; the vocabulary calls them A and B. A bomb event's <c>site</c> is not this number (see <see cref="UtilityTracker.PlantedSite"/>).</summary>
    public static BombSiteName SiteOf(int site) =>
        site switch
        {
            0 => BombSiteName.A,
            1 => BombSiteName.B,
            _ => BombSiteName.Unknown,
        };

    // ------------------------------------------------------------------ text

    public void Say(string text) => Server.PrintToChatAll(text);

    public void Say(IGamePlayer player, string text) => WithController(player, controller => controller.PrintToChat(text));

    public void PrintCenter(IGamePlayer player, string text) => WithController(player, controller => controller.PrintToCenter(text));

    public void PrintHud(IGamePlayer player, string text) => WithController(player, controller => controller.PrintToCenterHtml(text));

    public void PrintConsole(IGamePlayer player, string text) => WithController(player, controller => controller.PrintToConsole(text));

    // ------------------------------------------------------------------ the HUD

    /// <summary>The engine's class for a Panorama layout a server drives.</summary>
    public const string HudEntityClass = "custom_hud_layout";

    /// <summary>
    /// The targetname every layout of ours is spawned under. The entity outlives the
    /// plugin that made it, and a reload empties every dictionary, so this name in the
    /// world is the only record that survives of what is ours to remove.
    /// </summary>
    public const string HudEntityName = "ezpug_hud";

    /// <summary>
    /// <b>No entity before a round has started on the map that is up.</b>
    /// CounterStrikeSharp keeps the entity list behind a <c>Lazy</c> that caches a failed
    /// look for the life of the process, and one HUD call while a level loads would blind
    /// every plugin on the server until it restarts. The SDK's <see cref="Hud"/> keeps the
    /// same rule and is the one caller; this is the same rule kept twice, because the
    /// world hears a level end a second before the SDK does.
    /// </summary>
    private bool HudReady => _roundStartedOnMap;

    private void ForgetHudLayouts()
    {
        _roundStartedOnMap = false;
        _hudLayouts.Clear();
    }

    /// <summary>
    /// The layout and the name go in as spawn keyvalues, and both read back off the
    /// entity (measured on the dev node, <c>docs/hud.md</c>). Other plugins report that a
    /// layout written to <c>m_strLayout</c> after the spawn networks and reads back and
    /// is still never loaded by a client. The raw factory rather than
    /// <c>Utilities.CreateEntityByName</c>, which wraps a null pointer in an entity that
    /// faults when asked whether it is valid. <c>observable</c> is the entity's third
    /// key (the game's <c>csgo.fgd</c>: "Show each player's own version of this UI to
    /// whoever is spectating them") and reads back as <c>m_bObservable</c>.
    /// </summary>
    public void CreateHudLayout(string layout, bool observable = false) =>
        TouchHud($"creating {layout}", () =>
        {
            var pointer = VirtualFunctions.UTIL_CreateEntityByName(HudEntityClass, -1);
            if (pointer == IntPtr.Zero)
            {
                throw new InvalidOperationException($"the engine made no {HudEntityClass}");
            }

            var entity = new CCSCustomHudLayout(pointer);
            using (var keys = new CEntityKeyValues())
            {
                keys.SetString("targetname", HudEntityName);
                keys.SetString("layout", layout);
                if (observable)
                {
                    keys.SetBool("observable", true);
                }

                entity.DispatchSpawn(keys);
            }

            if (!entity.IsValid)
            {
                throw new InvalidOperationException("the entity did not survive its spawn");
            }

            _hudLayouts[layout] = entity;
        });

    /// <summary>
    /// Every layout of ours in the world, whoever made it: the ones this load created,
    /// and whatever else carries our name, found by walking the entities. Collected
    /// before anything is removed, because the walk is lazy and a removal moves its
    /// cursor.
    /// </summary>
    public void RemoveHudLayouts() =>
        TouchHud("removing the layouts", () =>
        {
            var ours = _hudLayouts.Values.Where(entity => entity.IsValid).ToDictionary(entity => entity.Index);
            _hudLayouts.Clear();
            foreach (var entity in OurHudLayouts())
            {
                ours[entity.Index] = entity;
            }

            foreach (var entity in ours.Values)
            {
                entity.Remove();
            }
        });

    /// <summary>Every <c>custom_hud_layout</c> in the world that carries our name, whoever made it.</summary>
    private static List<CCSCustomHudLayout> OurHudLayouts() =>
        [.. Utilities.FindAllEntitiesByDesignerName<CCSCustomHudLayout>(HudEntityClass)
            .Where(entity => entity.IsValid && entity.Entity?.Name == HudEntityName)];

    /// <summary>More elements than any table or state of a layout of ours holds; a count beyond it is memory that is not what it is taken for.</summary>
    private const int HudVectorMax = 4_096;

    /// <summary>
    /// <b>The layouts of ours in the world, read back off the entities</b> (PRD-07 T9):
    /// each one's path and <c>observable</c>, its three tables of names, and what
    /// everybody's state and every slot's hold. This is what the server networks, so it
    /// is as near to a client's screen as a server can look. Empty before a round has
    /// started on the map, for the reason <see cref="HudReady"/> gives.
    ///
    /// <para>CounterStrikeSharp's <c>NetworkedVector</c> hands out elements for entity
    /// handles only, so the elements are walked here: the vector's own count and first
    /// element from the native side, the stride from the schema's class size (a string
    /// is one pointer). Nothing is written. A read that does not add up is a line in
    /// the log and an empty answer, like every other HUD call.</para>
    /// </summary>
    public IReadOnlyList<HudLayoutReading> ReadHudLayouts()
    {
        var readings = new List<HudLayoutReading>();
        TouchHud("reading the layouts back", () =>
        {
            foreach (var entity in OurHudLayouts())
            {
                readings.Add(new HudLayoutReading(
                    entity.Index,
                    entity.StrLayout,
                    entity.Observable,
                    HudNames(entity.PanelIds.Handle),
                    HudNames(entity.ClassNames.Handle),
                    HudNames(entity.DialogVariableNames.Handle),
                    HudState(entity.GlobalLayoutState),
                    [.. HudElements(entity.PlayerLayoutStates.Handle, Schema.GetClassSize("CCSCustomHudLayoutState"))
                        .Select(pointer => HudState(new CCSCustomHudLayoutState(pointer)))]));
            }
        });
        return readings;
    }

    private static HudStateReading HudState(CCSCustomHudLayoutState state) =>
        new(
            state.PlayerSlot,
            state.InputCaptureEnabled,
            [.. HudElements(state.HasClasses.Handle, Schema.GetClassSize("HUDPanelHasClass_t"))
                .Select(pointer => new HUDPanelHasClass_t(pointer))
                .Select(entry => new HudClassReading(entry.PanelIdIndex, entry.ClassNameIndex, entry.ClassStatus switch
                {
                    EHudPanelClassStatus_t.k_eHudPanelClassStatus_HasClass => HudClassStatus.Has,
                    EHudPanelClassStatus_t.k_eHudPanelClassStatus_DoesNotHaveClass => HudClassStatus.DoesNotHave,
                    _ => HudClassStatus.Undefined,
                }))],
            [.. HudElements(state.DialogVariableStrings.Handle, Schema.GetClassSize("HUDPanelDialogVariableString_t"))
                .Select(pointer => new HUDPanelDialogVariableString_t(pointer))
                .Select(entry => new HudStringReading(entry.PanelIdIndex, entry.DialogVariableIndex, entry.Value ?? "", entry.IsSet))]);

    /// <summary>A table of names: a vector of strings, each one pointer to its characters.</summary>
    private static List<string> HudNames(IntPtr vector) =>
        [.. HudElements(vector, IntPtr.Size).Select(pointer => Utilities.ReadStringUtf8(pointer) ?? "")];

    /// <summary>Where each element of a networked vector lies, <paramref name="stride"/> bytes apart from the first.</summary>
    private static List<IntPtr> HudElements(IntPtr vector, int stride)
    {
        var count = NativeAPI.GetNetworkVectorSize(vector);
        if (count is < 0 or > HudVectorMax || stride <= 0)
        {
            throw new InvalidOperationException($"a vector of {count} element(s) of {stride} byte(s) is not a layout's");
        }

        if (count == 0)
        {
            return [];
        }

        var first = NativeAPI.GetNetworkVectorElementAt(vector, 0);
        if (first == IntPtr.Zero)
        {
            throw new InvalidOperationException($"a vector of {count} element(s) has no memory");
        }

        return [.. Enumerable.Range(0, count).Select(index => first + index * stride)];
    }

    public void SetHudClass(string layout, string panel, string className, bool has) =>
        WithHudLayout(layout, entity => entity.SetHasClass(panel, className, has));

    public void SetHudClass(IGamePlayer player, string layout, string panel, string className, bool has) =>
        WithHudLayout(layout, player, (entity, controller) => entity.SetHasClassForPlayer(controller, panel, className, has));

    public void SetHudVariable(string layout, string panel, string variable, string value) =>
        WithHudLayout(layout, entity => entity.SetDialogVariableString(panel, variable, value));

    public void SetHudVariable(IGamePlayer player, string layout, string panel, string variable, string value) =>
        WithHudLayout(layout, player, (entity, controller) => entity.SetDialogVariableStringForPlayer(controller, panel, variable, value));

    private void WithHudLayout(string layout, Action<CCSCustomHudLayout> action) =>
        TouchHud($"setting {layout}", () =>
        {
            if (_hudLayouts.TryGetValue(layout, out var entity) && entity.IsValid)
            {
                action(entity);
            }
        });

    /// <summary>
    /// One slot's state. The engine keeps one block per slot in a vector and the setter
    /// indexes it without a bounds check, so a slot the vector does not reach is refused
    /// here; a bot has no client to tell.
    /// </summary>
    private void WithHudLayout(string layout, IGamePlayer player, Action<CCSCustomHudLayout, CCSPlayerController> action) =>
        TouchHud($"setting {layout} for a player", () =>
        {
            var real = Real(player);
            if (!real.Valid || real.IsBot || !_hudLayouts.TryGetValue(layout, out var entity) || !entity.IsValid)
            {
                return;
            }

            if (real.Slot < 0 || real.Slot >= entity.PlayerLayoutStates.Count)
            {
                throw new InvalidOperationException($"slot {real.Slot} has no state on the layout");
            }

            action(entity, real.Controller);
        });

    /// <summary>
    /// Every HUD verb goes through here: nothing before a round has started, and a
    /// failure is a line in the log, once per kind, never an exception a match could
    /// trip over. The HUD is decoration (decision 34).
    /// </summary>
    private void TouchHud(string what, Action action)
    {
        if (!HudReady)
        {
            return;
        }

        try
        {
            action();
        }
        catch (Exception error)
        {
            if (_hudSaid.Add($"{what}: {error.Message}"))
            {
                _log.Warn($"hud: {what} failed and is skipped: {error.Message}");
            }
        }
    }

    /// <summary>
    /// The sound is emitted from the player's own controller to a filter that holds
    /// nobody else. The events this is used for are the game's UI ones, whose volume
    /// does not fall off with distance, so where the controller "is" does not matter and
    /// a dead player or a spectator hears it too. Decoration, like the layouts: a failure
    /// is one line in the log.
    /// </summary>
    public void PlaySound(IGamePlayer player, string soundEvent, float volume)
    {
        var real = Real(player);
        if (!real.Valid || real.IsBot)
        {
            return;
        }

        try
        {
            real.Controller.EmitSound(soundEvent, new RecipientFilter(real.Controller), volume);
        }
        catch (Exception error)
        {
            if (_hudSaid.Add($"sound: {error.Message}"))
            {
                _log.Warn($"hud: playing {soundEvent} failed and is skipped: {error.Message}");
            }
        }
    }

    // ------------------------------------------------------------------ player verbs

    public void Give(IGamePlayer player, string item) => WithController(player, controller => controller.GiveNamedItem(item));

    public void Strip(IGamePlayer player) => WithController(player, controller => controller.RemoveWeapons());

    public void Respawn(IGamePlayer player) => WithController(player, controller => controller.Respawn());

    public void SetHealth(IGamePlayer player, int health) =>
        WithPawn(player, pawn =>
        {
            pawn.Health = health;
            Utilities.SetStateChanged(pawn, "CBaseEntity", "m_iHealth");
        });

    public void SetArmor(IGamePlayer player, int armor) =>
        WithPawn(player, pawn =>
        {
            pawn.ArmorValue = armor;
            Utilities.SetStateChanged(pawn, "CCSPlayerPawn", "m_ArmorValue");
        });

    /// <summary>
    /// <b>The engine's own teleport</b> (PRD-03 T12): a vtable call CounterStrikeSharp
    /// exposes on every entity (<c>CBaseEntity_Teleport</c>, an offset rather than a byte
    /// signature, so it survives a game update the way a signature does not). It writes
    /// the origin and lets the engine network it; it does not trace, so a body told to
    /// stand inside a wall stands inside the wall.
    /// </summary>
    public void Teleport(IGamePlayer player, Vector3 position, Vector3? angles = null, Vector3? velocity = null) =>
        WithPawn(player, pawn => pawn.Teleport(position, angles, velocity));

    public void SetSpeed(IGamePlayer player, float multiplier) =>
        WithPawn(player, pawn =>
        {
            pawn.VelocityModifier = multiplier;
            Utilities.SetStateChanged(pawn, "CCSPlayerPawn", "m_flVelocityModifier");
        });

    /// <summary>
    /// The scoreboard's Premier cell (decision 21). Both fields are networked, so both
    /// are marked changed; clearing the type is what hides the number, and the number
    /// goes to zero with it so a stale rating cannot resurface.
    ///
    /// A refusal is caught and warned about once per boot rather than thrown: these two
    /// fields are the only ones in the seam an *option* can lock — CounterStrikeSharp
    /// says "Cannot set or get ... with FollowCS2ServerGuidelines option enabled" and the
    /// image turns that off (PRD-02 T27, `docker/cs2/Dockerfile`) — and a server whose
    /// config somebody changed should draw no rating, not drop a `release` on the floor
    /// (measured on the dev node: the throw ate the command's answer and the orchestrator
    /// called it `provider_unavailable`).
    /// </summary>
    public void SetScoreboardRating(IGamePlayer player, int? rating) =>
        WithController(player, controller =>
        {
            try
            {
                controller.CompetitiveRanking = rating ?? 0;
                controller.CompetitiveRankType = rating is null ? (sbyte)0 : CounterStrikePlayer.PremierRankType;
                Utilities.SetStateChanged(controller, "CCSPlayerController", "m_iCompetitiveRanking");
                Utilities.SetStateChanged(controller, "CCSPlayerController", "m_iCompetitiveRankType");
            }
            catch (Exception error)
            {
                if (!_ratingRefused)
                {
                    _ratingRefused = true;
                    _log.Warn($"the scoreboard rating was refused by the engine and will not be drawn: {error.Message}");
                }
            }
        });

    public void SetTeam(IGamePlayer player, PlayerTeam team) => WithController(player, controller => controller.ChangeTeam(CounterStrikePlayer.CsTeamOf(team)));

    public void Kick(IGamePlayer player, string reason) =>
        WithController(player, controller =>
        {
            if (controller.UserId is { } userId)
            {
                Server.ExecuteCommand($"kickid {userId} \"{Sanitize(reason)}\"");
            }
        });

    /// <summary><c>bot_add_ct</c> / <c>bot_add_t</c> / <c>bot_add</c>: each raises <c>bot_quota</c> by the one it adds, so the engine keeps the body.</summary>
    public void AddBot(PlayerTeam? side = null) =>
        Server.ExecuteCommand(side switch
        {
            PlayerTeam.CounterTerrorist => "bot_add_ct",
            PlayerTeam.Terrorist => "bot_add_t",
            _ => "bot_add",
        });

    public void KickBots() => Server.ExecuteCommand("bot_kick");

    // ------------------------------------------------------------------ server verbs

    public void ExecCfg(string file) => Server.ExecuteCommand($"exec {Sanitize(file)}");

    public void ExecCommand(string line) => Server.ExecuteCommand(line);

    public string? GetCvar(string name)
    {
        var cvar = ConVar.Find(name);
        if (cvar is null)
        {
            return null;
        }

        try
        {
            return cvar.Type switch
            {
                ConVarType.Bool => cvar.GetPrimitiveValue<bool>() ? "1" : "0",
                ConVarType.Int16 => cvar.GetPrimitiveValue<short>().ToString(System.Globalization.CultureInfo.InvariantCulture),
                ConVarType.UInt16 => cvar.GetPrimitiveValue<ushort>().ToString(System.Globalization.CultureInfo.InvariantCulture),
                ConVarType.Int32 => cvar.GetPrimitiveValue<int>().ToString(System.Globalization.CultureInfo.InvariantCulture),
                ConVarType.UInt32 => cvar.GetPrimitiveValue<uint>().ToString(System.Globalization.CultureInfo.InvariantCulture),
                ConVarType.Int64 => cvar.GetPrimitiveValue<long>().ToString(System.Globalization.CultureInfo.InvariantCulture),
                ConVarType.UInt64 => cvar.GetPrimitiveValue<ulong>().ToString(System.Globalization.CultureInfo.InvariantCulture),
                ConVarType.Float32 => cvar.GetPrimitiveValue<float>().ToString(System.Globalization.CultureInfo.InvariantCulture),
                ConVarType.Float64 => cvar.GetPrimitiveValue<double>().ToString(System.Globalization.CultureInfo.InvariantCulture),
                ConVarType.String => cvar.StringValue,
                _ => null,
            };
        }
        catch (Exception error)
        {
            _log.Warn($"reading cvar {name} failed: {error.Message}");
            return null;
        }
    }

    /// <summary>Set as a console line rather than through the handle, so a plugin's fake cvar and an engine cvar of any type take it the same way.</summary>
    public void SetCvar(string name, string value) => Server.ExecuteCommand($"{Sanitize(name)} \"{Sanitize(value)}\"");

    public void ChangeLevel(string map) => Server.ExecuteCommand($"changelevel {Sanitize(map)}");

    public void HostWorkshopMap(string workshopId) => Server.ExecuteCommand($"host_workshop_map {Sanitize(workshopId)}");

    /// <summary>What may not travel inside a console line: quotes, separators and line breaks.</summary>
    public static string Sanitize(string value) =>
        value.Replace("\"", "").Replace(";", "").Replace("\n", " ").Replace("\r", " ").Trim();

    private static void WithController(IGamePlayer player, Action<CCSPlayerController> action)
    {
        var real = Real(player);
        if (real.Valid)
        {
            action(real.Controller);
        }
    }

    private static void WithPawn(IGamePlayer player, Action<CCSPlayerPawn> action)
    {
        if (Real(player).Pawn is { IsValid: true } pawn)
        {
            action(pawn);
        }
    }
}
