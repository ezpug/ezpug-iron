using System.Numerics;

namespace EZPug.Sdk;

/// <summary>Which side a player sits on, as the engine counts them.</summary>
public enum PlayerTeam
{
    /// <summary>Not yet on a team (just connected).</summary>
    None,
    Spectator,
    Terrorist,
    CounterTerrorist,
}

/// <summary>
/// A player as a gamemode sees one: identity, where they sit, whether they are alive,
/// where they stand. Read-only by design — every change goes through
/// <see cref="IGameWorld"/>, so a fake can record it and a test can assert it.
/// </summary>
public interface IGamePlayer
{
    ulong SteamId64 { get; }
    /// <summary>The engine slot (0-based). Stable for the connection's life; the vocabulary does not carry it, the fleet console does.</summary>
    int Slot { get; }
    /// <summary>The in-game name at the moment of asking.</summary>
    string Name { get; }
    PlayerTeam Team { get; }
    bool IsAlive { get; }
    bool IsBot { get; }
    /// <summary>Engine world units, or <c>null</c> without a pawn (dead, connecting).</summary>
    Vector3? Position { get; }
    int Health { get; }
    int Armor { get; }
}

/// <summary>What the engine said when somebody died.</summary>
public sealed record PlayerDeath(
    IGamePlayer Victim,
    /// <summary><c>null</c> for the world (fall, self).</summary>
    IGamePlayer? Killer,
    IReadOnlyList<PlayerAssist> Assists,
    string Weapon,
    bool Headshot,
    bool Penetrated = false,
    bool Noscope = false,
    bool ThroughSmoke = false,
    bool AttackerBlind = false);

public sealed record PlayerAssist(IGamePlayer Player, bool Flash);

/// <summary>Why a round ended, as the engine reports it.</summary>
public enum RoundEndReason
{
    Elimination,
    BombExploded,
    BombDefused,
    TimeExpired,
    Other,
}

/// <summary>A round is over: who won and why, and the score as the engine keeps it (T on the left as CS does).</summary>
public sealed record RoundEnd(PlayerTeam Winner, RoundEndReason Reason, int TerroristScore, int CounterTerroristScore);

/// <summary>A line a player typed: raw, and which window (<c>say</c> or <c>say_team</c>).</summary>
public sealed record ChatLine(IGamePlayer Player, string Text, bool TeamOnly);

/// <summary>
/// The engine's match state as <c>cs_gamerules</c> keeps it, read on the game thread:
/// warmup, the rounds played so far in the match (what the scoreboard counts; reset by
/// <c>mp_restartgame</c>, so a knife round and warmup never count), whether a pause is
/// requested or in force (<c>mp_pause_match</c>), the two tactical timeouts and the
/// technical one, and whether the teams swap at the next round reset (halftime). What
/// the SDK's runtime numbers rounds from and what the core plugin's MatchZy flow watches
/// for pauses and side swaps (PRD-02 T9). <c>null</c> from <see cref="IGameWorld.Rules"/>
/// while no map is loaded.
/// </summary>
public sealed record GameRules(
    bool Warmup,
    int RoundsPlayed,
    bool Paused,
    bool TerroristTimeout,
    bool CounterTerroristTimeout,
    bool TechnicalTimeout,
    bool SwitchingTeamsAtRoundReset)
{
    /// <summary>The match is standing still for any reason.</summary>
    public bool Standing => Paused || TerroristTimeout || CounterTerroristTimeout || TechnicalTimeout;
}

/// <summary>Bomb site as the engine names it.</summary>
public enum BombSiteName
{
    Unknown,
    A,
    B,
}

/// <summary>
/// <b>The world seam.</b> Everything a gamemode may do to the server and everything the
/// server tells it, with no CounterStrikeSharp type on either side, so a mode is
/// tested by <c>FakeGameWorld</c> without CS2 and the core plugin implements this once
/// (PRD-02 T8). Every hook fires on the game thread; a mode does no locking.
/// When a mode needs a verb this seam lacks, the seam grows once — with a fake, with
/// a test — rather than the mode reaching around it.
/// </summary>
public interface IGameWorld
{
    /// <summary>The engine map currently loaded.</summary>
    string Map { get; }

    /// <summary>The timers a mode arms — the game-thread clock, so a callback runs where the engine allows.</summary>
    IClock Clock { get; }

    /// <summary>Every connected player, bots included, in slot order.</summary>
    IReadOnlyList<IGamePlayer> Players { get; }

    IGamePlayer? Find(ulong steamId64);

    /// <summary>The engine's match state right now, or <c>null</c> between maps. A snapshot: read it again to see a change.</summary>
    GameRules? Rules { get; }

    // Text
    void Say(string text);
    void Say(IGamePlayer player, string text);
    void PrintCenter(IGamePlayer player, string text);
    void PrintHud(IGamePlayer player, string text);
    void PrintConsole(IGamePlayer player, string text);

    // Player verbs
    /// <summary>Give an item by its engine name (<c>weapon_ak47</c>, <c>item_assaultsuit</c>).</summary>
    void Give(IGamePlayer player, string item);
    /// <summary>Remove every weapon.</summary>
    void Strip(IGamePlayer player);
    void Respawn(IGamePlayer player);
    void SetHealth(IGamePlayer player, int health);
    void SetArmor(IGamePlayer player, int armor);
    /// <summary>The entity minimum a power-up needs: movement speed as a multiplier of normal.</summary>
    void SetSpeed(IGamePlayer player, float multiplier);
    void SetTeam(IGamePlayer player, PlayerTeam team);
    void Kick(IGamePlayer player, string reason);

    // Server verbs
    /// <summary>Run <c>exec &lt;file&gt;</c> for a file under <c>cfg/</c>.</summary>
    void ExecCfg(string file);
    /// <summary>Run one console line as the server. The RCON fallback's door and the loader's.</summary>
    void ExecCommand(string line);
    string? GetCvar(string name);
    void SetCvar(string name, string value);
    void ChangeLevel(string map);
    void HostWorkshopMap(string workshopId);

    // Hooks
    event Action<string>? MapStarted;
    event Action<IGamePlayer>? PlayerConnected;
    event Action<IGamePlayer>? PlayerDisconnected;
    event Action<IGamePlayer>? PlayerSpawned;
    event Action<PlayerDeath>? PlayerDied;
    event Action? RoundStarted;
    event Action<RoundEnd>? RoundEnded;
    /// <summary>
    /// The map is over: the engine put the win panel up (<c>cs_win_panel_match</c>).
    /// The one end-of-map signal every mode shares — MatchZy's series and a mode that
    /// runs its own rounds both reach it — and what the demo flow stops recording on
    /// (PRD-02 T21) and the generic flow emitter reports <c>map_end</c> from (T22).
    /// </summary>
    event Action? MapEnded;
    event Action<IGamePlayer, BombSiteName>? BombPlanted;
    event Action<IGamePlayer, BombSiteName>? BombDefused;
    event Action<BombSiteName>? BombExploded;
    event Action<ChatLine>? ChatSaid;
    /// <summary>Once per engine frame. The runtime pumps the link here; a mode's <c>OnTick</c> hangs off it.</summary>
    event Action? Tick;
}
