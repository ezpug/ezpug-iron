using System.Text.Json.Nodes;
using EZPug.Sdk;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.PowerupDm.Tests;

/// <summary>
/// <b><c>powerup-dm</c> played on the SDK's harness</b> (PRD-02 T26), from the shipped
/// <c>gamemodes/powerup-dm/manifest.json</c> and without CS2: a full round with scripted
/// players — they join, spawn, claim, die, respawn and claim again — with every power-up
/// taken, both languages read back, the SDK's refusals in place, and the radar peek's ten
/// frames counted off the clock.
/// </summary>
public class PowerupDmTests
{
    private const ulong Tk = 76561198279375306;
    private const ulong Maex = 76561198279375307;
    private const ulong Bot = 1;

    private static AssignedGamemode Manifest() =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", "powerup-dm", "manifest.json")));

    private static JsonObject Kind(string kind) => new() { ["kind"] = kind };

    private static GamemodeTestHost Playing(out FakeGameWorld world, out FakePlatformLink link)
    {
        var host = new GamemodeTestHost(new PowerupDm());
        host.Start(GamemodeTestHost.AssignmentFor(
            Manifest(),
            teamA: [GamemodeTestHost.Player(Tk, "tk", Locale.De), GamemodeTestHost.Player(Maex, "maex", Locale.En)]));
        world = host.World;
        link = host.Link;
        return host;
    }

    [Fact]
    public void ARoundOfPowerupDm()
    {
        using var host = Playing(out var world, out var link);

        // The manifest is the mode's, and the assignment named this plugin.
        Assert.Equal("powerup-dm", host.Runtime.Assignment!.Gamemode.Id);
        Assert.Equal(["EZPug.PowerupDm"], host.Runtime.Assignment.Plugins);

        // Two humans and a bot arrive; each human is welcomed in their own language.
        var tk = world.Connect(Tk, "tk", PlayerTeam.Terrorist);
        var maex = world.Connect(Maex, "maex", PlayerTeam.CounterTerrorist);
        var bot = world.Connect(Bot, "Bot Cliff", PlayerTeam.Terrorist, bot: true);
        Assert.Contains(Branding.Prefixed("Ein Power-up pro Leben: tipp auf dem Handy oder schreib !powerup speed, !powerup armor, !powerup radar_peek."), world.Said[Tk]);
        Assert.Contains(Branding.Prefixed("One power-up per life: tap on your phone, or type !powerup speed, !powerup armor, !powerup radar_peek."), world.Said[Maex]);

        // Alive is the price of a power-up; a corpse pays nothing for asking.
        var early = link.PlayerCommand(Tk, PowerupDm.Verb, Kind(PowerupDm.SpeedKind));
        Assert.Equal((LinkCommandStatus.Rejected, PlayerCommandRefusal.NotAlive, 1L), (early.Status, early.Code, early.ChargesLeft));

        // `speed`, from the phone, in German.
        world.Spawn(tk);
        world.Spawn(maex);
        world.Spawn(bot);
        var speed = link.PlayerCommand(Tk, PowerupDm.Verb, Kind(PowerupDm.SpeedKind));
        Assert.Equal((LinkCommandStatus.Applied, 0L), (speed.Status, speed.ChargesLeft));
        Assert.Contains(new WorldAction("speed", Tk, "1.35"), world.Actions);
        Assert.Contains(Branding.Prefixed("Power-up aktiv: Tempo."), world.Said[Tk]);
        Assert.Contains("TEMPO", world.Centered[Tk]);
        var claimed = Assert.Single(link.EventsOf<PluginEvent>());
        Assert.Equal((PowerupDm.ClaimedEvent, Tk.ToString(), PowerupDm.SpeedKind),
            (claimed.Name, claimed.Data["steamId64"]!.GetValue<string>(), claimed.Data["kind"]!.GetValue<string>()));

        // One per life: the second tap this life is `no_charges`, said in German.
        var again = link.PlayerCommand(Tk, PowerupDm.Verb, Kind(PowerupDm.ArmorKind));
        Assert.Equal((PlayerCommandRefusal.NoCharges, "Keine Ladung mehr in diesem Leben.", 0L), (again.Code, again.Message, again.ChargesLeft));

        // A kind the manifest does not declare never reaches the mode.
        Assert.Equal(PlayerCommandRefusal.InvalidArgs, link.PlayerCommand(Maex, PowerupDm.Verb, Kind("invisibility")).Code);

        // `armor`, from chat, in English — `!powerup armor` is the phone's `{ "kind": "armor" }`.
        world.SayAs(maex, "!powerup armor");
        Assert.Contains(Branding.Prefixed("Power-up on: armor."), world.Said[Maex]);
        Assert.Contains(new WorldAction("armor", Maex, "100"), world.Actions);

        // A death drops the speed and refills the charge on the next spawn.
        world.Kill(tk, maex, weapon: "weapon_ak47", headshot: true);
        Assert.False(tk.IsAlive);
        world.Spawn(tk);
        Assert.Equal(1f, tk.Speed);
        Assert.Equal(LinkCommandStatus.Applied, link.PlayerCommand(Tk, PowerupDm.Verb, Kind(PowerupDm.ArmorKind)).Status);

        // Release: goodbye in each language, nothing left ticking.
        link.Release("ended: completed");
        Assert.Contains(Branding.Prefixed("Danke fürs Spielen!"), world.Said[Tk]);
        Assert.Contains(Branding.Prefixed("Thanks for playing!"), world.Said[Maex]);
        Assert.Equal(0, host.Clock.Pending);
    }

    /// <summary>
    /// The peek: one frame at once and one every <see cref="PowerupDm.PeekIntervalMs"/>
    /// after it, for five seconds and not a frame longer, each carrying every other living
    /// player's position and nothing that names them — and none of it as an event, because
    /// a position is never written down (CLAUDE.md).
    /// </summary>
    [Fact]
    public void TheRadarPeekIsFiveSecondsOfDotsAndNothingElse()
    {
        using var host = Playing(out var world, out var link);
        var tk = world.Connect(Tk, "tk", PlayerTeam.Terrorist);
        var maex = world.Connect(Maex, "maex", PlayerTeam.CounterTerrorist);
        var bot = world.Connect(Bot, "Bot Cliff", PlayerTeam.Terrorist, bot: true);
        world.Spawn(tk);
        world.Spawn(maex);
        world.Spawn(bot);
        tk.Position = new System.Numerics.Vector3(-1024.4f, 512.6f, -167.97f);
        maex.Position = new System.Numerics.Vector3(220.25f, 1880f, -167.97f);
        bot.Position = new System.Numerics.Vector3(90f, -400f, 64f);

        Assert.Equal(LinkCommandStatus.Applied, link.PlayerCommand(Tk, PowerupDm.Verb, Kind(PowerupDm.RadarPeekKind)).Status);
        var first = Assert.Single(link.Pushes);
        Assert.Equal((host.Runtime.Match.MatchId, Tk.ToString(), PowerupDm.PeekPush), (first.MatchId, first.SteamId64, first.Push.Name));
        Assert.Equal(PowerupDm.PeekDurationMs, first.Push.Data["expiresInMs"]!.GetValue<long>());
        Assert.Equal("de_mirage", first.Push.Data["map"]!.GetValue<string>());
        Assert.Equal((-1024L, 513L, -168L), (
            first.Push.Data["self"]!["x"]!.GetValue<long>(),
            first.Push.Data["self"]!["y"]!.GetValue<long>(),
            first.Push.Data["self"]!["z"]!.GetValue<long>()));

        // Everybody else who is alive, as dots: no name, no SteamID64, no team.
        var contacts = first.Push.Data["contacts"]!.AsArray();
        Assert.Equal(2, contacts.Count);
        Assert.Equal(["x", "y", "z"], contacts[0]!.AsObject().Select(pair => pair.Key));
        Assert.Contains("Radarblick: noch 5 s", world.Actions.Where(action => action.Verb == "hud").Select(action => action.Detail));

        // Ten frames in five seconds, the last one at the second the peek runs out.
        world.Elapse(PowerupDm.PeekIntervalMs);
        Assert.Equal(2, link.Pushes.Count);
        Assert.Equal(PowerupDm.PeekDurationMs - PowerupDm.PeekIntervalMs, link.Pushes[^1].Push.Data["expiresInMs"]!.GetValue<long>());
        for (var frame = 2; frame < PowerupDm.PeekDurationMs / PowerupDm.PeekIntervalMs; frame++)
        {
            world.Elapse(PowerupDm.PeekIntervalMs);
        }

        Assert.Equal(PowerupDm.PeekDurationMs / PowerupDm.PeekIntervalMs, link.Pushes.Count);
        world.Elapse(PowerupDm.PeekIntervalMs);
        world.Elapse(PowerupDm.PeekIntervalMs);
        Assert.Equal(PowerupDm.PeekDurationMs / PowerupDm.PeekIntervalMs, link.Pushes.Count);

        // The claim is a durable event; the peek's ten frames are not events at all —
        // they never entered the log, which is the whole point of a push.
        Assert.Equal(PowerupDm.RadarPeekKind, Assert.Single(link.EventsOf<PluginEvent>()).Data["kind"]!.GetValue<string>());
        Assert.DoesNotContain(PowerupDm.PeekPush, link.EventsOf<PluginEvent>().Select(plugin => plugin.Name));
    }

    /// <summary>A peek stops the moment its owner dies, however much of the five seconds was left.</summary>
    [Fact]
    public void ADeathEndsThePeek()
    {
        using var host = Playing(out var world, out var link);
        var tk = world.Connect(Tk, "tk", PlayerTeam.Terrorist);
        var maex = world.Connect(Maex, "maex", PlayerTeam.CounterTerrorist);
        world.Spawn(tk);
        world.Spawn(maex);
        link.PlayerCommand(Tk, PowerupDm.Verb, Kind(PowerupDm.RadarPeekKind));
        world.Elapse(PowerupDm.PeekIntervalMs);
        Assert.Equal(2, link.Pushes.Count);

        world.Kill(tk, maex);
        world.Elapse(PowerupDm.PeekIntervalMs * 4);
        Assert.Equal(2, link.Pushes.Count);

        // And the timer behind it is gone, not merely quiet: the release below cancels
        // the runtime's own (the position ticks, the go-live poll) and nothing is left.
        link.Release("ended: completed");
        Assert.Equal(0, host.Clock.Pending);
    }

    /// <summary>Both catalogs answer every key the mode asks for, in both languages.</summary>
    [Fact]
    public void EveryLineIsSaidInBothLanguages()
    {
        var localizer = Localizer.FromEmbedded(typeof(PowerupDm).Assembly, "EZPug.PowerupDm.Lines");
        string[] keys =
        [
            "powerup.welcome",
            "powerup.start",
            "powerup.landed",
            "powerup.bye",
            "powerup.peek.hud",
            $"powerup.kind.{PowerupDm.SpeedKind}",
            $"powerup.kind.{PowerupDm.ArmorKind}",
            $"powerup.kind.{PowerupDm.RadarPeekKind}",
            $"powerup.center.{PowerupDm.SpeedKind}",
            $"powerup.center.{PowerupDm.ArmorKind}",
            $"powerup.center.{PowerupDm.RadarPeekKind}",
        ];
        foreach (var key in keys)
        {
            Assert.True(localizer.Has(Locale.De, key), $"the German catalog is missing {key}");
            Assert.True(localizer.Has(Locale.En, key), $"the English catalog is missing {key}");
        }
    }

    /// <summary>The manifest and the class agree on the three kinds — the enum is the manifest's decision, and this is the check that it stayed one.</summary>
    [Fact]
    public void TheManifestDeclaresExactlyTheKindsTheModeImplements()
    {
        var spec = Assert.Single(Manifest().Commands);
        Assert.Equal(PowerupDm.Verb, spec.Name);
        Assert.Equal(1, spec.Charges!.Count);
        Assert.Equal(PlayerCommandChargePeriod.Life, spec.Charges.Per);
        var kinds = spec.Args!["properties"]!["kind"]!["enum"]!.AsArray().Select(node => node!.GetValue<string>());
        Assert.Equal([PowerupDm.SpeedKind, PowerupDm.ArmorKind, PowerupDm.RadarPeekKind], kinds);
    }
}
