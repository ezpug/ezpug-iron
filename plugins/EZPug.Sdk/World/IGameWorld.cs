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
    /// <summary>The engine plays this body. True for a plain bot <i>and</i> for a puppet — see <see cref="IsPuppet"/> for which.</summary>
    bool IsBot { get; }
    /// <summary>
    /// A bot cast as a rostered player (PRD-03 T7): <see cref="SteamId64"/> and
    /// <see cref="Name"/> are the roster entry's, and everything that speaks about a
    /// player — the announcement, a death, a position, a command's target — treats it as
    /// that person. What stays a bot's is what only a client could read: the connect card, the
    /// rating greeting, a line said to everybody.
    /// </summary>
    bool IsPuppet { get; }
    /// <summary>Engine world units, or <c>null</c> without a pawn (dead, connecting).</summary>
    Vector3? Position { get; }
    int Health { get; }
    int Armor { get; }

    /// <summary>
    /// The number the scoreboard shows where Premier shows its own (decision 21), read
    /// back from the engine, or <c>null</c> when nothing is shown. Written through
    /// <see cref="IGameWorld.SetScoreboardRating"/> — reading it here is how a test, and
    /// an operator's <c>ezpug_status</c>, sees what actually landed rather than what was
    /// asked for.
    /// </summary>
    int? ScoreboardRating { get; }
}

/// <summary>A bot the engine just put on the server, before the SDK has a player for it: the slot it took and the name the engine gave it.</summary>
public sealed record BotArrival(int Slot, string Name);

/// <summary>Who a bot is cast as: a roster entry's SteamID64 and the name it goes by.</summary>
public sealed record PuppetRole(ulong SteamId64, string Name);

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
/// A map is up: which one, and <b>when the engine started it</b> on the world's clock.
/// The two are not the same instant — an implementation may hold the news back until the
/// map is worth talking to (the core plugin waits <c>CounterStrikeWorld.MapReadyDelayMs</c>
/// after the engine's <c>OnMapStart</c>) — and a listener that asked for a level change in
/// between needs the earlier number to tell the map it asked for from the one that was
/// already standing (PRD-02 T22c).
/// </summary>
public sealed record MapStart(string Map, long StartedAtMs);

/// <summary>
/// The engine's match state as <c>cs_gamerules</c> keeps it, read on the game thread:
/// warmup, the phase (<see cref="GamePhase"/>), the rounds played so far in the match (what the scoreboard counts; reset by
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
    bool SwitchingTeamsAtRoundReset,
    GamePhase Phase = GamePhase.Unknown)
{
    /// <summary>The match is standing still for any reason.</summary>
    public bool Standing => Paused || TerroristTimeout || CounterTerroristTimeout || TechnicalTimeout;

    /// <summary>Any of the two tactical timeouts or the technical one is running.</summary>
    public bool Timeout => TerroristTimeout || CounterTerroristTimeout || TechnicalTimeout;
}

/// <summary>
/// The engine's <c>m_gamePhase</c>, which is the only way to tell the two states a match
/// software refuses to be disturbed in — the break between halves and the scoreboard
/// after the last round — from an ordinary live round. <see cref="Unknown"/> when the
/// engine gave a number this enum has no name for, or when nothing read it (the
/// harness's default): a caller that acts on the phase must treat it as "not known",
/// never as "not halftime".
/// </summary>
public enum GamePhase
{
    /// <summary>Nothing read the phase, or the engine named one this SDK does not know.</summary>
    Unknown = -1,
    WarmupRound = 0,
    PlayingStandard = 1,
    PlayingFirstHalf = 2,
    PlayingSecondHalf = 3,
    /// <summary>The break between the two halves.</summary>
    Halftime = 4,
    /// <summary>The match is over and the scoreboard is up.</summary>
    MatchEnded = 5,
}

/// <summary>Bomb site as the engine names it.</summary>
public enum BombSiteName
{
    Unknown,
    A,
    B,
}

/// <summary>What a thrown grenade is. The CT's fire is <see cref="Incendiary"/>, the T's <see cref="Molotov"/>.</summary>
public enum GrenadeKind
{
    He,
    Flash,
    Smoke,
    Molotov,
    Incendiary,
    Decoy,
}

/// <summary>In the air, or gone off and occupying space (a smoke's bloom, a fire, a flash's pop).</summary>
public enum GrenadeState
{
    Flying,
    Active,
}

/// <summary>
/// One grenade as the live radar draws it (ezpug/ezpug-iron#5): an id stable for its
/// life, engine world units, and for an active smoke or fire how far it reaches.
/// <see cref="Thrower"/> is the player as the world knows them, so a puppet's grenade is
/// the rostered player's.
/// </summary>
public sealed record GrenadeSighting(
    string Id,
    GrenadeKind Kind,
    Vector3 Position,
    GrenadeState State,
    float? Radius = null,
    IGamePlayer? Thrower = null);

/// <summary>Where the bomb is: on somebody, on the floor, or in a site.</summary>
public enum BombState
{
    Carried,
    Dropped,
    Planted,
}

/// <summary>The bomb as the live radar draws it: where, who carries it, and the site once planted.</summary>
public sealed record BombSighting(
    BombState State,
    Vector3 Position,
    IGamePlayer? Carrier = null,
    BombSiteName Site = BombSiteName.Unknown);

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

    /// <summary>
    /// <b>Who an arriving bot is</b> (PRD-03 T7). A player's identity is fixed the moment
    /// the world first names it, so the question is asked <i>before</i> that: every bot
    /// the engine adds is offered here first, and one that comes back with a role is a
    /// puppet — that SteamID64, that name, <see cref="IGamePlayer.IsPuppet"/> — from its
    /// very first hook. <c>null</c> (the answer, or no casting at all) leaves a plain bot,
    /// named by <see cref="BotIdentity"/>. The runtime's <see cref="Puppeteer"/> is the
    /// one caller; a mode never sets this.
    /// </summary>
    Func<BotArrival, PuppetRole?>? Casting { get; set; }

    /// <summary>
    /// <b>A body already here turns out to be somebody</b> (PRD-03 T7a). <see cref="Casting"/>
    /// answers at the door, which is where the SDK's own <see cref="Puppeteer"/> knows who
    /// it asked for. Under a <c>matchzy</c> flow MatchZy-Enhanced seats the bodies itself
    /// and decides who each one is seconds later, so the cast arrives after the world has
    /// already named the bot: this hands it over then. The body in <paramref name="slot"/>
    /// becomes that rostered player — id, name, <see cref="IGamePlayer.IsPuppet"/> — and is
    /// announced through <see cref="PlayerConnected"/>, because until now nothing had said
    /// it was here at all. A slot already cast as the same person is left alone and answers
    /// <c>true</c>; one cast as somebody else sees that person out first. <c>false</c> when
    /// the slot holds nobody, or holds a person rather than a bot.
    /// </summary>
    bool Recast(int slot, PuppetRole role);

    /// <summary>The engine's match state right now, or <c>null</c> between maps. A snapshot: read it again to see a change.</summary>
    GameRules? Rules { get; }

    /// <summary>
    /// <b>The utility on the map</b> (ezpug/ezpug-iron#5), for the position ticker. Every
    /// grenade flying or active right now: a smoke from its bloom until it expires, a fire
    /// while it burns. A flash, an HE or a decoy is gone from the map the moment it goes
    /// off, so each one that went off since the last call is in this answer
    /// <b>once</b>, <see cref="GrenadeState.Active"/> where it popped. Because of that,
    /// calling this consumes those pops, and the runtime's ticker is its one caller.
    /// </summary>
    IReadOnlyList<GrenadeSighting> SampleGrenades();

    /// <summary>Where the bomb is right now, or <c>null</c> while none is in play (no bomb in this mode, not handed out yet, exploded or defused).</summary>
    BombSighting? Bomb { get; }

    // Text
    void Say(string text);
    void Say(IGamePlayer player, string text);
    void PrintCenter(IGamePlayer player, string text);
    void PrintHud(IGamePlayer player, string text);
    void PrintConsole(IGamePlayer player, string text);

    // The HUD (decision 34). The runtime's <see cref="Hud"/> is the one caller: it owns
    // when a layout may exist and what a slot is told, and a mode reaches these through it.
    // There is no verb that takes a player's mouse, on purpose: the engine can freeze a
    // player behind a cursor, and nothing EZPug shows is worth a round.
    /// <summary>
    /// Put a layout on every client's screen: one <c>custom_hud_layout</c> entity for
    /// <paramref name="layout"/>, which is the layout's <b>source</b> path with its
    /// extension (<c>panorama/layout/custom_game/ezpug_welcome.xml</c>) — a client that
    /// does not have that file draws nothing and says nothing. The entity dies with the
    /// map and outlives everything else, a plugin reload included, so it is created
    /// under a name <see cref="RemoveHudLayouts"/> can find again.
    /// </summary>
    void CreateHudLayout(string layout);
    /// <summary>Remove every layout this seam ever created that is still in the world, found by name and not by memory: the ones a previous load of the plugin left behind too.</summary>
    void RemoveHudLayouts();
    /// <summary>Set or clear a class on one panel of a layout, for everybody.</summary>
    void SetHudClass(string layout, string panel, string className, bool has);
    /// <summary>The same for one player, over the value everybody has. Kept by the engine per <b>slot</b>, so it outlives the player who was told.</summary>
    void SetHudClass(IGamePlayer player, string layout, string panel, string className, bool has);
    /// <summary>Set a string a label of the layout binds as <c>{s:variable}</c>, for everybody.</summary>
    void SetHudVariable(string layout, string panel, string variable, string value);
    /// <summary>The same for one player, over the value everybody has. Per slot, like the class.</summary>
    void SetHudVariable(IGamePlayer player, string layout, string panel, string variable, string value);

    // Sound
    /// <summary>
    /// Play one of the <b>game's own</b> sound events to one player and nobody else
    /// (PRD-07 T6): <paramref name="soundEvent"/> is a name out of the game's
    /// <c>soundevents/*.vsndevts</c> (<c>EndMatch.ItemRevealSingleLocalPlayer</c>), never a
    /// file of ours, so there is nothing for a client to download.
    /// <paramref name="volume"/> is 0…1 of what the event plays at. A bot hears nothing,
    /// and a name the client does not know is silence, not an error.
    /// </summary>
    void PlaySound(IGamePlayer player, string soundEvent, float volume);

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
    /// <summary>
    /// Show <paramref name="rating"/> on the scoreboard where Premier shows its number,
    /// or hide it with <c>null</c> (decision 21). The engine keeps one such number per
    /// player and it is the only place a rating is drawn: no clan tag, no HUD card.
    /// Read back through <see cref="IGamePlayer.ScoreboardRating"/>.
    /// </summary>
    void SetScoreboardRating(IGamePlayer player, int? rating);
    void SetTeam(IGamePlayer player, PlayerTeam team);
    /// <summary>
    /// <b>Put a body where you say</b> (PRD-03 T12). Engine world units for
    /// <paramref name="position"/>, degrees for <paramref name="angles"/> as the engine
    /// keeps them (pitch, yaw, roll), engine units a second for
    /// <paramref name="velocity"/>; each of the last two left alone when <c>null</c>.
    /// There is no collision check and no ground trace — the engine puts the body where
    /// it is told, wall or no wall — so a path worth walking has to come from something
    /// that knows the map.
    /// </summary>
    void Teleport(IGamePlayer player, Vector3 position, Vector3? angles = null, Vector3? velocity = null);
    void Kick(IGamePlayer player, string reason);
    /// <summary>Ask the engine for one more bot, on <paramref name="side"/> or wherever it puts one. It arrives through <see cref="PlayerConnected"/> a moment later, or not at all (a full server): nothing here promises it.</summary>
    void AddBot(PlayerTeam? side = null);
    /// <summary>Take every bot off the server, puppets included.</summary>
    void KickBots();

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
    /// <summary>A map is up and worth talking to. Carries the instant the engine started it — see <see cref="MapStart"/>.</summary>
    event Action<MapStart>? MapStarted;
    event Action<IGamePlayer>? PlayerConnected;
    event Action<IGamePlayer>? PlayerDisconnected;
    event Action<IGamePlayer>? PlayerSpawned;
    event Action<PlayerDeath>? PlayerDied;
    event Action? RoundStarted;
    /// <summary>
    /// The freeze time of the round that just started is over and people can move
    /// (<c>round_freeze_end</c>). How long a freeze lasts is the mode's <c>mp_freezetime</c>;
    /// this is the instant it ends, which is what the HUD puts a card away on (PRD-07 T3).
    /// </summary>
    event Action? FreezeEnded;
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
