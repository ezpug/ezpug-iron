using System.Text.RegularExpressions;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>Half time is all-talk</b> (PRD-09 T4), every edge on the fake clock: the stretch
/// opens on the phase as the half's last round ends, says <c>halftime_started</c>, sets the
/// voice cvars, says one line and draws the band; it closes the instant the next round
/// starts, and on a pause that ends, a map change, the map's end, the release and an unload.
/// A match that keeps the teams apart says the fact and touches nothing else.
/// </summary>
public class HalftimeTests
{
    private const string Addon = "3811574606";
    private const ulong Ada = 76561198000000001;
    private const ulong Ben = 76561198000000002;
    private const ulong Cleo = 76561198000000003;

    /// <summary>What MatchZy's <c>live.cfg</c> leaves the voice at for a live match.</summary>
    private static readonly (string Name, string Value)[] LiveCfg =
    [
        ("sv_talk_enemy_living", "0"),
        ("sv_talk_enemy_dead", "0"),
        ("sv_alltalk", "0"),
        ("sv_full_alltalk", "0"),
        ("sv_deadtalk", "1"),
    ];

    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", id, "manifest.json")));

    private static GameRules Rules(GamePhase phase, int played = 2, bool swapping = false, bool paused = false) =>
        new(Warmup: false, played, paused, TerroristTimeout: false, CounterTerroristTimeout: false, TechnicalTimeout: false, swapping, phase);

    /// <summary>A pug of Ada (German, team A on CT) against Ben (English), live in its first half, the voice as MatchZy's live.cfg leaves it.</summary>
    private static GamemodeTestHost Live(bool voice = true, bool hud = false, string gamemode = "pug")
    {
        var host = new GamemodeTestHost(hudAddon: hud ? Addon : null);
        var assignment = GamemodeTestHost.AssignmentFor(
            Manifest(gamemode),
            teamA: [GamemodeTestHost.Player(Ada, "Ada")],
            teamB: [GamemodeTestHost.Player(Ben, "Ben", Locale.En)],
            maps: [new MapPlan { Map = "de_mirage", Sides = MapPlanSides.Ct }],
            hud: hud);
        host.Start(voice ? assignment with { HalftimeVoice = true } : assignment);
        foreach (var (name, value) in LiveCfg)
        {
            host.World.SetCvar(name, value);
        }

        host.World.Connect(Ada, "Ada", PlayerTeam.CounterTerrorist);
        host.World.Connect(Ben, "Ben", PlayerTeam.Terrorist);
        host.World.Rules = Rules(GamePhase.PlayingFirstHalf, played: 1);
        host.World.StartRound();
        host.World.Actions.Clear();
        return host;
    }

    /// <summary>The half's last round ends and the engine turns the phase over with it.</summary>
    private static void EndTheHalf(GamemodeTestHost host)
    {
        host.World.Rules = Rules(GamePhase.Halftime, swapping: true);
        host.World.EndRound(PlayerTeam.Terrorist, RoundEndReason.Elimination, tScore: 1, ctScore: 1);
    }

    /// <summary>The next half's first round starts its freeze time, the phase moved on.</summary>
    private static void StartTheNextHalf(GamemodeTestHost host)
    {
        host.World.Rules = Rules(GamePhase.PlayingSecondHalf);
        host.World.StartRound();
    }

    private static Dictionary<string, string?> Voice(GamemodeTestHost host) =>
        LiveCfg.ToDictionary(cvar => cvar.Name, cvar => host.World.GetCvar(cvar.Name));

    private static Dictionary<string, string?> Expected(bool open) =>
        open
            ? Halftime.Cvars.ToDictionary(cvar => cvar.Name, cvar => (string?)cvar.Open)
            : LiveCfg.ToDictionary(cvar => cvar.Name, cvar => (string?)cvar.Value);

    private static IReadOnlyList<WorldAction> CvarWrites(GamemodeTestHost host) =>
        [.. host.World.Actions.Where(action => action.Verb == "cvar")];

    private static string Line(GamemodeTestHost host, string text) => host.Runtime.Brand.Line(text);

    private const string OpenDe = "Halbzeit: Alle hören alle, bis die nächste Runde beginnt.";
    private const string OpenEn = "Half time: everyone can talk until the next round starts.";
    private const string ClosedDe = "Die Halbzeit ist vorbei: Ab jetzt hört dich nur dein Team.";
    private const string ClosedEn = "Half time is over: only your team can hear you now.";

    [Fact]
    public void ThePugClaimsIt_AndRushNeverDoes()
    {
        Assert.True(Manifest("pug").Capabilities.HalftimeVoice);
        Assert.False(Manifest("rush").Capabilities.HalftimeVoice);
        Assert.False(Manifest("retakes").Capabilities.HalftimeVoice);
    }

    [Fact]
    public void TheHalfsLastRoundOpensTheVoice_SaysTheFact_AndTheNextFreezeClosesIt()
    {
        using var host = Live();
        Assert.True(host.Runtime.Halftime.Voice);
        Assert.Equal(Expected(open: false), Voice(host));

        EndTheHalf(host);
        Assert.True(host.Runtime.Halftime.Open);
        Assert.Equal(Expected(open: true), Voice(host));
        // The fact: the sides after the break (the gamerules flag the swap), and the voice open.
        var fact = Assert.Single(host.Link.EventsOf<HalftimeStartedEvent>());
        Assert.Equal(TeamSide.T, fact.Sides.TeamA);
        Assert.Equal(TeamSide.Ct, fact.Sides.TeamB);
        Assert.True(fact.AllTalk);
        Assert.Equal(1, fact.MapNumber);
        // After the round's own end, never before it.
        Assert.Equal("halftime_started", host.Link.EventTypes[^1]);
        // One line each, in their own language.
        Assert.Equal(Line(host, OpenDe), host.World.Said[Ada][^1]);
        Assert.Equal(Line(host, OpenEn), host.World.Said[Ben][^1]);
        Assert.Contains(host.Logged, line => line.StartsWith("info: halftime: began after round 2; all-talk open (sv_talk_enemy_living 0 -> 1", StringComparison.Ordinal));
        Assert.StartsWith("half time is all-talk, open for 0 ms (sv_talk_enemy_living 1, sv_talk_enemy_dead 1", host.Runtime.Halftime.Report(), StringComparison.Ordinal);

        // The whole break, and not a cvar more: nothing is written again while it stands.
        host.World.Actions.Clear();
        host.World.Elapse(15_000);
        Assert.Empty(CvarWrites(host));
        Assert.True(host.Runtime.Halftime.Open);

        StartTheNextHalf(host);
        Assert.False(host.Runtime.Halftime.Open);
        Assert.Equal(Expected(open: false), Voice(host));
        Assert.Equal(Line(host, ClosedDe), host.World.Said[Ada][^1]);
        Assert.Equal(Line(host, ClosedEn), host.World.Said[Ben][^1]);
        Assert.Contains("info: halftime: all-talk closed after 15000 ms, the next round's freeze time began (sv_talk_enemy_living 0, sv_talk_enemy_dead 0, sv_alltalk 0, sv_full_alltalk 0, sv_deadtalk 1)", host.Logged);
        Assert.StartsWith("half time is all-talk, closed now (sv_talk_enemy_living 0", host.Runtime.Halftime.Report(), StringComparison.Ordinal);
        Assert.Single(host.Link.EventsOf<HalftimeStartedEvent>());
    }

    [Fact]
    public void APhaseTheEngineTurnsAFrameAfterTheRoundEnd_IsFoundByThePoll()
    {
        using var host = Live();
        host.World.EndRound(PlayerTeam.Terrorist, RoundEndReason.Elimination, tScore: 1, ctScore: 1);
        Assert.False(host.Runtime.Halftime.Open);

        host.World.Rules = Rules(GamePhase.Halftime, swapping: true);
        host.World.Elapse(Halftime.PollIntervalMs);
        Assert.True(host.Runtime.Halftime.Open);
        Assert.Single(host.Link.EventsOf<HalftimeStartedEvent>());
    }

    [Fact]
    public void ARoundStartBeforeThePhaseMovesOn_DoesNotOpenItAgain_ButTheNextBreakDoes()
    {
        using var host = Live();
        EndTheHalf(host);
        // The engine starts the round a frame before the phase says the second half.
        host.World.StartRound();
        Assert.False(host.Runtime.Halftime.Open);
        host.World.Elapse(Halftime.PollIntervalMs);
        Assert.False(host.Runtime.Halftime.Open);
        Assert.Equal(Expected(open: false), Voice(host));

        // The second half, then overtime's own break: a new stretch, a new fact.
        host.World.Rules = Rules(GamePhase.PlayingSecondHalf, played: 3);
        host.World.Elapse(Halftime.PollIntervalMs);
        host.World.Rules = Rules(GamePhase.Halftime, played: 4, swapping: false);
        host.World.Elapse(Halftime.PollIntervalMs);
        Assert.True(host.Runtime.Halftime.Open);
        var facts = host.Link.EventsOf<HalftimeStartedEvent>();
        Assert.Equal(2, facts.Count);
        // No swap flagged at this break: team A stays where the context holds it.
        Assert.Equal(TeamSide.Ct, facts[1].Sides.TeamA);
    }

    [Fact]
    public void APauseThatEnds_ClosesIt()
    {
        using var host = Live();
        EndTheHalf(host);
        host.World.Rules = Rules(GamePhase.Halftime, swapping: true, paused: true);
        host.World.Elapse(Halftime.PollIntervalMs);
        Assert.True(host.Runtime.Halftime.Open);

        host.World.Rules = Rules(GamePhase.Halftime, swapping: true);
        host.World.Elapse(Halftime.PollIntervalMs);
        Assert.False(host.Runtime.Halftime.Open);
        Assert.Equal(Expected(open: false), Voice(host));
        Assert.Contains(host.Logged, line => line.Contains("all-talk closed after 500 ms, a pause ended", StringComparison.Ordinal));
        Assert.Equal(Line(host, ClosedEn), host.World.Said[Ben][^1]);
    }

    [Fact]
    public void AMapChange_ClosesItWithoutALine()
    {
        using var host = Live();
        EndTheHalf(host);
        var said = host.World.Said[Ada].Count;
        host.World.StartMap("de_nuke");
        Assert.False(host.Runtime.Halftime.Open);
        Assert.Equal(Expected(open: false), Voice(host));
        Assert.Equal(said, host.World.Said[Ada].Count);
    }

    [Fact]
    public void TheMapsEnd_ClosesIt()
    {
        using var host = Live();
        EndTheHalf(host);
        host.World.EndMap();
        Assert.False(host.Runtime.Halftime.Open);
        Assert.Equal(Expected(open: false), Voice(host));
        Assert.Equal(Line(host, ClosedDe), host.World.Said[Ada][^1]);
    }

    [Fact]
    public void TheRelease_ClosesIt()
    {
        using var host = Live();
        EndTheHalf(host);
        host.Link.Release("force_end");
        Assert.False(host.Runtime.Halftime.Open);
        Assert.Equal(Expected(open: false), Voice(host));
        Assert.Equal("no match", host.Runtime.Halftime.Report());

        // Nothing is watched any more: a phase that says half time now is nobody's.
        host.World.Rules = Rules(GamePhase.Halftime, swapping: true);
        host.World.Elapse(Halftime.PollIntervalMs);
        Assert.Equal(Expected(open: false), Voice(host));
    }

    [Fact]
    public void AnUnload_ClosesIt()
    {
        var host = Live();
        EndTheHalf(host);
        host.Dispose();
        Assert.Equal(Expected(open: false), Voice(host));
    }

    [Fact]
    public void AMatchThatKeepsTheTeamsApart_SaysTheFactAndTouchesNothing()
    {
        using var host = Live(voice: false);
        Assert.False(host.Runtime.Halftime.Voice);
        var said = host.World.Said[Ada].Count;
        EndTheHalf(host);
        var fact = Assert.Single(host.Link.EventsOf<HalftimeStartedEvent>());
        Assert.False(fact.AllTalk);
        Assert.False(host.Runtime.Halftime.Open);
        StartTheNextHalf(host);
        Assert.Empty(CvarWrites(host));
        Assert.Equal(said, host.World.Said[Ada].Count);
        Assert.DoesNotContain(host.World.Actions, action => action.Verb.StartsWith("hud_", StringComparison.Ordinal));
        Assert.Equal("half time keeps the teams apart in this match", host.Runtime.Halftime.Report());
    }

    [Fact]
    public void ACvarTheEngineDoesNotKnow_IsLeftAlone()
    {
        using var host = new GamemodeTestHost();
        host.Start(GamemodeTestHost.AssignmentFor(Manifest("pug")) with { HalftimeVoice = true });
        host.World.SetCvar("sv_talk_enemy_living", "0");
        host.World.Rules = Rules(GamePhase.PlayingFirstHalf);
        host.World.StartRound();
        host.World.Actions.Clear();
        EndTheHalf(host);
        Assert.Equal(["cvar sv_talk_enemy_living 1"], CvarWrites(host).Select(action => action.ToString()));
        StartTheNextHalf(host);
        Assert.Equal("0", host.World.GetCvar("sv_talk_enemy_living"));
        Assert.Null(host.World.GetCvar("sv_full_alltalk"));
    }

    [Fact]
    public void TheBand_StandsForTheWholeStretch_InEachPersonsLanguage_AndGoesWithTheVoice()
    {
        using var host = Live(hud: true);
        var layout = host.World.HudLayout(Halftime.Layout);
        var ada = host.World.Find(Ada)!;
        var ben = host.World.Find(Ben)!;
        Assert.False(layout.Classes.GetValueOrDefault((Halftime.Band, Halftime.Shown)));

        EndTheHalf(host);
        Assert.True(layout.Classes[(Halftime.Band, Halftime.Shown)]);
        Assert.Equal("Halbzeit, alle hören alle", layout.Variable(ada.Slot, Halftime.BandText, Moments.Text));
        Assert.Equal("Half time, everyone can talk", layout.Variable(ben.Slot, Halftime.BandText, Moments.Text));

        // Somebody who connects while it stands is told their words over the slot's reset.
        var cleo = host.World.Connect(Cleo, "Cleo", PlayerTeam.Spectator);
        Assert.Equal("Halbzeit, alle hören alle", layout.Variable(cleo.Slot, Halftime.BandText, Moments.Text));
        host.World.Elapse(Hud.ResendDelayMs);
        Assert.Equal("Halbzeit, alle hören alle", layout.Variable(cleo.Slot, Halftime.BandText, Moments.Text));

        StartTheNextHalf(host);
        Assert.False(layout.Classes[(Halftime.Band, Halftime.Shown)]);
        // The line is said either way: everything the HUD shows is also a chat line (decision 34).
        Assert.Equal(Line(host, ClosedDe), host.World.Said[Ada][^1]);
    }

    [Fact]
    public void EveryPanelAndClassTheBandNamesIsInTheLayout()
    {
        var xml = Regex.Replace(File.ReadAllText(Repo.Path("hud", "layout", "ezpug_moment.xml")), @"<!--[\s\S]*?-->", "");
        var css = Regex.Replace(File.ReadAllText(Repo.Path("hud", "styles", "ezpug_halftime.css")), @"/\*[\s\S]*?\*/", "");
        Assert.Equal(Moments.Layout, Halftime.Layout);
        Assert.Matches(new Regex($"<Panel id=\"{Halftime.Band}\" class=\"ezpug-halftime\""), xml);
        Assert.Matches(new Regex($"<Label id=\"{Halftime.BandText}\"[^>]* text=\"\\{{s:{Moments.Text}\\}}\""), xml);
        Assert.Contains("<include src=\"s2r://panorama/styles/custom_game/ezpug_halftime.vcss_c\" />", xml, StringComparison.Ordinal);
        Assert.Contains($".ezpug-halftime.{Halftime.Shown}\n", css, StringComparison.Ordinal);
        // Put away with the voice, and quickly: one transition, over well inside a second.
        Assert.Single(Regex.Matches(css, @"transition-property\s*:"));
        Assert.Contains("transition-duration: 0.25s;", css, StringComparison.Ordinal);
    }
}
