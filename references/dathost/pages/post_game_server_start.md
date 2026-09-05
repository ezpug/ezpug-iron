---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Start a game server

This will reboot the server if the server is already on.

# OpenAPI definition

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "API",
    "version": "1.0"
  },
  "paths": {
    "/api/0.1/game-servers/{server_id}/start": {
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
        "description": "This will reboot the server if the server is already on.",
        "operationId": "post_game_server_start",
        "requestBody": {
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "properties": {
                  "allow_host_reassignment": {
                    "description": "If true, the server may be moved to another host/port if the current host is unreachable",
                    "type": "boolean"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Success"
          },
          "404": {
            "description": "A server with this id was not found"
          },
          "500": {
            "description": "Failed to start server, if this issue persists, please contact support@dathost.com"
          }
        },
        "summary": "Start a game server",
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