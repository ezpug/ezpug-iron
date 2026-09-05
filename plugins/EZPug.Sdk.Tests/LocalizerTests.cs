using EZPug.Sdk.Protocol;
using Xunit;

namespace EZPug.Sdk.Tests;

public class LocalizerTests
{
    [Fact]
    public void TheSdksTwoCatalogsHoldTheSameKeys()
    {
        var de = ResxCatalog.FromEmbedded(typeof(Localizer).Assembly, "EZPug.Sdk.I18n.Lines.de.resx");
        var en = ResxCatalog.FromEmbedded(typeof(Localizer).Assembly, "EZPug.Sdk.I18n.Lines.en.resx");
        Assert.True(de.Count > 0);
        Assert.Equal(de.Keys.Order(), en.Keys.Order());
    }

    [Fact]
    public void GermanIsTheDefaultAndNumbersFollowTheLocale()
    {
        var localizer = new Localizer();
        Assert.Equal(Locale.De, Localizer.DefaultLocale);
        Assert.Equal("Noch 4 Sekunden.", localizer.Get(Locale.De, "command.cooldown", 4));
        Assert.Equal("4 seconds left.", localizer.For(Locale.En)["command.cooldown", 4]);
        Assert.Equal("[no.such.key]", localizer.Get(Locale.En, "no.such.key"));
    }

    [Fact]
    public void AModesCatalogWinsOverTheSdksAndFallsBackToIt()
    {
        var mode = new Dictionary<Locale, ResxCatalog>
        {
            [Locale.De] = new(new Dictionary<string, string> { ["command.refused"] = "Nö.", ["mode.hello"] = "Servus {0}!" }),
            [Locale.En] = new(new Dictionary<string, string> { ["command.refused"] = "Nope.", ["mode.hello"] = "Hi {0}!" }),
        };
        var localizer = new Localizer(mode);
        Assert.Equal("Nö.", localizer.Get(Locale.De, "command.refused"));
        Assert.Equal("Hi tk!", localizer.Get(Locale.En, "mode.hello", "tk"));
        Assert.Equal("Only while alive.", localizer.Get(Locale.En, "command.not_alive"));
        Assert.True(localizer.Has(Locale.De, "mode.hello"));
        Assert.False(localizer.Has(Locale.De, "mode.bye"));
    }

    [Fact]
    public void AnEmbeddedPairIsReadByPrefix()
    {
        var localizer = Localizer.FromEmbedded(typeof(Localizer).Assembly, "EZPug.Sdk.I18n.Lines");
        Assert.Equal("Mit EZPug verbunden.", localizer.Get(Locale.De, "link.connected"));
        var missing = Assert.Throws<InvalidOperationException>(() => Localizer.FromEmbedded(typeof(Localizer).Assembly, "EZPug.Nope"));
        Assert.Contains("EZPug.Nope.de.resx", missing.Message);
    }
}
