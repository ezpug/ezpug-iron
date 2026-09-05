---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Duplicate a game server

Copies settings and files to a new server. Please note that the server's files are duplicated from a local cache, to make sure the latest file changes are preserved, update the local cache with the sync-files method first. Returns the new server.

# OpenAPI definition

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "API",
    "version": "1.0"
  },
  "paths": {
    "/api/0.1/game-servers/{server_id}/duplicate": {
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
      "post": {
        "description": "Copies settings and files to a new server. Please note that the server's files are duplicated from a local cache, to make sure the latest file changes are preserved, update the local cache with the sync-files method first. Returns the new server.",
        "operationId": "post_game_server_duplicate",
        "requestBody": {
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "properties": {
                  "location": {
                    "description": "ID for the location of the server, if not set it will use the same location as the source server. See this article for available locations:<br /><a target=\"_blank\" href=\"https://help.dathost.net/article/76-api-server-locations-mapping\">https://help.dathost.net/article/76-api-server-locations-mapping</a>",
                    "type": "string"
                  },
                  "destination_server_id": {
                    "description": "Optional destination server ID, if this is set this destination server will be WIPED and the settings/files of the source server will be copied over. If this isn't set a new server will be created instead.",
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/GameServerOutput"
                }
              }
            }
          },
          "404": {
            "description": "A server with this id was not found"
          }
        },
        "summary": "Duplicate a game server",
        "tags": [
          "Game Servers > Actions"
        ]
      }
    }
  },
  "tags": [
    {
      "description": "Game Servers > Actions",
      "name": "Game Servers > Actions"
    }
  ],
  "x-readme": {
    "proxy-enabled": false
  },
  "servers": [
    {
      "url": "//dathost.com"
    }
  ],
  "components": {
    "schemas": {
      "GameServerOutput": {
        "properties": {
          "added_voice_server": {
            "description": "ID of a voice server that was purchased with this server",
            "type": "string"
          },
          "ark_settings": {
            "properties": {
              "cluster_main_server": {
                "description": "Cluster main server",
                "type": "string"
              },
              "enable_ark_server_api": {
                "description": "Enable ARK Server API",
                "type": "boolean"
              },
              "server_branch": {
                "description": "Server branch",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "autostop": {
            "description": "Automatically stop server when empty <autostop_minutes> min",
            "type": "boolean"
          },
          "autostop_minutes": {
            "description": "Minutes until autostop triggers if is is enabled",
            "type": "integer"
          },
          "booting": {
            "description": "Is the server in booting state?",
            "type": "boolean"
          },
          "confirmed": {
            "description": "Has the server been ordered yet (used internally)",
            "type": "boolean"
          },
          "cost_per_hour": {
            "description": "Current cost per hour for this server",
            "type": "number"
          },
          "cost_per_month": {
            "description": "Base cost per month for this server (before storage/multiplier), used for grandfathered pricing",
            "type": "number"
          },
          "created_at": {
            "description": "UNIX timestamp when the server was created",
            "type": "integer"
          },
          "cs2_settings": {
            "properties": {
              "steam_game_server_login_token": {
                "description": "Steam Game Server Login Token",
                "type": "string"
              },
              "disable_bots": {
                "description": "Disable bots",
                "type": "boolean"
              },
              "enable_gotv": {
                "description": "Enable GOTV",
                "type": "boolean"
              },
              "enable_gotv_secondary": {
                "description": "Enables a secondary GOTV stream on the same server. <br><b>Warning:</b> The tv_delay and tv_delay1 shouldn’t be more than 10 seconds apart, otherwise the server runs the risk of a sudden shutdown.",
                "type": "boolean"
              },
              "enable_metamod": {
                "description": "Enable our managed version of MetaMod",
                "type": "boolean"
              },
              "game_mode": {
                "description": "Game mode",
                "type": "string"
              },
              "insecure": {
                "description": "Insecure server",
                "type": "boolean"
              },
              "maps_source": {
                "description": "Maps source",
                "type": "string",
                "enum": [
                  "mapgroup",
                  "workshop_collection",
                  "workshop_single_map"
                ]
              },
              "mapgroup": {
                "description": "Mapgroup",
                "type": "string"
              },
              "mapgroup_start_map": {
                "description": "Mapgroup start map",
                "type": "string"
              },
              "workshop_collection_id": {
                "description": "Steam workshop collection ID",
                "type": "string"
              },
              "workshop_collection_start_map_id": {
                "description": "Steam ID of workshop start map",
                "type": "string"
              },
              "workshop_single_map_id": {
                "description": "Steam ID of workshop single map",
                "type": "string"
              },
              "password": {
                "description": "Server password",
                "type": "string"
              },
              "private_server": {
                "description": "Private server",
                "type": "boolean"
              },
              "disable_workshop_command_filtering": {
                "description": "Disables the filtering of console commands on community/workshop maps, allowing all commands to be executed. By default, CS2 restricts certain commands when running workshop content.",
                "type": "boolean"
              },
              "rcon": {
                "description": "RCON password",
                "type": "string"
              },
              "slots": {
                "description": "Server slots",
                "type": "integer"
              }
            },
            "type": "object",
            "additionalProperties": true
          },
          "csgo_settings": {
            "properties": {
              "autoload_configs": {
                "description": "List of configs to load automatically",
                "items": {
                  "type": "string"
                },
                "type": "array"
              },
              "disable_1v1_warmup_arenas": {
                "description": "Disable 1v1 warmup arenas",
                "type": "boolean"
              },
              "disable_bots": {
                "description": "Disable bots",
                "type": "boolean"
              },
              "enable_csay_plugin": {
                "description": "Enable cSay plugin (required for eBot)",
                "type": "boolean"
              },
              "enable_gotv": {
                "description": "Enable GOTV",
                "type": "boolean"
              },
              "enable_gotv_secondary": {
                "description": "Enables a secondary GOTV stream on the same server. <br><b>Warning:</b> The tv_delay and tv_delay1 shouldn’t be more than 10 seconds apart, otherwise the server runs the risk of a sudden shutdown.",
                "type": "boolean"
              },
              "enable_sourcemod": {
                "description": "Enable Sourcemod",
                "type": "boolean"
              },
              "game_mode": {
                "description": "Game mode",
                "type": "string"
              },
              "insecure": {
                "description": "Insecure server",
                "type": "boolean"
              },
              "mapgroup": {
                "description": "Mapgroup",
                "type": "string"
              },
              "mapgroup_start_map": {
                "description": "Mapgroup start map",
                "type": "string"
              },
              "maps_source": {
                "description": "Maps source - mapgroup, workshop or workshop_single_map (in single map mode only workshop_start_map_id is loaded)",
                "type": "string"
              },
              "password": {
                "description": "Server password",
                "type": "string"
              },
              "private_server": {
                "description": "Private server",
                "type": "boolean"
              },
              "pure_server": {
                "description": "Pure server",
                "type": "boolean"
              },
              "rcon": {
                "description": "RCON password",
                "type": "string"
              },
              "slots": {
                "description": "Server slots",
                "type": "integer"
              },
              "sourcemod_admins": {
                "description": "This string is written as is to csgo/addons/sourcemod/configs/admins_simple.ini, documentation can be found here: https://wiki.alliedmods.net/Adding_Admins_(SourceMod)",
                "type": "string"
              },
              "sourcemod_plugins": {
                "description": "Sourcemod plugins",
                "items": {
                  "type": "string"
                },
                "type": "array"
              },
              "steam_game_server_login_token": {
                "description": "Steam Game Server Login Token",
                "type": "string"
              },
              "tickrate": {
                "description": "Server tickrate",
                "type": "number"
              },
              "workshop_authkey": {
                "description": "Workshop collection authkey, leave blank to use our default Authkey",
                "type": "string"
              },
              "workshop_id": {
                "description": "Steam workshop ID",
                "type": "string"
              },
              "workshop_start_map_id": {
                "description": "Steam ID of workshop start map",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "custom_domain": {
            "description": "Use a custom domain for the server",
            "type": "string"
          },
          "cycle_months_12_discount_percentage": {
            "description": "Discount percentage for a yearly subscription",
            "type": "integer"
          },
          "cycle_months_1_discount_percentage": {
            "description": "Discount percentage for a monthly subscription",
            "type": "integer"
          },
          "cycle_months_3_discount_percentage": {
            "description": "Discount percentage for a quarterly subscription",
            "type": "integer"
          },
          "cycle_months_6_discount_percentage": {
            "description": "Discount percentage for a 6-Month subscription",
            "type": "integer"
          },
          "default_file_locations": {
            "description": "Physical location of the server addons (used internally)",
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "deletion_protection": {
            "description": "While this is set DELETE operation will be blocked",
            "type": "boolean"
          },
          "disk_usage_bytes": {
            "description": "Disk usage in bytes",
            "type": "integer"
          },
          "duplicate_source_server": {
            "description": "ID of a server that this was cloned from, if any",
            "type": "string"
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
            "description": "",
            "type": "boolean"
          },
          "first_month_discount_percentage": {
            "description": "Discount percentage for the first month of a subscription",
            "type": "integer"
          },
          "ftp_password": {
            "description": "FTP password",
            "type": "string"
          },
          "game": {
            "description": "A lowercase string identifying the game that this server is running",
            "type": "string"
          },
          "hytale_settings": {
            "properties": {
              "server_branch": {
                "description": "Server branch",
                "type": "string"
              },
              "ignore_broken_mods": {
                "description": "Ignores broken mods, attempting to allow the server to boot even if one fails to load",
                "type": "boolean"
              },
              "domain_verification_token": {
                "description": "TXT record value published at hytale-server-verification.<custom_domain> to verify the server listing on hytale.com",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "id": {
            "description": "Server ID",
            "type": "string"
          },
          "ip": {
            "description": "Hostname or IP to gameserver",
            "type": "string"
          },
          "location": {
            "description": "ID for the location of the server, see this article for available locations:<br /><a target=\"_blank\" href=\"https://help.dathost.net/article/76-api-server-locations-mapping\">https://help.dathost.net/article/76-api-server-locations-mapping</a>",
            "type": "string"
          },
          "manual_sort_order": {
            "description": "Sort order in control panel",
            "type": "number"
          },
          "match_id": {
            "description": "Ongoing match using our match API, if any",
            "type": "string"
          },
          "max_cost_per_hour": {
            "description": "Max cost per hour for this server",
            "type": "number"
          },
          "max_cost_per_month": {
            "description": "Cost per month if server has a monthly subscription",
            "type": "number"
          },
          "max_disk_usage_gb": {
            "description": "Max disk usage excluding base installation in GB",
            "type": "integer"
          },
          "minecraft_settings": {
            "properties": {
              "server_type": {
                "description": "Server type",
                "type": "string"
              },
              "server_version": {
                "description": "Server version",
                "type": "string"
              },
              "enable_server_auto_update": {
                "description": "Server version",
                "type": "boolean"
              },
              "custom_server_path": {
                "description": "Custom server path",
                "type": "string"
              },
              "custom_server_runtime": {
                "description": "Custom server runtime",
                "type": "string"
              },
              "managed_mods": {
                "description": "Managed mods",
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "source": {
                      "type": "string"
                    },
                    "category_slug": {
                      "type": "string"
                    },
                    "mod_slug": {
                      "type": "string"
                    },
                    "mod_id": {
                      "type": "string"
                    },
                    "mod_name": {
                      "type": "string"
                    },
                    "logo_url": {
                      "type": "string"
                    },
                    "file_id": {
                      "type": "string"
                    },
                    "file_name": {
                      "type": "string"
                    },
                    "file_published_at": {
                      "type": "number"
                    },
                    "installed_at": {
                      "type": "number"
                    }
                  },
                  "additionalProperties": false
                }
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "month_credits": {
            "description": "Credits this server has used this month",
            "type": "number"
          },
          "month_reset_at": {
            "description": "UNIX timestamp when the month_credits will be reset",
            "type": "integer"
          },
          "mysql_password": {
            "description": "MySQL password",
            "type": "string"
          },
          "mysql_username": {
            "description": "MySQL username",
            "type": "string"
          },
          "name": {
            "description": "Name of the server",
            "type": "string"
          },
          "on": {
            "description": "Is the server currently on?",
            "type": "boolean"
          },
          "ongoing_maintenance": {
            "description": "Is system maintenance going on on this server",
            "type": "boolean"
          },
          "palworld_settings": {
            "properties": {
              "enable_rest_api": {
                "description": "Enable REST API",
                "type": "boolean"
              },
              "enable_server_auto_pause": {
                "description": "Enable server auto pause",
                "type": "boolean"
              },
              "public_server": {
                "description": "Public server",
                "type": "boolean"
              },
              "nosteam": {
                "description": "No Steam",
                "type": "boolean"
              },
              "enable_wine": {
                "description": "Enable Wine",
                "type": "boolean"
              },
              "enable_ue4ss": {
                "description": "Enable UE4SS",
                "type": "boolean"
              },
              "server_branch": {
                "description": "Server branch",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "players_online": {
            "description": "Number of players online",
            "type": "integer"
          },
          "ports": {
            "$ref": "#/components/schemas/Ports"
          },
          "prefer_dedicated": {
            "description": "Prefer assignment to dedicated hosts on account",
            "type": "boolean"
          },
          "projectzomboid_settings": {
            "properties": {
              "adminpassword": {
                "description": "Admin password",
                "type": "string"
              },
              "nosteam": {
                "description": "No Steam",
                "type": "boolean"
              },
              "server_branch": {
                "description": "Server branch",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "private_ip": {
            "description": "Private IP of game server (only available with Syntropy integration)",
            "type": "string"
          },
          "raw_ip": {
            "description": "IP to gameserver",
            "type": "string"
          },
          "reboot_on_crash": {
            "description": "Automatically reboot the server in case of server crash",
            "type": "boolean"
          },
          "romestead_settings": {
            "properties": {},
            "type": "object",
            "additionalProperties": false
          },
          "runescapedragonwilds_settings": {
            "properties": {},
            "type": "object",
            "additionalProperties": false
          },
          "satisfactory_settings": {
            "properties": {
              "server_branch": {
                "description": "Server branch",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "scheduled_commands": {
            "items": {
              "$ref": "#/components/schemas/ScheduledCommand"
            },
            "type": "array"
          },
          "server_error": {
            "description": "Have we detected an error on the server?",
            "type": "string"
          },
          "server_image": {
            "description": "Server image to use for this server",
            "type": "string"
          },
          "sevendaystodie_settings": {
            "properties": {
              "server_branch": {
                "description": "Server branch",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "sonsoftheforest_settings": {
            "properties": {
              "password": {
                "description": "Server password",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "soulmask_settings": {
            "properties": {
              "slots": {
                "description": "Server slots",
                "type": "number"
              },
              "password": {
                "description": "Server password",
                "type": "string"
              },
              "admin_password": {
                "description": "Admin password",
                "type": "string"
              },
              "enable_pvp": {
                "description": "Enable PvP",
                "type": "boolean"
              },
              "clan_size_limit": {
                "description": "Sets the maximum number of members in a clan",
                "type": "number"
              },
              "map": {
                "description": "Map to use. Cloud Mist Forest: Level01_Main, Shifting Sands: DLC_Level01_Main",
                "type": "string"
              },
              "cluster_main_server": {
                "description": "The server ID of the main server in the cluster. Set on all servers in a cluster, including the main server itself.",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "status": {
            "description": "Various server status (map, version etc.)",
            "items": {
              "$ref": "#/components/schemas/KeyValue"
            },
            "type": "array"
          },
          "subscription_cycle_months": {
            "description": "0 if server is pay as you go, otherwise subscription cycle length in months",
            "type": "integer"
          },
          "subscription_renewal_failed_attempts": {
            "description": "Number of failed attempts to renew this subscription",
            "type": "integer"
          },
          "subscription_renewal_next_attempt_at": {
            "description": "Timestamp of next subscription renewal attempt",
            "type": "integer"
          },
          "subscription_state": {
            "description": "State of the subscription of this server",
            "enum": [
              "PAY_AS_YOU_GO",
              "ACTIVE",
              "RENEWAL_FAILED",
              "SUSPENDED",
              "CANCELING",
              "CANCELED"
            ],
            "example": "PAY_AS_YOU_GO",
            "type": "string"
          },
          "teamfortress2_settings": {
            "properties": {
              "enable_gotv": {
                "description": "Enable GOTV",
                "type": "boolean"
              },
              "enable_sourcemod": {
                "description": "Enable Sourcemod",
                "type": "boolean"
              },
              "insecure": {
                "description": "Insecure server",
                "type": "boolean"
              },
              "password": {
                "description": "Server Password",
                "type": "string"
              },
              "rcon": {
                "description": "Server RCON",
                "type": "string"
              },
              "slots": {
                "description": "Server slots",
                "type": "integer"
              },
              "sourcemod_admins": {
                "description": "This string is written as is to tf/addons/sourcemod/configs/admins_simple.ini, documentation can be found here: https://wiki.alliedmods.net/Adding_Admins_(SourceMod)",
                "type": "string"
              },
              "start_map": {
                "description": "Starting map",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "teamspeak3_settings": {
            "properties": {
              "slots": {
                "description": "Server slots",
                "type": "integer"
              },
              "ts_admin_token": {
                "description": "TeamSpeak admin token",
                "type": "string"
              },
              "ts_server_id": {
                "description": "TeamSpeak server instance ID (useful for server query)",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "user_data": {
            "description": "Custom metadata for the server,is not used by the DatHost system",
            "type": "string"
          },
          "valheim_settings": {
            "properties": {
              "admins_steamid64": {
                "description": "JSON list of server admins in SteamID64 format",
                "items": {
                  "type": "string"
                },
                "type": "array"
              },
              "bepinex_plugins": {
                "description": "BepInEx plugins",
                "items": {
                  "type": "string"
                },
                "type": "array"
              },
              "enable_bepinex": {
                "description": "Enable BepInEx",
                "type": "boolean"
              },
              "enable_crossplay": {
                "description": "Enable crossplay",
                "type": "boolean"
              },
              "join_code": {
                "description": "Crossplay join code",
                "type": "string"
              },
              "password": {
                "description": "Server password",
                "type": "string"
              },
              "server_branch": {
                "description": "Server branch",
                "type": "string"
              },
              "world_name": {
                "description": "World name",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "vrising_settings": {
            "properties": {
              "enable_rest_api": {
                "description": "Enable REST API",
                "type": "boolean"
              },
              "server_branch": {
                "description": "Server branch",
                "type": "string"
              }
            },
            "type": "object",
            "additionalProperties": false
          },
          "windrose_settings": {
            "properties": {
              "invite_code": {
                "description": "Invite code",
                "type": "string"
              },
              "use_direct_connection": {
                "description": "Use direct IP connection instead of invite code",
                "type": "boolean"
              }
            },
            "type": "object",
            "additionalProperties": false
          }
        },
        "required": [
          "autostop",
          "autostop_minutes",
          "booting",
          "confirmed",
          "cost_per_hour",
          "cost_per_month",
          "cycle_months_12_discount_percentage",
          "cycle_months_1_discount_percentage",
          "cycle_months_3_discount_percentage",
          "cycle_months_6_discount_percentage",
          "enable_mysql",
          "ftp_password",
          "game",
          "id",
          "ip",
          "location",
          "max_cost_per_hour",
          "max_cost_per_month",
          "max_disk_usage_gb",
          "month_credits",
          "month_reset_at",
          "mysql_password",
          "mysql_username",
          "name",
          "on",
          "players_online",
          "private_ip",
          "raw_ip",
          "server_image",
          "subscription_cycle_months",
          "subscription_renewal_failed_attempts",
          "subscription_state",
          "user_data"
        ],
        "type": "object",
        "additionalProperties": false
      },
      "KeyValue": {
        "properties": {
          "key": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "type": "object",
        "additionalProperties": false
      },
      "Ports": {
        "properties": {
          "game": {
            "description": "Main game port",
            "type": "integer"
          },
          "gotv": {
            "description": "Port used for gotv streaming",
            "type": "integer"
          },
          "gotv_secondary": {
            "description": "Port used for gotv streaming",
            "type": "integer"
          }
        },
        "required": [
          "game",
          "gotv",
          "gotv_secondary"
        ],
        "type": "object",
        "additionalProperties": true
      },
      "ScheduledCommand": {
        "properties": {
          "action": {
            "type": "string"
          },
          "command": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "repeat": {
            "type": "integer"
          },
          "run_at": {
            "type": "integer"
          }
        },
        "type": "object",
        "additionalProperties": false
      }
    }
  }
}
```