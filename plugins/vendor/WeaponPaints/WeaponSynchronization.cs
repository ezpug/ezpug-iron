using System.Collections.Concurrent;
using CounterStrikeSharp.API.Modules.Utils;
using EZPug.Sdk.Hosting;

namespace WeaponPaints;

/// <summary>
/// <b>The data layer, over the link instead of MySQL</b> (EZPug PATCHES.md; decision 20 of
/// ezpug-iron). Upstream's class opened a connection and ran six <c>SELECT</c>s per player
/// into the plugin's tables; this one asks the core plugin's <see cref="ILoadoutSource"/> for
/// the player's Match API loadout — the roster's, or the latest <c>profile</c> push — and
/// <see cref="LoadoutMapper"/> turns it into the same rows. Synchronous and on the game
/// thread: there is no I/O left to take off it, and the source is a lookup in memory.
///
/// The writers (<c>Sync*ToDatabase</c>) are kept as no-ops so the call sites upstream left
/// behind (the disconnect hook's StatTrak flush) compile unchanged: a StatTrak counter the
/// plugin bumps in-game is the platform's to persist, and it travels the other way — nothing
/// on a server writes a loadout.
/// </summary>
internal class WeaponSynchronization
{
	private readonly WeaponPaintsConfig _config;
	private readonly ILoadoutSource? _source;

	internal WeaponSynchronization(ILoadoutSource? source, WeaponPaintsConfig config)
	{
		_source = source;
		_config = config;
	}

	/// <summary>Whether a source is there to ask. Without the core plugin every player keeps default items.</summary>
	internal bool Linked => _source is not null;

	/// <summary>
	/// Replace what the plugin holds for the player's slot with their current loadout. A
	/// player nobody has a loadout for ends up with nothing on the slot — the same as no
	/// rows — which also covers a refreshed profile that dropped a side.
	/// </summary>
	internal void GetPlayerData(PlayerInfo? player)
	{
		if (player is null || string.IsNullOrEmpty(player.SteamId) || !ulong.TryParse(player.SteamId, out var steamId64))
			return;

		try
		{
			var mapped = LoadoutMapper.Map(_source?.LoadoutOf(steamId64), _config.Additional);
			Apply(player.Slot, mapped);
		}
		catch (Exception ex)
		{
			Utility.Log($"An error occurred in GetPlayerData: {ex.Message}");
		}
	}

	/// <summary>Copy a mapped loadout into the plugin's tables for one slot, clearing the slot first.</summary>
	internal static void Apply(int slot, MappedLoadout mapped)
	{
		WeaponPaints.GPlayersKnife.TryRemove(slot, out _);
		WeaponPaints.GPlayersGlove.TryRemove(slot, out _);
		WeaponPaints.GPlayersMusic.TryRemove(slot, out _);
		WeaponPaints.GPlayersPin.TryRemove(slot, out _);
		WeaponPaints.GPlayersAgent.TryRemove(slot, out _);
		WeaponPaints.GPlayerWeaponsInfo.TryRemove(slot, out _);

		foreach (var (team, knife) in mapped.Knives)
		{
			WeaponPaints.GPlayersKnife.GetOrAdd(slot, _ => new ConcurrentDictionary<CsTeam, string>())[team] = knife;
		}

		foreach (var (team, glove) in mapped.Gloves)
		{
			WeaponPaints.GPlayersGlove.GetOrAdd(slot, _ => new ConcurrentDictionary<CsTeam, ushort>())[team] = glove;
		}

		foreach (var (team, music) in mapped.Music)
		{
			WeaponPaints.GPlayersMusic.GetOrAdd(slot, _ => new ConcurrentDictionary<CsTeam, ushort>())[team] = music;
		}

		foreach (var (team, pin) in mapped.Pins)
		{
			WeaponPaints.GPlayersPin.GetOrAdd(slot, _ => new ConcurrentDictionary<CsTeam, ushort>())[team] = pin;
		}

		if (mapped.Agents is { } agents)
		{
			WeaponPaints.GPlayersAgent[slot] = agents;
		}

		foreach (var (team, weapons) in mapped.Weapons)
		{
			var playerWeapons = WeaponPaints.GPlayerWeaponsInfo.GetOrAdd(slot,
				_ => new ConcurrentDictionary<CsTeam, ConcurrentDictionary<int, WeaponInfo>>());
			var teamWeapons = playerWeapons.GetOrAdd(team, _ => new ConcurrentDictionary<int, WeaponInfo>());
			foreach (var (defindex, info) in weapons)
			{
				teamWeapons[defindex] = info;
			}
		}
	}

	// The writers. Upstream persisted a menu choice or a StatTrak count back to MySQL;
	// nothing on an EZPug server writes a loadout, so each is a no-op with its signature
	// kept for the call sites that remain.

	internal Task SyncKnifeToDatabase(PlayerInfo player, string knife, CsTeam[] teams) => Task.CompletedTask;

	internal Task SyncGloveToDatabase(PlayerInfo player, ushort gloveDefIndex, CsTeam[] teams) => Task.CompletedTask;

	internal Task SyncAgentToDatabase(PlayerInfo player) => Task.CompletedTask;

	internal Task SyncWeaponPaintsToDatabase(PlayerInfo player) => Task.CompletedTask;

	internal Task SyncMusicToDatabase(PlayerInfo player, ushort music, CsTeam[] teams) => Task.CompletedTask;

	internal Task SyncPinToDatabase(PlayerInfo player, ushort pin, CsTeam[] teams) => Task.CompletedTask;

	internal Task SyncStatTrakToDatabase(PlayerInfo player) => Task.CompletedTask;
}
