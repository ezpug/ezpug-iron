using System.Text.Json;
using System.Text.Json.Nodes;
using EZPug.Sdk.Protocol;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// The generated protocol types against the files the TypeScript side wrote (PRD-02 T1):
/// every frame in <c>packages/protocol/fixtures/frames/*.json</c> and every vocabulary
/// event in the spine's recorded goldens under <c>packages/match-api/fixtures/recorded/</c>
/// is read into its C# twin, written back, and the whole file must come out byte for byte.
/// The fixtures are the arbiter of every shape disagreement between the two languages, so
/// a schema change that regenerates the C# and a fixture that no longer round-trips is a
/// disagreement this test names.
/// </summary>
public class ProtocolRoundTripTests
{
    private static readonly string Repo = FindRepo();

    /// <summary>The wire options plus the indentation the fixture writer uses (two spaces, LF).</summary>
    private static readonly JsonSerializerOptions Indented = new(ProtocolJson.Options)
    {
        WriteIndented = true,
        NewLine = "\n",
    };

    private static string FindRepo()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "pnpm-workspace.yaml")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName ?? throw new InvalidOperationException("not inside the repository");
    }

    private static Type FrameType(string schema) =>
        schema switch
        {
            "ServerFrame" => typeof(ServerFrame),
            "OrchestratorFrame" => typeof(OrchestratorFrame),
            "LinkCommand" => typeof(LinkCommand),
            _ => throw new InvalidOperationException($"no C# twin for {schema} — the node link is TypeScript on both ends"),
        };

    /// <summary>Read <paramref name="node"/> as <paramref name="type"/> and write it back as a node.</summary>
    private static JsonNode RoundTrip(JsonNode node, Type type)
    {
        var typed = JsonSerializer.Deserialize(node.ToJsonString(ProtocolJson.Options), type, ProtocolJson.Options)
            ?? throw new InvalidOperationException($"{type.Name}: null");
        return JsonSerializer.SerializeToNode(typed, type, ProtocolJson.Options)
            ?? throw new InvalidOperationException($"{type.Name}: serialized to null");
    }

    private static string Canonical(JsonNode document) => document.ToJsonString(Indented) + "\n";

    public static IEnumerable<object[]> FrameFixtures() =>
        Directory.GetFiles(Path.Combine(Repo, "packages/protocol/fixtures/frames"), "*.json")
            .Order()
            .Select(path => new object[] { Path.GetFileName(path) });

    [Theory]
    [MemberData(nameof(FrameFixtures))]
    public void EveryFrameFixtureRoundTripsByteForByte(string file)
    {
        var path = Path.Combine(Repo, "packages/protocol/fixtures/frames", file);
        var text = File.ReadAllText(path);
        var document = JsonNode.Parse(text)!.AsObject();
        var schema = document["schema"]!.GetValue<string>();
        var frames = document["frames"]!.AsArray();

        if (schema is "NodeFrame" or "OrchestratorNodeFrame")
        {
            // The node link has no C# side; the file still has to be the canonical shape.
            Assert.Equal(text, Canonical(document));
            return;
        }

        var type = FrameType(schema);
        Assert.NotEmpty(frames);
        for (var i = 0; i < frames.Count; i++)
        {
            frames[i] = RoundTrip(frames[i]!, type);
        }

        Assert.Equal(text, Canonical(document));
    }

    [Fact]
    public void EveryBranchOfEveryUnionHasAFixture()
    {
        foreach (var (schema, file) in new[] { ("ServerFrame", "server.json"), ("OrchestratorFrame", "orchestrator.json"), ("LinkCommand", "commands.json") })
        {
            var document = JsonNode.Parse(File.ReadAllText(Path.Combine(Repo, "packages/protocol/fixtures/frames", file)))!;
            var seen = document["frames"]!.AsArray()
                .Select(frame => JsonSerializer.Deserialize(frame!.ToJsonString(), FrameType(schema), ProtocolJson.Options)!.GetType())
                .ToHashSet();
            var branches = typeof(ServerFrame).Assembly.GetTypes()
                .Where(candidate => candidate.BaseType == FrameType(schema))
                .ToHashSet();
            Assert.Equal(branches, seen);
        }
    }

    public static IEnumerable<object[]> RecordedFixtures() =>
        Directory.GetFiles(Path.Combine(Repo, "packages/match-api/fixtures/recorded"), "*.json")
            .Order()
            .Select(path => new object[] { Path.GetFileName(path) });

    /// <summary>
    /// The spine's goldens: every webhook envelope whose payload is a vocabulary event (a
    /// <c>type</c> without a dot — the orchestration facts are the Match API's, not the
    /// plugin's) is round-tripped through <see cref="GameserverEvent"/> in place, and the
    /// whole file must still be its own bytes. The stream frames (<c>frames</c>, only in
    /// <c>stream-hello.json</c>) were written by the fake's hub in construction order —
    /// <c>type</c> first — rather than in the schema order a parse emits, so the events and
    /// position ticks inside them are compared as values, not bytes.
    /// </summary>
    [Theory]
    [MemberData(nameof(RecordedFixtures))]
    public void TheSpinesRecordedEventsRoundTripByteForByte(string file)
    {
        var path = Path.Combine(Repo, "packages/match-api/fixtures/recorded", file);
        var text = File.ReadAllText(path);
        var document = JsonNode.Parse(text)!.AsObject();
        var events = 0;

        foreach (var envelope in document["envelopes"]!.AsArray())
        {
            events += ReplacePayload(envelope!.AsObject());
        }

        foreach (var frame in document["frames"]!.AsArray())
        {
            var kind = frame!["type"]!.GetValue<string>();
            var streamed = kind switch
            {
                "event" => new[] { frame["envelope"]!["payload"]! },
                "tick" => frame["ticks"]!.AsArray().Select(tick => tick!).ToArray(),
                _ => [],
            };
            foreach (var payload in streamed)
            {
                if (payload["type"]!.GetValue<string>().Contains('.'))
                {
                    continue;
                }

                var back = RoundTrip(payload, typeof(GameserverEvent));
                Assert.True(JsonNode.DeepEquals(payload, back), $"{file}: a streamed {payload["type"]} changed in value");
                events++;
            }
        }

        Assert.Equal(text, Canonical(document));
        if (file is "happy-bo1.json")
        {
            Assert.True(events > 100, $"{file}: expected the Bo1 to carry more than a hundred events, saw {events}");
        }
    }

    private static int ReplacePayload(JsonObject envelope)
    {
        var payload = envelope["payload"]!;
        if (payload["type"]!.GetValue<string>().Contains('.'))
        {
            return 0;
        }

        envelope["payload"] = RoundTrip(payload, typeof(GameserverEvent));
        return 1;
    }

    [Theory]
    [InlineData(0.000001, "0.000001")]
    [InlineData(0.0000001, "1e-7")]
    [InlineData(1180, "1180")]
    [InlineData(92.5, "92.5")]
    [InlineData(-412.5, "-412.5")]
    [InlineData(0.1, "0.1")]
    [InlineData(1e21, "1e+21")]
    [InlineData(123456789012345680000.0, "123456789012345680000")]
    [InlineData(1.5e-7, "1.5e-7")]
    [InlineData(0, "0")]
    [InlineData(-0.0, "0")]
    [InlineData(1.7976931348623157e308, "1.7976931348623157e+308")]
    [InlineData(5e-324, "5e-324")]
    public void DoublesPrintLikeJavaScript(double value, string expected)
    {
        Assert.Equal(expected, JavaScriptNumberConverter.Format(value));
    }

    [Fact]
    public void AnUnknownDiscriminatorIsAJsonExceptionNotASilentNull()
    {
        var error = Assert.Throws<JsonException>(() =>
            ProtocolJson.Deserialize<ServerFrame>("{\"type\":\"teleport\"}"));
        Assert.Contains("teleport", error.Message);
    }

    [Fact]
    public void TheDiscriminatorMayComeLast()
    {
        var frame = ProtocolJson.Deserialize<ServerFrame>("{\"state\":\"idle\",\"type\":\"state\"}");
        var state = Assert.IsType<StateServerFrame>(frame);
        Assert.Equal(LinkServerState.Idle, state.State);
        Assert.Equal("state", state.Discriminator);
        Assert.Equal("{\"type\":\"state\",\"state\":\"idle\"}", ProtocolJson.Serialize<ServerFrame>(state));
    }

    [Fact]
    public void TheConstantsAreTheProtocolsOwn()
    {
        Assert.Equal(1, ProtocolConstants.ProtocolVersion);
        Assert.Equal("/link", ProtocolConstants.ServerLinkPath);
        Assert.Equal(200, ProtocolConstants.EventsBatchMax);
    }
}
