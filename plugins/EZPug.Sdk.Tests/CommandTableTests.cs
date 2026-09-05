using System.Text.Json.Nodes;
using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

public class CommandTableTests
{
    private const ulong Tk = 76561198279375306;

    private static PlayerCommandSpec Powerup(long cooldownMs = 0, PlayerCommandSpecCharges? charges = null, JsonObject? args = null) =>
        new()
        {
            Name = "powerup",
            Title = new LocalizedText { De = "Power-up", En = "Power-up" },
            CooldownMs = cooldownMs,
            Charges = charges,
            Args = args,
        };

    private static (CommandTable Table, FakeClock Clock) Build(params PlayerCommandSpec[] specs)
    {
        var clock = new FakeClock();
        return (new CommandTable(specs, clock, new Localizer()), clock);
    }

    [Fact]
    public void AnUndeclaredVerbIsUnknownInThePlayersLanguage()
    {
        var (table, _) = Build(Powerup());
        var de = table.Precheck(Tk, Locale.De, "teleport", null)!;
        var en = table.Precheck(Tk, Locale.En, "teleport", null)!;
        Assert.Equal(PlayerCommandRefusal.UnknownCommand, de.Code);
        Assert.Equal("Unbekannter Befehl.", de.Message);
        Assert.Equal("Unknown command.", en.Message);
    }

    [Fact]
    public void OneChargePerLifeRefillsOnSpawnOnly()
    {
        var (table, _) = Build(Powerup(charges: new PlayerCommandSpecCharges { Count = 1, Per = PlayerCommandChargePeriod.Life }));
        Assert.Null(table.Precheck(Tk, Locale.De, "powerup", null));
        var spent = table.Spend(Tk, "powerup");
        Assert.True(spent.Applied);
        Assert.Equal(0, spent.ChargesLeft);
        Assert.Null(spent.CooldownMs);

        var refused = table.Precheck(Tk, Locale.De, "powerup", null)!;
        Assert.Equal(PlayerCommandRefusal.NoCharges, refused.Code);
        Assert.Equal("Keine Ladung mehr in diesem Leben.", refused.Message);
        Assert.Equal(0, refused.ChargesLeft);

        table.Reset(PlayerCommandChargePeriod.Round);
        Assert.NotNull(table.Precheck(Tk, Locale.De, "powerup", null));
        table.Reset(PlayerCommandChargePeriod.Life, steamId64: 1);
        Assert.NotNull(table.Precheck(Tk, Locale.De, "powerup", null));
        table.Reset(PlayerCommandChargePeriod.Life, Tk);
        Assert.Null(table.Precheck(Tk, Locale.De, "powerup", null));
    }

    [Fact]
    public void TheCooldownIsADeadlineOnTheClockAndTheMessageRoundsUp()
    {
        var (table, clock) = Build(Powerup(cooldownMs: 4_000));
        var spent = table.Spend(Tk, "powerup");
        Assert.Equal(4_000, spent.CooldownMs);
        clock.Advance(1);
        var refused = table.Precheck(Tk, Locale.De, "powerup", null)!;
        Assert.Equal(PlayerCommandRefusal.Cooldown, refused.Code);
        Assert.Equal(3_999, refused.CooldownMs);
        Assert.Equal("Noch 4 Sekunden.", refused.Message);
        Assert.Equal("4 seconds left.", table.Precheck(Tk, Locale.En, "powerup", null)!.Message);
        clock.Advance(3_999);
        Assert.Null(table.Precheck(Tk, Locale.De, "powerup", null));
        Assert.Null(table.Precheck(76561198279375307, Locale.De, "powerup", null));
    }

    [Fact]
    public void ArgsAreCheckedAgainstTheManifestsSchemaBeforeTheModeSeesThem()
    {
        var schema = JsonNode.Parse("""{"type":"object","properties":{"kind":{"type":"string","enum":["haste","armor","heal"]}},"additionalProperties":false}""")!.AsObject();
        var (table, _) = Build(Powerup(args: schema));
        Assert.Null(table.Precheck(Tk, Locale.De, "powerup", null));
        Assert.Null(table.Precheck(Tk, Locale.De, "powerup", JsonNode.Parse("""{"kind":"haste"}""")!.AsObject()));
        var wrong = table.Precheck(Tk, Locale.En, "powerup", JsonNode.Parse("""{"kind":"speed"}""")!.AsObject())!;
        Assert.Equal(PlayerCommandRefusal.InvalidArgs, wrong.Code);
        Assert.Equal("Invalid input: args.kind must be one of [\"haste\",\"armor\",\"heal\"]", wrong.Message);
        var extra = table.Precheck(Tk, Locale.De, "powerup", JsonNode.Parse("""{"size":3}""")!.AsObject())!;
        Assert.Equal("Ungültige Eingabe: args.size is not allowed", extra.Message);

        var (bare, _) = Build(Powerup());
        Assert.Equal(PlayerCommandRefusal.InvalidArgs, bare.Precheck(Tk, Locale.De, "powerup", JsonNode.Parse("""{"x":1}""")!.AsObject())!.Code);
    }

    [Fact]
    public void TheModesRefusalsCostNothing()
    {
        var (table, _) = Build(Powerup(cooldownMs: 1_000, charges: new PlayerCommandSpecCharges { Count = 2, Per = PlayerCommandChargePeriod.Match }));
        var notAlive = table.Refused(Tk, Locale.En, "powerup", new PlayerCommandOutcome.NotAlive());
        Assert.Equal(PlayerCommandRefusal.NotAlive, notAlive.Code);
        Assert.Equal("Only while alive.", notAlive.Message);
        Assert.Equal(2, notAlive.ChargesLeft);
        var refused = table.Refused(Tk, Locale.De, "powerup", new PlayerCommandOutcome.Refused("Nicht jetzt."));
        Assert.Equal(PlayerCommandRefusal.Refused, refused.Code);
        Assert.Equal("Nicht jetzt.", refused.Message);
        Assert.Null(table.Precheck(Tk, Locale.De, "powerup", null));
        Assert.Equal((0L, (long?)2), table.StateOf(Tk, "powerup"));
    }
}

public class ArgsValidatorTests
{
    private static JsonObject Schema(string json) => JsonNode.Parse(json)!.AsObject();
    private static JsonObject Args(string json) => JsonNode.Parse(json)!.AsObject();

    [Theory]
    [InlineData("""{"type":"object","required":["n"],"properties":{"n":{"type":"integer","minimum":1,"maximum":5}}}""", """{"n":3}""", null)]
    [InlineData("""{"type":"object","required":["n"],"properties":{"n":{"type":"integer","minimum":1,"maximum":5}}}""", """{}""", "args.n is required")]
    [InlineData("""{"type":"object","properties":{"n":{"type":"integer"}}}""", """{"n":1.5}""", "args.n must be an integer")]
    [InlineData("""{"type":"object","properties":{"n":{"type":"number","maximum":5}}}""", """{"n":6}""", "args.n must be at most 5")]
    [InlineData("""{"type":"object","properties":{"s":{"type":"string","minLength":2}}}""", """{"s":"a"}""", "args.s must be at least 2 characters")]
    [InlineData("""{"type":"object","properties":{"b":{"type":"boolean"}}}""", """{"b":"yes"}""", "args.b must be a boolean")]
    [InlineData("""{"type":"object","properties":{"l":{"type":"array","items":{"type":"string"},"maxItems":1}}}""", """{"l":["a","b"]}""", "args.l allows at most 1 items")]
    [InlineData("""{"type":"object","properties":{"l":{"type":"array","items":{"type":"string"}}}}""", """{"l":["a",1]}""", "args.l[1] must be a string")]
    [InlineData("""{"type":"object","properties":{"k":{"const":"x"}}}""", """{"k":"y"}""", "args.k must be \"x\"")]
    public void TheSupportedKeywordsAreEnforced(string schema, string args, string? expected) =>
        Assert.Equal(expected, ArgsValidator.Validate(Schema(schema), Args(args)));

    [Fact]
    public void NoSchemaMeansNoArgs()
    {
        Assert.Null(ArgsValidator.Validate(null, null));
        Assert.Null(ArgsValidator.Validate(null, Args("{}")));
        Assert.Equal("this command takes no arguments", ArgsValidator.Validate(null, Args("""{"a":1}""")));
    }
}
