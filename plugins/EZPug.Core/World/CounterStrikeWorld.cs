using System.Numerics;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Utils;
using EZPug.Sdk;
using EngineRoundEndReason = CounterStrikeSharp.API.Modules.Entities.Constants.RoundEndReason;

namespace EZPug.Core;

/// <summary>
/// A player as the SDK sees one, over a CounterStrikeSharp controller. Identity (SteamID64,
/// slot) is fixed at connect; everything else is read from the controller on the game
/// thread when asked, and answers safely when the controller has gone. A bot has no
/// SteamID, so it is named by <see cref="BotIdentity"/>.
/// </summary>
public sealed class CounterStrikePlayer : IGamePlayer
{
    private readonly CCSPlayerController _controller;
    private string _name;

    public CounterStrikePlayer(CCSPlayerController controller)
    {
        _controller = controller;
        Slot = controller.Slot;
        IsBot = controller.IsBot;
        SteamId64 = IsBot ? BotIdentity.SteamId64Of(Slot) : controller.SteamID;
        _name = controller.PlayerName;
    }

    internal CCSPlayerController Controller => _controller;

    internal bool Valid => _controller.IsValid;

    public ulong SteamId64 { get; }

    public int Slot { get; }

    public bool IsBot { get; }

    public string Name
    {
        get
        {
            if (Valid && _controller.PlayerName is { Length: > 0 } name)
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

    public CounterStrikeWorld(BasePlugin plugin, GameThreadClock clock, ILinkLog log, string initialMap)
    {
        _plugin = plugin;
        _clock = clock;
        _log = log;
        _map = string.IsNullOrEmpty(initialMap) ? "unknown" : initialMap;
    }

    /// <summary>The map as last announced by the engine. Read from any thread (the heartbeat's).</summary>
    public string Map => Volatile.Read(ref _map);

    public IClock Clock => _clock;

    /// <summary>An immutable snapshot rebuilt on connect and disconnect; its count is safe off the game thread.</summary>
    public IReadOnlyList<IGamePlayer> Players => Volatile.Read(ref _players);

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
                        rules.SwitchingTeamsAtRoundReset);
            }
            catch (Exception)
            {
                return null;
            }
        }
    }

    // ------------------------------------------------------------------ hooks

    public event Action<MapStart>? MapStarted;
    public event Action<IGamePlayer>? PlayerConnected;
    public event Action<IGamePlayer>? PlayerDisconnected;
    public event Action<IGamePlayer>? PlayerSpawned;
    public event Action<PlayerDeath>? PlayerDied;
    public event Action? RoundStarted;
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
            // The instant is stamped here, not in the callback: a listener that asked for
            // a level change during this second has to know the map it hears about was
            // already standing before it asked (PRD-02 T22c).
            var startedAt = _clock.NowMs;
            _clock.After(MapReadyDelayMs, () => MapStarted?.Invoke(new MapStart(map, startedAt)));
        });

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
            if (gameEvent.Userid is { IsValid: true } controller && _bySlot.Remove(controller.Slot, out var player))
            {
                Snapshot();
                PlayerDisconnected?.Invoke(player);
            }

            return HookResult.Continue;
        });

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
            RoundStarted?.Invoke();
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
                BombPlanted?.Invoke(player, SiteOf(gameEvent.Site));
            }

            return HookResult.Continue;
        });

        _plugin.RegisterEventHandler<EventBombDefused>((gameEvent, _) =>
        {
            if (Known(gameEvent.Userid) is { } player)
            {
                BombDefused?.Invoke(player, SiteOf(gameEvent.Site));
            }

            return HookResult.Continue;
        });

        _plugin.RegisterEventHandler<EventBombExploded>((gameEvent, _) =>
        {
            BombExploded?.Invoke(SiteOf(gameEvent.Site));
            return HookResult.Continue;
        });

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

    private void Track(CCSPlayerController controller)
    {
        if (_bySlot.ContainsKey(controller.Slot))
        {
            return;
        }

        var player = new CounterStrikePlayer(controller);
        _bySlot[controller.Slot] = player;
        Snapshot();
        PlayerConnected?.Invoke(player);
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

    /// <summary>The engine numbers bomb sites 0 and 1; the vocabulary calls them A and B.</summary>
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
