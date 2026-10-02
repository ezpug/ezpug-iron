using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>Whether a server can draw a HUD at all</b> (PRD-07 T3): the addon's Workshop id
/// and MultiAddonManager's loader file, both or neither. A server with neither is every
/// server there was before the HUD, and must stay exactly that.
/// </summary>
public class HudAddonTests : IDisposable
{
    private const string Id = "3811574606";
    private readonly string _csgo = Path.Combine(Path.GetTempPath(), "ezpug-sdk-tests", Guid.NewGuid().ToString("N"));

    public HudAddonTests()
    {
        Directory.CreateDirectory(_csgo);
    }

    private void PlaceLoader()
    {
        var loader = Path.Combine(_csgo, HudAddon.LoaderFile);
        Directory.CreateDirectory(Path.GetDirectoryName(loader)!);
        File.WriteAllText(loader, "\"Metamod Plugin\"\n{\n}\n");
    }

    private void WriteSidecar(string json) => File.WriteAllText(Path.Combine(_csgo, Sidecar.FileName), json);

    private static Dictionary<string, string> Environment(string? id = null) =>
        id is null ? [] : new() { [HudAddon.Variable] = id };

    [Fact]
    public void AServerWithoutAnIdCannot()
    {
        PlaceLoader();
        var log = new RecordingLog();
        Assert.Null(HudAddon.Find(Environment(), _csgo, _csgo, log));
        Assert.Null(HudAddon.Find(Environment("  "), _csgo, _csgo, log));
        // Nothing to say about it either: this is what every server was before the HUD.
        Assert.Empty(log.Lines);
    }

    [Fact]
    public void TheIdAndTheLoaderFileTogetherAreTheAnswer()
    {
        PlaceLoader();
        Assert.Equal(Id, HudAddon.Find(Environment(Id), _csgo, _csgo));
        // The entrypoint strips the whitespace an env file leaves; so does this.
        Assert.Equal(Id, HudAddon.Find(Environment($" {Id}\n"), _csgo, _csgo));
    }

    [Fact]
    public void AnIdWithoutTheLoaderFileIsOffAndSaysSo()
    {
        var log = new RecordingLog();
        Assert.Null(HudAddon.Find(Environment(Id), _csgo, _csgo, log));
        var line = Assert.Single(log.Lines);
        Assert.Contains(HudAddon.LoaderFile, line);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("hello")]
    [InlineData("38115 74606")]
    [InlineData("3811574606; quit")]
    [InlineData("123456789012345678901")]
    public void WhatIsNotAWorkshopIdIsNoId(string value)
    {
        // The id ends up in a console line (`mm_add_client_addon <id>`), so the grammar
        // is the entrypoint's own: digits, no leading zero, twenty at most.
        PlaceLoader();
        Assert.Null(HudAddon.Find(Environment(value), _csgo, _csgo));
    }

    [Fact]
    public void ADathostCloneReadsItFromTheSidecarFile()
    {
        PlaceLoader();
        WriteSidecar($$"""{"url":"https://gs.ezpug.com","token":"ezs_not-a-secret_from_file_0000000","hudAddon":"{{Id}}"}""");
        Assert.Equal(Id, HudAddon.Find(Environment(), _csgo, _csgo));

        // The environment first, as for the link's own two facts.
        Assert.Equal("42", HudAddon.Find(Environment("42"), _csgo, _csgo));

        // A sidecar that says nothing about a HUD is the sidecar every clone had before.
        WriteSidecar("""{"url":"https://gs.ezpug.com","token":"ezs_not-a-secret_from_file_0000000"}""");
        Assert.Null(HudAddon.Find(Environment(), _csgo, _csgo));
        WriteSidecar("not json");
        Assert.Null(HudAddon.Find(Environment(), _csgo, _csgo));
    }

    [Fact]
    public void TheLoaderFileIsWhereTheOrchestratorPutsIt()
    {
        // Two languages, one path: the Dathost provider uploads the file here and the
        // image's entrypoint copies it here.
        var provider = File.ReadAllText(Repo.Path("apps", "orchestrator", "src", "providers", "hud-addon.ts"));
        Assert.Contains($"HUD_ADDON_LOADER_PATH = '{HudAddon.LoaderFile}'", provider);
        Assert.Contains($"HUD_ADDON_SERVER_VAR = '{HudAddon.Variable}'", provider);
        var entrypoint = File.ReadAllText(Repo.Path("docker", "cs2", "entrypoint.sh"));
        Assert.Contains($"$CSGO/{Path.GetDirectoryName(HudAddon.LoaderFile)}/", entrypoint);
    }

    public void Dispose() => Directory.Delete(_csgo, recursive: true);

    private sealed class RecordingLog : ILinkLog
    {
        public List<string> Lines { get; } = [];

        public void Info(string message) => Lines.Add(message);

        public void Warn(string message) => Lines.Add(message);
    }
}
