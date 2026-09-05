---
updatedAt: 2026-03-02T16:45:29.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Warmup & Custom Settings

Our **Warmup Config** is applied immediately upon receiving a Match POST (after the server has booted) while awaiting player connections. We recommend keeping this untouched, as the current setup with a warmup deathmatch is designed to optimize the user experience.

The **Live Config** is initiated just before the start of a match when the players have been assigned to their teams. It is at this point that custom settings, if any, should be made.

To override any of these configs, place the following files on the server (can be done programatically [via the API](https://dathost.net/reference/post_game_server_files_item)):

* For changes during the warmup phase, use `cfg/warmup_server.cfg`
* For changes when the game starts, use `cfg/live_server.cfg`

Check out our configs below to understand what is done by our API, and when your overrides will be executed.

 

```yaml Warmup Config
mp_teamname_1                         "${match.team1.name || ""}"
mp_teamflag_1                         "${match.team1.flag || ""}"
mp_teamname_2                         "${match.team2.name || ""}"
mp_teamflag_2                         "${match.team2.flag || ""}"
sv_vote_kick_ban_duration             "0"
mp_warmuptime_all_players_connected   "0"
mp_match_restart_delay                "300"
mp_limitteams                         "0"
mp_autoteambalance                    "false"
mp_warmuptime                         "${match.settings.connect_time + 3}"
mp_force_pick_time                    "0"
mp_free_armor                         "2"
mp_warmup_items_nocost                "true"
mp_buy_allow_grenades                 "false"
mp_ct_default_grenades                "weapon_smokegrenade"
mp_t_default_grenades                 "weapon_smokegrenade"
mp_ct_default_melee                   "weapon_knife"
mp_ct_default_secondary               "weapon_deagle"
mp_ct_default_primary                 "weapon_m4a1"
mp_t_default_melee                    "weapon_knife"
mp_t_default_secondary                "weapon_deagle"
mp_t_default_primary                  "weapon_ak47"
mp_maxmoney                           "0"
sv_disable_teamselect_menu            "1" // Only runs if settings.enable_plugin = true
exec                                  "warmup_server.cfg" // Add this file to add custom cvars
```
```yaml Live Config
mp_force_pick_time                    "60"
mp_free_armor                         "0"
mp_buy_allow_grenades                 "true"
mp_ct_default_grenades                ""
mp_t_default_grenades                 ""
mp_backup_round_file_pattern          "${match._id}_round%round%.txt"
mp_limitteams                         "1"
mp_team_intro_time                    "0"
mp_backup_restore_load_file           "cs2-match-api-config-${match._id}.txt"
exec                                  "live_server.cfg" // Make custom edits in this file
mp_restartgame                        "1"
tv_record                             "${match._id}"
say                                   ">>> LIVE LIVE LIVE <<<"
say                                   ">>> LIVE LIVE LIVE <<<"
say                                   ">>> LIVE LIVE LIVE <<<"
```