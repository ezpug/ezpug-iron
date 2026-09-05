---
updatedAt: 2026-08-27T18:30:15.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Start a CS2 match

Start a CS2 match

<Callout icon="📘" theme="info">
  Our CS2 Match API is primarily built for standard 5v5 matches. <Anchor target="_blank" href="https://dathost.net/docs/cs2-match-api-introduction#supported-game-modes">Read more about supported game modes here.</Anchor>
</Callout>

<Callout icon="📘" theme="info">
  This endpoint takes full control of the match. Disable any other match-controlling plugins (e.g. MatchZy) on the server first, otherwise both will manage warmup and match start simultaneously and cause conflicts.
</Callout>

# OpenAPI definition

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "API",
    "version": "1.0"
  },
  "paths": {
    "/api/0.1/cs2-matches": {
      "post": {
        "description": "Start a CS2 match",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CS2MatchInput"
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
                  "$ref": "#/components/schemas/CS2MatchOutput"
                }
              }
            }
          },
          "404": {
            "description": "Game server not found"
          }
        },
        "summary": "Start a CS2 match",
        "tags": [
          "CS2 Matches"
        ],
        "x-internal": false
      }
    }
  },
  "tags": [
    {
      "description": "CS2 Matches",
      "name": "CS2 Matches"
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
      "CS2MatchPlayerInput": {
        "type": "object",
        "properties": {
          "steam_id_64": {
            "type": "string",
            "pattern": "[0-9]+",
            "default": ""
          },
          "team": {
            "type": "string",
            "enum": [
              "team1",
              "team2",
              "spectator"
            ]
          },
          "nickname_override": {
            "type": "string",
            "description": "Optional override of the Steam default nickname",
            "default": ""
          }
        },
        "required": [
          "steam_id_64",
          "team"
        ],
        "additionalProperties": false
      },
      "CS2MatchInput": {
        "type": "object",
        "properties": {
          "game_server_id": {
            "type": "string",
            "description": "Id of the game server to run the match on. Must be a CS2 server on the same account as the match"
          },
          "team1": {
            "type": "object",
            "description": "Settings for team 1, which starts as CT",
            "properties": {
              "name": {
                "description": "Team name",
                "type": "string",
                "default": ""
              },
              "flag": {
                "description": "Team flag (ISO alpha-2: <a href=\"https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2\" target=\"_blank\">https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2</a>)",
                "type": "string",
                "default": ""
              }
            },
            "additionalProperties": false
          },
          "team2": {
            "type": "object",
            "description": "Settings for team 2, which starts as T",
            "properties": {
              "name": {
                "description": "Team name",
                "type": "string",
                "default": ""
              },
              "flag": {
                "description": "Team flag (ISO alpha-2: <a href=\"https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2\" target=\"_blank\">https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2</a>)",
                "type": "string",
                "default": ""
              }
            },
            "additionalProperties": false
          },
          "players": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CS2MatchPlayerInput"
            }
          },
          "settings": {
            "type": "object",
            "description": "Match settings",
            "properties": {
              "map": {
                "type": "string",
                "description": "Specifies the map for the match. Options include local/official maps (e.g. <code>de_dust2</code>), workshop maps (e.g. <code>workshop/3071899764</code>), or <code>null</code> for the server-configured map.",
                "default": null
              },
              "password": {
                "type": "string",
                "description": "Server password. Use \"\" to remove the password. Use null to use the password configured on the game server.",
                "default": null
              },
              "connect_time": {
                "type": "integer",
                "description": "Time in seconds until match is canceled if not everyone has joined",
                "default": 300
              },
              "match_begin_countdown": {
                "type": "integer",
                "description": "Time in seconds after everyone has joined until match start",
                "default": 30
              },
              "team_size": {
                "type": "integer",
                "description": "Amount of players in each team. By default, the number of players will be the same as the number of Steam IDs entered in each team. Set this to a custom amount if you need to enter more Steam IDs than should participate, for example, to allow an emergency substitution during the game.",
                "default": null
              },
              "wait_for_gotv": {
                "type": "boolean",
                "description": "Controls the GOTV demo recording stop time to mitigate the \"GOTV lag spoiler\".<br /><code>False</code>: Stops demo 20s after match ends.<br /><code>True</code>: Stops demo after <code>tv_delay</code> (default 105s) + 20s after match ends. Recommended if you have live GOTV viewers.",
                "default": false
              },
              "enable_plugin": {
                "type": "boolean",
                "description": "Enable experimental CounterStrikeSharp plugin to lock players to their teams",
                "default": false
              },
              "enable_tech_pause": {
                "type": "boolean",
                "description": "Enable tech pause using the !tech chat command",
                "default": false
              }
            },
            "additionalProperties": false
          },
          "webhooks": {
            "type": "object",
            "description": "Documentation: <a target=\"_blank\" href=\"https://dathost.com/docs/cs2-match-api-webhooks\">https://dathost.com/docs/cs2-match-api-webhooks</a>",
            "properties": {
              "match_end_url": {
                "type": "string",
                "default": ""
              },
              "round_end_url": {
                "type": "string",
                "default": ""
              },
              "player_votekick_success_url": {
                "type": "string",
                "default": ""
              },
              "event_url": {
                "type": "string",
                "description": "URL that will recieve webhooks for all event types specified by the \"enabled_events\" setting",
                "default": ""
              },
              "enabled_events": {
                "type": "array",
                "description": "Array of event types to subscribe to, use [\"*\"] to subscribe to all avents",
                "items": {
                  "type": "string",
                  "enum": [
                    "*",
                    "booting_server",
                    "loading_map",
                    "server_ready_for_players",
                    "all_players_connected",
                    "match_started",
                    "match_ended",
                    "players_exited",
                    "gotv_stopped",
                    "player_connected",
                    "player_disconnected",
                    "player_votekicked",
                    "round_end",
                    "match_canceled"
                  ]
                },
                "default": []
              },
              "authorization_header": {
                "type": "string",
                "description": "This is added as is as the \"Authorization\" HTTP header to all webhook requests",
                "default": ""
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "game_server_id",
          "players"
        ],
        "additionalProperties": false
      },
      "CS2MatchPlayerOutput": {
        "type": "object",
        "properties": {
          "match_id": {
            "type": "string"
          },
          "steam_id_64": {
            "type": "string",
            "pattern": "[0-9]+"
          },
          "team": {
            "type": "string",
            "enum": [
              "team1",
              "team2",
              "spectator"
            ]
          },
          "nickname_override": {
            "type": "string"
          },
          "connected": {
            "type": "boolean"
          },
          "kicked": {
            "type": "boolean"
          },
          "disconnected_at": {
            "description": "If the player left the match during the live phase this will be the UNIX timestamp of the last disconnect event. Otherwise null.",
            "type": "integer"
          },
          "disconnected_reason": {
            "description": "If the player left the match during the live phase this will be the reason for the disconnect. Otherwise null.",
            "type": "string"
          },
          "stats": {
            "type": "object",
            "properties": {
              "kills": {
                "type": "integer"
              },
              "assists": {
                "type": "integer"
              },
              "deaths": {
                "type": "integer"
              },
              "mvps": {
                "type": "integer"
              },
              "score": {
                "type": "integer"
              },
              "2ks": {
                "type": "integer"
              },
              "3ks": {
                "type": "integer"
              },
              "4ks": {
                "type": "integer"
              },
              "5ks": {
                "type": "integer"
              },
              "kills_with_headshot": {
                "type": "integer"
              },
              "kills_with_pistol": {
                "type": "integer"
              },
              "kills_with_sniper": {
                "type": "integer"
              },
              "damage_dealt": {
                "type": "integer"
              },
              "entry_attempts": {
                "type": "integer"
              },
              "entry_successes": {
                "type": "integer"
              },
              "flashes_thrown": {
                "type": "integer"
              },
              "flashes_successful": {
                "type": "integer"
              },
              "flashes_enemies_blinded": {
                "type": "integer"
              },
              "utility_thrown": {
                "type": "integer"
              },
              "utility_damage": {
                "type": "integer"
              },
              "1vX_attempts": {
                "type": "integer"
              },
              "1vX_wins": {
                "type": "integer"
              }
            },
            "required": [
              "kills",
              "assists",
              "deaths",
              "mvps",
              "score",
              "2ks",
              "3ks",
              "4ks",
              "5ks",
              "kills_with_headshot",
              "kills_with_pistol",
              "kills_with_sniper",
              "damage_dealt",
              "entry_attempts",
              "entry_successes",
              "flashes_thrown",
              "flashes_successful",
              "flashes_enemies_blinded",
              "utility_thrown",
              "utility_damage",
              "1vX_attempts",
              "1vX_wins"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "match_id",
          "steam_id_64",
          "team",
          "nickname_override",
          "connected",
          "kicked",
          "stats"
        ],
        "additionalProperties": false
      },
      "CS2MatchOutput": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "game_server_id": {
            "type": "string",
            "description": "Id of the game server to run the match on. Must be a CS2 server on the same account as the match"
          },
          "team1": {
            "description": "Settings for team 1, which starts as CT",
            "type": "object",
            "properties": {
              "name": {
                "description": "Team name",
                "type": "string"
              },
              "flag": {
                "description": "Team flag (ISO alpha-2: <a href=\"https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2\" target=\"_blank\">https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2</a>)",
                "type": "string"
              },
              "stats": {
                "type": "object",
                "properties": {
                  "score": {
                    "type": "integer"
                  }
                },
                "additionalProperties": false,
                "required": [
                  "score"
                ]
              }
            },
            "required": [
              "name",
              "flag"
            ],
            "additionalProperties": false
          },
          "team2": {
            "description": "Settings for team 2, which starts as T",
            "type": "object",
            "properties": {
              "name": {
                "description": "Team name",
                "type": "string"
              },
              "flag": {
                "description": "Team flag (ISO alpha-2: <a href=\"https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2\" target=\"_blank\">https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2</a>)",
                "type": "string"
              },
              "stats": {
                "type": "object",
                "properties": {
                  "score": {
                    "type": "integer"
                  }
                },
                "additionalProperties": false,
                "required": [
                  "score"
                ]
              }
            },
            "required": [
              "name",
              "flag"
            ],
            "additionalProperties": false
          },
          "players": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CS2MatchPlayerOutput"
            }
          },
          "settings": {
            "type": "object",
            "properties": {
              "map": {
                "type": "string",
                "description": "Specifies the map for the match. Options include local/official maps (e.g. <code>de_dust2</code>), workshop maps (e.g. <code>workshop/3071899764</code>), or <code>null</code> for the server-configured map."
              },
              "password": {
                "type": "string",
                "description": "Server password. Use \"\" to remove the password. Use null to use the password configured on the game server."
              },
              "connect_time": {
                "type": "integer",
                "description": "Time in seconds until match is canceled if not everyone has joined",
                "default": 300
              },
              "match_begin_countdown": {
                "type": "integer",
                "description": "Time in seconds after everyone has joined until match start",
                "default": 30
              },
              "team_size": {
                "type": "integer",
                "description": "Amount of players in each team. By default, the number of players will be the same as the number of Steam IDs entered in each team. Set this to a custom amount if you need to enter more Steam IDs than should participate, for example, to allow an emergency substitution during the game."
              },
              "wait_for_gotv": {
                "type": "boolean",
                "description": "Controls the GOTV demo recording stop time to mitigate the \"GOTV lag spoiler\".<br /><code>False</code>: Stops demo 20s after match ends.<br /><code>True</code>: Stops demo after <code>tv_delay</code> (default 105s) + 20s after match ends. Recommended if you have live GOTV viewers.",
                "default": false
              },
              "enable_plugin": {
                "type": "boolean",
                "description": "Enable experimental CounterStrikeSharp plugin to lock players to their teams",
                "default": false
              },
              "enable_tech_pause": {
                "type": "boolean",
                "description": "Enable tech pause using the !tech chat command",
                "default": false
              }
            },
            "required": [
              "map",
              "password",
              "connect_time",
              "match_begin_countdown",
              "team_size",
              "wait_for_gotv",
              "enable_plugin",
              "enable_tech_pause"
            ],
            "additionalProperties": false
          },
          "webhooks": {
            "type": "object",
            "properties": {
              "match_end_url": {
                "type": "string"
              },
              "round_end_url": {
                "type": "string"
              },
              "player_votekick_success_url": {
                "type": "string"
              },
              "event_url": {
                "type": "string",
                "description": "URL that will recieve webhooks for all event types specified by the \"enabled_events\" setting"
              },
              "enabled_events": {
                "type": "array",
                "description": "Array of event types to subscribe to, use [\"*\"] to subscribe to all avents",
                "items": {
                  "type": "string",
                  "enum": [
                    "*",
                    "booting_server",
                    "loading_map",
                    "server_ready_for_players",
                    "all_players_connected",
                    "match_started",
                    "match_ended",
                    "players_exited",
                    "gotv_stopped",
                    "player_connected",
                    "player_disconnected",
                    "player_votekicked",
                    "round_end",
                    "match_canceled"
                  ]
                }
              },
              "authorization_header": {
                "type": "string"
              }
            },
            "required": [
              "match_end_url",
              "round_end_url",
              "player_votekick_success_url",
              "authorization_header",
              "event_url",
              "enabled_events"
            ],
            "additionalProperties": false
          },
          "rounds_played": {
            "type": "integer"
          },
          "finished": {
            "type": "boolean"
          },
          "cancel_reason": {
            "type": "string"
          },
          "events": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "event": {
                  "type": "string",
                  "description": "The type of event that was triggered",
                  "enum": [
                    "booting_server",
                    "loading_map",
                    "server_ready_for_players",
                    "all_players_connected",
                    "match_started",
                    "match_ended",
                    "players_exited",
                    "gotv_stopped",
                    "player_connected",
                    "player_disconnected",
                    "player_votekicked",
                    "round_end",
                    "match_canceled"
                  ]
                },
                "timestamp": {
                  "type": "integer",
                  "description": "UNIX timestamp when the event was triggered"
                },
                "payload": {
                  "type": "object",
                  "description": "Additional data depending on the object type"
                }
              },
              "required": [
                "event",
                "timestamp"
              ]
            }
          }
        },
        "required": [
          "id",
          "game_server_id",
          "players",
          "webhooks",
          "rounds_played",
          "finished",
          "cancel_reason",
          "events"
        ],
        "additionalProperties": false
      }
    }
  }
}
```