using EZPug.Sdk;

namespace EZPug.Core;

/// <summary>
/// <c>ezpug_restore &lt;file&gt; &lt;round&gt;</c>: load a round backup that is already on
/// disk under <c>game/csgo</c> — the operator's door to what MatchZy's own <c>.restore</c>
/// does, by file name. The engine's <c>mp_backup_restore_load_file</c> does the work; the
/// whole recovery flow (the backup arriving in the assignment, the file written here,
/// <c>server_ready</c> re-announced with the round) is PRD-02 T14 and builds on this.
/// The file name is a name, never a path: no separators, no parent references.
/// </summary>
public static class BackupRestorer
{
    public sealed record Outcome(bool Applied, string Message);

    public static Outcome Restore(IGameWorld world, string csgoDirectory, string file, string round)
    {
        if (string.IsNullOrWhiteSpace(file) || file.Contains('/') || file.Contains('\\') || file.Contains("..") || !file.EndsWith(".txt", StringComparison.OrdinalIgnoreCase))
        {
            return new Outcome(false, "usage: ezpug_restore <backup file name ending in .txt, no path> <round>");
        }

        if (!int.TryParse(round, out var roundNumber) || roundNumber < 0)
        {
            return new Outcome(false, "usage: ezpug_restore <file> <round: a non-negative number>");
        }

        if (!File.Exists(Path.Combine(csgoDirectory, file)))
        {
            return new Outcome(false, $"no backup named {file} under {csgoDirectory}");
        }

        world.ExecCommand($"mp_backup_restore_load_file {file}");
        return new Outcome(true, $"restoring round {roundNumber} from {file}");
    }
}
