using CounterStrikeSharp.API.Modules.Utils;
using EZPug.Sdk.Protocol;

namespace WeaponPaints;

/// <summary>
/// One player's loadout in the shape the plugin keeps it — what upstream's six
/// <c>Get*FromDatabase</c> readers assembled out of six MySQL tables, as one value the
/// mapper builds and <see cref="WeaponSynchronization"/> copies into the plugin's tables.
/// Plain dictionaries rather than the plugin's own <c>ConcurrentDictionary</c> statics so
/// the mapping can be proven under xunit without the engine (the statics sit on the
/// plugin class, whose static initialiser reads game signatures).
/// </summary>
public sealed class MappedLoadout
{
	public Dictionary<CsTeam, string> Knives { get; } = new();
	public Dictionary<CsTeam, ushort> Gloves { get; } = new();
	public Dictionary<CsTeam, ushort> Music { get; } = new();
	public Dictionary<CsTeam, ushort> Pins { get; } = new();
	/// <summary>Agents are one row per player, not per side: <c>(agent_ct, agent_t)</c>, or <c>null</c> when the loadout names neither.</summary>
	public (string? CT, string? T)? Agents { get; set; }
	public Dictionary<CsTeam, Dictionary<int, WeaponInfo>> Weapons { get; } = new();

	public bool IsEmpty =>
		Knives.Count == 0 && Gloves.Count == 0 && Music.Count == 0 && Pins.Count == 0 && Agents is null && Weapons.Count == 0;
}

/// <summary>
/// <b>The data layer</b> (EZPug PATCHES.md): a Match API <c>Loadout</c> — the roster's, or a
/// <c>profile</c> push's, handed over by the core plugin through <c>ILoadoutSource</c> —
/// mapped into what the plugin used to read out of MySQL. The schema is a mapping of the
/// pinned commit's tables field for field (<c>Loadout</c>'s doc comment in
/// <c>@ezpug/match-api</c> lists the correspondence), so every rule upstream applied to a
/// row is applied here to a field:
///
/// <list type="bullet">
/// <item><c>weapon_team</c> <c>2</c> is <see cref="CsTeam.Terrorist"/> and <c>3</c> is
/// <see cref="CsTeam.CounterTerrorist"/> — the Match API's <c>t</c> and <c>ct</c> blocks.
/// Upstream copied a row with <c>weapon_team</c> <c>0</c> to both sides; the Match API has
/// no such row, a side is present or it is not.</item>
/// <item>a keychain column read as <c>0;0;0;0;0</c> when the player had none, and the
/// reader still produced a <c>KeyChainInfo</c> of zeros; an absent keychain maps to the
/// same zeros, so <c>GivePlayerWeaponSkin</c> behaves exactly as it did.</item>
/// <item>five sticker columns, each <c>id;schema;x;y;wear;scale;rotation</c> or empty; the
/// Match API sends only the occupied slots, in order, and each becomes a
/// <see cref="StickerInfo"/> the way a parsed column did.</item>
/// <item>the feature flags (<c>KnifeEnabled</c> and friends) gate each table's read, as
/// they gated each query.</item>
/// <item>a value the plugin holds narrower than the wire (a <c>ushort</c> glove or music
/// id, an <c>int</c> paint) is clamped, never thrown on — a loadout that would not fit
/// degrades to default items, and skins never touch match flow.</item>
/// </list>
/// </summary>
public static class LoadoutMapper
{
	/// <summary>The fork's <c>weapon_team</c> for each Match API side (<c>LOADOUT_SIDE_TEAM_NUMBER</c> in <c>@ezpug/match-api</c>).</summary>
	public const int TerroristTeamNumber = 2;
	public const int CounterTerroristTeamNumber = 3;

	public static MappedLoadout Map(Loadout? loadout, Additional features)
	{
		var mapped = new MappedLoadout();
		if (loadout is null)
		{
			return mapped;
		}

		MapSide(mapped, CsTeam.Terrorist, loadout.T, features);
		MapSide(mapped, CsTeam.CounterTerrorist, loadout.Ct, features);

		if (features.AgentEnabled)
		{
			var ct = loadout.Ct?.Agent;
			var t = loadout.T?.Agent;
			if (!string.IsNullOrEmpty(ct) || !string.IsNullOrEmpty(t))
			{
				mapped.Agents = (ct, t);
			}
		}

		return mapped;
	}

	private static void MapSide(MappedLoadout mapped, CsTeam team, SideLoadout? side, Additional features)
	{
		if (side is null)
		{
			return;
		}

		if (features.KnifeEnabled && !string.IsNullOrEmpty(side.Knife))
		{
			mapped.Knives[team] = side.Knife;
		}

		if (features.GloveEnabled && side.Gloves is { } gloves && gloves > 0)
		{
			mapped.Gloves[team] = ToUShort(gloves);
		}

		if (features.MusicEnabled && side.Music is { } music && music > 0)
		{
			mapped.Music[team] = ToUShort(music);
		}

		if (features.PinsEnabled && side.Pin is { } pin && pin > 0)
		{
			mapped.Pins[team] = ToUShort(pin);
		}

		if (!features.SkinEnabled)
		{
			return;
		}

		foreach (var skin in side.Weapons)
		{
			if (skin.Defindex <= 0 || skin.Defindex > int.MaxValue)
			{
				continue;
			}

			if (!mapped.Weapons.TryGetValue(team, out var weapons))
			{
				weapons = new Dictionary<int, WeaponInfo>();
				mapped.Weapons[team] = weapons;
			}

			weapons[(int)skin.Defindex] = MapWeapon(skin);
		}
	}

	/// <summary>One <c>wp_player_skins</c> row, as <c>GetWeaponPaintsFromDatabase</c> read it.</summary>
	public static WeaponInfo MapWeapon(WeaponSkin skin)
	{
		var info = new WeaponInfo
		{
			Paint = ToInt(skin.PaintId),
			Seed = ToInt(skin.Seed),
			Wear = (float)skin.Wear,
			Nametag = skin.Nametag ?? "",
			StatTrak = skin.Stattrak,
			StatTrakCount = ToInt(skin.StattrakCount),
			KeyChain = skin.Keychain is { } keychain
				? new KeyChainInfo
				{
					Id = ToUInt(keychain.Id),
					OffsetX = (float)keychain.X,
					OffsetY = (float)keychain.Y,
					OffsetZ = (float)keychain.Z,
					Seed = ToUInt(keychain.Seed),
				}
				: new KeyChainInfo(),
		};

		foreach (var sticker in skin.Stickers)
		{
			info.Stickers.Add(new StickerInfo
			{
				Id = ToUInt(sticker.Id),
				Schema = ToUInt(sticker.Schema),
				OffsetX = (float)sticker.X,
				OffsetY = (float)sticker.Y,
				Wear = (float)sticker.Wear,
				Scale = (float)sticker.Scale,
				Rotation = (float)sticker.Rotation,
			});
		}

		return info;
	}

	private static int ToInt(long value) => (int)Math.Clamp(value, int.MinValue, int.MaxValue);

	private static uint ToUInt(long value) => (uint)Math.Clamp(value, 0, uint.MaxValue);

	private static ushort ToUShort(long value) => (ushort)Math.Clamp(value, 0, ushort.MaxValue);
}
