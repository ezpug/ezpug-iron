---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Send a line of text to a game server console

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
        "operationId": "post_game_server_console",
        "requestBody": {
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "properties": {
                  "line": {
                    "description": "A line of text to send to the server console",
                    "type": "string"
                  }
                },
                "required": [
                  "line"
                ]
              }
            }
          },
          "required": true
        },
        "responses": {
          "200": {
            "description": "Success"
          },
          "404": {
            "description": "A server with this id was not found"
          }
        },
        "summary": "Send a line of text to a game server console",
        "tags": [
          "Game Servers > Console"
        ]
      }
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