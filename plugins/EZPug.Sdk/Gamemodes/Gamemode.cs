using System.Text.Json.Nodes;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>A gamemode is a class over the SDK and a manifest beside it</b> (CLAUDE.md). Derive,
/// override the hooks you need, emit through <see cref="Emit"/>; the runtime hands you
/// the world, the link, the clock, the localizer and the assignment, and takes them back
/// when the match ends. Nothing here is a CounterStrikeSharp type, so a mode runs under
/// <c>GamemodeTestHost</c> without CS2. Every hook fires on the game thread.
/// <c>docs/sdk.md</c> shows one in fifty lines.
/// </summary>
public abstract class Gamemode
{
    private GamemodeRuntime? _runtime;

    /// <summary>The manifest id this mode implements (<c>powerup-dm</c>). Checked against the assignment: a mismatch is refused before <see cref="OnAssigned"/>.</summary>
    public abstract string Id { get; }

    /// <summary>
    /// The mode's own lines over the SDK's. Override with
    /// <c>Localizer.FromEmbedded(GetType().Assembly, "My.Mode.Lines")</c> for a mode that
    /// prints anything of its own.
    /// </summary>
    protected virtual Localizer CreateLocalizer() => new();

    // ------------------------------------------------------------------ what the runtime provides

    protected IGameWorld World => Runtime.World;
    protected IPlatformLink Link => Runtime.Link;
    protected IClock Clock => Runtime.World.Clock;
    protected Localizer Localizer => Runtime.Localizer;
    protected Facts Facts => Runtime.Facts;
    protected MatchContext Match => Runtime.Match;
    /// <summary>The current assignment, or <c>null</c> between matches.</summary>
    protected Assignment? Assignment => Runtime.Assignment;
    /// <summary>The player commands the manifest declares, with their cooldown and charge state.</summary>
    protected CommandTable? Commands => Runtime.Commands;

    internal GamemodeRuntime Runtime => _runtime ?? throw new InvalidOperationException($"{GetType().Name} is not attached to a runtime");

    internal void Bind(GamemodeRuntime runtime) => _runtime = runtime;

    internal void Unbind() => _runtime = null;

    internal Localizer BuildLocalizer() => CreateLocalizer();

    // ------------------------------------------------------------------ hooks

    /// <summary>The orchestrator assigned a match. Plugins are enabled and cfg exec'd by the host before this; the map may still be loading.</summary>
    public virtual void OnAssigned(Assignment assignment) { }

    /// <summary>The match's first map is up and the server said <c>server_ready</c>: go.</summary>
    public virtual void OnStart() { }

    public virtual void OnPlayerJoined(IGamePlayer player) { }

    public virtual void OnPlayerLeft(IGamePlayer player) { }

    public virtual void OnPlayerSpawned(IGamePlayer player) { }

    public virtual void OnPlayerDied(PlayerDeath death) { }

    /// <summary><paramref name="roundNumber"/> is 1-based and already in <see cref="Match"/>.</summary>
    public virtual void OnRoundStart(long roundNumber) { }

    public virtual void OnRoundEnd(RoundEnd roundEnd) { }

    /// <summary>A line a player typed that was not a declared verb; the vocabulary event is emitted by the runtime.</summary>
    public virtual void OnChat(ChatLine line) { }

    /// <summary>
    /// A declared verb, from the phone or as <c>!verb</c> in chat, after the SDK checked the
    /// args, the cooldown and the charges. Return <see cref="PlayerCommandOutcome.Ok"/> to
    /// spend the charge and start the cooldown; a refusal costs nothing.
    /// </summary>
    public virtual PlayerCommandOutcome OnPlayerCommand(IGamePlayer player, string command, JsonObject? args) =>
        PlayerCommandOutcome.Ok;

    /// <summary>A profile arrived for a player (open join, a refreshed rating or loadout). Already in <see cref="Assignment"/>.</summary>
    public virtual void OnProfile(RosterEntry player) { }

    /// <summary>A Match API command the runtime does not answer itself (pause, unpause, restart_round, force_end, restore, reroll). Return <see cref="CommandAnswer.Deferred"/> and call <c>Link.AnswerCommand</c> later for work that waits on the engine. Default: unsupported.</summary>
    public virtual CommandAnswer OnCommand(LinkCommand command) =>
        CommandAnswer.Rejected(MatchApiErrorCode.CommandUnsupported, $"{command.Discriminator} is not supported by {Id}");

    /// <summary>Every engine frame while a match is assigned.</summary>
    public virtual void OnTick() { }

    /// <summary>The match is over for this server (<c>release</c>), or the orchestrator wants it to finish what it has (<c>drain</c> comes through <see cref="OnDrain"/>). Timers and player state are cleared after this returns.</summary>
    public virtual void OnEnd(string? reason) { }

    public virtual void OnDrain() { }

    // ------------------------------------------------------------------ helpers

    /// <summary>Emit a vocabulary event, stamped with the per-match seq. <see cref="Facts"/> builds them.</summary>
    protected void Emit(GameserverEvent gameserverEvent) => Runtime.Emit(gameserverEvent);

    /// <summary>A <c>plugin_event</c> with a snake_case name and any JSON-shaped data.</summary>
    protected void EmitPluginEvent(string name, object data) => Runtime.Emit(Facts.Plugin(name, data));

    protected Locale LocaleOf(IGamePlayer player) => Assignment?.LocaleOf(player.SteamId64) ?? Localizer.DefaultLocale;

    /// <summary>The lines in this player's language: <c>Lines(player)["powerup.landed", kind]</c>.</summary>
    protected LocalizedLines Lines(IGamePlayer player) => Localizer.For(LocaleOf(player));

    /// <summary>Say a localized line to one player.</summary>
    protected void Say(IGamePlayer player, string key, params object[] args) => World.Say(player, Lines(player)[key, args]);

    /// <summary>Say a localized line to everybody, each in their own language.</summary>
    protected void SayAll(string key, params object[] args)
    {
        foreach (var player in World.Players.Where(player => !player.IsBot))
        {
            World.Say(player, Lines(player)[key, args]);
        }
    }

    protected void PrintCenter(IGamePlayer player, string key, params object[] args) => World.PrintCenter(player, Lines(player)[key, args]);

    /// <summary>Per-player state the runtime drops when the player leaves and clears when the match ends.</summary>
    protected PlayerState<T> PlayerState<T>(Func<IGamePlayer, T> create) => Runtime.RegisterState(new PlayerState<T>(create));

    /// <summary>A timer on the world's clock, cancelled when the match ends.</summary>
    protected IClockTimer After(long delayMs, Action callback) => Runtime.Track(Clock.After(delayMs, callback));

    protected IClockTimer Every(long intervalMs, Action callback) => Runtime.Track(Clock.Every(intervalMs, callback));
}
