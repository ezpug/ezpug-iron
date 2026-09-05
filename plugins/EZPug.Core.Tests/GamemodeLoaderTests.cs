using System.Text.Json.Nodes;
using EZPug.Sdk;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Core.Tests;

/// <summary>
/// The loader on the harness: every console line it issues for an assignment, in order,
/// against the shipped manifests; the map hook before <c>server_ready</c>; the release.
/// </summary>
public class GamemodeLoaderTests
{
    private sealed class Rig : IDisposable
    {
        public Rig(params string[] installed)
        {
            Image = new FakeImage().With("EZPug.Core", disabled: false);
            foreach (var name in installed)
            {
                Image.With(name);
            }

            World = new FakeGameWorld(map: "de_dust2");
            Link = new FakePlatformLink();
            Runtime = new GamemodeRuntime(World, Link, Log);
            Loader = new GamemodeLoader(World, Image.Catalog(), Image.CsgoDirectory, lobbyMap: "de_dust2", Log);
            Loader.Bind(Runtime);
            Link.Welcome();
        }

        public FakeImage Image { get; }
        public FakeGameWorld World { get; }
        public FakePlatformLink Link { get; }
        public GamemodeRuntime Runtime { get; }
        public GamemodeLoader Loader { get; }
        public RecordingLog Log { get; } = new();

        public string MatchConfigPath => Path.Combine(Image.CsgoDirectory, GamemodeLoader.MatchConfigFile);

        public IReadOnlyList<string> Actions => World.Actions.Select(action => action.ToString()).ToList();

        public void Dispose()
        {
            Runtime.Dispose();
            Image.Dispose();
        }
    }

    public sealed class RecordingLog : ILinkLog
    {
        public List<string> Lines { get; } = [];

        public void Info(string message) => Lines.Add("info: " + message);

        public void Warn(string message) => Lines.Add("warn: " + message);
    }

    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    [Fact]
    public void APugAssignmentLoadsMatchZyChangesTheMapThenConfiguresItWhenTheMapIsUp()
    {
        using var rig = new Rig("MatchZy", "RetakesPlugin");
        var config = JsonNode.Parse("""{"matchid":"6f1a2b3c","num_maps":1,"maplist":["de_mirage"]}""")!.AsObject();
        var assignment = GamemodeTestHost.AssignmentFor(Manifest("pug"), map: "de_mirage") with { MatchzyConfig = config };

        rig.Link.Assign(assignment);
        Assert.Equal(
            [
                "cvar hostname EZPug · pug · Mirage",
                "command css_plugins load plugins/disabled/MatchZy/MatchZy.dll",
                "changelevel de_mirage",
            ],
            rig.Actions);
        Assert.Equal(["MatchZy"], rig.Loader.Enabled);
        Assert.Equal([LinkServerState.Assigned], rig.Link.States.Select(state => state.State));
        Assert.Empty(rig.Link.Events);
        Assert.False(File.Exists(rig.MatchConfigPath));

        // The map hook runs before server_ready: at that moment nothing has been emitted and the cfg is already exec'd.
        var seenAtMapLoaded = new List<string>();
        rig.Runtime.MapLoaded += (_, _) =>
        {
            seenAtMapLoaded.Add($"events={rig.Link.Events.Count}");
            seenAtMapLoaded.AddRange(rig.Actions.Skip(3));
        };
        rig.World.StartMap();

        Assert.Equal(
            [
                "exec ezpug/pug.cfg",
                "cvar matchzy_kick_when_no_match_loaded false",
                "cvar matchzy_demo_recording_enabled true",
                "cvar matchzy_enable_tech_pause true",
                "cvar matchzy_stop_command_available true",
                "cvar matchzy_reset_cvars_on_series_end true",
                "command matchzy_loadmatch cfg/ezpug/match.json",
            ],
            rig.Actions.Skip(3));
        Assert.Equal("events=0", seenAtMapLoaded[0]);
        Assert.Equal(7, seenAtMapLoaded.Count - 1);
        Assert.Equal(["server_ready"], rig.Link.EventTypes);
        Assert.Equal(config.ToJsonString(ProtocolJson.Options), File.ReadAllText(rig.MatchConfigPath));

        // Release: unload in reverse, the config gone, back to the lobby, idle.
        rig.Link.Release("ended: completed");
        Assert.Equal(
            [
                "command css_plugins unload plugins/disabled/MatchZy/MatchZy.dll",
                "changelevel de_dust2",
            ],
            rig.Actions.Skip(10));
        Assert.False(File.Exists(rig.MatchConfigPath));
        Assert.Empty(rig.Loader.Enabled);
        Assert.Equal(LinkServerState.Idle, rig.Link.States[^1].State);
        Assert.DoesNotContain(rig.Log.Lines, line => line.StartsWith("warn"));
    }

    [Fact]
    public void SeveralPluginsUnloadInReverseAndAMissingOneIsSkippedWithAWarning()
    {
        using var rig = new Rig("MatchZy", "WeaponPaints");
        var assignment = GamemodeTestHost.AssignmentFor(Manifest("pug")) with { Plugins = ["MatchZy", "WeaponPaints", "Ghost", "MatchZy"] };
        rig.Link.Assign(assignment);
        Assert.Equal(["MatchZy", "WeaponPaints"], rig.Loader.Enabled);
        Assert.Contains("warn: the assignment names plugin Ghost, which is not installed; skipped", rig.Log.Lines);
        rig.World.StartMap();
        rig.Link.Release();
        Assert.Equal(
            [
                "command css_plugins unload plugins/disabled/WeaponPaints/WeaponPaints.dll",
                "command css_plugins unload plugins/disabled/MatchZy/MatchZy.dll",
                "changelevel de_dust2",
            ],
            rig.Actions.TakeLast(3));
    }

    [Fact]
    public void AConfigModeLoadsNothingAndExecsItsCfgOnTheMap()
    {
        using var rig = new Rig();
        rig.Link.Assign(GamemodeTestHost.AssignmentFor(Manifest("flying-scoutsman"), map: "de_inferno"));
        Assert.Equal(["cvar hostname EZPug · flying-scoutsman · Inferno", "changelevel de_inferno"], rig.Actions);
        rig.World.StartMap();
        Assert.Equal(["exec ezpug/flying-scoutsman.cfg"], rig.Actions.Skip(2));
        Assert.False(File.Exists(rig.MatchConfigPath));
        Assert.DoesNotContain(rig.Log.Lines, line => line.StartsWith("warn"));
    }

    [Fact]
    public void AWorkshopMapIsHostedByIdAndTheHostnameKeepsTheId()
    {
        using var rig = new Rig();
        rig.Link.Assign(GamemodeTestHost.AssignmentFor(Manifest("flying-scoutsman"), map: "3070923343"));
        Assert.Equal(["cvar hostname EZPug · flying-scoutsman · 3070923343", "host_workshop_map 3070923343"], rig.Actions);
    }

    [Fact]
    public void TheRequestsHostnameWins()
    {
        using var rig = new Rig();
        var assignment = GamemodeTestHost.AssignmentFor(Manifest("flying-scoutsman")) with { Branding = new MatchBranding { Hostname = "SaarLAN 2026 · Scoutsman" } };
        rig.Link.Assign(assignment);
        Assert.Equal("cvar hostname SaarLAN 2026 · Scoutsman", rig.Actions[0]);
    }

    [Fact]
    public void AMatchzyFlowWithoutAConfigAndABackupToRestoreAreSaidPlainly()
    {
        using var rig = new Rig("MatchZy");
        var assignment = GamemodeTestHost.AssignmentFor(Manifest("pug")) with
        {
            Restore = new RoundBackup { MapNumber = 1, RoundNumber = 7, Filename = "backup_round07.txt", Content = "x" },
        };
        rig.Link.Assign(assignment);
        rig.World.StartMap();
        Assert.Contains("warn: the assignment carries a backup for round 7; restoring on assign is PRD-02 T14 and is not done here", rig.Log.Lines);
        Assert.Contains(rig.Log.Lines, line => line.StartsWith("warn: a matchzy flow with no matchzyConfig"));
        Assert.DoesNotContain(rig.Actions, action => action.Contains("matchzy_loadmatch"));
        Assert.False(File.Exists(rig.MatchConfigPath));
    }

    [Theory]
    [InlineData("de_mirage", "Mirage")]
    [InlineData("cs_office", "Office")]
    [InlineData("ar_shoots", "Shoots")]
    [InlineData("3070923343", "3070923343")]
    [InlineData("de_", "de_")]
    public void MapsArePrettiedForTheHostname(string map, string pretty) => Assert.Equal(pretty, GamemodeLoader.PrettyMap(map));
}
