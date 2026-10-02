using EZPug.Sdk;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Core.Tests;

/// <summary>The operator's doors: the status line, the hello, the restore by file name.</summary>
public class ConsoleCommandTests
{
    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    [Fact]
    public void TheStatusLineSaysEverythingButASecret()
    {
        using var image = new FakeImage().With("EZPug.Core", disabled: false).With("MatchZy");
        var world = new FakeGameWorld(map: "de_dust2");
        var link = new FakePlatformLink(provider: "nodes", serverId: "devbox-1");
        using var runtime = new GamemodeRuntime(world, link);
        var loader = new GamemodeLoader(world, image.Catalog(), image.CsgoDirectory, "de_dust2");
        loader.Bind(runtime);
        link.Welcome();

        var unlinked = StatusReport.Render(new StatusReport.Input(runtime, link, null, null, image.Catalog(), loader));
        Assert.Contains("link: unlinked (set EZPUG_IRON_URL + EZPUG_SERVER_TOKEN, or write ezpug.json)", unlinked);
        Assert.Contains("state: booting, map de_dust2, 0 player(s)", unlinked);
        Assert.Contains("match: none", unlinked);
        Assert.Contains("mode: none attached", unlinked);
        Assert.Contains("scoreboard: no match", unlinked);
        Assert.Contains("plugins enabled: none", unlinked);
        Assert.Contains("plugins installed: EZPug.Core, MatchZy", unlinked);

        link.Assign(GamemodeTestHost.AssignmentFor(
            Manifest("pug"),
            map: "de_mirage",
            teamA: [GamemodeTestHost.Player(76561198279375306, "tk", rating: 1820)]));
        world.StartMap();
        world.Connect(76561198279375306, "tk", PlayerTeam.Terrorist);
        var linked = StatusReport.Render(new StatusReport.Input(
            runtime, link, new Uri("wss://gs.ezpug.com/link?token=never-here"), (LastSeq: 41, Pending: 2), image.Catalog(), loader));
        Assert.Contains("link: connected to gs.ezpug.com as nodes/devbox-1", linked);
        Assert.Contains("buffer: lastSeq 41, 2 unacked", linked);
        Assert.Contains("state: assigned, map de_mirage, 1 player(s)", linked);
        Assert.Contains("match: 6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b (pug, flow matchzy), map 1 round 0", linked);
        // The one line an operator reads to know EZ Rating reached the scoreboard: read
        // back off the players, not off what the assignment asked for (PRD-02 T27).
        Assert.Contains("scoreboard: 1 rated: tk 1820", linked);
        Assert.Contains("plugins enabled: MatchZy", linked);
        Assert.DoesNotContain("never-here", linked);
        Assert.DoesNotContain("token", linked, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TheHelloReportsVersionsCapabilitiesAndTheImage()
    {
        using var image = new FakeImage().With("EZPug.Core", disabled: false).With("MatchZy").With("RetakesPlugin");
        var hello = HelloFactsBuilder.Build(image.Catalog(), "  EZPug · pug · Mirage ");
        Assert.Equal("0.1.0", hello.Versions.Plugin);
        Assert.Equal(SdkInfo.Version, hello.Versions.Sdk);
        Assert.Equal(SdkInfo.CounterStrikeSharpApiVersion, hello.Versions.CounterStrikeSharp);
        Assert.Equal(SdkInfo.Version, hello.Versions.Matchzy);
        Assert.Null(hello.Versions.Metamod);
        Assert.Equal([HelloCapability.Positions, HelloCapability.Chat, HelloCapability.PlayerCommands, HelloCapability.Widget, HelloCapability.Backups, HelloCapability.ScoreboardRating], hello.Capabilities);
        Assert.Equal(["EZPug.Core", "MatchZy", "RetakesPlugin"], hello.Plugins);
        Assert.Equal("EZPug · pug · Mirage", hello.Hostname);
        Assert.Equal("ezpug", HelloFactsBuilder.Build(image.Catalog(), " ").Hostname);
        Assert.Null(HelloFactsBuilder.Build(new FakeImage().Catalog(), "x").Versions.Matchzy);
    }

    [Fact]
    public void TheHelloNamesTheHudOnlyOnAServerThatCanDrawOne()
    {
        // The list above is what a server without the addon says, to the byte: off means
        // untouched (PRD-07 T3). With the addon's id and MultiAddonManager, one more word.
        using var image = new FakeImage().With("EZPug.Core", disabled: false);
        var without = HelloFactsBuilder.Build(image.Catalog(), "x", hud: false);
        Assert.Equal(HelloFactsBuilder.Capabilities, without.Capabilities);
        Assert.DoesNotContain(HelloCapability.Hud, without.Capabilities);

        var with = HelloFactsBuilder.Build(image.Catalog(), "x", hud: true);
        Assert.Equal([.. HelloFactsBuilder.Capabilities, HelloCapability.Hud], with.Capabilities);
    }

    [Fact]
    public void TheStatusLineSaysWhereTheHudStandsOnAServerThatHasOne()
    {
        using var image = new FakeImage().With("EZPug.Core", disabled: false);
        var world = new FakeGameWorld(map: "de_dust2");
        var link = new FakePlatformLink();
        using var runtime = new GamemodeRuntime(world, link, hudAddon: "3811574606");
        var loader = new GamemodeLoader(world, image.Catalog(), image.CsgoDirectory, "de_dust2");
        loader.Bind(runtime);
        link.Welcome();
        string Status() => StatusReport.Render(new StatusReport.Input(runtime, link, null, null, image.Catalog(), loader));

        Assert.Contains("hud: addon 3811574606, off for this match", Status());

        link.Assign(GamemodeTestHost.AssignmentFor(Manifest("flying-scoutsman"), hud: true));
        world.StartMap();
        Assert.Contains("hud: addon 3811574606, on, 2 layout(s) waiting for a round start", Status());
        world.StartRound();
        Assert.Contains("hud: addon 3811574606, on, 2 layout(s) in the world", Status());

        // What clients are handed is MultiAddonManager's own list, read back: a server
        // whose plugin does not answer says so, rather than what it once asked for.
        Assert.Contains($"hud: {Hud.ClientAddons} does not answer", Status());
        world.SetCvar(Hud.ClientAddons, "3811574606");
        Assert.Contains("hud: clients who connect now are handed 3811574606", Status());
        world.SetCvar(Hud.ClientAddons, "");
        Assert.Contains("hud: clients who connect now are handed no addon", Status());
        // The entities are the host's to read; a report given none says there are none.
        Assert.Contains("hud: no layout of ours is in the world", Status());

        // And a server without the addon says nothing at all about one.
        using var plain = new GamemodeRuntime(world, new FakePlatformLink());
        Assert.DoesNotContain("hud", StatusReport.Render(new StatusReport.Input(plain, link, null, null, image.Catalog(), loader)));
    }

    [Fact]
    public void TheStatusReportSaysWhatTheLayoutsInTheWorldHold()
    {
        // The entity's own tables and states, as `CounterStrikeWorld.ReadHudLayouts`
        // hands them over: names by index, everybody's state, one state per slot.
        var nobody = Enumerable.Range(0, 4).Select(slot => new HudStateReading(slot, false, [], [])).ToList();
        var moment = new HudLayoutReading(
            412,
            Moments.Layout,
            Observable: true,
            Panels: ["moment_toast_1", "moment_toast_1_text", "moment_card"],
            Classes: ["tier-common", "tier-rare", "shown"],
            Variables: ["text"],
            Everybody: new HudStateReading(-1, false, [new(0, 0, HudClassStatus.DoesNotHave), new(0, 1, HudClassStatus.Has)], []),
            Slots:
            [
                nobody[0],
                new HudStateReading(1, false, [new(0, 2, HudClassStatus.Has), new(2, 2, HudClassStatus.Undefined)], [new(1, 0, "Ada wins: BIG jersey!", true), new(2, 0, "", false)]),
                nobody[2],
                nobody[3],
            ]);
        var welcome = new HudLayoutReading(413, Welcome.Layout, false, [], [], [], new HudStateReading(-1, false, [], []), nobody);

        Assert.Equal(
            [
                $"hud: layout {Moments.Layout} is entity 412, observable, 4 slot(s); panels [moment_toast_1, moment_toast_1_text, moment_card], classes [tier-common, tier-rare, shown], strings [text]",
                "hud:   everybody, moment_toast_1: -tier-common +tier-rare",
                "hud:   slot 1, moment_toast_1: +shown",
                "hud:   slot 1, moment_toast_1_text: {s:text}=\"Ada wins: BIG jersey!\"",
                "hud:   slot 1, moment_card: ?shown {s:text} unset",
                "hud:   3 of 4 slot(s) hold nothing",
                $"hud: layout {Welcome.Layout} is entity 413, 4 slot(s); panels [], classes [], strings []",
                "hud:   4 of 4 slot(s) hold nothing",
            ],
            HudReadback.Render([moment, welcome]));

        // An index past the entity's own table is named by its number, and a state that
        // took the mouse is shouted: nothing of ours ever asks for that.
        var odd = moment with { Everybody = new HudStateReading(-1, true, [new(7, 9, HudClassStatus.Has)], []), Slots = [] };
        Assert.Equal(
            [
                $"hud: layout {Moments.Layout} is entity 412, observable, 0 slot(s); panels [moment_toast_1, moment_toast_1_text, moment_card], classes [tier-common, tier-rare, shown], strings [text]",
                "hud:   everybody TAKES THE MOUSE, which nothing of ours ever asks for",
                "hud:   everybody, #7: +#9",
                "hud:   0 of 0 slot(s) hold nothing",
            ],
            HudReadback.Render([odd]));
    }

    [Fact]
    public void RestoreLoadsABackupByNameAndRefusesPathsAndAbsentFiles()
    {
        using var image = new FakeImage();
        Directory.CreateDirectory(image.CsgoDirectory);
        File.WriteAllText(Path.Combine(image.CsgoDirectory, "backup_round07.txt"), "round 7");
        var world = new FakeGameWorld();

        Assert.False(BackupRestorer.Restore(world, image.CsgoDirectory, "../secrets.txt", "7").Applied);
        Assert.False(BackupRestorer.Restore(world, image.CsgoDirectory, "cfg/server.cfg", "7").Applied);
        Assert.False(BackupRestorer.Restore(world, image.CsgoDirectory, "backup_round07.txt", "seven").Applied);
        var missing = BackupRestorer.Restore(world, image.CsgoDirectory, "backup_round08.txt", "8");
        Assert.False(missing.Applied);
        Assert.StartsWith("no backup named backup_round08.txt", missing.Message);
        Assert.Empty(world.Actions);

        var applied = BackupRestorer.Restore(world, image.CsgoDirectory, "backup_round07.txt", "7");
        Assert.True(applied.Applied);
        Assert.Equal("restoring round 7 from backup_round07.txt", applied.Message);
        Assert.Equal(["command mp_backup_restore_load_file backup_round07.txt"], world.Actions.Select(action => action.ToString()));
    }

    [Fact]
    public void TheUnlinkedLinkDropsEventsAndSaysSoOnce()
    {
        var log = new GamemodeLoaderTests.RecordingLog();
        var link = new UnlinkedPlatformLink(log);
        Assert.False(link.Connected);
        Assert.Null(link.Source);
        link.Emit(new ServerReadyEvent { MatchId = "m", Source = new GameserverSource { Provider = "x", ServerId = "y" } });
        link.Emit(new ServerReadyEvent { MatchId = "m", Source = new GameserverSource { Provider = "x", ServerId = "y" } });
        Assert.Equal(["warn: unlinked: no EZPUG_IRON_URL/EZPUG_SERVER_TOKEN and no ezpug.json; events are dropped"], log.Lines);
    }
}
