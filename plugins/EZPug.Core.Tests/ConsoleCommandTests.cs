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
        Assert.Contains("plugins enabled: none", unlinked);
        Assert.Contains("plugins installed: EZPug.Core, MatchZy", unlinked);

        link.Assign(GamemodeTestHost.AssignmentFor(Manifest("pug"), map: "de_mirage"));
        world.StartMap();
        world.Connect(76561198279375306, "tk", PlayerTeam.Terrorist);
        var linked = StatusReport.Render(new StatusReport.Input(
            runtime, link, new Uri("wss://gs.ezpug.com/link?token=never-here"), (LastSeq: 41, Pending: 2), image.Catalog(), loader));
        Assert.Contains("link: connected to gs.ezpug.com as nodes/devbox-1", linked);
        Assert.Contains("buffer: lastSeq 41, 2 unacked", linked);
        Assert.Contains("state: assigned, map de_mirage, 1 player(s)", linked);
        Assert.Contains("match: 6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b (pug, flow matchzy), map 1 round 0", linked);
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
        Assert.Equal([GamemodeCapability.Positions, GamemodeCapability.Chat, GamemodeCapability.PlayerCommands, GamemodeCapability.Widget], hello.Capabilities);
        Assert.Equal(["EZPug.Core", "MatchZy", "RetakesPlugin"], hello.Plugins);
        Assert.Equal("EZPug · pug · Mirage", hello.Hostname);
        Assert.Equal("ezpug", HelloFactsBuilder.Build(image.Catalog(), " ").Hostname);
        Assert.Null(HelloFactsBuilder.Build(new FakeImage().Catalog(), "x").Versions.Matchzy);
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
