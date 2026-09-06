namespace EZPug.Sdk;

/// <summary>
/// <b>Finding the demo on disk.</b> Whoever recorded it — MatchZy on its own schedule or
/// the SDK with <c>tv_record</c> — GOTV writes one file and keeps writing to it until
/// <c>tv_stoprecord</c>; there is no event, no callback and no cvar that says "done".
/// So the plugin watches instead: the newest <c>.dem</c> under a folder, and the length
/// it had the last time somebody looked. A file whose length has not moved for a settle
/// window is a file nothing is writing to any more (PRD-02 T21).
/// </summary>
public static class DemoFiles
{
    /// <summary>Where MatchZy writes its demos by default (<c>matchzy_demo_path</c>), relative to <c>game/csgo</c>.</summary>
    public const string MatchZyFolder = "MatchZy";

    /// <summary>What a <c>.dem</c> is PUT as. Not JSON, not text — bytes.</summary>
    public const string ContentType = "application/octet-stream";

    /// <summary>One demo file on disk: where it is, what it is called, how long it is right now.</summary>
    public sealed record Found(string Path, string FileName, long Length);

    /// <summary>
    /// The most recently written <c>.dem</c> in <paramref name="folder"/>, or <c>null</c>
    /// when the folder holds none. <paramref name="contains"/> narrows it to the files
    /// whose name carries a marker (MatchZy puts the match's <c>matchid</c> in its demo
    /// names, so a server that played twice does not hand over the wrong match's demo).
    /// </summary>
    public static Found? Newest(string folder, string? contains = null)
    {
        if (!Directory.Exists(folder))
        {
            return null;
        }

        Found? newest = null;
        var newestAt = DateTime.MinValue;
        foreach (var path in Directory.GetFiles(folder, "*.dem"))
        {
            var name = Path.GetFileName(path);
            if (contains is { Length: > 0 } marker && !name.Contains(marker, StringComparison.Ordinal))
            {
                continue;
            }

            FileInfo info;
            try
            {
                info = new FileInfo(path);
                if (!info.Exists)
                {
                    continue;
                }
            }
            catch (IOException)
            {
                continue;
            }

            if (newest is null || info.LastWriteTimeUtc > newestAt)
            {
                newest = new Found(path, name, info.Length);
                newestAt = info.LastWriteTimeUtc;
            }
        }

        return newest;
    }
}
