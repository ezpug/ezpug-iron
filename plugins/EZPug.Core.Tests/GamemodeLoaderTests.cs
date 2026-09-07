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
    internal sealed class Rig : IDisposable
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
            Loader = new GamemodeLoader(World, Image.Catalog(), Image.CsgoDirectory, lobbyMap: "de_dust2", Log, RemoteLog);
            Loader.Bind(Runtime);
            Link.Welcome();
        }

        public FakeImage Image { get; }
        public FakeGameWorld World { get; }
        public FakePlatformLink Link { get; }
        public GamemodeRuntime Runtime { get; }
        public GamemodeLoader Loader { get; }
        public RecordingLog Log { get; } = new();

        /// <summary>What the core builds from the sidecar: the door's URL and this server's token.</summary>
        public static MatchZyRemoteLog RemoteLog { get; } =
            MatchZyRemoteLog.From(new Sidecar(Sidecar.LinkUrlOf("http://127.0.0.1:3430"), "ezs_not-a-secret_0000000000000000000", null));

        public string MatchConfigPath => Path.Combine(Image.CsgoDirectory, GamemodeLoader.MatchConfigFile);

        /// <summary>
        /// The map comes up <b>and the loader's second console frame lands</b>: the cfg is
        /// exec'd on the map hook, everything the assignment asks for
        /// <see cref="GamemodeLoader.CvarSettleMs"/> later, and <c>server_ready</c> after
        /// that (T22a). A test that wants to stand between the two calls
        /// <c>World.StartMap</c> itself.
        /// </summary>
        public void StartMap(string? map = null)
        {
            World.StartMap(map);
            World.Elapse(GamemodeLoader.CvarSettleMs);
        }

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
        var config = JsonNode.Parse("""{"matchid":"6f1a2b3c","num_maps":1,"maplist":["de_mirage"],"cvars":{}}""")!.AsObject();
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

        // The map hook runs before server_ready: at that moment nothing has been emitted
        // and the mode's cfg — and only the mode's cfg — has been said to the console.
        var seenAtMapLoaded = new List<string>();
        rig.Runtime.MapLoaded += (_, _) =>
        {
            seenAtMapLoaded.Add($"events={rig.Link.Events.Count}");
            seenAtMapLoaded.AddRange(rig.Actions.Skip(3));
        };
        rig.World.StartMap();

        // **The first console frame is the cfg's alone** (T22a): the engine reconciles a
        // cvar's effects once at the end of a frame, so nothing that could undo what the
        // cfg just did shares one with it — and the server is not ready until the rest
        // has been said.
        Assert.Equal(["events=0", "exec ezpug/pug.cfg"], seenAtMapLoaded);
        Assert.Equal(["exec ezpug/pug.cfg"], rig.Actions.Skip(3));
        Assert.Empty(rig.Link.Events);
        Assert.False(File.Exists(rig.MatchConfigPath));

        // The second, a beat later: everything the assignment asks for, in the order the
        // pug lane proved, and then server_ready.
        rig.World.Elapse(GamemodeLoader.CvarSettleMs);
        Assert.Equal(
            [
                "cvar matchzy_kick_when_no_match_loaded false",
                "cvar matchzy_demo_recording_enabled true",
                // `1`, not `true`: MatchZy declares this one as a FakeConVar<bool> and the
                // engine's own parser refuses "true" (T13, seen on a real server).
                "cvar matchzy_enable_tech_pause 1",
                "cvar matchzy_stop_command_available true",
                "cvar matchzy_reset_cvars_on_series_end true",
                "command matchzy_loadmatch cfg/ezpug/match.json",
                // The remote log after loadmatch (loading replaces MatchZy's config object), the token last.
                // Quoted, because `//` is a console comment (MatchZyRemoteLog).
                "command matchzy_remote_log_url \"http://127.0.0.1:3430/matchzy/log\"",
                "command matchzy_remote_log_header_key \"x-ezpug-server-token\"",
                "command matchzy_remote_log_header_value \"ezs_not-a-secret_0000000000000000000\"",
            ],
            rig.Actions.Skip(4));
        Assert.Equal(["server_ready"], rig.Link.EventTypes);
        // The file is the orchestrator's config plus the hostname format MatchZy rewrites the hostname from; no token in it.
        var written = JsonNode.Parse(File.ReadAllText(rig.MatchConfigPath))!.AsObject();
        Assert.Equal("EZPug · pug · Mirage", written["cvars"]!["matchzy_hostname_format"]!.GetValue<string>());
        Assert.DoesNotContain("not-a-secret", File.ReadAllText(rig.MatchConfigPath));
        written["cvars"]!.AsObject().Remove("matchzy_hostname_format");
        Assert.Equal(config.ToJsonString(ProtocolJson.Options), written.ToJsonString(ProtocolJson.Options));

        // Release: unload in reverse, the config gone, back to the lobby, idle.
        rig.Link.Release("ended: completed");
        Assert.Equal(
            [
                "command css_plugins unload plugins/disabled/MatchZy/MatchZy.dll",
                "changelevel de_dust2",
            ],
            rig.Actions.Skip(13));
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
        rig.StartMap();
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
    public void AConfigModeLoadsNothingAndExecsItsCfgOnTheMapABeatBeforeTheRequestsCvars()
    {
        using var rig = new Rig();
        var assignment = GamemodeTestHost.AssignmentFor(Manifest("flying-scoutsman"), map: "de_inferno") with
        {
            // What the merge hands the server: the request's `bot_quota` under the mode's,
            // and `ezpug/flying-scoutsman.cfg` is the file that switches `bot_quota_mode`
            // out from under whoever is standing (T22a).
            Cvars = new Dictionary<string, string> { ["bot_quota"] = "10", ["mp_maxrounds"] = "4" },
        };
        rig.Link.Assign(assignment);
        Assert.Equal(["cvar hostname EZPug · flying-scoutsman · Inferno", "changelevel de_inferno"], rig.Actions);

        // The cfg's frame, alone: a `bot_quota` beside it would be reconciled against the
        // value the frame started with and change nothing at all.
        rig.World.StartMap();
        Assert.Equal(["exec ezpug/flying-scoutsman.cfg"], rig.Actions.Skip(2));
        Assert.Empty(rig.Link.Events);

        // A beat later the request's cvars land — and only then is the server ready.
        rig.World.Elapse(GamemodeLoader.CvarSettleMs);
        Assert.Equal(["cvar bot_quota 10", "cvar mp_maxrounds 4"], rig.Actions.Skip(3));
        Assert.Equal(["server_ready"], rig.Link.EventTypes);
        Assert.False(File.Exists(rig.MatchConfigPath));
        Assert.DoesNotContain(rig.Log.Lines, line => line.StartsWith("warn"));
    }

    [Fact]
    public void AReleaseInsideTheBeatDropsWhatWasStillToBeSaid()
    {
        using var rig = new Rig("MatchZy");
        var config = JsonNode.Parse("""{"matchid":"6f1a2b3c","num_maps":1,"maplist":["de_mirage"],"cvars":{}}""")!.AsObject();
        rig.Link.Assign(GamemodeTestHost.AssignmentFor(Manifest("pug"), map: "de_mirage") with { MatchzyConfig = config });
        rig.World.StartMap();

        // The match is over before the second frame came due: a server released inside the
        // beat says nothing more to the console for a match it no longer holds, and never
        // claims it was ready.
        rig.Link.Release("ended: completed");
        rig.World.Elapse(GamemodeLoader.CvarSettleMs * 4);
        Assert.DoesNotContain(rig.Actions, action => action.StartsWith("cvar matchzy_"));
        Assert.DoesNotContain(rig.Actions, action => action.Contains("matchzy_loadmatch"));
        Assert.Empty(rig.Link.EventTypes);
        Assert.Equal(LinkServerState.Idle, rig.Link.States[^1].State);
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
    public void AMatchzyFlowWithoutAConfigIsSaidPlainlyAndRestoresNothing()
    {
        using var rig = new Rig("MatchZy");
        var assignment = GamemodeTestHost.AssignmentFor(Manifest("pug")) with
        {
            Restore = new RoundBackup { MapNumber = 1, RoundNumber = 7, Filename = "matchzy_1_0_round06.json", Content = "{}" },
        };
        rig.Link.Assign(assignment);
        rig.StartMap();
        Assert.Contains(rig.Log.Lines, line => line.StartsWith("warn: a matchzy flow with no matchzyConfig"));
        Assert.DoesNotContain(rig.Actions, action => action.Contains("matchzy_loadmatch"));
        Assert.DoesNotContain(rig.Actions, action => action.Contains("matchzy_loadbackup"));
        Assert.False(File.Exists(rig.MatchConfigPath));
        Assert.False(Directory.Exists(Path.Combine(rig.Image.CsgoDirectory, MatchZyBackups.Folder)));
    }

    [Fact]
    public void ARestoreLoadsTheBackupsMapWritesTheFileWithTheRemoteLogInsideAndLoadsItAfterTheConfig()
    {
        using var rig = new Rig("MatchZy");
        var config = JsonNode.Parse("""{"matchid":"2065155295","num_maps":2,"maplist":["de_mirage","de_inferno"],"cvars":{}}""")!.AsObject();
        // What crossed the link: the dead server's file, its remote log scrubbed of the token.
        var crossed = new JsonObject
        {
            ["matchid"] = "2065155295",
            ["round"] = "06",
            ["map_name"] = "de_inferno",
            ["match_config"] = new JsonObject
            {
                ["RemoteLogURL"] = "http://127.0.0.1:3430/matchzy/log",
                ["RemoteLogHeaderKey"] = "x-ezpug-server-token",
                ["RemoteLogHeaderValue"] = "",
                ["changed_cvars"] = new JsonObject { ["matchzy_remote_log_header_value"] = "" },
            }.ToJsonString(),
            ["valve_backup"] = "backup text",
        }.ToJsonString();
        var assignment = GamemodeTestHost.AssignmentFor(Manifest("pug")) with
        {
            MatchzyConfig = config,
            Maps = [new MapPlan { Map = "de_mirage", Sides = MapPlanSides.Knife }, new MapPlan { Map = "de_inferno", Sides = MapPlanSides.Knife }],
            Restore = new RoundBackup { MapNumber = 2, RoundNumber = 7, Filename = "matchzy_2065155295_1_round06.json", Content = crossed },
        };

        rig.Link.Assign(assignment);
        // The backup's map, not the plan's first; the hostname names it too.
        Assert.Equal("cvar hostname EZPug · pug · Inferno", rig.Actions[0]);
        Assert.Equal("changelevel de_inferno", rig.Actions[^1]);
        Assert.Equal((2L, 6L), (rig.Runtime.Match.MapNumber, rig.Runtime.Match.RoundNumber));

        rig.StartMap("de_inferno");
        var afterCvars = rig.Actions.SkipWhile(action => !action.StartsWith("command matchzy_loadmatch")).ToList();
        Assert.Equal(
            [
                "command matchzy_loadmatch cfg/ezpug/match.json",
                "command matchzy_remote_log_url \"http://127.0.0.1:3430/matchzy/log\"",
                "command matchzy_remote_log_header_key \"x-ezpug-server-token\"",
                "command matchzy_remote_log_header_value \"ezs_not-a-secret_0000000000000000000\"",
                // The backup, after the config: loading it replaces MatchZy's config from the file.
                "command matchzy_loadbackup matchzy_2065155295_1_round06.json",
                "command matchzy_remote_log_url \"http://127.0.0.1:3430/matchzy/log\"",
                "command matchzy_remote_log_header_key \"x-ezpug-server-token\"",
                "command matchzy_remote_log_header_value \"ezs_not-a-secret_0000000000000000000\"",
            ],
            afterCvars);

        // The file is where MatchZy looks, with this server's remote log put back inside.
        var written = Path.Combine(rig.Image.CsgoDirectory, MatchZyBackups.Folder, "matchzy_2065155295_1_round06.json");
        Assert.True(File.Exists(written));
        var backup = JsonNode.Parse(File.ReadAllText(written))!.AsObject();
        Assert.Equal("backup text", backup["valve_backup"]!.GetValue<string>());
        var restoredConfig = JsonNode.Parse(backup["match_config"]!.GetValue<string>())!.AsObject();
        Assert.Equal("ezs_not-a-secret_0000000000000000000", restoredConfig["RemoteLogHeaderValue"]!.GetValue<string>());
        Assert.Equal("ezs_not-a-secret_0000000000000000000", restoredConfig["changed_cvars"]!["matchzy_remote_log_header_value"]!.GetValue<string>());
        // The match config file itself still carries no token.
        Assert.DoesNotContain("not-a-secret", File.ReadAllText(rig.MatchConfigPath));

        // Said on the link: the restore, before the map is announced ready. going_live stays MatchZy's.
        Assert.Equal(["plugin_event", "server_ready"], rig.Link.EventTypes);
        var restored = Assert.Single(rig.Link.EventsOf<PluginEvent>());
        Assert.Equal(GamemodeLoader.BackupRestoredEvent, restored.Name);
        Assert.Equal(2, restored.Data["mapNumber"]!.GetValue<long>());
        Assert.Equal(7, restored.Data["roundNumber"]!.GetValue<long>());
        Assert.Equal("matchzy_2065155295_1_round06.json", restored.Data["filename"]!.GetValue<string>());
        Assert.Contains(rig.Log.Lines, line => line.StartsWith("info: restoring map 2 round 7 from matchzy_2065155295_1_round06.json"));
    }

    [Fact]
    public void ARestoreWithAPathForAFileNameIsRefusedAndAConfigOnlyFlowSaysItCannotRestore()
    {
        using var rig = new Rig("MatchZy");
        var config = JsonNode.Parse("""{"matchid":"1","num_maps":1,"maplist":["de_mirage"],"cvars":{}}""")!.AsObject();
        var unsafeName = GamemodeTestHost.AssignmentFor(Manifest("pug")) with
        {
            MatchzyConfig = config,
            Restore = new RoundBackup { MapNumber = 1, RoundNumber = 3, Filename = "../cfg/server.json", Content = "{}" },
        };
        rig.Link.Assign(unsafeName);
        rig.StartMap();
        Assert.DoesNotContain(rig.Actions, action => action.Contains("matchzy_loadbackup"));
        Assert.Contains(rig.Log.Lines, line => line.StartsWith("warn: the backup for round 3 is named ../cfg/server.json"));
        Assert.False(File.Exists(Path.Combine(rig.Image.CsgoDirectory, "cfg", "server.json")));
        Assert.Equal(["server_ready"], rig.Link.EventTypes);

        using var scoutsman = new Rig();
        scoutsman.Link.Assign(GamemodeTestHost.AssignmentFor(Manifest("flying-scoutsman")) with
        {
            Restore = new RoundBackup { MapNumber = 1, RoundNumber = 3, Filename = "matchzy_1_0_round02.json", Content = "{}" },
        });
        Assert.Contains(scoutsman.Log.Lines, line => line.StartsWith("warn: the assignment carries a backup for round 3, but a"));
    }

    [Theory]
    [InlineData("de_mirage", "Mirage")]
    [InlineData("cs_office", "Office")]
    [InlineData("ar_shoots", "Shoots")]
    [InlineData("3070923343", "3070923343")]
    [InlineData("de_", "de_")]
    public void MapsArePrettiedForTheHostname(string map, string pretty) => Assert.Equal(pretty, GamemodeLoader.PrettyMap(map));
}
