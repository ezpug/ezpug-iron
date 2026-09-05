using Xunit;

namespace EZPug.Sdk.Tests;

public class SidecarTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "ezpug-sdk-tests", Guid.NewGuid().ToString("N"));

    public SidecarTests()
    {
        Directory.CreateDirectory(_directory);
    }

    [Fact]
    public void TheEnvironmentWinsOverTheFile()
    {
        File.WriteAllText(Path.Combine(_directory, Sidecar.FileName), """{"url":"https://gs.ezpug.com","token":"ezs_not-a-secret_from_file_0000000"}""");
        var sidecar = Sidecar.Load(
            new Dictionary<string, string>
            {
                [Sidecar.UrlVariable] = "http://127.0.0.1:3430",
                [Sidecar.TokenVariable] = "ezs_not-a-secret_from_env_00000000",
                [Sidecar.BufferDirVariable] = "/tmp/buffer",
            },
            Path.Combine(_directory, Sidecar.FileName))!;
        Assert.Equal(new Uri("ws://127.0.0.1:3430/link"), sidecar.LinkUrl);
        Assert.Equal("ezs_not-a-secret_from_env_00000000", sidecar.Token);
        Assert.Equal("/tmp/buffer", sidecar.BufferDir);
    }

    [Fact]
    public void TheFileIsReadWhenTheEnvironmentIsSilent()
    {
        File.WriteAllText(Path.Combine(_directory, Sidecar.FileName), """{"url":"https://gs.ezpug.com","token":"ezs_not-a-secret_from_file_0000000","bufferDir":"data/ezpug"}""");
        var sidecar = Sidecar.Load(new Dictionary<string, string> { [Sidecar.UrlVariable] = "http://only-half" }, Path.Combine(_directory, Sidecar.FileName))!;
        Assert.Equal(new Uri("wss://gs.ezpug.com/link"), sidecar.LinkUrl);
        Assert.Equal("data/ezpug", sidecar.BufferDir);
        Assert.Null(Sidecar.Load(new Dictionary<string, string>(), Path.Combine(_directory, "missing.json")));
    }

    [Theory]
    [InlineData("https://gs.ezpug.com", "wss://gs.ezpug.com/link")]
    [InlineData("https://gs.ezpug.com/", "wss://gs.ezpug.com/link")]
    [InlineData("http://127.0.0.1:3430", "ws://127.0.0.1:3430/link")]
    [InlineData("wss://gs.ezpug.com/link", "wss://gs.ezpug.com/link")]
    [InlineData("ws://host:3430/custom", "ws://host:3430/custom")]
    public void TheLinkUrlIsDerivedFromTheBaseUrl(string given, string expected) =>
        Assert.Equal(new Uri(expected), Sidecar.LinkUrlOf(given));

    [Fact]
    public void TheTokenNeverPrints()
    {
        var sidecar = new Sidecar(new Uri("wss://gs.ezpug.com/link"), "ezs_not-a-secret_0000000000000000", null);
        Assert.DoesNotContain("ezs_", sidecar.ToString());
        Assert.Contains("[redacted]", sidecar.ToString());
        Assert.Throws<ArgumentException>(() => Sidecar.LinkUrlOf("ftp://nope"));
    }

    public void Dispose() => Directory.Delete(_directory, recursive: true);
}
