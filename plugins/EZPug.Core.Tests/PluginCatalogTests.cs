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
        // No gameinfo.gi to read: the engine is taken to write under game/csgo.
        Assert.Equal(paths.CsgoDirectory, paths.EngineWriteDirectory);
    }

    /// <summary>The search paths of the gameinfo.gi the dev node and Dathost both run, Metamod's line included (PRD-04 T11).</summary>
    private const string GameInfo = """
        "GameInfo"
        {
        	FileSystem
        	{
        		SearchPaths
        		{
        			Game_LowViolence	csgo_lv // Perfect World content override
        			Game	csgo/addons/metamod

        			Game	csgo
        			Mod		csgo
        		}
        	}
        }
        """;

    [Theory]
    [InlineData(GameInfo, "csgo/addons/metamod")]
    [InlineData("SearchPaths\n{\n\tGame_LowViolence\tcsgo_lv\n\tGame\tcsgo\n}", "csgo")]
    [InlineData("SearchPaths\n{\n\t\"Game\"\t\"csgo/addons/metamod\" // quoted\n}", "csgo/addons/metamod")]
    [InlineData("SearchPaths\n{\n\tMod\tcsgo\n}\nGame\tcsgo/elsewhere", null)]
    [InlineData("Game\tcsgo/outside", null)]
    public void TheEnginesWritePathIsTheFirstGameSearchPath(string gameInfo, string? expected) =>
        Assert.Equal(expected, ServerPaths.FirstGamePath(gameInfo));

    [Fact]
    public void WithMetamodLeadingGameInfoTheEngineWritesUnderAddonsMetamod()
    {
        using var image = new FakeImage();
        File.WriteAllText(Path.Combine(image.CsgoDirectory, "gameinfo.gi"), GameInfo);
        var paths = new ServerPaths(image.ModuleDirectory);
        Assert.Equal(Path.GetFullPath(Path.Combine(image.CsgoDirectory, "addons", "metamod")), paths.EngineWriteDirectory);
    }
}
