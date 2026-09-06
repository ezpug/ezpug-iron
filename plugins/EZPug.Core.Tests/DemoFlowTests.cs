using System.Diagnostics;
using System.Text.Json.Nodes;
using EZPug.Sdk;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Core.Tests;

/// <summary>
/// <b>Demos over the link's shoulder, on the harness</b> (PRD-02 T21). The whole flow
/// without CS2: a demo appears on disk, stops growing, is PUT at the assignment's URL
/// and announced with its size and hash — and the three honest failures beside it
/// (nowhere to put it, nothing to find, a mode that records no demo at all).
/// </summary>
public class DemoFlowTests
{
    private const long Serial = 4711;
    private const string UploadUrl = "https://bucket.invalid/demos/match.dem?signed=1";

    private sealed class Rig : IDisposable
    {
        public Rig()
        {
            Image = new FakeImage().With("EZPug.Core", disabled: false).With("MatchZy");
            World = new FakeGameWorld(map: "de_dust2");
            Link = new FakePlatformLink();
            Runtime = new GamemodeRuntime(World, Link, Log);
            Transport = new FakeDemoTransport();
            Flow = new DemoFlow(World, Runtime, Image.CsgoDirectory, new DemoUploader(Transport, World.Clock, Log), Log);
            Flow.Bind();
            Link.Welcome();
            World.SetCvar("tv_delay", "105");
        }

        public FakeImage Image { get; }
        public FakeGameWorld World { get; }
        public FakePlatformLink Link { get; }
        public GamemodeRuntime Runtime { get; }
        public FakeDemoTransport Transport { get; }
        public DemoFlow Flow { get; }
        public GamemodeLoaderTests.RecordingLog Log { get; } = new();

        public string MatchZyFolder => Path.Combine(Image.CsgoDirectory, DemoFiles.MatchZyFolder);

        /// <summary>Assign a match and bring its map up, exactly as the runtime would.</summary>
        public Assignment Start(string gamemode = "pug", string? uploadUrl = UploadUrl)
        {
            var manifest = GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", gamemode, "manifest.json")));
            var frame = GamemodeTestHost.AssignmentFor(manifest, map: "de_mirage") with
            {
                MatchzyConfig = JsonNode.Parse("{\"matchid\":" + Serial + "}")!.AsObject(),
                Maps = [new MapPlan { Map = "de_mirage", Sides = MapPlanSides.Ct }],
                DemoUploadUrl = uploadUrl,
            };
            Link.Assign(frame);
            World.StartMap("de_mirage");
            Link.Events.Clear();
            return Runtime.Assignment!;
        }

        /// <summary>Put a demo of <paramref name="bytes"/> bytes where the recorder would have.</summary>
        public string WriteDemo(string folder, string name, int bytes)
        {
            Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, name);
            File.WriteAllBytes(path, Enumerable.Range(0, bytes).Select(i => (byte)(i % 251)).ToArray());
            return path;
        }

        /// <summary>One poll of the watcher.</summary>
        public void Poll() => World.Elapse(DemoFlow.PollIntervalMs);

        /// <summary>
        /// Poll until the flow has said something, giving the thread pool room: the PUT
        /// itself is a task, and the event it produces comes back on the world's clock.
        /// </summary>
        public async Task<DemoAvailableEvent?> WaitForDemoAsync()
        {
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < Patience.TimeoutMs)
            {
                if (Link.EventsOf<DemoAvailableEvent>().FirstOrDefault() is { } found)
                {
                    return found;
                }

                Poll();
                await Task.Delay(1);
            }

            return null;
        }

        public void Dispose()
        {
            Runtime.Dispose();
            Image.Dispose();
        }
    }

    [Fact]
    public async Task AMatchZyDemoThatStoppedGrowingIsUploadedAndAnnouncedWithItsHash()
    {
        using var rig = new Rig();
        rig.Start();
        // MatchZy owns `tv_record` for its own flow: nothing here touches GOTV.
        Assert.DoesNotContain(rig.World.Actions, action => action.Verb == "command" && action.Detail.StartsWith("tv_record"));

        var path = rig.WriteDemo(rig.MatchZyFolder, $"2026_{Serial}_de_mirage_A_vs_B.dem", 2_048);
        rig.World.EndMap();
        // Still being written: one poll sees a length, the next sees it move.
        rig.Poll();
        File.AppendAllText(path, new string('x', 32));
        rig.Poll();
        Assert.Empty(rig.Transport.Attempts);

        // Now it stands still for the settle window and goes up.
        rig.World.Elapse(DemoFlow.SettleMs);
        var announced = await rig.WaitForDemoAsync();

        Assert.NotNull(announced);
        Assert.Equal($"2026_{Serial}_de_mirage_A_vs_B.dem", announced.Filename);
        Assert.Equal(2_080, announced.SizeBytes);
        Assert.Equal(DemoFiles.ContentType, announced.ContentType);
        Assert.NotNull(announced.Sha256);
        Assert.Equal(64, announced.Sha256!.Length);
        Assert.Equal(1, announced.MapNumber);
        var attempt = Assert.Single(rig.Transport.Attempts);
        Assert.Equal(new Uri(UploadUrl), attempt.Url);
        Assert.Equal(File.ReadAllBytes(path), attempt.Body);
    }

    [Fact]
    public async Task WithNowhereToPutItTheDemoIsStillAnnouncedAndCarriesNoHash()
    {
        using var rig = new Rig();
        rig.Start(uploadUrl: null);
        rig.WriteDemo(rig.MatchZyFolder, $"2026_{Serial}_de_mirage_A_vs_B.dem", 512);
        rig.World.EndMap();
        rig.Poll();
        rig.World.Elapse(DemoFlow.SettleMs);

        var announced = await rig.WaitForDemoAsync();

        Assert.NotNull(announced);
        Assert.Null(announced.Sha256);
        Assert.Null(announced.ContentType);
        Assert.Empty(rig.Transport.Attempts);
        Assert.Contains(rig.Log.Lines, line => line.Contains("named nowhere to put one"));
    }

    [Fact]
    public void AModeThatRecordsNoDemoNeverLooksForOne()
    {
        using var rig = new Rig();
        rig.Start(gamemode: "flying-scoutsman");
        rig.World.EndMap();
        rig.World.Elapse(DemoFlow.WindowMs + DemoFlow.SettleMs);

        Assert.False(rig.Flow.Active);
        Assert.Empty(rig.Link.EventsOf<DemoAvailableEvent>());
        Assert.Empty(rig.Transport.Attempts);
    }

    [Fact]
    public void ADemoThatNeverAppearsIsGivenUpOnAtTheWindowAndSaidSo()
    {
        using var rig = new Rig();
        rig.Start();
        rig.World.EndMap();
        rig.World.Elapse(DemoFlow.WindowMs + DemoFlow.PollIntervalMs);

        Assert.Empty(rig.Link.EventsOf<DemoAvailableEvent>());
        Assert.Empty(rig.Transport.Attempts);
        Assert.Contains(rig.Log.Lines, line => line.Contains("no demo appeared"));
    }

    [Fact]
    public async Task AModeWithoutMatchZyRecordsItselfAndStopsOneGotvDelayAfterTheWinPanel()
    {
        using var rig = new Rig();
        // The `pug` manifest with its flow changed: what a `records: demo` mode on the
        // SDK looks like before one ships (T22 onwards).
        var manifest = GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", "pug", "manifest.json")));
        var frame = GamemodeTestHost.AssignmentFor(manifest with { Flow = GamemodeFlow.Plugin }, map: "de_mirage") with
        {
            Maps = [new MapPlan { Map = "de_mirage", Sides = MapPlanSides.Ct }],
            DemoUploadUrl = UploadUrl,
        };
        rig.Link.Assign(frame);
        rig.World.StartMap("de_mirage");

        Assert.True(rig.Flow.OwnsRecording);
        var recording = Assert.Single(rig.World.Actions, action => action.Verb == "command" && action.Detail.StartsWith("tv_record"));
        var name = recording.Detail["tv_record ".Length..];

        rig.World.EndMap();
        rig.World.Elapse(1_000);
        Assert.DoesNotContain(rig.World.Actions, action => action.Verb == "command" && action.Detail == "tv_stoprecord");

        // 105 s of GOTV delay later, and only then, GOTV is told to stop.
        rig.World.Elapse(105_000);
        Assert.Contains(rig.World.Actions, action => action.Verb == "command" && action.Detail == "tv_stoprecord");

        rig.WriteDemo(rig.Image.CsgoDirectory, name + ".dem", 1_024);
        rig.Poll();
        rig.World.Elapse(DemoFlow.SettleMs);
        var announced = await rig.WaitForDemoAsync();

        Assert.NotNull(announced);
        Assert.Equal(name + ".dem", announced.Filename);
        Assert.NotNull(announced.Sha256);
    }
}
