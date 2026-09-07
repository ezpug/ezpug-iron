using System.Text.Json.Nodes;
using CounterStrikeSharp.API.Modules.Utils;
using EZPug.Sdk.Protocol;
using Xunit;

namespace WeaponPaints.Tests;

/// <summary>
/// <b>The fork's data layer</b> (PRD-02 T28, decision 20): a Match API <c>Loadout</c> mapped
/// into the rows upstream read out of six MySQL tables, proven against the protocol's own
/// recorded <c>assign</c> frame — the loadout the whole tree shares — and the rules the
/// readers applied to a row (<c>plugins/vendor/WeaponPaints/PATCHES.md</c>).
/// </summary>
public class LoadoutMapperTests
{
    private static readonly Additional Everything = new();

    /// <summary>The recorded assign frame's rostered player with a loadout: <c>tk</c>, T side full, CT side one skin.</summary>
    private static Loadout Fixture()
    {
        var document = JsonNode.Parse(File.ReadAllText(Repo.Path("packages", "protocol", "fixtures", "frames", "orchestrator.json")))!.AsObject();
        var assign = document["frames"]!.AsArray().First(frame => frame!["type"]!.GetValue<string>() == "assign")!;
        var frame = ProtocolJson.Deserialize<AssignOrchestratorFrame>(assign.ToJsonString());
        return frame.Teams.TeamA.Players.Concat(frame.Teams.TeamB.Players).First(player => player.Loadout is not null).Loadout!;
    }

    [Fact]
    public void TheRecordedLoadoutMapsFieldForField()
    {
        var mapped = LoadoutMapper.Map(Fixture(), Everything);

        // wp_player_knife, wp_player_gloves, wp_player_music, wp_player_pins: one row per side.
        Assert.Equal("weapon_knife_karambit", mapped.Knives[CsTeam.Terrorist]);
        Assert.Equal((ushort)5027, mapped.Gloves[CsTeam.Terrorist]);
        Assert.Equal((ushort)3, mapped.Music[CsTeam.Terrorist]);
        Assert.Equal((ushort)874, mapped.Pins[CsTeam.Terrorist]);
        // The CT block carried none of them, so the CT rows do not exist — not defaults, absence.
        Assert.False(mapped.Knives.ContainsKey(CsTeam.CounterTerrorist));
        Assert.False(mapped.Gloves.ContainsKey(CsTeam.CounterTerrorist));
        Assert.False(mapped.Music.ContainsKey(CsTeam.CounterTerrorist));
        Assert.False(mapped.Pins.ContainsKey(CsTeam.CounterTerrorist));

        // wp_player_agents: one row per player, (agent_ct, agent_t).
        Assert.Equal((null, "customplayer_tm_leet_variantg"), mapped.Agents);

        // wp_player_skins, T side: the AK with everything on it.
        var ak = mapped.Weapons[CsTeam.Terrorist][7];
        Assert.Equal(490, ak.Paint);
        Assert.Equal(661, ak.Seed);
        Assert.Equal(0.12f, ak.Wear, 1e-6f);
        Assert.Equal("lauwarm", ak.Nametag);
        Assert.True(ak.StatTrak);
        Assert.Equal(1337, ak.StatTrakCount);
        var sticker = Assert.Single(ak.Stickers);
        Assert.Equal(4u, sticker.Id);
        Assert.Equal(0u, sticker.Schema);
        Assert.Equal(0.5f, sticker.OffsetX);
        Assert.Equal(-0.25f, sticker.OffsetY);
        Assert.Equal(0f, sticker.Wear);
        Assert.Equal(1f, sticker.Scale);
        Assert.Equal(0f, sticker.Rotation);
        Assert.NotNull(ak.KeyChain);
        Assert.Equal(20u, ak.KeyChain!.Id);
        Assert.Equal(7u, ak.KeyChain.Seed);
        Assert.Equal(0f, ak.KeyChain.OffsetX);

        // wp_player_skins, CT side: a bare M4A1-S row — the column defaults, as the reader saw them.
        var m4 = Assert.Single(mapped.Weapons[CsTeam.CounterTerrorist]).Value;
        Assert.Equal(1231, m4.Paint);
        Assert.Equal(0, m4.Seed);
        Assert.Equal(0.000001f, m4.Wear, 1e-9f);
        Assert.Equal("", m4.Nametag);
        Assert.False(m4.StatTrak);
        Assert.Equal(0, m4.StatTrakCount);
        Assert.Empty(m4.Stickers);
        // `weapon_keychain` defaulted to `0;0;0;0;0` and the reader still built a KeyChainInfo
        // of zeros; GivePlayerWeaponSkin relies on it being there.
        Assert.NotNull(m4.KeyChain);
        Assert.Equal(0u, m4.KeyChain!.Id);
        Assert.False(mapped.IsEmpty);
    }

    [Fact]
    public void NoLoadoutIsNoRows()
    {
        Assert.True(LoadoutMapper.Map(null, Everything).IsEmpty);
        Assert.True(LoadoutMapper.Map(new Loadout(), Everything).IsEmpty);
        Assert.True(LoadoutMapper.Map(new Loadout { T = new SideLoadout() }, Everything).IsEmpty);
    }

    [Fact]
    public void TheSideBlocksAreTheTeamNumbersTheTablesUsed()
    {
        // `weapon_team` 2 and 3 — CS2's own numbers, and what `LOADOUT_SIDE_TEAM_NUMBER` in
        // @ezpug/match-api writes down. Both languages have to agree, so the TS source is read.
        Assert.Equal(LoadoutMapper.TerroristTeamNumber, (int)CsTeam.Terrorist);
        Assert.Equal(LoadoutMapper.CounterTerroristTeamNumber, (int)CsTeam.CounterTerrorist);
        var source = File.ReadAllText(Repo.Path("packages", "match-api", "src", "resources", "loadout.ts"));
        Assert.Contains($"Object.freeze({{ t: {LoadoutMapper.TerroristTeamNumber}, ct: {LoadoutMapper.CounterTerroristTeamNumber} }})", source);

        var mapped = LoadoutMapper.Map(new Loadout
        {
            T = new SideLoadout { Knife = "weapon_knife_flip" },
            Ct = new SideLoadout { Knife = "weapon_knife_gut", Gloves = 5031 },
        }, Everything);
        Assert.Equal("weapon_knife_flip", mapped.Knives[CsTeam.Terrorist]);
        Assert.Equal("weapon_knife_gut", mapped.Knives[CsTeam.CounterTerrorist]);
        Assert.Equal([CsTeam.CounterTerrorist], mapped.Gloves.Keys);
    }

    [Fact]
    public void TheFeatureFlagsGateEachTableAsTheyGatedEachQuery()
    {
        var loadout = Fixture();

        var noKnives = LoadoutMapper.Map(loadout, new Additional { KnifeEnabled = false });
        Assert.Empty(noKnives.Knives);
        Assert.NotEmpty(noKnives.Weapons);

        var noSkins = LoadoutMapper.Map(loadout, new Additional { SkinEnabled = false });
        Assert.Empty(noSkins.Weapons);
        Assert.NotEmpty(noSkins.Knives);

        var noAgents = LoadoutMapper.Map(loadout, new Additional { AgentEnabled = false });
        Assert.Null(noAgents.Agents);

        var nothing = LoadoutMapper.Map(loadout, new Additional
        {
            KnifeEnabled = false, GloveEnabled = false, MusicEnabled = false,
            AgentEnabled = false, SkinEnabled = false, PinsEnabled = false,
        });
        Assert.True(nothing.IsEmpty);
    }

    [Fact]
    public void AValueWiderThanThePluginHoldsIsClampedNeverThrownOn()
    {
        var mapped = LoadoutMapper.Map(new Loadout
        {
            T = new SideLoadout
            {
                Gloves = 70_000,
                Music = long.MaxValue,
                Weapons =
                [
                    new WeaponSkin { Defindex = 7, PaintId = long.MaxValue, Seed = -5, StattrakCount = long.MaxValue, Keychain = new Keychain { Id = -1 } },
                    // A defindex that is not a weapon's is skipped; the rest of the side still lands.
                    new WeaponSkin { Defindex = 0, PaintId = 1 },
                    new WeaponSkin { Defindex = (long)int.MaxValue + 1, PaintId = 1 },
                ],
            },
        }, Everything);

        Assert.Equal(ushort.MaxValue, mapped.Gloves[CsTeam.Terrorist]);
        Assert.Equal(ushort.MaxValue, mapped.Music[CsTeam.Terrorist]);
        var weapons = mapped.Weapons[CsTeam.Terrorist];
        Assert.Equal([7], weapons.Keys);
        Assert.Equal(int.MaxValue, weapons[7].Paint);
        Assert.Equal(-5, weapons[7].Seed);
        Assert.Equal(int.MaxValue, weapons[7].StatTrakCount);
        Assert.Equal(0u, weapons[7].KeyChain!.Id);
    }

    [Fact]
    public void FiveStickerSlotsInOrderAndNoMore()
    {
        var stickers = Enumerable.Range(1, 5).Select(id => new Sticker { Id = id, Rotation = id * 10 }).ToList();
        var mapped = LoadoutMapper.Map(new Loadout
        {
            Ct = new SideLoadout { Weapons = [new WeaponSkin { Defindex = 60, PaintId = 1231, Stickers = stickers }] },
        }, Everything);

        var m4 = mapped.Weapons[CsTeam.CounterTerrorist][60];
        Assert.Equal([1u, 2u, 3u, 4u, 5u], m4.Stickers.Select(sticker => sticker.Id));
        Assert.Equal([10f, 20f, 30f, 40f, 50f], m4.Stickers.Select(sticker => sticker.Rotation));
    }
}
