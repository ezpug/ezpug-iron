using System.Text.Json.Nodes;
using EZPug.Sdk;

namespace EZPug.Sdk.Tests.Modes;

/// <summary>
/// The mode <c>docs/sdk.md</c> shows: deathmatch by cfg, one power-up per life from the
/// phone or <c>!powerup</c> in chat. Everything the manifest declares — the verb, its one
/// charge per life, its args — is enforced by the SDK before <see cref="OnPlayerCommand"/>
/// runs; the mode only does the thing and says so in the player's language.
/// </summary>
public sealed class PowerupDemo : Gamemode
{
    private sealed class Life
    {
        public string? Powerup;
    }

    private PlayerState<Life>? _lives;

    public override string Id => "powerup-dm";

    protected override Localizer CreateLocalizer() => Localizer.FromEmbedded(GetType().Assembly, "EZPug.Sdk.Tests.Modes.PowerupDemo");

    public override void OnAssigned(Assignment assignment) => _lives = PlayerState(_ => new Life());

    public override void OnPlayerJoined(IGamePlayer player) => Say(player, "powerup.welcome");

    public override void OnPlayerSpawned(IGamePlayer player)
    {
        _lives![player].Powerup = null;
        World.SetSpeed(player, 1f);
    }

    public override PlayerCommandOutcome OnPlayerCommand(IGamePlayer player, string command, JsonObject? args)
    {
        if (!player.IsAlive)
        {
            return new PlayerCommandOutcome.NotAlive();
        }

        var kind = args?["kind"]?.GetValue<string>() ?? "haste";
        switch (kind)
        {
            case "haste":
                World.SetSpeed(player, 1.4f);
                break;
            case "armor":
                World.SetArmor(player, 100);
                break;
            default:
                World.SetHealth(player, 100);
                break;
        }

        _lives![player].Powerup = kind;
        Say(player, "powerup.landed", Lines(player)[$"powerup.kind.{kind}"]);
        EmitPluginEvent("powerup_claimed", new { steamId64 = player.SteamId64.ToString(), kind });
        return PlayerCommandOutcome.Ok;
    }

    public override void OnPlayerDied(PlayerDeath death) => After(2_000, () => World.Respawn(death.Victim));

    public override void OnEnd(string? reason) => SayAll("powerup.bye");
}
