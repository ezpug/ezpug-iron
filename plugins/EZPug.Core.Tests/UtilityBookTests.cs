using System.Numerics;
using EZPug.Sdk;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Core.Tests;

/// <summary>
/// The utility layer as the game's events tell it (PRD-05 T2c, ezpug/ezpug-iron#5). The
/// tracker is a thin adapter; everything a real node showed it gets wrong would be wrong
/// here first.
/// </summary>
public class UtilityBookTests
{
    private long _now = 1_000;
    private readonly FakePlayer _tk = new(76561198279375306, "tk", 1) { IsAlive = true, Position = new Vector3(10, 20, 30) };
    private readonly FakePlayer _maex = new(76561198279375307, "maex", 2) { IsAlive = true, Position = new Vector3(-5, -5, 0) };

    private UtilityBook Book() => new(() => _now);

    [Fact]
    public void ASmokeFliesBloomsWithItsRadiusAndClears()
    {
        var book = Book();
        book.Threw(GrenadeKind.Smoke, _tk);
        Assert.True(book.SearchDue);
        book.Searched();
        book.Flying(0x1_0042, 66, GrenadeKind.Smoke, _tk, new Vector3(100, 0, 64));

        var flying = Assert.Single(book.Sample());
        Assert.Equal(("65602", GrenadeKind.Smoke, GrenadeState.Flying, (float?)null), (flying.Id, flying.Kind, flying.State, flying.Radius));
        Assert.Same(_tk, flying.Thrower);

        // The bloom is where the event says, under the same id, with the smoke's reach.
        book.Bloomed(0x1_0042, 66, new Vector3(400, 10, 0), null);
        var standing = Assert.Single(book.Sample());
        Assert.Equal(("65602", GrenadeState.Active, UtilityBook.SmokeRadius), (standing.Id, standing.State, standing.Radius));
        Assert.Equal(new Vector3(400, 10, 0), standing.Position);
        Assert.Same(_tk, standing.Thrower);
        Assert.Empty(book.Following());

        book.Cleared(0x1_0042);
        Assert.Empty(book.Sample());
        // Its entity may linger a moment; a later search does not take it up again.
        Assert.True(book.Knows(0x1_0042));
        book.Flying(0x1_0042, 66, GrenadeKind.Smoke, _tk, new Vector3(400, 10, 0));
        Assert.Empty(book.Sample());
    }

    [Fact]
    public void ASmokeNobodySawFlyingStillStands()
    {
        var book = Book();
        book.Bloomed(null, 70, new Vector3(1, 2, 3), _maex);
        var standing = Assert.Single(book.Sample());
        Assert.Equal((GrenadeKind.Smoke, GrenadeState.Active), (standing.Kind, standing.State));
        Assert.Same(_maex, standing.Thrower);
    }

    [Fact]
    public void AFlashPopsOnceUnderItsFlightsIdAndIsGone()
    {
        var book = Book();
        book.Flying(0x2_0050, 80, GrenadeKind.Flash, _tk, new Vector3(0, 0, 90));
        book.Popped(0x2_0050, GrenadeKind.Flash, new Vector3(5, 5, 5), null);

        var pop = Assert.Single(book.Sample());
        Assert.Equal((book.Sample().Count, pop.Id, pop.State, pop.Radius), (0, "131152", GrenadeState.Active, (float?)null));
        Assert.Same(_tk, pop.Thrower);
    }

    [Fact]
    public void AMolotovHandsItsIdAndThrowerToTheFireThatStartsWhereItLanded()
    {
        var book = Book();
        book.Threw(GrenadeKind.Incendiary, _maex);
        book.Flying(0x3_0010, 90, GrenadeKind.Incendiary, _maex, new Vector3(1000, 0, 0));
        // A second one lands far away, a moment later.
        book.Threw(GrenadeKind.Molotov, _tk);
        book.Flying(0x3_0011, 91, GrenadeKind.Molotov, _tk, new Vector3(-2000, 0, 0));

        // The first lands: its entity is gone before its fire starts.
        book.Vanished(0x3_0010);
        _now += 100;
        book.Burning(0x3_0099, 99, new Vector3(1030, 20, 0));

        var fire = book.Sample().Single(grenade => grenade.State == GrenadeState.Active);
        Assert.Equal(("196624", GrenadeKind.Incendiary, UtilityBook.FireRadius), (fire.Id, fire.Kind, fire.Radius));
        Assert.Same(_maex, fire.Thrower);

        // Its flames spread; the tracker reads the centre and reach off the inferno.
        book.Spread(0x3_0099, new Vector3(1040, 25, 0), 180, GrenadeKind.Molotov);
        fire = book.Sample().Single(grenade => grenade.Id == "196624");
        Assert.Equal((new Vector3(1040, 25, 0), 180f, GrenadeKind.Incendiary), (fire.Position, fire.Radius, fire.Kind));

        // The second still flies, and it burns out on inferno_expire.
        Assert.Contains(book.Following(), followed => followed.Key == 0x3_0011 && !followed.Fire);
        book.Cleared(0x3_0099);
        Assert.DoesNotContain(book.Sample(), grenade => grenade.Id == "196624");
    }

    [Fact]
    public void AFireWhoseProjectileNobodyFoundIsNamedByTheOldestThrowWaitingForOne()
    {
        var book = Book();
        book.Threw(GrenadeKind.Molotov, _tk);
        _now += 1_500;
        book.Burning(0x4_0001, 12, new Vector3(0, 0, 0));
        var fire = Assert.Single(book.Sample());
        Assert.Equal((GrenadeKind.Molotov, GrenadeState.Active), (fire.Kind, fire.State));
        Assert.Same(_tk, fire.Thrower);

        // A throw too old to be waiting still names nothing.
        book.Threw(GrenadeKind.Incendiary, _maex);
        _now += UtilityBook.ThrownFireMs + 1;
        book.Burning(0x4_0002, 13, new Vector3(9, 9, 9));
        var stray = book.Sample().Single(grenade => grenade.Id == 0x4_0002u.ToString());
        Assert.Null(stray.Thrower);
    }

    [Fact]
    public void ANewRoundForgetsEveryGrenadeAndLooksForTheBombAgain()
    {
        var book = Book();
        book.Bloomed(0x5_0001, 5, Vector3.Zero, _tk);
        book.BombCarried(_tk);
        book.Reset();
        Assert.Empty(book.Sample());
        Assert.Null(book.Bomb());
        Assert.True(book.BombSearchDue);
        Assert.False(book.Knows(0x5_0001));
    }

    [Fact]
    public void TheBombIsCarriedWhereItsCarrierStandsDroppedPlantedAndGone()
    {
        var book = Book();
        Assert.True(book.BombSearchDue);
        book.BombSearched();
        Assert.Null(book.Bomb());

        book.BombCarried(_tk);
        _tk.Position = new Vector3(50, 60, 70);
        var carried = book.Bomb();
        Assert.Equal((BombState.Carried, new Vector3(50, 60, 70)), (carried?.State, carried?.Position));
        Assert.Same(_tk, carried?.Carrier);

        // Killed with it and no bomb_dropped yet: it lies where they fell.
        _tk.IsAlive = false;
        Assert.Equal(BombState.Dropped, book.Bomb()?.State);
        Assert.Null(book.Bomb()?.Carrier);

        book.BombDropped(new Vector3(55, 60, 0));
        Assert.Equal((BombState.Dropped, new Vector3(55, 60, 0)), (book.Bomb()?.State, book.Bomb()?.Position));

        book.BombCarried(_maex);
        book.BombPlanted(new Vector3(-2050, 440, 32), BombSiteName.B);
        var planted = book.Bomb();
        Assert.Equal((BombState.Planted, BombSiteName.B), (planted?.State, planted?.Site));
        Assert.Null(planted?.Carrier);

        book.BombGone();
        Assert.Null(book.Bomb());
        // Freeze time ends with no bomb known: look once more; with one known, do not.
        book.LookForBomb();
        Assert.True(book.BombSearchDue);
        book.BombCarried(_maex);
        Assert.False(book.BombSearchDue);
    }
}
