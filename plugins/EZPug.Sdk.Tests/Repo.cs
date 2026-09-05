namespace EZPug.Sdk.Tests;

/// <summary>The repository root, found from the test assembly's location, for the fixtures every language shares.</summary>
internal static class Repo
{
    public static readonly string Root = Find();

    public static string Path(params string[] parts) => System.IO.Path.Combine([Root, .. parts]);

    private static string Find()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(System.IO.Path.Combine(directory.FullName, "pnpm-workspace.yaml")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName ?? throw new InvalidOperationException("not inside the repository");
    }
}
