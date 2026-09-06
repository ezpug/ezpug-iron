using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace EZPug.Core;

/// <summary>
/// <b>MatchZy's round backups, as the link carries them.</b> On every live round start
/// MatchZy writes <c>game/csgo/MatchZyDataBackup/matchzy_&lt;matchid&gt;_&lt;map&gt;_round&lt;NN&gt;.json</c>
/// (<c>BackupManagement.cs</c> <c>CreateMatchZyRoundDataBackup</c>): its own match state
/// plus the engine's <c>mp_backup_round_file</c> text inside, which is what its restore
/// reads back. <c>NN</c> is the rounds completed, so the file restores to round
/// <c>NN + 1</c> — the vocabulary's <c>backup_written.roundNumber</c>.
///
/// The file carries MatchZy's whole config object (<c>match_config</c>), remote-log
/// header value included — this server's link token. <see cref="Scrub"/> blanks it before
/// the content crosses the link, so the orchestrator's <c>backups</c> table never holds a
/// secret; a restore (PRD-02 T14) points the remote log again after loading the file.
/// </summary>
public static class MatchZyBackups
{
    public const string Folder = "MatchZyDataBackup";

    /// <summary>The keys of MatchZy's serialised config that hold the remote-log header value.</summary>
    private static readonly string[] SecretConfigKeys = ["RemoteLogHeaderValue"];

    private static readonly Regex FileName = new(@"^matchzy_(\d+)_(\d+)_round(\d+)\.json$", RegexOptions.CultureInvariant);

    public sealed record Found(string Path, string FileName, int RoundsCompleted);

    /// <summary>The newest backup of one match and map in <paramref name="folder"/> by its round number, or <c>null</c>.</summary>
    public static Found? Newest(string folder, long serial, int mapIndex)
    {
        if (!Directory.Exists(folder))
        {
            return null;
        }

        Found? newest = null;
        foreach (var path in Directory.GetFiles(folder, "matchzy_*.json"))
        {
            var name = Path.GetFileName(path);
            var match = FileName.Match(name);
            if (!match.Success
                || !long.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var fileSerial)
                || !int.TryParse(match.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var fileMap)
                || !int.TryParse(match.Groups[3].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var round)
                || fileSerial != serial || fileMap != mapIndex)
            {
                continue;
            }

            if (newest is null || round > newest.RoundsCompleted)
            {
                newest = new Found(path, name, round);
            }
        }

        return newest;
    }

    /// <summary>
    /// The backup with the remote-log header value removed from <c>match_config</c> (and
    /// from the changed/original cvar maps, should a future MatchZy put it there), compact.
    /// Anything that is not a JSON object comes back as it was.
    /// </summary>
    public static string Scrub(string json)
    {
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return json;
        }

        if (node is not JsonObject backup)
        {
            return json;
        }

        if (backup["match_config"] is JsonValue configValue && configValue.TryGetValue<string>(out var configJson))
        {
            JsonNode? config;
            try
            {
                config = JsonNode.Parse(configJson);
            }
            catch (JsonException)
            {
                config = null;
            }

            if (config is JsonObject configObject)
            {
                foreach (var key in SecretConfigKeys)
                {
                    if (configObject.ContainsKey(key))
                    {
                        configObject[key] = "";
                    }
                }

                foreach (var map in new[] { "changed_cvars", "original_cvars" })
                {
                    if (configObject[map] is JsonObject cvars)
                    {
                        foreach (var name in cvars.Select(pair => pair.Key).Where(IsRemoteLogSecret).ToList())
                        {
                            cvars[name] = "";
                        }
                    }
                }

                backup["match_config"] = configObject.ToJsonString();
            }
        }

        return backup.ToJsonString();
    }

    private static bool IsRemoteLogSecret(string cvar) =>
        cvar.EndsWith("remote_log_header_value", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The inverse of <see cref="Scrub"/>, for a backup that crossed the link and is about to
    /// be written for MatchZy on <i>this</i> server (PRD-02 T14): the remote log inside
    /// <c>match_config</c> pointed at the orchestrator with this server's token, because
    /// MatchZy's restore deserialises that config — twice, once when the file is loaded and
    /// again when the match starts — and the URL alone, with the header blanked, would post
    /// every match-flow event of the resumed match at a door that refuses it. The cvar maps
    /// get the same value where the dead server's config carried the key. Anything that is
    /// not a JSON object comes back as it was.
    /// </summary>
    public static string WithRemoteLog(string json, MatchZyRemoteLog remoteLog)
    {
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return json;
        }

        if (node is not JsonObject backup)
        {
            return json;
        }

        if (backup["match_config"] is not JsonValue configValue || !configValue.TryGetValue<string>(out var configJson))
        {
            return json;
        }

        JsonNode? config;
        try
        {
            config = JsonNode.Parse(configJson);
        }
        catch (JsonException)
        {
            return json;
        }

        if (config is not JsonObject configObject)
        {
            return json;
        }

        configObject["RemoteLogURL"] = remoteLog.Url.ToString();
        configObject["RemoteLogHeaderKey"] = remoteLog.HeaderKey;
        configObject["RemoteLogHeaderValue"] = remoteLog.HeaderValue;
        foreach (var map in new[] { "changed_cvars", "original_cvars" })
        {
            if (configObject[map] is JsonObject cvars)
            {
                foreach (var name in cvars.Select(pair => pair.Key).Where(IsRemoteLogSecret).ToList())
                {
                    cvars[name] = remoteLog.HeaderValue;
                }
            }
        }

        backup["match_config"] = configObject.ToJsonString();
        return backup.ToJsonString();
    }

    /// <summary>A backup file name as MatchZy wrote it and the link carried it: a name, never a path.</summary>
    public static bool IsSafeFileName(string filename) =>
        !string.IsNullOrWhiteSpace(filename)
        && !filename.Contains('/')
        && !filename.Contains('\\')
        && !filename.Contains("..")
        && filename.EndsWith(".json", StringComparison.OrdinalIgnoreCase);
}
