---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Update a game server

If the server is on this will restart the server to reflect the changes.

# OpenAPI definition

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "API",
    "version": "1.0"
  },
  "paths": {
    "/api/0.1/game-servers/{server_id}": {
      "parameters": [
        {
          "in": "path",
          "name": "server_id",
          "required": true,
          "schema": {
            "type": "string"
          }
        }
      ],
      "put": {
        "description": "If the server is on this will restart the server to reflect the changes.",
        "operationId": "put_game_server_item",
        "requestBody": {
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "properties": {
                  "added_voice_server": {
                    "description": "ID of a voice server that was purchased with this server",
                    "type": "string"
                  },
                  "autostop": {
                    "description": "Automatically stop server when empty <autostop_minutes> min",
                    "type": "boolean"
                  },
                  "autostop_minutes": {
                    "description": "Minutes until autostop triggers if is is enabled",
                    "type": "integer"
                  },
                  "confirmed": {
                    "description": "Has the server been ordered yet (used internally)",
                    "type": "boolean"
                  },
                  "custom_domain": {
                    "description": "Use a custom domain for the server",
                    "type": "string"
                  },
                  "deletion_protection": {
                    "description": "While this is set DELETE operation will be blocked",
                    "type": "boolean"
                  },
                  "enable_core_dump": {
                    "description": "Write core dump file on server crash",
                    "type": "boolean"
                  },
                  "enable_mysql": {
                    "description": "Enable MySQL addon",
                    "type": "boolean"
                  },
                  "enable_syntropy": {
                    "type": "boolean"
                  },
                  "location": {
                    "description": "ID for the location of the server, see this article for available locations:<br /><a target=\"_blank\" href=\"https://help.dathost.net/article/76-api-server-locations-mapping\">https://help.dathost.net/article/76-api-server-locations-mapping</a>",
                    "type": "string"
                  },
                  "manual_sort_order": {
                    "description": "Sort order in control panel",
                    "type": "number"
                  },
                  "max_disk_usage_gb": {
                    "description": "Max disk usage excluding base installation in GB, 30GB included, extra disk space charged at €0.3 / GB / Month",
                    "type": "integer",
                    "minimum": 30,
                    "maximum": 100
                  },
                  "name": {
                    "description": "Name of the server",
                    "type": "string"
                  },
                  "prefer_dedicated": {
                    "description": "Prefer assignment to dedicated hosts on account",
                    "type": "boolean"
                  },
                  "reboot_on_crash": {
                    "description": "Automatically reboot the server in case of server crash",
                    "type": "boolean"
                  },
                  "scheduled_commands": {
                    "description": "JSON list with scheduled commands (see game-servers.GET for format to use)",
                    "type": "string"
                  },
                  "server_image": {
                    "description": "Server image to use for this server",
                    "type": "string",
                    "enum": [
                      "default",
                      "ubuntu_20.04"
                    ]
                  },
                  "user_data": {
                    "description": "Custom metadata for the server, is not used by the DatHost system",
                    "type": "string"
                  },
                  "ark_settings.enable_ark_server_api": {
                    "description": "Enable ARK Server API",
                    "type": "boolean"
                  },
                  "cs2_settings.steam_game_server_login_token": {
                    "description": "Steam Game Server Login Token",
                    "type": "string"
                  },
                  "cs2_settings.disable_bots": {
                    "description": "Disable bots",
                    "type": "boolean"
                  },
                  "cs2_settings.enable_gotv": {
                    "description": "Enable GOTV",
                    "type": "boolean"
                  },
                  "cs2_settings.enable_gotv_secondary": {
                    "description": "Enables a secondary GOTV stream on the same server. <br><b>Warning:</b> The tv_delay and tv_delay1 shouldn’t be more than 10 seconds apart, otherwise the server runs the risk of a sudden shutdown.",
                    "type": "boolean"
                  },
                  "cs2_settings.enable_metamod": {
                    "description": "Enable MetaMod",
                    "type": "boolean"
                  },
                  "cs2_settings.game_mode": {
                    "description": "Game mode",
                    "type": "string",
                    "enum": [
                      "competitive",
                      "casual",
                      "arms_race",
                      "ffa_deathmatch",
                      "retakes",
                      "wingman",
                      "custom"
                    ]
                  },
                  "cs2_settings.insecure": {
                    "description": "Insecure server",
                    "type": "boolean"
                  },
                  "cs2_settings.maps_source": {
                    "description": "Maps source (in workshop single map mode only workshop_start_map_id is loaded)",
                    "type": "string",
                    "enum": [
                      "mapgroup",
                      "workshop_collection",
                      "workshop_single_map"
                    ]
                  },
                  "cs2_settings.mapgroup": {
                    "description": "Mapgroup",
                    "type": "string"
                  },
                  "cs2_settings.mapgroup_start_map": {
                    "description": "Mapgroup start map",
                    "type": "string"
                  },
                  "cs2_settings.workshop_collection_start_map_id": {
                    "description": "Steam ID of workshop start map",
                    "type": "string"
                  },
                  "cs2_settings.workshop_single_map_id": {
                    "description": "Steam ID of workshop single map",
                    "type": "string"
                  },
                  "cs2_settings.password": {
                    "description": "Server password",
                    "type": "string"
                  },
                  "cs2_settings.private_server": {
                    "description": "Private server",
                    "type": "boolean"
                  },
                  "cs2_settings.disable_workshop_command_filtering": {
                    "description": "Disables the filtering of console commands on community/workshop maps, allowing all commands to be executed. By default, CS2 restricts certain commands when running workshop content.",
                    "type": "boolean"
                  },
                  "cs2_settings.rcon": {
                    "description": "RCON password",
                    "type": "string"
                  },
                  "cs2_settings.slots": {
                    "description": "Server slots (5 - 64)",
                    "type": "integer",
                    "minimum": 5,
                    "maximum": 64
                  },
                  "csgo_settings.autoload_configs": {
                    "description": "JSON list of configs to load automatically",
                    "type": "string"
                  },
                  "csgo_settings.disable_1v1_warmup_arenas": {
                    "description": "Disable 1v1 warmup arenas",
                    "type": "boolean"
                  },
                  "csgo_settings.disable_bots": {
                    "description": "Disable bots",
                    "type": "boolean"
                  },
                  "csgo_settings.enable_csay_plugin": {
                    "description": "Enable cSay plugin (required for eBot)",
                    "type": "boolean"
                  },
                  "csgo_settings.enable_gotv": {
                    "description": "Enable GOTV",
                    "type": "boolean"
                  },
                  "csgo_settings.enable_gotv_secondary": {
                    "description": "Enables a secondary GOTV stream on the same server. <br><b>Warning:</b> The tv_delay and tv_delay1 shouldn’t be more than 10 seconds apart, otherwise the server runs the risk of a sudden shutdown.",
                    "type": "boolean"
                  },
                  "csgo_settings.enable_sourcemod": {
                    "description": "Enable Sourcemod",
                    "type": "boolean"
                  },
                  "csgo_settings.game_mode": {
                    "description": "Game mode",
                    "type": "string",
                    "enum": [
                      "classic_competitive",
                      "classic_casual",
                      "arms_race",
                      "demolition",
                      "deathmatch",
                      "custom",
                      "danger_zone",
                      "wingman",
                      "guardian",
                      "coop_strike",
                      "short_competitive"
                    ]
                  },
                  "csgo_settings.insecure": {
                    "description": "Insecure server",
                    "type": "boolean"
                  },
                  "csgo_settings.mapgroup": {
                    "description": "Mapgroup",
                    "type": "string"
                  },
                  "csgo_settings.mapgroup_start_map": {
                    "description": "Mapgroup start map",
                    "type": "string"
                  },
                  "csgo_settings.maps_source": {
                    "description": "Maps source - mapgroup, workshop or workshop_single_map (in single map mode only workshop_start_map_id is loaded)",
                    "type": "string",
                    "enum": [
                      "mapgroup",
                      "workshop",
                      "workshop_single_map"
                    ]
                  },
                  "csgo_settings.password": {
                    "description": "Server password",
                    "type": "string"
                  },
                  "csgo_settings.private_server": {
                    "description": "Private server",
                    "type": "boolean"
                  },
                  "csgo_settings.pure_server": {
                    "description": "Pure server",
                    "type": "boolean"
                  },
                  "csgo_settings.rcon": {
                    "description": "RCON password",
                    "type": "string"
                  },
                  "csgo_settings.slots": {
                    "description": "Server slots (5 - 64)",
                    "type": "integer",
                    "minimum": 5,
                    "maximum": 64
                  },
                  "csgo_settings.sourcemod_admins": {
                    "description": "This string is written as is to csgo/addons/sourcemod/configs/admins_simple.ini, documentation can be found here: https://wiki.alliedmods.net/Adding_Admins_(SourceMod)",
                    "type": "string"
                  },
                  "csgo_settings.sourcemod_plugins": {
                    "description": "JSON list of sourcemod plugin IDs",
                    "type": "string"
                  },
                  "csgo_settings.steam_game_server_login_token": {
                    "description": "Steam Game Server Login Token",
                    "type": "string"
                  },
                  "csgo_settings.tickrate": {
                    "description": "Server tickrate",
                    "type": "number",
                    "enum": [
                      64,
                      85,
                      100,
                      102.4,
                      128
                    ]
                  },
                  "csgo_settings.workshop_authkey": {
                    "description": "Workshop collection authkey, leave blank to use our default Authkey",
                    "type": "string"
                  },
                  "csgo_settings.workshop_id": {
                    "description": "Steam workshop ID",
                    "type": "string"
                  },
                  "csgo_settings.workshop_start_map_id": {
                    "description": "Steam ID of workshop start map",
                    "type": "string"
                  },
                  "teamfortress2_settings.enable_gotv": {
                    "description": "Enable GOTV",
                    "type": "boolean"
                  },
                  "teamfortress2_settings.enable_sourcemod": {
                    "description": "Enable Sourcemod",
                    "type": "boolean"
                  },
                  "teamfortress2_settings.insecure": {
                    "description": "Insecure server",
                    "type": "boolean"
                  },
                  "teamfortress2_settings.password": {
                    "description": "Server password",
                    "type": "string"
                  },
                  "teamfortress2_settings.rcon": {
                    "description": "Server RCON",
                    "type": "string"
                  },
                  "teamfortress2_settings.slots": {
                    "description": "Server slots (5 - 32)",
                    "type": "integer",
                    "minimum": 5,
                    "maximum": 32
                  },
                  "teamfortress2_settings.sourcemod_admins": {
                    "description": "This string is written as is to tf/addons/sourcemod/configs/admins_simple.ini, documentation can be found here: https://wiki.alliedmods.net/Adding_Admins_(SourceMod)",
                    "type": "string"
                  },
                  "teamfortress2_settings.start_map": {
                    "description": "Starting map",
                    "type": "string"
                  },
                  "teamspeak3_settings.slots": {
                    "description": "Server slots (5 - 1000)",
                    "type": "integer",
                    "minimum": 5,
                    "maximum": 1000
                  },
                  "valheim_settings.admins_steamid64": {
                    "description": "JSON list of server admins in SteamID64 format",
                    "type": "string"
                  },
                  "valheim_settings.bepinex_plugins": {
                    "description": "JSON list of BepInEx plugin IDs",
                    "type": "string"
                  },
                  "valheim_settings.enable_bepinex": {
                    "description": "Enable BepInEx",
                    "type": "boolean"
                  },
                  "valheim_settings.enable_crossplay": {
                    "description": "Enable crossplay",
                    "type": "boolean"
                  },
                  "valheim_settings.password": {
                    "description": "Server password",
                    "type": "string"
                  },
                  "valheim_settings.server_branch": {
                    "description": "Server branch",
                    "type": "string"
                  },
                  "valheim_settings.world_name": {
                    "description": "World name",
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Success"
          }
        },
        "summary": "Update a game server",
        "tags": [
          "Game Servers > General"
        ]
      }
    }
  },
  "tags": [
    {
      "description": "Game Servers > General",
      "name": "Game Servers > General"
    }
  ],
  "x-readme": {
    "proxy-enabled": false
  },
  "servers": [
    {
      "url": "//dathost.com"
    }
  ]
}
```