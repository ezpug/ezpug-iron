using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>
/// The wire's map name, read on the server side (PRD-05 T1): the spelling the platform
/// sends, <c>workshop/&lt;id&gt;/&lt;name&gt;</c>, is hosted by its id, and an official map
/// by its engine name.
/// </summary>
public class MapIdentifierTests
{
    [Theory]
    [InlineData("workshop/3084291314/aim_map", "3084291314")]
    [InlineData("workshop/3070288000/de_cache", "3070288000")]
    [InlineData("3070923343", "3070923343")]
    [InlineData("de_mirage", null)]
    [InlineData("ar_baggage", null)]
    [InlineData("workshop/0123/aim_map", null)]
    [InlineData("workshop/3084291314", null)]
    [InlineData("workshop/3084291314/aim_map/extra", null)]
    public void AWorkshopPlanIsHostedByItsId(string map, string? id) => Assert.Equal(id, MapIdentifier.WorkshopIdOf(map));

    [Theory]
    [InlineData("workshop/3084291314/aim_map", "aim_map")]
    [InlineData("de_mirage", "de_mirage")]
    [InlineData("3070923343", "3070923343")]
    public void AWorkshopPlanIsNamedByItsName(string map, string name) => Assert.Equal(name, MapIdentifier.NameOf(map));
}
