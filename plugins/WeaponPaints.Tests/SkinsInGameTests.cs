using System.Text.Json.Nodes;
using EZPug.Sdk.Protocol;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Xunit;
using Xunit.Abstractions;

namespace WeaponPaints.Tests;

/// <summary>
/// <b>Skins with the wrong pattern</b> (playtest 2026-10-04: "the Dragon Lore has the
/// checkered pattern on the scope lens"). The loadout arrived intact and the mapping was
/// right; what broke is that the CS2 update of 2026-09-22 moved
/// <c>CAttributeList::SetOrAddAttributeValueByName</c> out from under the pinned gamedata.
/// CounterStrikeSharp swallows the missing signature, the first call to the function throws
/// halfway through <c>GivePlayerWeaponSkin</c>, and everything after it is skipped — the
/// legacy-model body group first of all, so a CS:GO-era paint kit lands on the CS2 mesh's
/// UVs. These tests hold the three links of that chain: the wire value maps unchanged, the
/// catalogue says which kits need the legacy body, and the gamedata matches the game
/// (<c>plugins/vendor/WeaponPaints/PATCHES.md</c>, "The signature").
/// </summary>
public class SkinsInGameTests(ITestOutputHelper output)
{
    private const string Signature = "CAttributeList_SetOrAddAttributeValueByName";

    /// <summary>
    /// The first 31 bytes of the function in <c>libserver.so</c> of CS2 build 25687242
    /// (public, 2026-10-02 21:56 UTC: <c>DepotDownloader -app 730 -depot 2347773</c>), and
    /// byte-identical in build 25472966 (2026-09-22) on the dev node. <c>this</c> to
    /// <c>r13</c>, the name to <c>rbx</c>, the float spilled with <c>movss</c> — the shape the
    /// signature is written against.
    /// </summary>
    private const string Prologue20261002 = "55 48 89 E5 41 57 41 56 41 55 49 89 FD 41 54 53 48 89 F3 48 83 EC 78 F3 0F 11 85 6C FF FF FF";

    /// <summary>The signature <c>build-459</c> shipped, which no CS2 build since 2026-09-22 contains.</summary>
    private const string StaleLinux = "55 48 89 E5 41 57 41 56 49 89 FE 41 55 41 54 53 48 89 F3 48 83 EC ? F3 0F 11 85";

    /// <summary>Rantanplan's T-side AWP exactly as match 513fb90f's request carried it (iron production, 2026-10-04 14:24 UTC).</summary>
    private const string DragonLoreOnTheWire = """
        {"seed": 0, "wear": 0, "paintId": 344, "defindex": 9, "stattrak": false, "stattrakCount": 0, "stickers": [
          {"x": 0, "y": 0, "id": 80, "wear": 0, "scale": 1, "schema": 0, "rotation": 0},
          {"x": 0, "y": 0, "id": 76, "wear": 0, "scale": 1, "schema": 1, "rotation": 0},
          {"x": 0, "y": 0, "id": 62, "wear": 0, "scale": 1, "schema": 2, "rotation": 0},
          {"x": 0, "y": 0, "id": 60, "wear": 0, "scale": 1, "schema": 3, "rotation": 0},
          {"x": 0, "y": 0, "id": 53, "wear": 0, "scale": 1, "schema": 4, "rotation": 0}]}
        """;

    [Fact]
    public void TheDragonLoreReachesThePluginAsPaintKit344SeedZeroWearZero()
    {
        var skin = ProtocolJson.Deserialize<WeaponSkin>(DragonLoreOnTheWire);
        var info = LoadoutMapper.MapWeapon(skin);

        // m_nFallbackPaintKit / "set item texture prefab", m_nFallbackSeed, m_flFallbackWear:
        // nothing swapped, nothing truncated, so the pattern is not the mapper's.
        Assert.Equal(344, info.Paint);
        Assert.Equal(0, info.Seed);
        Assert.Equal(0f, info.Wear);
        Assert.Equal([80u, 76u, 62u, 60u, 53u], info.Stickers.Select(sticker => sticker.Id));
    }

    [Theory]
    // Rantanplan's loadout on 2026-10-04, one row per finish he had equipped.
    [InlineData(9, 344, true)] // AWP | Dragon Lore
    [InlineData(9, 446, true)] // AWP | Medusa
    [InlineData(1, 757, true)] // Desert Eagle | Emerald Jörmungandr
    [InlineData(7, 44, true)] // AK-47 | Case Hardened
    [InlineData(16, 309, true)] // M4A4 | Howl
    [InlineData(507, 44, true)] // ★ Karambit | Case Hardened
    [InlineData(1, 37, false)] // Desert Eagle | Blaze
    [InlineData(60, 1476, false)] // M4A1-S | Fatal Glitch
    [InlineData(515, 568, false)] // ★ Butterfly Knife | Gamma Doppler
    public void TheCatalogueSaysWhichFinishesNeedTheLegacyBody(int defindex, int paint, bool legacy)
    {
        // The plugin's own read (Utility.LoadSkinsFromFile) and its own query
        // (WeaponAction.GivePlayerWeaponSkin), restated: `paint` is a string in the file
        // and ToObject<int> is what makes "344" equal 344.
        var skins = JsonConvert.DeserializeObject<List<JObject>>(
            File.ReadAllText(Repo.Path("plugins", "vendor", "WeaponPaints", "data", "skins_en.json")))!;
        var rows = skins
            .Where(w => w["weapon_defindex"]?.ToObject<int>() == defindex && w["paint"]?.ToObject<int>() == paint)
            .ToList();

        Assert.Single(rows);
        Assert.Equal(legacy, rows[0].Value<bool>("legacy_model"));
    }

    [Fact]
    public void TheLinuxSignatureMatchesTheFunctionInTodaysBuildAndTheStaleOneDoesNot()
    {
        var prologue = Bytes(Prologue20261002);

        Assert.Equal([0], Matches(LinuxSignature(), prologue));
        Assert.Empty(Matches(StaleLinux, prologue));
    }

    /// <summary>
    /// The whole binary, when this box has one: exactly one match, or CounterStrikeSharp
    /// either finds nothing (skins half-applied, as on 2026-10-04) or the wrong function.
    /// <c>EZPUG_CS2_LIBSERVER</c> names it; otherwise the dev node's install in the
    /// <c>cs2-data</c> volume (<c>pnpm cs2:install</c>) is read where Docker keeps it. Absent,
    /// the test says so and passes, unless <c>EZPUG_CS2_TESTS=required</c>.
    /// </summary>
    [Fact]
    public void TheLinuxSignatureIsFoundExactlyOnceInTheInstalledGame()
    {
        var path = new[]
            {
                Environment.GetEnvironmentVariable("EZPUG_CS2_LIBSERVER"),
                "/var/lib/docker/volumes/ezpug-iron-cs2_cs2-data/_data/game/csgo/bin/linuxsteamrt64/libserver.so",
            }
            .FirstOrDefault(candidate => !string.IsNullOrEmpty(candidate) && CanRead(candidate));

        if (path is null)
        {
            Assert.NotEqual("required", Environment.GetEnvironmentVariable("EZPUG_CS2_TESTS"));
            output.WriteLine("skipped: no libserver.so on this box (EZPUG_CS2_LIBSERVER, or `pnpm cs2:install`)");
            return;
        }

        var found = Matches(LinuxSignature(), File.ReadAllBytes(path));
        Assert.True(found.Count == 1, $"{Signature}: {found.Count} matches in {path}; gamedata/weaponpaints.json wants upstream's newer signature");
    }

    private static string LinuxSignature()
    {
        var gamedata = JsonNode.Parse(File.ReadAllText(Repo.Path("plugins", "vendor", "WeaponPaints", "gamedata", "weaponpaints.json")))!;
        return gamedata[Signature]!["signatures"]!["linux"]!.GetValue<string>();
    }

    private static bool CanRead(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static byte[] Bytes(string hex) => hex.Split(' ').Select(octet => Convert.ToByte(octet, 16)).ToArray();

    /// <summary>Every offset the IDA-style signature (<c>?</c> is any byte) matches at, as CounterStrikeSharp's <c>FindSignature</c> reads one.</summary>
    private static List<int> Matches(string signature, byte[] haystack)
    {
        var pattern = signature.Split(' ').Select(token => token == "?" ? (int?)null : Convert.ToByte(token, 16)).ToArray();
        var first = pattern[0]!.Value;
        var found = new List<int>();
        for (var start = Array.IndexOf(haystack, (byte)first); start >= 0 && start <= haystack.Length - pattern.Length; start = Array.IndexOf(haystack, (byte)first, start + 1))
        {
            var match = true;
            for (var i = 1; i < pattern.Length && match; i++)
            {
                match = pattern[i] is not { } expected || haystack[start + i] == expected;
            }

            if (match)
            {
                found.Add(start);
            }
        }

        return found;
    }
}
