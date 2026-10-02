using EZPug.Sdk.Protocol;
using EZPug.Sdk.Testing;
using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// <b>A mode's own words on the HUD</b> (PRD-07 T8): <c>Toast</c> and <c>ToastAll</c> on
/// <see cref="Gamemode"/> are <c>Say</c> and <c>SayAll</c> plus a strip on the moment's
/// toast rows. The chat line is said whatever the server can draw, the strip is each
/// player's language without the chat's colours, and it shares its three rows with the
/// platform's moments rather than writing over them.
/// </summary>
public class ModeToastTests
{
    private const string Addon = "3811574606";
    private const ulong Ada = 76561198000000001;
    private const ulong Ben = 76561198000000002;

    private const string Landed = "Power-up aktiv: Tempo.";
    private const string Bye = "Danke fürs Spielen!";
    private const string ByeEnglish = "Thanks for playing!";

    /// <summary>A mode that says what a test tells it to, with the sample mode's lines.</summary>
    private sealed class Talker : Gamemode
    {
        public override string Id => "powerup-dm";

        protected override Localizer CreateLocalizer() =>
            Localizer.FromEmbedded(GetType().Assembly, "EZPug.Sdk.Tests.Modes.PowerupDemo");

        public void Landed(IGamePlayer player, string kind = "Tempo") => Toast(player, "powerup.landed", kind);

        public void Bye() => ToastAll("powerup.bye");
    }

    /// <summary>A free-for-all with Ada (German) and Ben (English) on it, in warmup.</summary>
    private static (GamemodeTestHost Host, Talker Mode) Assigned(bool hud = true, string? addon = Addon)
    {
        var mode = new Talker();
        var host = new GamemodeTestHost(mode, hudAddon: addon);
        host.Start(GamemodeTestHost.AssignmentFor(
            GamemodeTestHost.ManifestFrom(File.ReadAllText(Repo.Path("gamemodes", "powerup-dm", "manifest.json"))),
            teamA: [GamemodeTestHost.Player(Ada, "Ada"), GamemodeTestHost.Player(Ben, "Ben", Locale.En)],
            hud: hud));
        host.World.Connect(Ada, "Ada");
        host.World.Connect(Ben, "Ben");
        host.World.Rules = new GameRules(
            Warmup: true, RoundsPlayed: 0, Paused: false, TerroristTimeout: false, CounterTerroristTimeout: false,
            TechnicalTimeout: false, SwitchingTeamsAtRoundReset: false, GamePhase.WarmupRound);
        host.World.StartRound();
        return (host, mode);
    }

    private static IGamePlayer Player(GamemodeTestHost host, ulong steamId64) => host.World.Find(steamId64)!;

    private static MomentCommand Moment(string correlationId, string line) => new()
    {
        CorrelationId = correlationId,
        Kind = "drop",
        Tier = MomentTier.Rare,
        Text = new MomentCommandText
        {
            De = new MomentWords { Everyone = line },
            En = new MomentWords { Everyone = line },
        },
        InMs = 0,
    };

    /// <summary>What the toast in <paramref name="row"/> says on this player's screen, or <c>null</c> when it is not up.</summary>
    private static string? ToastOn(GamemodeTestHost host, ulong steamId64, int row = 1)
    {
        var slot = Player(host, steamId64).Slot;
        if (host.World.HudLayouts.Count == 0)
        {
            return null;
        }

        var layout = host.World.HudLayout(Moments.Layout);
        return layout.Has(slot, Moments.Toast(row), Moments.Shown)
            ? layout.Variable(slot, Moments.ToastText(row), Moments.Text)
            : null;
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData(Addon, false)]
    public void WithTheHudOffAToastIsWhatSayIs_AndNothingElse(string? addon, bool asked)
    {
        var (host, mode) = Assigned(hud: asked, addon: addon);
        using var _ = host;

        mode.Landed(Player(host, Ada));
        mode.Bye();
        host.World.Elapse(Moments.ToastMs);

        Assert.Equal([host.Runtime.Brand.Line(Landed), host.Runtime.Brand.Line(Bye)], host.World.Said[Ada][^2..]);
        Assert.Equal(host.Runtime.Brand.Line(ByeEnglish), host.World.Said[Ben][^1]);
        Assert.Empty(host.World.HudActions);
    }

    [Fact]
    public void AToastForOnePersonIsTheirChatLineAndAStripOnTheirScreenAlone()
    {
        var (host, mode) = Assigned();
        using var _ = host;

        mode.Landed(Player(host, Ada));

        Assert.Equal(host.Runtime.Brand.Line(Landed), host.World.Said[Ada][^1]);
        Assert.DoesNotContain(host.Runtime.Brand.Line(Landed), host.World.Said.GetValueOrDefault(Ben, []));
        // The strip is the line without the prefix: the screen is the server's already.
        Assert.Equal(Landed, ToastOn(host, Ada));
        Assert.Null(ToastOn(host, Ben));
        // A mode's words are plain, where a moment is tinted by its tier.
        Assert.True(host.World.HudLayout(Moments.Layout).Classes[(Moments.Toast(1), "tier-common")]);

        host.Clock.Advance(Moments.ToastMs);
        Assert.Null(ToastOn(host, Ada));
    }

    [Fact]
    public void AToastForEverybodyIsEachPersonsOwnLanguage()
    {
        var (host, mode) = Assigned();
        using var _ = host;

        mode.Bye();

        Assert.Equal(host.Runtime.Brand.Line(Bye), host.World.Said[Ada][^1]);
        Assert.Equal(host.Runtime.Brand.Line(ByeEnglish), host.World.Said[Ben][^1]);
        Assert.Equal(Bye, ToastOn(host, Ada));
        Assert.Equal(ByeEnglish, ToastOn(host, Ben));
    }

    [Fact]
    public void TheChatsColoursStayInTheChat()
    {
        var (host, mode) = Assigned();
        using var _ = host;
        var painted = ChatColor.Paint(ChatColor.Green, "Tempo");

        mode.Landed(Player(host, Ada), painted);

        Assert.Equal(host.Runtime.Brand.Line($"Power-up aktiv: {painted}."), host.World.Said[Ada][^1]);
        Assert.Equal(Landed, ToastOn(host, Ada));
    }

    [Fact]
    public void AModesToastAndAMomentsShareTheRows_AndNeitherWritesOverTheOther()
    {
        var (host, mode) = Assigned();
        using var _ = host;

        host.Link.Command(Moment("m1", "one"));
        mode.Landed(Player(host, Ada));
        mode.Bye();
        host.Link.Command(Moment("m2", "four"));

        Assert.Equal("one", ToastOn(host, Ada, row: 1));
        Assert.Equal(Landed, ToastOn(host, Ada, row: 2));
        Assert.Equal(Bye, ToastOn(host, Ada, row: 3));
        // A row is everybody's: Ada's own toast holds the second one, and Ben's is empty.
        Assert.Equal("one", ToastOn(host, Ben, row: 1));
        Assert.Null(ToastOn(host, Ben, row: 2));
        Assert.Equal(ByeEnglish, ToastOn(host, Ben, row: 3));

        // The fourth waits for the first row, whoever it is from.
        host.Clock.Advance(Moments.ToastMs + Moments.ToastRestMs);
        Assert.Equal("four", ToastOn(host, Ben, row: 1));
    }

    [Fact]
    public void ABotAndSomebodyWhoLeftGetNoStrip_AndTakeNoRow()
    {
        var (host, mode) = Assigned();
        using var _ = host;
        var bot = host.World.Connect(76561198000000099, "BOT Kai", bot: true);
        var ben = Player(host, Ben);
        host.World.Disconnect(ben);
        var before = host.World.HudActions.Count;

        mode.Landed(bot);
        mode.Landed(ben);

        Assert.Equal(before, host.World.HudActions.Count);
        mode.Landed(Player(host, Ada));
        Assert.Equal(Landed, ToastOn(host, Ada, row: 1));
    }

    [Fact]
    public void AReleaseTakesTheStripWithIt()
    {
        var (host, mode) = Assigned();
        using var _ = host;
        mode.Bye();

        host.Link.Release("ended: completed");
        var actions = host.World.Actions.Count;
        host.World.Elapse(Moments.ToastMs + Moments.ToastRestMs);

        Assert.Equal(actions, host.World.Actions.Count);
        Assert.Empty(host.World.HudLayouts);
    }
}
