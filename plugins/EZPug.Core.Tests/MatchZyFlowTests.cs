using System.Text.Json.Nodes;
using EZPug.Sdk;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Core.Tests;

/// <summary>
/// <b>What MatchZy cannot say, observed on the harness</b> (PRD-02 T9): pauses from the
/// gamerules, the <c>pause</c> command answered with MatchZy's own admin verb, side
/// swaps from the roster or the engine's flag, round backups crossing the link with the
/// token scrubbed — and nothing at all for another flow.
/// </summary>
public class MatchZyFlowTests
{
    private const long Serial = 4711;
    private static readonly RosterEntry Tk = new() { SteamId64 = "76561198279375306", Name = "tk", Locale = Locale.De };
    private static readonly RosterEntry Maex = new() { SteamId64 = "76561198279375307", Name = "maex", Locale = Locale.En };

    private sealed class Rig : IDisposable
    {
        public Rig()
        {
            Image = new FakeImage().With("EZPug.Core", disabled: false).With("MatchZy").With("RetakesPlugin");
            World = new FakeGameWorld(map: "de_dust2");
            Link = new FakePlatformLink();
            Runtime = new GamemodeRuntime(World, Link, Log);
            Loader = new GamemodeLoader(World, Image.Catalog(), Image.CsgoDirectory, "de_dust2", Log, GamemodeLoaderTests.Rig.RemoteLog);
            Loader.Bind(Runtime);
            Flow = new MatchZyFlow(World, Runtime, Image.CsgoDirectory, Log);
            Flow.Bind();
            Link.Welcome();
        }

        public FakeImage Image { get; }
        public FakeGameWorld World { get; }
        public FakePlatformLink Link { get; }
        public GamemodeRuntime Runtime { get; }
        public GamemodeLoader Loader { get; }
        public MatchZyFlow Flow { get; }
        public GamemodeLoaderTests.RecordingLog Log { get; } = new();

        public string BackupFolder => Path.Combine(Image.CsgoDirectory, MatchZyBackups.Folder);

        /// <summary>A pug assigned and its map up, team A starting CT, the roster given.</summary>
        public Assignment StartPug(bool roster = true)
        {
            var manifest = GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", "pug", "manifest.json")));
            var config = JsonNode.Parse("{\"matchid\":" + Serial + ",\"num_maps\":1,\"maplist\":[\"de_mirage\"],\"cvars\":{}}")!.AsObject();
            var assignment = GamemodeTestHost.AssignmentFor(manifest, map: "de_mirage", teamA: roster ? [Tk] : [], teamB: roster ? [Maex] : []) with
            {
                MatchzyConfig = config,
                Maps = [new MapPlan { Map = "de_mirage", Sides = MapPlanSides.Ct }],
            };
            Link.Assign(assignment);
            World.StartMap("de_mirage");
            Link.Events.Clear();
            return Runtime.Assignment!;
        }

        public void Rules(bool paused = false, bool tTimeout = false, bool ctTimeout = false, bool technical = false, bool swapping = false, bool warmup = false, int played = 0) =>
            World.Rules = new GameRules(warmup, played, paused, tTimeout, ctTimeout, technical, swapping);

        public void Poll() => World.Elapse(MatchZyFlow.PollIntervalMs);

        public void Dispose()
        {
            Runtime.Dispose();
            Image.Dispose();
        }
    }

    [Fact]
    public void PausesAndUnpausesAreReadOffTheGamerules()
    {
        using var rig = new Rig();
        rig.StartPug();
        rig.Rules();
        rig.Poll();
        Assert.Empty(rig.Link.Events);

        rig.Rules(paused: true);
        rig.Poll();
        var paused = Assert.Single(rig.Link.EventsOf<MatchPausedEvent>());
        Assert.Null(paused.Kind);
        Assert.Null(paused.PausedBy);
        Assert.Equal(1, paused.MapNumber);
        rig.Poll();
        Assert.Single(rig.Link.EventsOf<MatchPausedEvent>());

        rig.Rules(paused: false);
        rig.Poll();
        Assert.Single(rig.Link.EventsOf<MatchUnpausedEvent>());

        // A tactical timeout names the team on that side: team A started CT, so the T timeout is team B's.
        rig.Rules(tTimeout: true);
        rig.Poll();
        var tactical = rig.Link.EventsOf<MatchPausedEvent>()[^1];
        Assert.Equal(PauseKind.Tactical, tactical.Kind);
        Assert.Equal(PauseSource.TeamB, tactical.PausedBy);
        rig.Rules();
        rig.Poll();

        rig.Rules(technical: true);
        rig.Poll();
        Assert.Equal(PauseKind.Technical, rig.Link.EventsOf<MatchPausedEvent>()[^1].Kind);
        Assert.Equal(["match_paused", "match_unpaused", "match_paused", "match_unpaused", "match_paused"], rig.Link.EventTypes);
    }

    [Fact]
    public void ThePauseCommandIsMatchZysForcePauseAndReportsAnAdminPause()
    {
        using var rig = new Rig();
        rig.StartPug();
        rig.Rules();

        var result = rig.Link.Command(new PauseCommand { CorrelationId = "c-1" });
        Assert.Equal(LinkCommandStatus.Applied, result!.Status);
        Assert.Contains("command css_forcepause", rig.World.Actions.Select(action => action.ToString()));

        rig.Rules(paused: true);
        rig.Poll();
        var paused = Assert.Single(rig.Link.EventsOf<MatchPausedEvent>());
        Assert.Equal(PauseKind.Admin, paused.Kind);
        Assert.Equal(PauseSource.Admin, paused.PausedBy);

        var unpause = rig.Link.Command(new UnpauseCommand { CorrelationId = "c-2" });
        Assert.Equal(LinkCommandStatus.Applied, unpause!.Status);
        Assert.Contains("command css_forceunpause", rig.World.Actions.Select(action => action.ToString()));
        rig.Rules();
        rig.Poll();
        Assert.Single(rig.Link.EventsOf<MatchUnpausedEvent>());

        // The next pause is not the admin's unless the admin asked again.
        rig.Rules(paused: true);
        rig.Poll();
        Assert.Null(rig.Link.EventsOf<MatchPausedEvent>()[^1].Kind);
    }

    [Fact]
    public void SideSwapsFollowTheRosterAtARoundStartOutsideWarmup()
    {
        using var rig = new Rig();
        rig.StartPug();
        var tk = rig.World.Connect(76561198279375306, "tk", PlayerTeam.CounterTerrorist);
        rig.World.Connect(76561198279375307, "maex", PlayerTeam.Terrorist);
        rig.Link.Events.Clear();

        // Warmup rounds say nothing about sides.
        rig.Rules(warmup: true);
        tk.Team = PlayerTeam.Terrorist;
        rig.World.StartRound();
        Assert.Empty(rig.Link.EventsOf<SideSwapEvent>());
        tk.Team = PlayerTeam.CounterTerrorist;

        // Live: team A on CT, as planned — nothing to say.
        rig.Rules(played: 0);
        rig.World.StartRound();
        Assert.Empty(rig.Link.EventsOf<SideSwapEvent>());
        Assert.Equal(1, rig.Runtime.Match.RoundNumber);

        // Halftime: team A now stands on T.
        tk.Team = PlayerTeam.Terrorist;
        rig.Rules(played: 12);
        rig.World.StartRound();
        var swap = Assert.Single(rig.Link.EventsOf<SideSwapEvent>());
        Assert.Equal(TeamSide.T, swap.Sides.TeamA);
        Assert.Equal(TeamSide.Ct, swap.Sides.TeamB);
        Assert.Equal(TeamSide.T, rig.Runtime.Match.TeamASide);
        Assert.Equal(13, rig.Runtime.Match.RoundNumber);

        // Still on T next round: said once.
        rig.Rules(played: 13);
        rig.World.StartRound();
        Assert.Single(rig.Link.EventsOf<SideSwapEvent>());
    }

    [Fact]
    public void WithNobodyRosteredTheEngineFlagDecidesTheSwap()
    {
        using var rig = new Rig();
        rig.StartPug(roster: false);
        rig.Rules(played: 1);
        rig.World.StartRound();
        Assert.Empty(rig.Link.EventsOf<SideSwapEvent>());

        // The engine flags the swap during the round that ends the half; the next round start is on the other side.
        rig.Rules(played: 2, swapping: true);
        rig.Poll();
        rig.Rules(played: 2);
        rig.World.StartRound();
        var swap = Assert.Single(rig.Link.EventsOf<SideSwapEvent>());
        Assert.Equal(TeamSide.T, swap.Sides.TeamA);

        rig.Rules(played: 3);
        rig.World.StartRound();
        Assert.Single(rig.Link.EventsOf<SideSwapEvent>());
    }

    [Fact]
    public void RoundBackupsCrossTheLinkOnceEachWithTheTokenScrubbed()
    {
        using var rig = new Rig();
        var assignment = rig.StartPug();
        rig.Rules(played: 2);
        Directory.CreateDirectory(rig.BackupFolder);
        var secret = "ezs_not-a-secret_0000000000000000000";
        var config = $$"""{"RemoteLogURL":"http://127.0.0.1:3430/matchzy/log","RemoteLogHeaderKey":"x-ezpug-server-token","RemoteLogHeaderValue":"{{secret}}","MatchId":4711}""";
        var backup = new JsonObject
        {
            ["matchid"] = "4711",
            ["round"] = "02",
            ["match_config"] = config,
            ["valve_backup"] = "\"round\" { \"team1_score\" \"1\" \"team2_score\" \"1\" }",
        };
        File.WriteAllText(Path.Combine(rig.BackupFolder, "matchzy_4711_0_round02.json"), backup.ToJsonString());
        // Another match's file and another map's are not ours.
        File.WriteAllText(Path.Combine(rig.BackupFolder, "matchzy_9999_0_round07.json"), backup.ToJsonString());
        File.WriteAllText(Path.Combine(rig.BackupFolder, "matchzy_4711_1_round05.json"), backup.ToJsonString());

        rig.World.StartRound();
        Assert.Empty(rig.Link.Backups);
        rig.World.Elapse(MatchZyFlow.BackupSettleMs);

        var frame = Assert.Single(rig.Link.Backups);
        Assert.Equal(assignment.MatchId, frame.MatchId);
        Assert.Equal(1, frame.Backup.MapNumber);
        Assert.Equal(3, frame.Backup.RoundNumber);
        Assert.Equal("matchzy_4711_0_round02.json", frame.Backup.Filename);
        Assert.DoesNotContain(secret, frame.Backup.Content);
        var scrubbed = JsonNode.Parse(JsonNode.Parse(frame.Backup.Content)!["match_config"]!.GetValue<string>())!.AsObject();
        Assert.Equal("", scrubbed["RemoteLogHeaderValue"]!.GetValue<string>());
        Assert.Equal("x-ezpug-server-token", scrubbed["RemoteLogHeaderKey"]!.GetValue<string>());
        Assert.Contains("team1_score", frame.Backup.Content);
        var written = Assert.Single(rig.Link.EventsOf<BackupWrittenEvent>());
        Assert.Equal(3, written.RoundNumber);
        Assert.Equal("matchzy_4711_0_round02.json", written.Filename);

        // The same file again is not sent twice; a newer one is.
        rig.World.StartRound();
        rig.World.Elapse(MatchZyFlow.BackupSettleMs);
        Assert.Single(rig.Link.Backups);
        File.WriteAllText(Path.Combine(rig.BackupFolder, "matchzy_4711_0_round03.json"), backup.ToJsonString());
        rig.World.StartRound();
        rig.World.Elapse(MatchZyFlow.BackupSettleMs);
        Assert.Equal(2, rig.Link.Backups.Count);
        Assert.Equal(4, rig.Link.Backups[^1].Backup.RoundNumber);
        Assert.DoesNotContain(rig.Log.Lines, line => line.Contains(secret));
    }

    [Fact]
    public void NothingHappensForAnotherFlow()
    {
        using var rig = new Rig();
        var manifest = GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", "retakes", "manifest.json")));
        rig.Link.Assign(GamemodeTestHost.AssignmentFor(manifest, map: "de_mirage"));
        rig.World.StartMap("de_mirage");
        rig.Link.Events.Clear();
        Assert.False(rig.Flow.Active);

        rig.Rules(paused: true, swapping: true);
        rig.Poll();
        rig.World.StartRound();
        // The SDK's generic emitter owns a `plugin` flow's story (PRD-02 T22) and says
        // its part; none of MatchZy's own — a pause, a backup — is said by anybody.
        Assert.Equal(["going_live", "side_swap", "round_start"], rig.Link.EventTypes);
        Assert.Empty(rig.Link.EventsOf<MatchPausedEvent>());
        Assert.Empty(rig.Link.Backups);

        var result = rig.Link.Command(new PauseCommand { CorrelationId = "c-1" });
        Assert.Equal(LinkCommandStatus.Rejected, result!.Status);
        Assert.Equal(MatchApiErrorCode.CommandUnsupported, result.Code);
        Assert.DoesNotContain("command css_forcepause", rig.World.Actions.Select(action => action.ToString()));

        // Released: the poll is gone with the assignment, and so is the generic emitter's.
        rig.Link.Events.Clear();
        rig.Link.Release();
        rig.Rules(paused: false);
        rig.Poll();
        rig.World.StartRound();
        Assert.Empty(rig.Link.Events);
    }

    [Fact]
    public void ASecondMapWhileAssignedIsTheSeriesNextMapAndTheConfigIsNotReloaded()
    {
        using var rig = new Rig();
        rig.StartPug();
        var loads = rig.World.Actions.Count(action => action.ToString().StartsWith("command matchzy_loadmatch"));
        Assert.Equal(1, loads);
        Assert.Equal(1, rig.Runtime.Match.MapNumber);

        rig.World.StartMap("de_nuke");
        Assert.Equal(1, rig.World.Actions.Count(action => action.ToString().StartsWith("command matchzy_loadmatch")));
        Assert.Equal(2, rig.Runtime.Match.MapNumber);
        Assert.Equal(0, rig.Runtime.Match.RoundNumber);
        Assert.Contains(rig.Log.Lines, line => line.Contains("mid-series"));
    }
}
