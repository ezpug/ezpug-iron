using System.Globalization;
using System.Numerics;
using System.Text.Json.Nodes;
using EZPug.Sdk;

namespace EZPug.PowerupDm;

/// <summary>
/// <b><c>powerup-dm</c>: the original mode</b> (PRD-02 T26, decision 17). Free-for-all
/// deathmatch — the cfg beside the manifest is that half — where every life buys exactly
/// one power-up, claimed from the phone (or with <c>!powerup</c> in chat) and gone when
/// the player dies.
///
/// Three of them, and which three is the manifest's decision, not this file's: the verb
/// <c>powerup</c> declares a <c>kind</c> whose enum is <c>speed</c>, <c>armor</c>,
/// <c>radar_peek</c>, and the SDK refuses a fourth with <c>invalid_args</c> before
/// <see cref="OnPlayerCommand"/> ever runs. What the class decides is what each one
/// <i>does</i>:
///
/// <list type="bullet">
/// <item><c>speed</c> — <see cref="SpeedMultiplier"/>× movement until this life ends.</item>
/// <item><c>armor</c> — a full vest, which the cfg never hands out at spawn.</item>
/// <item><c>radar_peek</c> — <see cref="PeekDurationMs"/> of everybody else's position,
/// pushed to the tapper's phone as a widget frame every <see cref="PeekIntervalMs"/> and
/// never written down anywhere (CLAUDE.md: position ticks are ephemeral). The phone is
/// the radar; the player is looking at their hand while the game carries on without
/// them, which is the trade.</item>
/// </list>
///
/// What this class does <b>not</b> write, because the SDK does: the one charge per life
/// and its refill on spawn, the args check, the German/English line per player, the
/// <c>player_connected</c>/<c>player_death</c>/<c>chat_*</c> events, the match flow
/// (<c>GenericFlow</c> reads the engine — this mode has no story of its own to tell), the
/// per-match <c>seq</c>, the timers' cleanup at release. <c>docs/sdk.md</c> is the map.
/// </summary>
public sealed class PowerupDm : Gamemode
{
    /// <summary>The manifest id this class implements.</summary>
    public const string Id_ = "powerup-dm";

    /// <summary>The verb the manifest declares. One per life, no cooldown — the life is the cooldown.</summary>
    public const string Verb = "powerup";

    /// <summary>The <c>kind</c> values the manifest's enum carries. A kind not in this set never reaches the mode.</summary>
    public const string SpeedKind = "speed";
    public const string ArmorKind = "armor";
    public const string RadarPeekKind = "radar_peek";

    /// <summary>What <c>!powerup</c> with no word after it means. The phone always names a kind; a typed line need not.</summary>
    public const string DefaultKind = SpeedKind;

    /// <summary>The <c>plugin_event</c> a claimed power-up leaves in the match log: <c>steamId64</c>, <c>kind</c>.</summary>
    public const string ClaimedEvent = "powerup_claimed";

    /// <summary>The push name the widget draws its canvas from (`gamemodes/powerup-dm/widget/`).</summary>
    public const string PeekPush = "radar_peek";

    /// <summary>How much faster <c>speed</c> makes a player, as a multiple of normal.</summary>
    public const float SpeedMultiplier = 1.35f;

    /// <summary>What <c>armor</c> is worth. The cfg's <c>mp_free_armor 0</c> is why it is worth anything.</summary>
    public const int ArmorPoints = 100;

    /// <summary>How long a <c>radar_peek</c> lasts — the five seconds the PRD names.</summary>
    public const long PeekDurationMs = 5_000;

    /// <summary>How often the peek is refreshed while it runs. Ten frames in five seconds: enough to see somebody move, few enough for a phone on venue wifi.</summary>
    public const long PeekIntervalMs = 500;

    /// <summary>What one player has spent this life on, and — when that was the peek — the instant it stops.</summary>
    private sealed class Life
    {
        public string? Powerup;
        /// <summary>The clock instant this player's peek ends; <c>0</c> when none is running.</summary>
        public long PeekUntilMs;
    }

    private PlayerState<Life>? _lives;

    public override string Id => Id_;

    protected override Localizer CreateLocalizer() =>
        Localizer.FromEmbedded(GetType().Assembly, "EZPug.PowerupDm.Lines");

    public override void OnAssigned(Assignment assignment)
    {
        _lives = PlayerState(_ => new Life());
        // **One timer for every peek there will ever be**, armed once and cancelled with
        // the match: a timer per claim would be a timer per life per player, and the
        // runtime holds each until the match ends. The peeks running right now are the
        // player states that say so.
        Every(PeekIntervalMs, PushPeeks);
    }

    public override void OnStart() => SayAll("powerup.start");

    public override void OnPlayerJoined(IGamePlayer player) => Say(player, "powerup.welcome");

    /// <summary>
    /// A new life: the SDK has already refilled the charge (<c>charges.per: life</c>), so
    /// all that is left is to take back what the last one bought. Speed above all — a
    /// multiplier survives a respawn and would otherwise be a power-up somebody keeps.
    /// </summary>
    public override void OnPlayerSpawned(IGamePlayer player)
    {
        var life = _lives![player];
        life.PeekUntilMs = 0;
        life.Powerup = null;
        World.SetSpeed(player, 1f);
    }

    public override void OnPlayerDied(PlayerDeath death) => _lives![death.Victim].PeekUntilMs = 0;

    /// <summary>
    /// The tap, from the phone or from chat, after the SDK checked the verb, the args, the
    /// cooldown and the charge. Only a living player may claim one — a corpse asking for
    /// speed is <c>not_alive</c>, and it costs them nothing.
    /// </summary>
    public override PlayerCommandOutcome OnPlayerCommand(IGamePlayer player, string command, JsonObject? args)
    {
        if (!player.IsAlive)
        {
            return new PlayerCommandOutcome.NotAlive();
        }

        var kind = args?["kind"]?.GetValue<string>() ?? DefaultKind;
        var life = _lives![player];
        switch (kind)
        {
            case ArmorKind:
                World.SetArmor(player, ArmorPoints);
                break;
            case RadarPeekKind:
                // The five seconds start now and the first frame goes out now; the rest
                // ride the mode's one timer.
                life.PeekUntilMs = Clock.NowMs + PeekDurationMs;
                PushPeek(player, life);
                break;
            default:
                World.SetSpeed(player, SpeedMultiplier);
                break;
        }

        life.Powerup = kind;
        Say(player, "powerup.landed", Lines(player)[$"powerup.kind.{kind}"]);
        PrintCenter(player, $"powerup.center.{kind}");
        EmitPluginEvent(ClaimedEvent, new { steamId64 = player.SteamId64.ToString(CultureInfo.InvariantCulture), kind });
        return PlayerCommandOutcome.Ok;
    }

    public override void OnEnd(string? reason) => SayAll("powerup.bye");

    // ------------------------------------------------------------------ the peek

    /// <summary>
    /// One turn of the mode's only timer: a frame for every peek still running, and the
    /// end of every one whose five seconds are up or whose owner has stopped being
    /// somebody who can look at a phone. On the world's clock, so every read of a
    /// position happens on the game thread.
    /// </summary>
    private void PushPeeks()
    {
        var now = Clock.NowMs;
        foreach (var (steamId64, life) in _lives!.All.ToList())
        {
            if (life.PeekUntilMs == 0)
            {
                continue;
            }

            var player = World.Find(steamId64);
            if (player is null || !player.IsAlive || now >= life.PeekUntilMs)
            {
                life.PeekUntilMs = 0;
                continue;
            }

            PushPeek(player, life);
        }
    }

    /// <summary>
    /// One frame of the peek: where the tapper is, where everybody else alive is, and how
    /// much of the five seconds is left. Coordinates are engine world units rounded to
    /// whole numbers — a radar's worth of precision and a smaller frame — and no name, no
    /// SteamID64 and no team ride along: this is a picture of dots, not a wallhack with a
    /// scoreboard. Nobody but the tapper's own phone ever sees it, and nothing keeps it.
    /// </summary>
    private void PushPeek(IGamePlayer player, Life life)
    {
        var contacts = new JsonArray();
        foreach (var other in World.Players)
        {
            if (other.SteamId64 == player.SteamId64 || !other.IsAlive || other.Position is not { } at)
            {
                continue;
            }

            contacts.Add(Point(at));
        }

        var left = Math.Max(0, life.PeekUntilMs - Clock.NowMs);
        PushWidget(player, PeekPush, new JsonObject
        {
            ["map"] = World.Map,
            ["expiresInMs"] = left,
            ["self"] = player.Position is { } here ? Point(here) : null,
            ["contacts"] = contacts,
        });

        World.PrintHud(player, Lines(player)["powerup.peek.hud", (long)Math.Ceiling(left / 1000.0)]);
    }

    private static JsonObject Point(Vector3 at) =>
        new()
        {
            ["x"] = (long)Math.Round(at.X),
            ["y"] = (long)Math.Round(at.Y),
            ["z"] = (long)Math.Round(at.Z),
        };
}
