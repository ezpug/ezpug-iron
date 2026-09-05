---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Add a player to a CS2 match

Add a player to a CS2 match

# OpenAPI definition

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "API",
    "version": "1.0"
  },
  "paths": {
    "/api/0.1/cs2-matches/{match_id}/players": {
      "post": {
        "description": "Add a player to a CS2 match",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CS2MatchPlayerInput"
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
                  "$ref": "#/components/schemas/CS2MatchPlayerOutput"
                }
              }
            }
          },
          "404": {
            "description": "A match with this id was not found"
          }
        },
        "summary": "Add a player to a CS2 match",
        "tags": [
          "CS2 Matches"
        ]
      },
      "parameters": [
        {
          "in": "path",
          "name": "match_id",
          "required": true,
          "schema": {
            "type": "string"
          }
        }
      ]
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
      }
    }
  }
}
```