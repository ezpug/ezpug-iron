using Xunit;

namespace EZPug.Core.Tests;

/// <summary>
/// <b>The HUD never takes the mouse</b> (decision 34, PRD-07's working rules). The engine
/// lets a layout put a player in cursor mode and freeze their movement until it lets go;
/// an entity that outlives its plugin can then hold a player for good. Our seam has no
/// verb for it, and this is the test that keeps one from arriving by another door: the
/// call does not appear anywhere in the code this repo ships.
/// </summary>
public class NoInputCaptureTests
{
    private static readonly string[] Shipped = ["plugins", "gamemodes", "gamemode-kit", "hud", "apps", "packages", "docker", "scripts"];
    private static readonly string[] Skipped = ["bin", "obj", "node_modules", "dist", ".turbo", ".cache"];
    private static readonly string[] Code = [".cs", ".ts", ".tsx", ".js", ".mjs", ".xml", ".css", ".cfg", ".sh"];

    [Fact]
    public void NothingInTheRepoCapturesInput()
    {
        // Spelled in two halves so this file is not the one hit.
        var call = "SetInputCapture" + "Enabled";
        var hits = Shipped
            .Select(folder => Repo.Path(folder))
            .Where(Directory.Exists)
            .SelectMany(Files)
            .Where(file => File.ReadAllText(file).Contains(call, StringComparison.OrdinalIgnoreCase))
            .Select(file => Path.GetRelativePath(Repo.Root, file))
            .ToList();
        Assert.Empty(hits);
    }

    private static IEnumerable<string> Files(string directory)
    {
        foreach (var file in Directory.EnumerateFiles(directory))
        {
            if (Code.Contains(Path.GetExtension(file)))
            {
                yield return file;
            }
        }

        foreach (var child in Directory.EnumerateDirectories(directory))
        {
            if (Skipped.Contains(Path.GetFileName(child)))
            {
                continue;
            }

            foreach (var file in Files(child))
            {
                yield return file;
            }
        }
    }
}
