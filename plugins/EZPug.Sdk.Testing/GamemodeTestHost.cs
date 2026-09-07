using System.Text.Json;
using EZPug.Sdk;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk.Testing;

/// <summary>
/// <b>Run a gamemode under xunit without CS2</b>: a <see cref="FakeGameWorld"/> on a
/// <see cref="FakeClock"/>, a <see cref="FakePlatformLink"/>, the real
/// <see cref="GamemodeRuntime"/> between them, and the mode attached. A test scripts
/// the world (players connect, spawn, die, type), pushes the orchestrator's frames
/// through the link, advances the clock, and asserts the exact events the mode emitted.
/// <see cref="AssignmentFor"/> builds an <c>assign</c> from a manifest the way the
/// orchestrator composes one, so a test starts from the shipped <c>manifest.json</c>.
/// </summary>
public sealed class GamemodeTestHost : IDisposable
{
    /// <summary>
    /// <paramref name="mode"/> may be <c>null</c>: a <c>config</c>-tier mode is a manifest
    /// and a cfg with no class anywhere (PRD-02 T22), and the runtime — the vocabulary it
    /// emits, the SDK's generic flow — is exactly what such a match is made of.
    /// </summary>
    public GamemodeTestHost(Gamemode? mode = null, FakeClock? clock = null, string map = "de_mirage")
    {
        Clock = clock ?? new FakeClock();
        World = new FakeGameWorld(Clock, map);
        Link = new FakePlatformLink();
        Runtime = new GamemodeRuntime(World, Link);
        Mode = mode;
        if (mode is not null)
        {
            Runtime.Attach(mode);
        }

        Link.Welcome();
    }

    public FakeClock Clock { get; }
    public FakeGameWorld World { get; }
    public FakePlatformLink Link { get; }
    public GamemodeRuntime Runtime { get; }
    public Gamemode? Mode { get; }

    /// <summary>Assign the match and bring the first map up, which is when <c>OnStart</c> fires and <c>server_ready</c> is emitted.</summary>
    public Assignment Start(AssignOrchestratorFrame assignment)
    {
        Link.Assign(assignment);
        World.StartMap(assignment.Maps[0].Map);
        return Runtime.Assignment!;
    }

    /// <summary>
    /// An <c>assign</c> for <paramref name="manifest"/> (the shipped JSON, as a string or a
    /// parsed <see cref="AssignedGamemode"/>) with a Bo1 on the manifest's first map or
    /// <paramref name="map"/> (or the whole <paramref name="maps"/> plan for a series), the
    /// roster given, the mode's own cvars, no rules. What the orchestrator's
    /// <c>link/assign.ts</c> would compose for a plain request.
    /// </summary>
    public static AssignOrchestratorFrame AssignmentFor(
        AssignedGamemode manifest,
        string matchId = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b",
        string map = "de_mirage",
        IReadOnlyList<RosterEntry>? teamA = null,
        IReadOnlyList<RosterEntry>? teamB = null,
        IReadOnlyList<MapPlan>? maps = null,
        MatchBranding? branding = null) =>
        new()
        {
            MatchId = matchId,
            Game = manifest.Game,
            Gamemode = manifest,
            Plugins = manifest.Plugins,
            Cfg = manifest.Cfg,
            Cvars = new Dictionary<string, string>(manifest.Cvars),
            Maps = maps ?? [new MapPlan { Map = map, Sides = MapPlanSides.Knife }],
            Teams = new MatchTeams
            {
                TeamA = new Roster { Name = "Team A", Players = teamA ?? [] },
                TeamB = new Roster { Name = "Team B", Players = teamB ?? [] },
            },
            Branding = branding ?? new MatchBranding(),
        };

    /// <summary>Read a shipped <c>gamemodes/&lt;id&gt;/manifest.json</c> as the server would receive it (maps and widget dropped).</summary>
    public static AssignedGamemode ManifestFrom(string json)
    {
        var node = JsonSerializer.Deserialize<System.Text.Json.Nodes.JsonObject>(json)
            ?? throw new JsonException("the manifest is not an object");
        node.Remove("maps");
        node.Remove("widget");
        return ProtocolJson.Deserialize<AssignedGamemode>(node.ToJsonString());
    }

    public static RosterEntry Player(ulong steamId64, string name, Locale locale = Locale.De, long? rating = null) =>
        new() { SteamId64 = steamId64.ToString(), Name = name, Locale = locale, Rating = rating };

    public void Dispose() => Runtime.Dispose();
}
