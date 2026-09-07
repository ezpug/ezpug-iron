using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes;
using EZPug.Sdk.Hosting;
using Microsoft.Extensions.Logging;

namespace WeaponPaints;

// EZPug (PATCHES.md): the data layer reads loadouts from the core plugin's
// ILoadoutSource over the link; there is no MySQL, no MenuManager and no menu in
// this fork, and nothing here reaches the network.
[MinimumApiVersion(338)]
public partial class WeaponPaints : BasePlugin, IPluginConfig<WeaponPaintsConfig>
{
	internal static WeaponPaints Instance { get; private set; } = new();

	public WeaponPaintsConfig Config { get; set; } = new();
    private static WeaponPaintsConfig _config { get; set; } = new();
    public override string ModuleAuthor => "Nereziel & daffyy; the data layer by EZPug";
	public override string ModuleDescription => "Skins, gloves, agents, music kits and pins from the EZPug loadout a match carries";
	public override string ModuleName => "WeaponPaints";
	public override string ModuleVersion => "3.3a";

	public override void Load(bool hotReload)
	{
		Instance = this;

		FindLoadouts();
		WeaponSync = new WeaponSynchronization(_loadouts, Config);

		// Upstream re-read every connected player only on a hot reload, because a fresh
		// load had nobody connected yet. This plugin is hot-loaded by the core plugin's
		// loader when a match is assigned, sometimes with players standing (an open-join
		// mode), so it always asks — a player the source knows is dressed on their next
		// spawn, and a player it does not is left alone.
		OnMapStart(string.Empty);

		GPlayerWeaponsInfo.Clear();
		GPlayersKnife.Clear();
		GPlayersGlove.Clear();
		GPlayersAgent.Clear();
		GPlayersPin.Clear();
		GPlayersMusic.Clear();

		foreach (var player in Enumerable
			         .OfType<CCSPlayerController>(Utilities.GetPlayers().TakeWhile(_ => WeaponSync != null))
			         .Where(player => player.IsValid &&
				         !string.IsNullOrEmpty(player.IpAddress) && player is
					         { IsBot: false, Connected: PlayerConnectedState.Connected }))
		{
			var playerInfo = new PlayerInfo
			{
				UserId = player.UserId,
				Slot = player.Slot,
				Index = (int)player.Index,
				SteamId = player?.SteamID.ToString(),
				Name = player?.PlayerName,
				IpAddress = player?.IpAddress?.Split(":")[0]
			};

			WeaponSync?.GetPlayerData(playerInfo);
		}

		Utility.LoadSkinsFromFile(ModuleDirectory + $"/data/skins_{_config.SkinsLanguage}.json", Logger);
		Utility.LoadGlovesFromFile(ModuleDirectory + $"/data/gloves_{_config.SkinsLanguage}.json", Logger);
		Utility.LoadAgentsFromFile(ModuleDirectory + $"/data/agents_{_config.SkinsLanguage}.json", Logger);
		Utility.LoadMusicFromFile(ModuleDirectory + $"/data/music_{_config.SkinsLanguage}.json", Logger);
		Utility.LoadPinsFromFile(ModuleDirectory + $"/data/collectibles_{_config.SkinsLanguage}.json", Logger);

		RegisterListeners();
	}

	public override void Unload(bool hotReload)
	{
		if (_loadouts is { } loadouts)
		{
			loadouts.LoadoutChanged -= OnLoadoutChanged;
			_loadouts = null;
		}
	}

	public void OnConfigParsed(WeaponPaintsConfig config)
	{
		Config = config;
		_config = config;

		// Upstream looked two levels up from the plugin folder, which is the
		// counterstrikesharp root only for a plugin under `plugins/`; this one is
		// installed under `plugins/disabled/` and hot-loaded (decision 16), so the
		// root is found by name. Measured on the dev node: the old path put a
		// "you need to upload weaponpaints.json" error in every boot log while
		// CounterStrikeSharp had already loaded the file.
		if (!File.Exists(Path.Combine(CounterStrikeSharpRoot(), "gamedata", "weaponpaints.json")))
		{
			Logger.LogError("You need to upload \"weaponpaints.json\" to \"gamedata directory\"!");
			Unload(false);
			return;
		}

		_localizer = Localizer;

		Utility.Config = config;
		Utility.ShowAd(ModuleVersion);
	}

	public override void OnAllPluginsLoaded(bool hotReload)
	{
		if (_loadouts is null)
		{
			// The core plugin came later than this one: look once more now that every
			// plugin has loaded, the way an EZPug gamemode plugin does.
			FindLoadouts();
			WeaponSync = new WeaponSynchronization(_loadouts, Config);
		}

		RegisterCommands();
	}

	/// <summary>The <c>addons/counterstrikesharp</c> directory this plugin is installed under, however deep; upstream's two-levels-up when no ancestor carries the name.</summary>
	private string CounterStrikeSharpRoot()
	{
		for (var directory = new DirectoryInfo(ModuleDirectory); directory is not null; directory = directory.Parent)
		{
			if (string.Equals(directory.Name, "counterstrikesharp", StringComparison.OrdinalIgnoreCase))
				return directory.FullName;
		}

		return Path.GetDirectoryName(Path.GetDirectoryName(ModuleDirectory)) ?? ModuleDirectory;
	}

	/// <summary>
	/// The one door a loadout comes through: the core plugin's <see cref="ILoadoutSource"/>,
	/// found through CounterStrikeSharp's shared plugin API. Without it every player keeps
	/// default items and the match runs regardless — skins never touch match flow.
	/// </summary>
	private void FindLoadouts()
	{
		if (_loadouts is not null)
			return;

		_loadouts = LoadoutSource.Find();
		if (_loadouts is null)
		{
			Logger.LogWarning("EZPug.Core is not loaded, so no loadout can reach this server: every player keeps default items until it is");
			return;
		}

		_loadouts.LoadoutChanged += OnLoadoutChanged;
		Logger.LogInformation("loadouts come from EZPug.Core over the link; MySQL is not involved");
	}

	/// <summary>
	/// A <c>profile</c> reached the core plugin for a player: re-read their loadout now if they
	/// are standing here, so the next weapon, spawn or <c>!wp</c> applies it. Nothing is forced
	/// on the player mid-round — the platform's page says "applies on your next connect, or
	/// type !wp", and that stays true. A player who is not connected (or a bot, which upstream
	/// never dresses) is read when they connect, as before.
	/// </summary>
	private void OnLoadoutChanged(ulong steamId64)
	{
		try
		{
			var player = Utilities.GetPlayerFromSteamId(steamId64);
			if (player is null || !player.IsValid || player.IsBot || player.UserId is null)
			{
				Logger.LogInformation("loadout for {SteamId64} changed; nobody by that SteamID is connected, so it is read on their connect", steamId64);
				return;
			}

			var playerInfo = new PlayerInfo
			{
				UserId = player.UserId,
				Slot = player.Slot,
				Index = (int)player.Index,
				SteamId = player.SteamID.ToString(),
				Name = player.PlayerName,
				IpAddress = player.IpAddress?.Split(":")[0]
			};

			WeaponSync?.GetPlayerData(playerInfo);
			Logger.LogInformation("loadout for {SteamId64} ({Name}) re-read; it applies on their next spawn, weapon or !wp", steamId64, player.PlayerName);
		}
		catch (Exception ex)
		{
			Logger.LogWarning("could not re-read the loadout for {SteamId64}: {Message}", steamId64, ex.Message);
		}
	}
}
