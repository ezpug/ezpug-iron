using System.Text.Json.Nodes;
using Xunit;

namespace EZPug.Core.Tests;

public class MatchZyBackupsTests : IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "ezpug-backups-" + Guid.NewGuid().ToString("N"));

    public MatchZyBackupsTests() => Directory.CreateDirectory(_folder);

    public void Dispose() => Directory.Delete(_folder, recursive: true);

    [Fact]
    public void NewestPicksTheHighestRoundOfOneMatchAndMap()
    {
        foreach (var name in new[] { "matchzy_1_0_round00.json", "matchzy_1_0_round09.json", "matchzy_1_0_round10.json", "matchzy_1_1_round12.json", "matchzy_2_0_round30.json", "matchzy_1_0_round03.txt", "notes.json" })
        {
            File.WriteAllText(Path.Combine(_folder, name), "{}");
        }

        var found = MatchZyBackups.Newest(_folder, 1, 0);
        Assert.NotNull(found);
        Assert.Equal("matchzy_1_0_round10.json", found.FileName);
        Assert.Equal(10, found.RoundsCompleted);
        Assert.Equal(12, MatchZyBackups.Newest(_folder, 1, 1)!.RoundsCompleted);
        Assert.Null(MatchZyBackups.Newest(_folder, 3, 0));
        Assert.Null(MatchZyBackups.Newest(Path.Combine(_folder, "missing"), 1, 0));
    }

    [Fact]
    public void ScrubBlanksTheRemoteLogHeaderValueWhereverMatchZyPutIt()
    {
        var config = new JsonObject
        {
            ["RemoteLogURL"] = "http://127.0.0.1:3430/matchzy/log",
            ["RemoteLogHeaderKey"] = "x-ezpug-server-token",
            ["RemoteLogHeaderValue"] = "ezs_not-a-secret_0000000000000000000",
            ["changed_cvars"] = new JsonObject { ["mp_maxrounds"] = "24", ["matchzy_remote_log_header_value"] = "ezs_not-a-secret_0000000000000000000" },
            ["original_cvars"] = new JsonObject { ["get5_remote_log_header_value"] = "ezs_not-a-secret_0000000000000000000" },
            ["MatchId"] = 4711,
        };
        var backup = new JsonObject { ["matchid"] = "4711", ["match_config"] = config.ToJsonString(), ["valve_backup"] = "x" };

        var scrubbed = MatchZyBackups.Scrub(backup.ToJsonString());
        Assert.DoesNotContain("not-a-secret", scrubbed);
        var inner = JsonNode.Parse(JsonNode.Parse(scrubbed)!["match_config"]!.GetValue<string>())!.AsObject();
        Assert.Equal("", inner["RemoteLogHeaderValue"]!.GetValue<string>());
        Assert.Equal("x-ezpug-server-token", inner["RemoteLogHeaderKey"]!.GetValue<string>());
        Assert.Equal("http://127.0.0.1:3430/matchzy/log", inner["RemoteLogURL"]!.GetValue<string>());
        Assert.Equal("24", inner["changed_cvars"]!["mp_maxrounds"]!.GetValue<string>());
        Assert.Equal("", inner["changed_cvars"]!["matchzy_remote_log_header_value"]!.GetValue<string>());
        Assert.Equal("", inner["original_cvars"]!["get5_remote_log_header_value"]!.GetValue<string>());
        Assert.Equal(4711, inner["MatchId"]!.GetValue<int>());
        Assert.Equal("x", JsonNode.Parse(scrubbed)!["valve_backup"]!.GetValue<string>());
    }

    [Fact]
    public void ScrubLeavesWhatItCannotReadAlone()
    {
        Assert.Equal("not json", MatchZyBackups.Scrub("not json"));
        Assert.Equal("[1,2]", MatchZyBackups.Scrub("[1,2]"));
        Assert.Equal("{\"matchid\":\"1\"}", MatchZyBackups.Scrub("{ \"matchid\": \"1\" }"));
        Assert.Equal("{\"match_config\":\"not json either\"}", MatchZyBackups.Scrub("{\"match_config\":\"not json either\"}"));
    }
}
