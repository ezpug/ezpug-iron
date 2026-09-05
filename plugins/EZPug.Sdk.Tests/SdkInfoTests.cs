using System.Diagnostics;
using EZPug.Sdk;
using Xunit;

namespace EZPug.Sdk.Tests;

public class SdkInfoTests
{
    [Fact]
    public void ThePinnedVersionIsTheOneThatWasRestored()
    {
        // Directory.Build.props states one number; the SDK's metadata carries it
        // and the CounterStrikeSharp.API assembly that landed beside the tests
        // must be that same release — a pin that drifts from the restored
        // package is exactly what this catches.
        var pinned = SdkInfo.CounterStrikeSharpApiVersion;
        var restored = Path.Combine(AppContext.BaseDirectory, "CounterStrikeSharp.API.dll");

        Assert.Matches(@"^\d+\.\d+\.\d+$", pinned);
        Assert.True(File.Exists(restored), $"expected the restored assembly at {restored}");

        // The product version is `1.0.373+Branch.main.Sha.…`: the release, then
        // build metadata. Only the release is the pin.
        var product = FileVersionInfo.GetVersionInfo(restored).ProductVersion ?? "";
        var release = product.Split('+', 2)[0];
        Assert.Equal(pinned, release);
    }
}
