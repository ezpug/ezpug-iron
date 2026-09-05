using Xunit;

namespace EZPug.Core.Tests;

public class PluginCatalogTests
{
    [Fact]
    public void ListsEnabledFoldersThenDisabledOnesAndSpeaksDllPaths()
    {
        using var image = new FakeImage()
            .With("EZPug.Core", disabled: false)
            .With("RetakesPlugin")
            .With("MatchZy")
            .With("EZPug.PowerupDm")
            .With("Broken", dll: false);
        Directory.CreateDirectory(Path.Combine(image.PluginsDirectory, "disabled", "MatchZy", "lang"));

        var catalog = image.Catalog();
        Assert.Equal(["EZPug.Core", "EZPug.PowerupDm", "MatchZy", "RetakesPlugin"], catalog.Installed);
        Assert.Equal("plugins/disabled/MatchZy/MatchZy.dll", catalog.Find("MatchZy")!.RelativeDllPath);
        Assert.Equal("plugins/EZPug.Core/EZPug.Core.dll", catalog.Find("EZPug.Core")!.RelativeDllPath);
        Assert.Null(catalog.Find("Broken"));
        Assert.Null(catalog.Find("disabled"));
    }

    [Fact]
    public void ReadsAnAssemblyVersionWithoutLoadingIt()
    {
        using var image = new FakeImage().With("MatchZy");
        var catalog = image.Catalog();
        Assert.Equal(EZPug.Sdk.SdkInfo.Version, catalog.VersionOf("MatchZy"));
        Assert.Null(catalog.VersionOf("RetakesPlugin"));
    }

    [Fact]
    public void AMissingPluginsDirectoryIsAnEmptyCatalog()
    {
        var catalog = PluginCatalog.Scan(Path.Combine(Path.GetTempPath(), "does-not-exist-" + Guid.NewGuid().ToString("N")));
        Assert.Empty(catalog.Installed);
    }

    [Fact]
    public void ServerPathsAreDerivedFromThePluginFolder()
    {
        using var image = new FakeImage();
        var paths = new ServerPaths(image.ModuleDirectory);
        Assert.Equal(Path.GetFullPath(image.CounterStrikeSharpRoot), paths.CounterStrikeSharpRoot);
        Assert.Equal(Path.GetFullPath(image.PluginsDirectory), paths.PluginsDirectory);
        Assert.Equal(Path.GetFullPath(image.CsgoDirectory), paths.CsgoDirectory);
        Assert.Equal(Path.Combine(Path.GetFullPath(image.ModuleDirectory), "link-buffer"), paths.DefaultBufferDirectory);
        Assert.DoesNotContain("token", paths.ToString(), StringComparison.OrdinalIgnoreCase);
    }
}
