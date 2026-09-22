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
            StartMap("de_mirage");
            Link.Events.Clear();
            return Runtime.Assignment!;
        }

        public void Rules(bool paused = false, bool tTimeout = false, bool ctTimeout = false, bool technical = false, bool swapping = false, bool warmup = false, int played = 0, GamePhase phase = GamePhase.PlayingStandard) =>
            World.Rules = new GameRules(warmup, played, paused, tTimeout, ctTimeout, technical, swapping, phase);

        /// <summary>The map comes up and the loader's second console frame lands a beat later (T22a).</summary>
        public void StartMap(string map)
        {
            World.StartMap(map);
            World.Elapse(GamemodeLoader.CvarSettleMs);
        }

        public void Poll() => World.Elapse(MatchZyFlow.PollIntervalMs);

        /// <summary>Long enough for a watched pause to run out of beat and be answered.</summary>
        public void Beat() => World.Elapse(MatchZyFlow.PauseAnswerMs + MatchZyFlow.PollIntervalMs);

        /// <summary>The late answer to the command with that id, as the orchestrator would read it off the link.</summary>
        public CommandResultServerFrame Answer(string correlationId) =>
            Link.CommandResults.Single(result => result.CorrelationId == correlationId);

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

        // The answer is not the relay's: the verb goes out and the command waits on the
        // gamerules (PRD-04 T4).
        Assert.Null(rig.Link.Command(new PauseCommand { CorrelationId = "c-1" }));
        Assert.Contains("command css_forcepause", rig.World.Actions.Select(action => action.ToString()));
        Assert.Empty(rig.Link.CommandResults);

        rig.Rules(paused: true);
        rig.Poll();
        var paused = Assert.Single(rig.Link.EventsOf<MatchPausedEvent>());
        Assert.Equal(PauseKind.Admin, paused.Kind);
        Assert.Equal(PauseSource.Admin, paused.PausedBy);
        // The fact is emitted before the answer is given, so nothing the plugin says can
        // arrive out of order — what the two pipes do to them after that is the link's.
        Assert.Equal(LinkCommandStatus.Applied, rig.Answer("c-1").Status);

        Assert.Null(rig.Link.Command(new UnpauseCommand { CorrelationId = "c-2" }));
        Assert.Contains("command css_forceunpause", rig.World.Actions.Select(action => action.ToString()));
        rig.Rules();
        rig.Poll();
        Assert.Single(rig.Link.EventsOf<MatchUnpausedEvent>());
        Assert.Equal(LinkCommandStatus.Applied, rig.Answer("c-2").Status);

        // The next pause is not the admin's unless the admin asked again.
        rig.Rules(paused: true);
        rig.Poll();
        Assert.Null(rig.Link.EventsOf<MatchPausedEvent>()[^1].Kind);
    }

    /// <summary>
    /// <b>A pause that says no</b> (PRD-04 T4, OPEN-POINTS §6). The sixth extended run of
    /// PRD-03 T18 went red because both commands came back <c>applied</c> and the match
    /// never paused: the pause landed at halftime, where MatchZy's <c>ForcePauseMatch</c>
    /// returns early and says so only in chat. Now the beat runs out, the gamerules are
    /// asked what they were doing, and the client is told.
    /// </summary>
    [Fact]
    public void APauseMatchZyRefusedComesBackRejectedWithTheReasonInFront()
    {
        using var rig = new Rig();
        rig.StartPug();
        rig.Rules(swapping: true, phase: GamePhase.Halftime);

        Assert.Null(rig.Link.Command(new PauseCommand { CorrelationId = "c-1" }));
        Assert.Contains("command css_forcepause", rig.World.Actions.Select(action => action.ToString()));
        // Nothing is said while the beat is still running.
        rig.Poll();
        Assert.Empty(rig.Link.CommandResults);

        rig.Beat();
        var refused = rig.Answer("c-1");
        Assert.Equal(LinkCommandStatus.Rejected, refused.Status);
        Assert.Equal(MatchApiErrorCode.InvalidState, refused.Code);
        Assert.StartsWith("halftime: ", refused.Message);
        Assert.Empty(rig.Link.EventsOf<MatchPausedEvent>());

        // And the refusal is not remembered as an admin pause: the tactical timeout that
        // comes after it is the team's, not the admin's.
        rig.Rules(ctTimeout: true);
        rig.Poll();
        Assert.Equal(PauseKind.Tactical, Assert.Single(rig.Link.EventsOf<MatchPausedEvent>()).Kind);
    }

    /// <summary>
    /// The reason word for every state the gamerules can name, and the two the beat
    /// cannot judge — a match already standing where it was asked to stand — which are
    /// refused up front, the way MatchZy refuses them itself, without sending the verb.
    /// </summary>
    [Theory]
    [InlineData("pause", GamePhase.Halftime, false, false, "halftime", true)]
    [InlineData("pause", GamePhase.MatchEnded, false, false, "post_game", true)]
    [InlineData("pause", GamePhase.PlayingStandard, false, true, "timeout_active", true)]
    [InlineData("pause", GamePhase.WarmupRound, false, false, "not_live", true)]
    [InlineData("pause", GamePhase.PlayingStandard, false, false, "unknown", true)]
    [InlineData("pause", GamePhase.Unknown, false, false, "unknown", true)]
    [InlineData("pause", GamePhase.PlayingStandard, true, false, "already_paused", false)]
    [InlineData("pause", GamePhase.PlayingStandard, true, true, "timeout_active", false)]
    [InlineData("unpause", GamePhase.PlayingStandard, false, false, "not_paused", false)]
    [InlineData("unpause", GamePhase.Halftime, true, false, "halftime", true)]
    public void EveryRefusalNamesItsReasonAndIsInvalidState(string verb, GamePhase phase, bool paused, bool timeout, string word, bool relayed)
    {
        using var rig = new Rig();
        rig.StartPug();
        rig.Rules(paused: paused, ctTimeout: timeout, phase: phase, warmup: phase == GamePhase.WarmupRound);

        LinkCommand command = verb == "pause"
            ? new PauseCommand { CorrelationId = "c-1" }
            : new UnpauseCommand { CorrelationId = "c-1" };
        var immediate = rig.Link.Command(command);
        rig.Beat();

        var answer = rig.Answer("c-1");
        Assert.Equal(LinkCommandStatus.Rejected, answer.Status);
        Assert.Equal(MatchApiErrorCode.InvalidState, answer.Code);
        Assert.StartsWith($"{word}: ", answer.Message);
        Assert.Equal(relayed, immediate is null);
        Assert.Equal(relayed, rig.World.Actions.Any(action => action.ToString().StartsWith($"command css_force{verb}")));
    }

    /// <summary>
    /// Nobody is left on the orchestrator's fifteen-second deadline: a match released
    /// while its pause was being watched for answers the command on the way out, and one
    /// asked of a server with no map never leaves the plugin.
    /// </summary>
    [Fact]
    public void AWatchedPauseIsAnsweredWhenTheMatchGoesAwayUnderIt()
    {
        using var rig = new Rig();
        rig.StartPug();
        rig.Rules();
        Assert.Null(rig.Link.Command(new PauseCommand { CorrelationId = "c-1" }));

        rig.Link.Release();
        var answer = rig.Answer("c-1");
        Assert.Equal(LinkCommandStatus.Rejected, answer.Status);
        Assert.StartsWith("released: ", answer.Message);

        rig.StartPug();
        rig.World.Rules = null;
        var noMap = rig.Link.Command(new PauseCommand { CorrelationId = "c-2" });
        Assert.Equal(LinkCommandStatus.Rejected, noMap!.Status);
        Assert.StartsWith("no_gamerules: ", noMap.Message);
        // The verb never went out a second time: the one on the list is the first ask's.
        Assert.Equal(1, rig.World.Actions.Count(action => action.ToString() == "command css_forcepause"));
    }

    /// <summary>The engine's <c>m_gamePhase</c> as the SDK names it: the numbers it knows, and anything else as unknown.</summary>
    [Theory]
    [InlineData(0, GamePhase.WarmupRound)]
    [InlineData(4, GamePhase.Halftime)]
    [InlineData(5, GamePhase.MatchEnded)]
    [InlineData(-1, GamePhase.Unknown)]
    [InlineData(9, GamePhase.Unknown)]
    public void TheEnginesGamePhaseNumberIsNamedOrUnknown(int engine, GamePhase expected) =>
        Assert.Equal(expected, CounterStrikeWorld.PhaseOf(engine));

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
        rig.StartMap("de_mirage");
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

        rig.StartMap("de_nuke");
        Assert.Equal(1, rig.World.Actions.Count(action => action.ToString().StartsWith("command matchzy_loadmatch")));
        Assert.Equal(2, rig.Runtime.Match.MapNumber);
        Assert.Equal(0, rig.Runtime.Match.RoundNumber);
        Assert.Contains(rig.Log.Lines, line => line.Contains("mid-series"));
    }
}
