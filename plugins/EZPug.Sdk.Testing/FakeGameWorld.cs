using System.Numerics;
using EZPug.Sdk;

namespace EZPug.Sdk.Testing;

/// <summary>A scripted player: a test sets what the world would report.</summary>
public sealed class FakePlayer : IGamePlayer
{
    public FakePlayer(ulong steamId64, string name, int slot)
    {
        SteamId64 = steamId64;
        Name = name;
        Slot = slot;
    }

    public ulong SteamId64 { get; }
    public int Slot { get; }
    public string Name { get; set; }
    public PlayerTeam Team { get; set; } = PlayerTeam.None;
    public bool IsAlive { get; set; }
    public bool IsBot { get; set; }
    public Vector3? Position { get; set; }
    public int Health { get; set; } = 100;
    public int Armor { get; set; }
    public float Speed { get; set; } = 1f;
    /// <summary>What <c>Give</c> handed this player, in order, until a <c>Strip</c>.</summary>
    public List<string> Items { get; } = [];
}

/// <summary>One thing a mode did to the world, for a test's assertions.</summary>
public sealed record WorldAction(string Verb, ulong? SteamId64, string Detail)
{
    public override string ToString() => SteamId64 is null ? $"{Verb} {Detail}" : $"{Verb} {SteamId64} {Detail}";
}

/// <summary>
/// <b>The world without CS2.</b> Every verb a mode calls is recorded in
/// <see cref="Actions"/> (and applied to the scripted players where it has a visible
/// effect: health, armor, speed, items, team); every hook is a method a test calls to
/// make something happen — <see cref="Connect"/>, <see cref="Spawn"/>, <see cref="Kill"/>,
/// <see cref="StartRound"/>, <see cref="Say"/>. Timers run on the <see cref="FakeClock"/>;
/// <see cref="Frame"/> fires one engine tick, which is also when the link is pumped.
/// </summary>
public sealed class FakeGameWorld : IGameWorld
{
    private readonly List<FakePlayer> _players = [];
    private readonly Dictionary<string, string> _cvars = new(StringComparer.OrdinalIgnoreCase);

    public FakeGameWorld(FakeClock? clock = null, string map = "de_mirage")
    {
        FakeClock = clock ?? new FakeClock();
        Map = map;
    }

    public FakeClock FakeClock { get; }
    public IClock Clock => FakeClock;
    public string Map { get; private set; }
    public IReadOnlyList<IGamePlayer> Players => _players;
    /// <summary>What the engine would report as its match state; a test sets it, <c>null</c> (the default) means no gamerules to read.</summary>
    public GameRules? Rules { get; set; }
    public List<WorldAction> Actions { get; } = [];
    /// <summary>Every line said to everybody, and per player.</summary>
    public List<string> Broadcasts { get; } = [];
    public Dictionary<ulong, List<string>> Said { get; } = new();
    public Dictionary<ulong, List<string>> Centered { get; } = new();

    /// <summary>
    /// Every action as it is taken, for a test that has to stand <i>between</i> two of
    /// them — <see cref="Actions"/> answers "what happened", this answers "what was true
    /// when it did" (the loader writing a plugin's config before it loads the plugin,
    /// PRD-02 T23).
    /// </summary>
    public event Action<WorldAction>? Acted;

    private void Record(WorldAction action)
    {
        Actions.Add(action);
        Acted?.Invoke(action);
    }

    public IGamePlayer? Find(ulong steamId64) => _players.FirstOrDefault(player => player.SteamId64 == steamId64);

    // ------------------------------------------------------------------ verbs

    public void Say(string text)
    {
        Broadcasts.Add(text);
        Record(new WorldAction("say", null, text));
    }

    public void Say(IGamePlayer player, string text)
    {
        Said.GetOrAdd(player.SteamId64).Add(text);
        Record(new WorldAction("say", player.SteamId64, text));
    }

    public void PrintCenter(IGamePlayer player, string text)
    {
        Centered.GetOrAdd(player.SteamId64).Add(text);
        Record(new WorldAction("center", player.SteamId64, text));
    }

    public void PrintHud(IGamePlayer player, string text) => Record(new WorldAction("hud", player.SteamId64, text));

    public void PrintConsole(IGamePlayer player, string text) => Record(new WorldAction("console", player.SteamId64, text));

    public void Give(IGamePlayer player, string item)
    {
        Fake(player).Items.Add(item);
        Record(new WorldAction("give", player.SteamId64, item));
    }

    public void Strip(IGamePlayer player)
    {
        Fake(player).Items.Clear();
        Record(new WorldAction("strip", player.SteamId64, ""));
    }

    public void Respawn(IGamePlayer player)
    {
        Record(new WorldAction("respawn", player.SteamId64, ""));
        Spawn(player);
    }

    public void SetHealth(IGamePlayer player, int health)
    {
        Fake(player).Health = health;
        Record(new WorldAction("health", player.SteamId64, health.ToString()));
    }

    public void SetArmor(IGamePlayer player, int armor)
    {
        Fake(player).Armor = armor;
        Record(new WorldAction("armor", player.SteamId64, armor.ToString()));
    }

    public void SetSpeed(IGamePlayer player, float multiplier)
    {
        Fake(player).Speed = multiplier;
        Record(new WorldAction("speed", player.SteamId64, multiplier.ToString(System.Globalization.CultureInfo.InvariantCulture)));
    }

    public void SetTeam(IGamePlayer player, PlayerTeam team)
    {
        Fake(player).Team = team;
        Record(new WorldAction("team", player.SteamId64, team.ToString()));
    }

    public void Kick(IGamePlayer player, string reason)
    {
        Record(new WorldAction("kick", player.SteamId64, reason));
        Disconnect(player);
    }

    public void ExecCfg(string file) => Record(new WorldAction("exec", null, file));

    public void ExecCommand(string line) => Record(new WorldAction("command", null, line));

    public string? GetCvar(string name) => _cvars.GetValueOrDefault(name);

    public void SetCvar(string name, string value)
    {
        _cvars[name] = value;
        Record(new WorldAction("cvar", null, $"{name} {value}"));
    }

    public void ChangeLevel(string map)
    {
        Record(new WorldAction("changelevel", null, map));
        Map = map;
    }

    public void HostWorkshopMap(string workshopId) => Record(new WorldAction("host_workshop_map", null, workshopId));

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

    // ------------------------------------------------------------------ the script

    /// <summary>
    /// The map finished loading (after a <c>ChangeLevel</c>, or at boot). A real world may
    /// hold the news back a beat, so <paramref name="startedAtMs"/> says when the engine
    /// started the map if that is not now — which is how a test writes the boot map whose
    /// news arrives after the assignment already asked for another one (PRD-02 T22c).
    /// </summary>
    public void StartMap(string? map = null, long? startedAtMs = null)
    {
        if (map is not null)
        {
            Map = map;
        }

        MapStarted?.Invoke(new MapStart(Map, startedAtMs ?? Clock.NowMs));
    }

    public FakePlayer Connect(ulong steamId64, string name, PlayerTeam team = PlayerTeam.None, bool bot = false)
    {
        var slot = Enumerable.Range(0, 64).First(candidate => _players.All(player => player.Slot != candidate));
        var player = new FakePlayer(steamId64, name, slot) { Team = team, IsBot = bot };
        _players.Add(player);
        _players.Sort((a, b) => a.Slot.CompareTo(b.Slot));
        PlayerConnected?.Invoke(player);
        return player;
    }

    public void Disconnect(IGamePlayer player)
    {
        if (_players.Remove(Fake(player)))
        {
            PlayerDisconnected?.Invoke(player);
        }
    }

    public void Spawn(IGamePlayer player)
    {
        var fake = Fake(player);
        fake.IsAlive = true;
        fake.Health = 100;
        fake.Position ??= Vector3.Zero;
        PlayerSpawned?.Invoke(player);
    }

    public void Kill(IGamePlayer victim, IGamePlayer? killer, string weapon = "weapon_ak47", bool headshot = false, IReadOnlyList<PlayerAssist>? assists = null)
    {
        var fake = Fake(victim);
        fake.IsAlive = false;
        fake.Health = 0;
        PlayerDied?.Invoke(new PlayerDeath(victim, killer, assists ?? [], weapon, headshot));
    }

    public void StartRound() => RoundStarted?.Invoke();

    public void EndRound(PlayerTeam winner, RoundEndReason reason, int tScore, int ctScore) =>
        RoundEnded?.Invoke(new RoundEnd(winner, reason, tScore, ctScore));

    /// <summary>The engine put the match win panel up: the map is over.</summary>
    public void EndMap() => MapEnded?.Invoke();

    public void PlantBomb(IGamePlayer player, BombSiteName site) => BombPlanted?.Invoke(player, site);

    public void DefuseBomb(IGamePlayer player, BombSiteName site) => BombDefused?.Invoke(player, site);

    public void ExplodeBomb(BombSiteName site) => BombExploded?.Invoke(site);

    /// <summary>A player typed a line (<c>say</c>, or <c>say_team</c> with <paramref name="teamOnly"/>).</summary>
    public void SayAs(IGamePlayer player, string text, bool teamOnly = false) => ChatSaid?.Invoke(new ChatLine(player, text, teamOnly));

    /// <summary>One engine frame: the link is pumped, the mode's <c>OnTick</c> runs.</summary>
    public void Frame() => Tick?.Invoke();

    /// <summary>Advance the clock by <paramref name="ms"/> and fire a frame — a test's "a little later".</summary>
    public void Elapse(long ms)
    {
        FakeClock.Advance(ms);
        Frame();
    }

    private static FakePlayer Fake(IGamePlayer player) =>
        player as FakePlayer ?? throw new ArgumentException("not one of this world's players", nameof(player));
}

internal static class DictionaryExtensions
{
    public static List<string> GetOrAdd(this Dictionary<ulong, List<string>> lists, ulong key)
    {
        if (!lists.TryGetValue(key, out var list))
        {
            list = [];
            lists[key] = list;
        }

        return list;
    }
}
