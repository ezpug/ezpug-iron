using System.Text.Json.Nodes;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// One match as the orchestrator assigned it to this server (<c>assign</c>, composed in
/// <c>apps/orchestrator/src/link/assign.ts</c>): the manifest resolved, the plugins to
/// enable and their own config files, the cfg and the flat cvars, the map plan, the rules, the roster with every
/// profile and loadout, the warmup lines, the branding, the demo's upload URL, and the
/// backup to restore when the match resumes here. Profiles pushed later
/// (<c>profile</c> frames: open-join players, a refreshed rating) land in
/// <see cref="Profiles"/> too, so a mode asks one place who somebody is.
/// </summary>
public sealed class Assignment
{
    private readonly Dictionary<ulong, RosterEntry> _profiles = new();
    private readonly Dictionary<ulong, MatchTeam> _rostered = new();

    public Assignment(AssignOrchestratorFrame frame)
    {
        Frame = frame;
        foreach (var player in frame.Teams.TeamA.Players)
        {
            Push(player, MatchTeam.TeamA);
        }

        foreach (var player in frame.Teams.TeamB.Players)
        {
            Push(player, MatchTeam.TeamB);
        }
    }

    /// <summary>The frame as it arrived, for anything this class does not name.</summary>
    public AssignOrchestratorFrame Frame { get; }

    public string MatchId => Frame.MatchId;
    public Game Game => Frame.Game;
    public AssignedGamemode Gamemode => Frame.Gamemode;
    public IReadOnlyList<string> Plugins => Frame.Plugins;
    public IReadOnlyList<string> Cfg => Frame.Cfg;
    public IReadOnlyDictionary<string, string> Cvars => Frame.Cvars;
    public JsonObject? MatchzyConfig => Frame.MatchzyConfig;

    /// <summary>A vendored plugin's own config file, by plugin folder — what the loader writes where CounterStrikeSharp reads it, before the folder is enabled (PRD-02 T23).</summary>
    public IReadOnlyDictionary<string, JsonObject>? PluginConfigs => Frame.PluginConfigs;
    public IReadOnlyList<MapPlan> Maps => Frame.Maps;
    public MatchRules? Rules => Frame.Rules;
    public MatchTeams Teams => Frame.Teams;
    public IReadOnlyList<string> WarmupLines => Frame.WarmupLines;
    public MatchBranding Branding => Frame.Branding;
    public string? DemoUploadUrl => Frame.DemoUploadUrl;

    /// <summary>The match asks for the HUD (decision 34). What a server without the addon does with that is nothing at all: <see cref="EZPug.Sdk.Hud"/>.</summary>
    public bool Hud => Frame.Hud == true;

    /// <summary>One presigned PUT per map of a series (PRD-02 T38a); <see cref="DemoUploadUrlFor"/> is how to read it.</summary>
    public IReadOnlyList<AssignOrchestratorFrameDemoUploadUrl>? DemoUploadUrls => Frame.DemoUploadUrls;

    public RoundBackup? Restore => Frame.Restore;

    /// <summary>The request's <c>simulation</c> block: present means the roster is played by puppets (PRD-03 T7) — every entry, or the ones its <c>puppets</c> list names (PRD-04 T2, <see cref="IsPuppet"/>). Who seats them is <see cref="Puppeteer.Seats"/>'s question.</summary>
    public MatchSimulation? Simulation => Frame.Simulation;

    /// <summary>
    /// Whether the roster entry <paramref name="steamId64"/> is played by a puppet (PRD-04 T2):
    /// the match is simulated, the player is rostered, and <c>simulation.puppets</c> either
    /// names them or names nobody in particular. A rostered player a partial list leaves out
    /// is a person, expected through the mode's ordinary door, and the seat is never a bot's.
    /// </summary>
    public bool IsPuppet(ulong steamId64)
    {
        if (Simulation is not { } simulation || !IsRostered(steamId64))
        {
            return false;
        }

        return simulation.Puppets is not { } named || named.Contains(steamId64.ToString());
    }

    /// <summary>How many roster entries a partial <c>simulation.puppets</c> leaves to people; zero for an all-puppet or a real match.</summary>
    public int HumansAmongPuppets =>
        Simulation is null ? 0 : _rostered.Keys.Count(steamId64 => !IsPuppet(steamId64));

    /// <summary>What the puppets do beyond playing the match out (PRD-03 T11): the scenario the request named, resolved into knobs by the orchestrator. Absent is "just play it".</summary>
    public PuppetScript? Puppets => Frame.Puppets;

    /// <summary>
    /// Where map <paramref name="mapNumber"/>'s demo goes: its own presigned PUT when the
    /// request drew one, else the single <see cref="DemoUploadUrl"/>, else nowhere. The same
    /// rule the orchestrator and the published fake follow (`demoUploadUrlFor`).
    /// </summary>
    public string? DemoUploadUrlFor(int mapNumber)
    {
        if (DemoUploadUrls is { } urls)
        {
            foreach (var entry in urls)
            {
                if (entry.MapNumber == mapNumber)
                {
                    return entry.Url;
                }
            }
        }

        return DemoUploadUrl;
    }

    /// <summary>Every profile known — the roster's, plus each one pushed since — by SteamID64.</summary>
    public IReadOnlyDictionary<ulong, RosterEntry> Profiles => _profiles;

    public RosterEntry? ProfileOf(ulong steamId64) => _profiles.GetValueOrDefault(steamId64);

    /// <summary>The team the roster puts a player on; <c>null</c> for somebody who joined open.</summary>
    public MatchTeam? RosteredTeamOf(ulong steamId64) =>
        _rostered.TryGetValue(steamId64, out var team) ? team : null;

    public bool IsRostered(ulong steamId64) => _rostered.ContainsKey(steamId64);

    /// <summary>The player's locale from their profile; German when nobody knows them (CLAUDE.md "Bilingual").</summary>
    public Locale LocaleOf(ulong steamId64) => ProfileOf(steamId64)?.Locale ?? Localizer.DefaultLocale;

    /// <summary>The locale most rostered players speak, for a line everybody reads at once (the warmup lines).</summary>
    public Locale MajorityLocale()
    {
        var english = _profiles.Values.Count(profile => profile.Locale == Locale.En);
        return english > _profiles.Count - english ? Locale.En : Locale.De;
    }

    /// <summary>A pushed profile: added, or replacing the roster's copy of the same player.</summary>
    public void Push(RosterEntry player) => Push(player, null);

    private void Push(RosterEntry player, MatchTeam? team)
    {
        if (!ulong.TryParse(player.SteamId64, out var steamId64))
        {
            return;
        }

        _profiles[steamId64] = player;
        if (team is { } rostered)
        {
            _rostered[steamId64] = rostered;
        }
    }
}
