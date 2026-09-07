using EZPug.Sdk;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Core.Tests;

/// <summary>
/// <b>The skins hand-off</b> (PRD-02 T28, decision 20): the core plugin's <see cref="RosterLoadouts"/>
/// answers the WeaponPaints fork out of the assignment's profiles — the roster's loadouts,
/// then every <c>profile</c> pushed since — and says on the console that it did, because on
/// a bots run that line is the only place the hand-off can be seen.
/// </summary>
public class RosterLoadoutsTests
{
    private const ulong Tk = 76561198279375306;
    private const ulong Maex = 76561198279375307;
    private const ulong Stranger = 76561198000000009;

    private static AssignedGamemode Manifest(string id) =>
        GamemodeTestHost.ManifestFrom(File.ReadAllText(Path.Combine(Repo.Root, "gamemodes", id, "manifest.json")));

    private static Loadout Karambit() => new()
    {
        T = new SideLoadout
        {
            Knife = "weapon_knife_karambit",
            Gloves = 5027,
            Agent = "customplayer_tm_leet_variantg",
            Music = 3,
            Pin = 874,
            Weapons = [new WeaponSkin { Defindex = 7, PaintId = 490 }],
        },
        Ct = new SideLoadout { Weapons = [new WeaponSkin { Defindex = 60, PaintId = 1231 }] },
    };

    private sealed class Rig : IDisposable
    {
        public Rig()
        {
            World = new FakeGameWorld(map: "de_mirage");
            Link = new FakePlatformLink();
            Runtime = new GamemodeRuntime(World, Link, Log);
            Loadouts = new RosterLoadouts(Runtime, Log);
            Loadouts.LoadoutChanged += steamId64 => Changed.Add(steamId64);
            Link.Welcome();
        }

        public FakeGameWorld World { get; }
        public FakePlatformLink Link { get; }
        public GamemodeRuntime Runtime { get; }
        public RosterLoadouts Loadouts { get; }
        public GamemodeLoaderTests.RecordingLog Log { get; } = new();
        public List<ulong> Changed { get; } = [];

        public IReadOnlyList<string> SkinsLines => Log.Lines.Where(line => line.Contains("skins:")).ToList();

        public void Dispose()
        {
            Loadouts.Dispose();
            Runtime.Dispose();
        }
    }

    [Fact]
    public void TheRostersLoadoutsAreHandedOutAndNobodyElseGetsOne()
    {
        using var rig = new Rig();
        // No match: nothing to hand out, and that is an answer, not an error.
        Assert.Null(rig.Loadouts.LoadoutOf(Tk));

        var karambit = Karambit();
        rig.Link.Assign(GamemodeTestHost.AssignmentFor(
            Manifest("retakes"),
            teamA: [new RosterEntry { SteamId64 = Tk.ToString(), Name = "tk", Loadout = karambit }],
            teamB: [GamemodeTestHost.Player(Maex, "maex")]));

        // The roster's own object — a lookup in the assignment, no copy to go stale.
        Assert.Same(karambit, rig.Loadouts.LoadoutOf(Tk));
        // A rostered player without one, and a stranger, both get default items.
        Assert.Null(rig.Loadouts.LoadoutOf(Maex));
        Assert.Null(rig.Loadouts.LoadoutOf(Stranger));
        Assert.Empty(rig.Changed);

        Assert.Equal(
            [
                $"info: skins: no loadout for {Tk}; default items",
                $"info: skins: handed {Tk}'s loadout to the skins layer (t: 1 weapon, knife, gloves, agent, music, pin; ct: 1 weapon)",
                $"info: skins: no loadout for {Maex}; default items",
                $"info: skins: no loadout for {Stranger}; default items",
            ],
            rig.SkinsLines);
    }

    [Fact]
    public void AProfilePushIsAnnouncedAndReadBackWhateverItCarries()
    {
        using var rig = new Rig();
        rig.Link.Assign(GamemodeTestHost.AssignmentFor(
            Manifest("retakes"),
            teamA: [new RosterEntry { SteamId64 = Tk.ToString(), Name = "tk", Loadout = Karambit() }]));

        // Somebody who joined open: their profile arrives with a loadout, the skins layer is
        // told, and the read that follows is the pushed one.
        var pushed = new Loadout { Ct = new SideLoadout { Knife = "weapon_knife_butterfly" } };
        rig.Link.PushProfile(new RosterEntry { SteamId64 = Stranger.ToString(), Name = "Ada", Loadout = pushed });
        Assert.Equal([Stranger], rig.Changed);
        Assert.Same(pushed, rig.Loadouts.LoadoutOf(Stranger));

        // A refreshed profile for a rostered player that carries no loadout replaces the
        // roster's copy: the skins layer is told all the same, and the read says default.
        rig.Link.PushProfile(GamemodeTestHost.Player(Tk, "tk", rating: 1820));
        Assert.Equal([Stranger, Tk], rig.Changed);
        Assert.Null(rig.Loadouts.LoadoutOf(Tk));

        Assert.Equal(
            [
                $"info: skins: profile for {Stranger} carries a loadout (ct: 0 weapons, knife); the skins layer re-reads it",
                $"info: skins: handed {Stranger}'s loadout to the skins layer (ct: 0 weapons, knife)",
                $"info: skins: profile for {Tk} carries no loadout; the skins layer re-reads it",
                $"info: skins: no loadout for {Tk}; default items",
            ],
            rig.SkinsLines);
    }

    [Fact]
    public void AReleasedMatchTakesItsLoadoutsWithIt()
    {
        using var rig = new Rig();
        rig.Link.Assign(GamemodeTestHost.AssignmentFor(
            Manifest("retakes"),
            teamA: [new RosterEntry { SteamId64 = Tk.ToString(), Name = "tk", Loadout = Karambit() }]));
        Assert.NotNull(rig.Loadouts.LoadoutOf(Tk));

        rig.Link.Release();
        Assert.Null(rig.Loadouts.LoadoutOf(Tk));

        // A profile with no match assigned still announces itself — the runtime has nowhere to
        // keep it, so the read after it is default items, and nothing throws.
        rig.Link.PushProfile(GamemodeTestHost.Player(Tk, "tk"));
        Assert.Equal([Tk], rig.Changed);
        Assert.Null(rig.Loadouts.LoadoutOf(Tk));
    }

    [Fact]
    public void DisposingUnhooksTheRuntime()
    {
        using var rig = new Rig();
        rig.Loadouts.Dispose();
        rig.Link.PushProfile(GamemodeTestHost.Player(Tk, "tk"));
        Assert.Empty(rig.Changed);
    }

    [Theory]
    [InlineData(null, null, "empty")]
    [InlineData("t", null, "t: 1 weapon, knife, gloves, agent, music, pin")]
    [InlineData(null, "ct", "ct: 1 weapon")]
    [InlineData("t", "ct", "t: 1 weapon, knife, gloves, agent, music, pin; ct: 1 weapon")]
    public void ALoadoutIsDescribedByWhatEachSideHoldsNeverByItsValues(string? t, string? ct, string expected)
    {
        var full = Karambit();
        var loadout = new Loadout { T = t is null ? null : full.T, Ct = ct is null ? null : full.Ct };
        Assert.Equal(expected, RosterLoadouts.Describe(loadout));
    }
}
