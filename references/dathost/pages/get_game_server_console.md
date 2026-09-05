---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Get the last lines of backlog from a game server console

# OpenAPI definition

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "API",
    "version": "1.0"
  },
  "paths": {
    "/api/0.1/game-servers/{server_id}/console": {
      "get": {
        "operationId": "get_game_server_console",
        "parameters": [
          {
            "description": "Maximum number of lines to fetch (1-100000)",
            "in": "query",
            "name": "max_lines",
            "schema": {
              "type": "integer",
              "default": 1000
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Success"
          },
          "404": {
            "description": "A server with this id was not found"
          }
        },
        "summary": "Get the last lines of backlog from a game server console",
        "tags": [
          "Game Servers > Console"
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
      "description": "Game Servers > Console",
      "name": "Game Servers > Console"
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