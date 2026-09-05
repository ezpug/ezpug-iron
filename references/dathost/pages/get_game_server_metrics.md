---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Get game server metrics

# OpenAPI definition

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "API",
    "version": "1.0"
  },
  "paths": {
    "/api/0.1/game-servers/{server_id}/metrics": {
      "get": {
        "operationId": "get_game_server_metrics",
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/MetricsOutput"
                }
              }
            }
          }
        },
        "summary": "Get game server metrics",
        "tags": [
          "Game Servers > General"
        ]
      },
      "parameters": [
        {
          "in": "path",
          "name": "server_id",
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
  ],
  "components": {
    "schemas": {
      "GraphPoint": {
        "properties": {
          "timestamp": {
            "type": "integer"
          },
          "value": {
            "type": "integer"
          }
        },
        "type": "object",
        "additionalProperties": false
      },
      "MapsPlayed": {
        "properties": {
          "map": {
            "description": "Map name",
            "type": "string"
          },
          "seconds": {
            "description": "Approx. seconds played",
            "type": "integer"
          }
        },
        "type": "object",
        "additionalProperties": false
      },
      "MetricsOutput": {
        "properties": {
          "all_time_players": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/Player"
            },
            "description": "All time players stats"
          },
          "maps_played": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/MapsPlayed"
            },
            "description": "Maps played"
          },
          "players_online": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/Player"
            },
            "description": "Current players online"
          },
          "players_online_graph": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/GraphPoint"
            },
            "description": "Players online graph"
          },
          "memory_usage_bytes_graph": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/GraphPoint"
            },
            "description": "Memory usage graph in bytes (Minecraft only)"
          }
        },
        "type": "object",
        "additionalProperties": false
      },
      "Player": {
        "properties": {
          "duration": {
            "description": "How long the player has been online (only CS:GO and TeamFortress 2)",
            "type": "integer"
          },
          "name": {
            "description": "Player nickname",
            "type": "string"
          },
          "score": {
            "description": "Player score (only CS:GO and TeamFortress 2)",
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