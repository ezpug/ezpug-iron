---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Stop a game server

# OpenAPI definition

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "API",
    "version": "1.0"
  },
  "paths": {
    "/api/0.1/game-servers/{server_id}/stop": {
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
        "operationId": "post_game_server_stop",
        "responses": {
          "200": {
            "description": "Success"
          },
          "404": {
            "description": "A server with this id was not found"
          }
        },
        "summary": "Stop a game server",
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
  ]
}
```