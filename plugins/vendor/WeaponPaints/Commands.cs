using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;

namespace WeaponPaints;

// EZPug (PATCHES.md): the menus (knife, skins, gloves, agents, music, pins), the `!ws`
// website line and the `!st` StatTrak toggle are gone with MenuManager and MySQL — a
// player's choices are the platform's page, and the loadout arrives over the link. What
// stays is what re-reads it: `!wp` for a player, `wp_refresh` for the console, and the
// upstream `!kill`, off by default.
public partial class WeaponPaints
{
	private void OnCommandRefresh(CCSPlayerController? player, CommandInfo command)
	{
		if (!Config.Additional.CommandWpEnabled || !Config.Additional.SkinEnabled || !_gBCommandsAllowed) return;
		if (!Utility.IsPlayerValid(player)) return;

		if (player == null || !player.IsValid || player.UserId == null || player.IsBot) return;

		PlayerInfo? playerInfo = new PlayerInfo
		{
			UserId = player.UserId,
			Slot = player.Slot,
			Index = (int)player.Index,
			SteamId = player?.SteamID.ToString(),
			Name = player?.PlayerName,
			IpAddress = player?.IpAddress?.Split(":")[0]
		};

		try
		{
			if (player != null && !CommandsCooldown.TryGetValue(player.Slot, out var cooldownEndTime) ||
			    player != null && DateTime.UtcNow >= (CommandsCooldown.TryGetValue(player.Slot, out cooldownEndTime) ? cooldownEndTime : DateTime.UtcNow))
			{
				CommandsCooldown[player.Slot] = DateTime.UtcNow.AddSeconds(Config.CmdRefreshCooldownSeconds);

				if (WeaponSync != null)
				{
					// EZPug (PATCHES.md): a lookup in memory, on the game thread — so the
					// re-apply below sees the data it just read, which upstream's Task.Run never guaranteed.
					WeaponSync.GetPlayerData(playerInfo);

					GivePlayerGloves(player);
					RefreshWeapons(player);
					GivePlayerAgent(player);
					GivePlayerMusicKit(player);
					AddTimer(0.15f, () => GivePlayerPin(player));
				}

				if (!string.IsNullOrEmpty(Localizer["wp_command_refresh_done"]))
				{
					player.Print(Localizer["wp_command_refresh_done"]);
				}
				return;
			}
			if (!string.IsNullOrEmpty(Localizer["wp_command_cooldown"]))
			{
				player!.Print(Localizer["wp_command_cooldown"]);
			}
		}
		catch (Exception) { }
	}

	private void RegisterCommands()
	{
		_config.Additional.CommandRefresh.ForEach(c =>
		{
			AddCommand($"css_{c}", "Skins refresh", (player, info) =>
			{
				if (!Utility.IsPlayerValid(player)) return;
				OnCommandRefresh(player, info);
			});
		});

		if (Config.Additional.CommandKillEnabled)
		{
			_config.Additional.CommandKill.ForEach(c =>
			{
				AddCommand($"css_{c}", "kill yourself", (player, _) =>
				{
					if (player == null || !Utility.IsPlayerValid(player) || player.PlayerPawn.Value == null || !player.PlayerPawn.IsValid) return;

					player.PlayerPawn.Value.CommitSuicide(true, false);
				});
			});
		}

		AddCommand("wp_refresh", "Admin refresh player skins", (player, info) =>
		{
			OnCommandSkinRefresh(player, info);
		});
	}

	private void OnCommandSkinRefresh(CCSPlayerController? player, CommandInfo command)
	{
		if (!Config.Additional.CommandWpEnabled || !Config.Additional.SkinEnabled || !_gBCommandsAllowed) return;
		if (player != null)
		{
			return;
		}

		var args = command.GetArg(1);
			
		if (string.IsNullOrEmpty(args))
		{
			Console.WriteLine("[WeaponPaints] Usage: wp_refresh <steamid64|all>");
			Console.WriteLine("[WeaponPaints] Examples:");
			Console.WriteLine("[WeaponPaints]   wp_refresh all - Refresh skins for all players");
			Console.WriteLine("[WeaponPaints]   wp_refresh 76561198012345678 - Refresh skins by SteamID64");
			return;
		}

		var targetPlayers = new List<CCSPlayerController>();

		if (args.Equals("all", StringComparison.OrdinalIgnoreCase))
		{
			targetPlayers = Utilities.GetPlayers().Where(p => 
				p != null && p.IsValid && !p.IsBot && p.UserId != null).ToList();
			
			if (targetPlayers.Count == 0)
			{
				Console.WriteLine("[WeaponPaints] No players connected to refresh.");
				return;
			}
			
			Console.WriteLine($"[WeaponPaints] Refreshing skins for {targetPlayers.Count} players...");
		}
		else
		{
			var foundPlayer = Utilities.GetPlayers().FirstOrDefault(p => 
				p != null && p.IsValid && !p.IsBot && p.UserId != null && 
				 p.SteamID.ToString() == args);

			if (foundPlayer == null)
			{
				Console.WriteLine($"[WeaponPaints] Player with SteamID64 '{args}' not found.");
				return;
			}

			targetPlayers.Add(foundPlayer);
			Console.WriteLine($"[WeaponPaints] Refreshing skins for {foundPlayer.PlayerName}...");
		}

		foreach (var targetPlayer in targetPlayers)
		{
			try
			{
				PlayerInfo? playerInfo = new PlayerInfo
				{
					UserId = targetPlayer.UserId,
					Slot = targetPlayer.Slot,
					Index = (int)targetPlayer.Index,
					SteamId = targetPlayer.SteamID.ToString(),
					Name = targetPlayer.PlayerName,
					IpAddress = targetPlayer.IpAddress?.Split(":")[0]
				};

				if (WeaponSync != null)
				{
					WeaponSync.GetPlayerData(playerInfo);
				}

				GivePlayerGloves(targetPlayer);
				RefreshWeapons(targetPlayer);
				GivePlayerAgent(targetPlayer);
				GivePlayerMusicKit(targetPlayer);
				AddTimer(0.15f, () => GivePlayerPin(targetPlayer));

				if (!string.IsNullOrEmpty(Localizer["wp_command_refresh_done"]))
				{
					targetPlayer.Print(Localizer["wp_command_refresh_done"]);
				}

				Console.WriteLine($"[WeaponPaints] Skins refreshed for {targetPlayer.PlayerName}");
			}
			catch (Exception ex)
			{
				Console.WriteLine($"[WeaponPaints] Error refreshing skins for {targetPlayer.PlayerName}: {ex.Message}");
			}
		}

		Console.WriteLine("[WeaponPaints] Refresh process completed.");
	}
}
